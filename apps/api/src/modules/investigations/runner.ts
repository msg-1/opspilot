import { env } from '../../config/env';
import { type InvestigationRequest, aiService } from '../../integrations/aiService';
import { logger } from '../../lib/logger';
import { investigationsTotal } from '../../lib/metrics';
import { notifyUsers } from '../../lib/notify';
import { prisma } from '../../lib/prisma';
import { withSpan } from '../../lib/tracing';
import { signToolToken } from '../../middleware/auth';
import { onWorkerShutdown, registerProcessor } from '../../queues';
import { incidentKey } from '../incidents';
import { markFailed, markInterrupted, persistently } from './persistence';
import { Cancelled, Superseded, eventConsumer } from './stream';

/** The reason a run is aborted when its worker is shutting down. */
class ShuttingDown extends Error {}

// The investigations this process is running right now, so that it can stop them on shutdown
// and can tell "I am still running this" from "whoever was running this is gone".
const running = new Map<string, AbortController>();

/** Stops every investigation this process is running; each is recorded as interrupted. */
export function interruptRunning() {
  for (const abort of running.values()) abort.abort(new ShuttingDown());
  return running.size;
}

/**
 * Runs one queued investigation from start to finish (in the worker): hands the question to the
 * AI service with a token that lets it read this organisation's data, consumes the stream, and
 * records the outcome.
 *
 * An investigation is run at most once. Starting it is a conditional update, so of two
 * deliveries of the same work only one runs. `redelivered` says the queue is handing the job
 * out again because the worker that had it stopped answering: if the investigation is still
 * marked as running and it is not running here, nobody is running it, and it is recorded as
 * interrupted at once. It is not started again: with a model that would be a second charge,
 * and the person who asked can decide that.
 */
export async function runInvestigation(investigationId: string, { redelivered = false }: { redelivered?: boolean } = {}) {
  if (running.has(investigationId)) return;
  const abort = new AbortController();
  running.set(investigationId, abort);
  try {
    const claimed = await prisma.investigation.updateMany({ where: { id: investigationId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (!claimed.count) {
      if (redelivered && (await markInterrupted(investigationId))) logger.warn({ investigationId }, 'investigation interrupted: its worker stopped; recorded as failed');
      return;
    }
    await execute(investigationId, abort);
  } finally {
    running.delete(investigationId);
  }
}

async function execute(investigationId: string, abort: AbortController) {
  const investigation = await prisma.investigation.findUniqueOrThrow({
    where: { id: investigationId },
    include: { organization: { select: { name: true } }, incident: { include: { services: { select: { service: { select: { id: true, name: true, slug: true } } } } } } },
  });
  const { organizationId } = investigation;

  const { onEvent, addStep, state } = eventConsumer(investigationId, abort);
  const request: InvestigationRequest = {
    investigationId,
    question: investigation.question,
    organizationName: investigation.organization.name,
    apiUrl: env.API_URL ?? `http://localhost:${env.API_PORT}`,
    toolToken: signToolToken(organizationId, investigationId),
    incident: investigation.incident
      ? {
          id: investigation.incident.id,
          key: incidentKey(investigation.incident.number),
          title: investigation.incident.title,
          description: investigation.incident.description,
          severity: investigation.incident.severity,
          status: investigation.incident.status,
          startedAt: investigation.incident.startedAt.toISOString(),
          resolvedAt: investigation.incident.resolvedAt?.toISOString() ?? null,
          services: investigation.incident.services.map((s) => s.service),
        }
      : undefined,
    timeWindow:
      investigation.timeWindowStart && investigation.timeWindowEnd
        ? { from: investigation.timeWindowStart.toISOString(), to: investigation.timeWindowEnd.toISOString() }
        : undefined,
  };

  try {
    // The request to the AI service, and everything done with what it streams back.
    await withSpan('investigation.run', { attributes: { 'opspilot.investigation.id': investigationId } }, () => aiService.runInvestigation(request, onEvent, abort.signal));
    if (!state.finished) throw new Error('The AI service ended the investigation without producing a report');
    investigationsTotal.inc({ status: 'completed', provider: state.provider });
  } catch (err) {
    if (err instanceof Cancelled) {
      investigationsTotal.inc({ status: 'cancelled', provider: state.provider });
      return;
    }
    // It already reached another end (failed, interrupted, cancelled); the late report was not stored.
    if (err instanceof Superseded) return;
    if (state.finished) {
      // The report is stored. What failed came after it (the timeline entry, a notification);
      // that does not turn a completed investigation into a failed one.
      logger.error({ err, investigationId }, 'investigation completed, but a follow-up write failed');
      return;
    }
    if (err instanceof ShuttingDown) {
      await persistently(() => markInterrupted(investigationId));
      investigationsTotal.inc({ status: 'interrupted', provider: state.provider });
      return;
    }
    const message = describeFailure(err);
    logger.error({ err, investigationId }, 'investigation failed');
    await addStep({ type: 'error', title: 'Investigation failed', detail: message, status: 'failed' }).catch(() => undefined);
    // If this cannot be written either, the job fails, the row stays RUNNING and the periodic sweep ends it.
    const recorded = await persistently(() => markFailed(investigationId, message));
    if (!recorded.count) return;
    investigationsTotal.inc({ status: 'failed', provider: state.provider });
    await notifyUsers([investigation.createdById], { organizationId, type: 'investigation.failed', title: 'Investigation failed', body: message.slice(0, 200), link: `/investigations/${investigationId}` }).catch(() => undefined);
  }
}

/**
 * What is recorded on the investigation and shown to the person who started it. A database
 * error's own text names hosts, ports and queries; it goes to the log, not to the record.
 */
function describeFailure(err: unknown) {
  const error = err as Error | undefined;
  if (error?.name?.startsWith('PrismaClient')) return 'The database could not be reached while the investigation was running, so it was stopped. No conclusions were recorded. Start it again.';
  return (error?.message || 'The investigation failed for an unknown reason.').slice(0, 1000);
}

registerProcessor('investigation', ({ investigationId }, delivery) => runInvestigation(investigationId, delivery));
onWorkerShutdown(interruptRunning);

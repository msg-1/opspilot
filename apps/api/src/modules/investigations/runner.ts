import { env } from '../../config/env';
import { type InvestigationRequest, aiService } from '../../integrations/aiService';
import { logger } from '../../lib/logger';
import { investigationsTotal } from '../../lib/metrics';
import { notifyUsers } from '../../lib/notify';
import { prisma } from '../../lib/prisma';
import { withSpan } from '../../lib/tracing';
import { signToolToken } from '../../middleware/auth';
import { registerProcessor } from '../../queues';
import { incidentKey } from '../incidents';
import { markFailed } from './persistence';
import { Cancelled, eventConsumer } from './stream';

/**
 * Runs one queued investigation from start to finish (in the worker): hands the question to the
 * AI service with a token that lets it read this organisation's data, consumes the stream, and
 * records the outcome.
 */
export async function runInvestigation(investigationId: string) {
  const investigation = await prisma.investigation.findUnique({
    where: { id: investigationId },
    include: { organization: { select: { name: true } }, incident: { include: { services: { select: { service: { select: { id: true, name: true, slug: true } } } } } } },
  });
  if (!investigation || investigation.status !== 'QUEUED') return;
  const { organizationId } = investigation;
  await prisma.investigation.update({ where: { id: investigationId }, data: { status: 'RUNNING', startedAt: new Date() } });

  const abort = new AbortController();
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
    const message = (err as Error).message.slice(0, 1000);
    logger.error({ err, investigationId }, 'investigation failed');
    await addStep({ type: 'error', title: 'Investigation failed', detail: message, status: 'failed' }).catch(() => undefined);
    await markFailed(investigationId, message);
    investigationsTotal.inc({ status: 'failed', provider: state.provider });
    await notifyUsers([investigation.createdById], { organizationId, type: 'investigation.failed', title: 'Investigation failed', body: message.slice(0, 200), link: `/investigations/${investigationId}` });
  }
}

registerProcessor('investigation', ({ investigationId }) => runInvestigation(investigationId));

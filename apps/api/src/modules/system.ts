import { Router } from 'express';
import { aiService } from '../integrations/aiService';
import { env } from '../config/env';
import { writeAudit } from '../lib/audit';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { requirePermission } from '../middleware/auth';
import { enqueue, queueStats, redisPing, registerProcessor } from '../queues';
import { addIncidentEvent } from './incidents';
import { markInterrupted } from './investigations/persistence';
import { evaluateAlerts } from './monitoring';

// ───────────────────────── Scheduled jobs ─────────────────────────

registerProcessor('alert-eval', async () => {
  await evaluateAlerts();
  // The same once-a-minute tick sweeps up work stranded by a worker that died mid-job.
  await reapStranded();
});

// Longer than any job can legitimately take (the AI call itself times out after INVESTIGATION_TIMEOUT_MS).
const STALE = { runningInvestigation: env.INVESTIGATION_TIMEOUT_MS + 5 * 60_000, queuedInvestigation: 60 * 60_000, executingRemediation: 5 * 60_000, indexingDocument: 10 * 60_000 };

/**
 * A job that dies with its process leaves its row in an in-progress state that no retry will
 * ever revisit. This finds such rows and moves them to an honest terminal (or retryable) state.
 */
export async function reapStranded(now = new Date()) {
  const before = (ms: number) => new Date(now.getTime() - ms);
  const investigations = await prisma.investigation.findMany({
    where: { OR: [{ status: 'RUNNING', startedAt: { lt: before(STALE.runningInvestigation) } }, { status: 'QUEUED', createdAt: { lt: before(STALE.queuedInvestigation) } }] },
    select: { id: true },
  });
  for (const inv of investigations) await markInterrupted(inv.id, now);

  const unknown = 'Execution was interrupted and its outcome is unknown. Check the target system before retrying: the change may or may not have been applied.';
  const actions = await prisma.remediationAction.findMany({ where: { status: 'EXECUTING', updatedAt: { lt: before(STALE.executingRemediation) } }, select: { id: true, organizationId: true, incidentId: true, title: true } });
  for (const action of actions) {
    const claimed = await prisma.remediationAction.updateMany({ where: { id: action.id, status: 'EXECUTING' }, data: { status: 'FAILED', executedAt: now, executionResult: { mode: 'unknown', success: false, outcome: 'unknown', summary: unknown } } });
    if (!claimed.count) continue;
    await writeAudit({ organizationId: action.organizationId, actorType: 'system', actorLabel: 'OPSILUME worker', action: 'remediation.execute_interrupted', resourceType: 'remediation_action', resourceId: action.id });
    if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `Remediation outcome unknown: ${action.title} — ${unknown}`, { kind: 'system', label: 'OPSILUME worker' }, { actionId: action.id });
  }

  const documents = await prisma.knowledgeDocument.findMany({ where: { indexStatus: 'indexing', updatedAt: { lt: before(STALE.indexingDocument) } }, select: { id: true } });
  for (const doc of documents) {
    await prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { indexStatus: 'pending' } });
    await enqueue('knowledge-index', { documentId: doc.id }).catch(() => undefined);
  }

  const result = { investigations: investigations.length, remediations: actions.length, documents: documents.length };
  if (result.investigations || result.remediations || result.documents) logger.warn(result, 'recovered stranded work');
  return result;
}

/** Deletes logs and metric samples older than each organisation's retention period. */
export async function applyRetention() {
  const orgs = await prisma.organization.findMany({ select: { id: true, settings: { select: { logRetentionDays: true } } } });
  let logs = 0;
  let metrics = 0;
  for (const org of orgs) {
    const cutoff = new Date(Date.now() - (org.settings?.logRetentionDays ?? 30) * 86_400_000);
    logs += (await prisma.logEntry.deleteMany({ where: { organizationId: org.id, timestamp: { lt: cutoff } } })).count;
    metrics += (await prisma.metricSample.deleteMany({ where: { organizationId: org.id, timestamp: { lt: cutoff } } })).count;
  }
  await prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  if (logs || metrics) logger.info({ logs, metrics }, 'retention applied');
  return { logs, metrics };
}

registerProcessor('log-retention', async () => {
  await applyRetention();
});

// ───────────────────────── Health & status ─────────────────────────

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'opspilot-api', time: new Date().toISOString() });
});

healthRouter.get('/ready', async (_req, res) => {
  const [database, redis] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    redisPing(),
  ]);
  res.status(database && redis ? 200 : 503).json({ status: database && redis ? 'ready' : 'not_ready', database, redis });
});

export const systemRouter = Router();

systemRouter.get('/status', requirePermission('read'), async (_req, res) => {
  const [database, redis, queues, ai] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    redisPing(),
    queueStats().catch(() => []),
    aiService.status().then((s) => ({ reachable: true as const, ...s })).catch((err: Error) => ({ reachable: false as const, detail: err.message })),
  ]);
  res.json({ database, redis, queues, ai });
});

import { Router } from 'express';
import { aiService } from '../integrations/aiService';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { requirePermission } from '../middleware/auth';
import { queueStats, redisPing, registerProcessor } from '../queues';
import { evaluateAlerts } from './monitoring';

// ───────────────────────── Scheduled jobs ─────────────────────────

registerProcessor('alert-eval', async () => {
  await evaluateAlerts();
});

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

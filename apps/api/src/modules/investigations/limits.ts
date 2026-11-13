import { env } from '../../config/env';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';

/** Per-organisation limits on investigations. They bound model spend. */

export const organizationLimits = () => ({ maxConcurrent: env.INVESTIGATION_MAX_CONCURRENT, dailyInvestigations: env.INVESTIGATION_DAILY_LIMIT, dailyCostUsd: env.AI_DAILY_COST_LIMIT_USD });

/** What this organisation has used since midnight UTC. */
export async function usageToday(organizationId: string) {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const [agg, running] = await Promise.all([
    prisma.investigation.aggregate({ where: { organizationId, createdAt: { gte: since } }, _count: true, _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true } }),
    prisma.investigation.count({ where: { organizationId, status: { in: ['QUEUED', 'RUNNING'] } } }),
  ]);
  return { investigations: agg._count, running, estimatedCostUsd: Math.round((agg._sum.estimatedCostUsd ?? 0) * 10_000) / 10_000, tokens: (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0) };
}

/** Spending guard: refuses new investigations once the organisation's limits are reached. */
export async function assertWithinLimits(organizationId: string) {
  const usage = await usageToday(organizationId);
  const refuse = (message: string) => new AppError(429, 'limit_reached', message);
  if (env.INVESTIGATION_MAX_CONCURRENT && usage.running >= env.INVESTIGATION_MAX_CONCURRENT) {
    throw refuse(`${usage.running} investigations are already in progress (limit ${env.INVESTIGATION_MAX_CONCURRENT}). Wait for one to finish or cancel it.`);
  }
  if (env.INVESTIGATION_DAILY_LIMIT && usage.investigations >= env.INVESTIGATION_DAILY_LIMIT) {
    throw refuse(`The daily limit of ${env.INVESTIGATION_DAILY_LIMIT} investigations has been reached. It resets at midnight UTC.`);
  }
  if (env.AI_DAILY_COST_LIMIT_USD && usage.estimatedCostUsd >= env.AI_DAILY_COST_LIMIT_USD) {
    throw refuse(`Today's estimated model spend ($${usage.estimatedCostUsd.toFixed(2)}) has reached the daily limit of $${env.AI_DAILY_COST_LIMIT_USD.toFixed(2)}. It resets at midnight UTC; raise AI_DAILY_COST_LIMIT_USD to allow more.`);
  }
}

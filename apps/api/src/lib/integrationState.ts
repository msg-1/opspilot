import { ZodError } from 'zod';
import { isTest } from '../config/env';
import { AppError } from './errors';
import { logger } from './logger';
import { prisma } from './prisma';

/**
 * What OPSILUME knows about whether a data source is working. A source is "configured" when
 * someone saved a key or a token; that says nothing about whether data arrives. This records
 * what actually happened: data accepted, data rejected, and the result of explicit checks.
 *
 * Everything stored here is shown to people in the organisation, so messages are composed
 * from field names and our own wording. They never include payload values or credentials.
 */

export const INGESTION_SOURCES = ['logs', 'metrics', 'deployments', 'events'] as const;
export type IngestionSource = (typeof INGESTION_SOURCES)[number];
export type IntegrationId = IngestionSource | 'github' | 'remediation_webhook';

// Accepted data is frequent; one row update per source every half minute is enough to know it is alive.
const SUCCESS_WRITE_INTERVAL_MS = isTest ? 0 : 30_000;
const lastSuccessWrite = new Map<string, number>();

const upsert = (organizationId: string, integration: IntegrationId, data: Record<string, unknown>) =>
  prisma.integrationState.upsert({ where: { organizationId_integration: { organizationId, integration } }, create: { organizationId, integration, ...data }, update: data });

/** Never lets bookkeeping fail the request it describes. */
const quietly = (work: Promise<unknown>) => work.then(() => undefined, (err: Error) => logger.warn({ err: err.message }, 'could not record integration state'));

/** Data was accepted. `unknownServices` are names in it that match no registered service. */
export function noteAccepted(organizationId: string, integration: IntegrationId, unknownServices: string[] = []) {
  const key = `${organizationId}:${integration}`;
  const now = Date.now();
  if (!unknownServices.length && now - (lastSuccessWrite.get(key) ?? 0) < SUCCESS_WRITE_INTERVAL_MS) return Promise.resolve();
  lastSuccessWrite.set(key, now);
  return quietly(upsert(organizationId, integration, { lastSuccessAt: new Date(now), unknownServices: unknownServices.slice(0, 20).map((s) => s.slice(0, 80)) }));
}

export function noteRejected(organizationId: string, integration: IntegrationId, message: string, unknownServices?: string[]) {
  return quietly(upsert(organizationId, integration, { lastErrorAt: new Date(), lastError: message.slice(0, 500), ...(unknownServices ? { unknownServices: unknownServices.slice(0, 20).map((s) => s.slice(0, 80)) } : {}) }));
}

export function noteCheck(organizationId: string, integration: IntegrationId, ok: boolean, detail: string) {
  return quietly(upsert(organizationId, integration, { lastCheckedAt: new Date(), lastCheckOk: ok, lastCheckDetail: detail.slice(0, 500) }));
}

/**
 * Why a request to an ingestion endpoint was refused, in words that are safe to store and show:
 * which field was wrong and how, never what was sent. Returns null for failures that are not
 * the sender's (a database outage is not a misconfigured integration).
 */
export function describeRejection(err: unknown): string | null {
  if (err instanceof ZodError) {
    const [first] = err.issues;
    const where = first?.path.length ? first.path.join('.') : 'request body';
    const more = err.issues.length > 1 ? ` (and ${err.issues.length - 1} more problem${err.issues.length > 2 ? 's' : ''})` : '';
    return `The request was rejected: ${where}: ${first?.message ?? 'invalid'}${more}.`;
  }
  // Our own messages sometimes quote what the caller sent (a version, an environment). The quoted part is left out.
  if (err instanceof AppError && err.status >= 400 && err.status < 500) return `The request was rejected: ${err.message.replace(/"[^"]*"/g, '(value omitted)')}`;
  return null;
}

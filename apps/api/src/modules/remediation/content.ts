import { createHash } from 'node:crypto';
import type { RemediationAction } from '@prisma/client';

/**
 * Action hashing. An approval is given for exact content: a hash of the action's type, title,
 * description, risk, service and parameters. Everything that binds an approval to an action
 * goes through contentHash().
 */

export type Content = Pick<RemediationAction, 'type' | 'title' | 'description' | 'risk' | 'serviceId'> & { parameters?: unknown };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  return value ?? null;
}

/** Identifies exactly what an approver was shown. Key order in parameters does not matter; values do. */
export function contentHash(a: Content): string {
  const content = { type: a.type, title: a.title, description: a.description, risk: a.risk, serviceId: a.serviceId ?? null, parameters: canonical(a.parameters ?? null) };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

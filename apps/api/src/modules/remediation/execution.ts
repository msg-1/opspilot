import type { RemediationAction } from '@prisma/client';
import { env } from '../../config/env';
import { decrypt, hmacSha256Hex } from '../../lib/crypto';
import { assertSafeOutboundUrl } from '../../lib/netguard';
import { getSettings } from '../organization';
import { contentHash } from './content';

/**
 * Carrying out an action. OPSILUME changes nothing itself: a read-only diagnostic is recorded
 * by a person, and a state-changing action is either dispatched to the organisation's
 * remediation webhook or carried out by hand and attested.
 *
 * Every attempt at an action carries the same idempotency key. A timeout, a dropped connection
 * or a 5xx leaves the outcome UNKNOWN, never "executed" and never a clean failure.
 */

export interface ExecutionResult {
  mode: 'webhook' | 'manual' | 'diagnostic';
  success: boolean;
  /** applied: done · not_applied: certainly not done · unknown: may or may not have been done */
  outcome: 'applied' | 'not_applied' | 'unknown';
  summary: string;
  detail?: Record<string, unknown>;
}

/**
 * OpsPilot has no direct access to production. An approved action is carried out either
 *  - by POSTing it (HMAC-signed) to the organisation's remediation webhook, e.g. a CI/CD
 *    pipeline or runbook automation that performs the change, or
 *  - manually by the operator, who then attests in OpsPilot that it was done.
 * In both cases the effect is recorded on the service timeline.
 */
export async function execute(action: RemediationAction, operator: { userId: string; label: string }, approvers: { approverId: string; approvedAt: Date }[], manualNotes?: string): Promise<ExecutionResult> {
  if (action.effect === 'read_only') {
    // Diagnostics are carried out by a person and never dispatched: nothing here can change a system.
    return { mode: 'diagnostic', success: true, outcome: 'applied', summary: `Read-only diagnostic carried out and recorded by ${operator.label}. Nothing was changed.`, detail: manualNotes ? { findings: manualNotes } : undefined };
  }
  const settings = await getSettings(action.organizationId);
  if (!settings.remediationWebhookUrl) {
    return { mode: 'manual', success: true, outcome: 'applied', summary: `Carried out manually and attested by ${operator.label}. OPSILUME did not change any external system.`, detail: manualNotes ? { notes: manualNotes } : undefined };
  }
  const body = JSON.stringify({
    event: 'remediation.execute',
    actionId: action.id,
    // The same for every attempt at this action, so a receiver can refuse to apply it twice.
    idempotencyKey: action.id,
    attempt: action.attempts,
    type: action.type,
    effect: action.effect,
    title: action.title,
    serviceId: action.serviceId,
    incidentId: action.incidentId,
    parameters: action.parameters,
    contentHash: contentHash(action),
    approvals: approvers,
    approvedAt: new Date().toISOString(),
    executedBy: operator.label,
  });
  const secret = settings.remediationWebhookSecretEncrypted ? decrypt(settings.remediationWebhookSecretEncrypted) : null;
  let target: Awaited<ReturnType<typeof assertSafeOutboundUrl>>;
  try {
    // Re-validated at call time: the host may resolve differently than when it was saved.
    target = await assertSafeOutboundUrl(settings.remediationWebhookUrl);
  } catch (err) {
    return { mode: 'webhook', success: false, outcome: 'not_applied', summary: `Nothing was sent: the remediation webhook address was refused (${(err as Error).message}).` };
  }
  try {
    const res = await fetch(target, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'user-agent': 'opspilot', 'idempotency-key': action.id, 'x-opspilot-attempt': String(action.attempts), ...(secret ? { 'x-opspilot-signature': `sha256=${hmacSha256Hex(secret, body)}` } : {}) },
      body,
      signal: AbortSignal.timeout(env.REMEDIATION_WEBHOOK_TIMEOUT_MS),
    });
    // The response body is deliberately not stored: it would let a webhook owner read
    // whatever the server can reach.
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return { mode: 'webhook', success: true, outcome: 'applied', summary: `Dispatched to remediation webhook (HTTP ${res.status}).`, detail: { status: res.status } };
    // A 4xx is a refusal. A 5xx may have failed half-way through.
    const refused = res.status >= 400 && res.status < 500;
    return {
      mode: 'webhook',
      success: false,
      outcome: refused ? 'not_applied' : 'unknown',
      summary: refused ? `Remediation webhook rejected the request (HTTP ${res.status}). Nothing was applied.` : `Remediation webhook failed (HTTP ${res.status}). Whether the change was applied is unknown: check the target system before retrying.`,
      detail: { status: res.status },
    };
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
    return {
      mode: 'webhook',
      success: false,
      outcome: 'unknown',
      summary: timedOut
        ? `The remediation webhook did not answer within ${env.REMEDIATION_WEBHOOK_TIMEOUT_MS / 1000} seconds. The request was sent; whether the change was applied is unknown. Check the target system before retrying.`
        : `The connection to the remediation webhook failed (${(err as Error).message}). Whether the change was applied is unknown: check the target system before retrying.`,
    };
  }
}

import type { Prisma, RemediationAction, RiskLevel } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { env } from '../config/env';
import { type ActionEffect, actionEffect, runbookPlan } from '../lib/actionEffect';
import { audit } from '../lib/audit';
import { decrypt, hmacSha256Hex } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { csvEnum, paged, paginate, paginationQuery, param } from '../lib/http';
import { assertSafeOutboundUrl } from '../lib/netguard';
import { notifyRoles, notifyUsers } from '../lib/notify';
import { prisma } from '../lib/prisma';
import { authOf, can, requirePermission, requireUser, userOf } from '../middleware/auth';
import { addIncidentEvent } from './incidents';
import { getSettings } from './organization';

/**
 * Remediation lifecycle:
 *   PROPOSED → PENDING_APPROVAL → APPROVED → EXECUTING → EXECUTED | FAILED
 *                              ↘ REJECTED            (CANCELLED from any pre-execution state)
 * Nothing here can be triggered by the AI agent: it may only create PROPOSED actions.
 * Approval and execution are restricted to signed-in humans (requireUser).
 *
 * Effect. Every action is read_only or state_changing, decided from its type and its text
 * (lib/actionEffect.ts), never from what the proposer says.
 *   read_only       a diagnostic. Needs no approval; a human records that it was done. It is
 *                   never sent to the webhook, so a misjudged text cannot change anything.
 *   state_changing  needs at least one approval, whatever the organisation's settings say.
 *
 * Binding. An approval is given for exact content: a hash of type, title, description, risk,
 * service and parameters. Editing an action supersedes its approvals and returns it to PROPOSED.
 * Execution recomputes the hash and counts only approvals given for that hash.
 *
 * Outcome. A webhook that times out or fails mid-flight leaves the outcome UNKNOWN, and the
 * record says so. Such an action can be retried only after a human confirms the change was not
 * applied; the idempotency key stays the same across attempts so a receiver can refuse a repeat.
 */

export const REMEDIATION_TYPES = ['rollback_deployment', 'restart_service', 'scale_service', 'toggle_feature_flag', 'config_change', 'run_runbook', 'manual'] as const;

export const remediationInput = z.object({
  type: z.enum(REMEDIATION_TYPES),
  title: z.string().trim().min(4).max(200),
  description: z.string().trim().min(4).max(5000),
  rationale: z.string().trim().max(5000).nullable().optional(),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  incidentId: z.string().nullable().optional(),
  investigationId: z.string().nullable().optional(),
  serviceId: z.string().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

type Content = Pick<RemediationAction, 'type' | 'title' | 'description' | 'risk' | 'serviceId'> & { parameters?: unknown };

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

/** Effect of an action, reading the runbook it points at (parameters.runbookDocumentId) when there is one. */
async function effectOf(organizationId: string, a: { type: string; title: string; description: string; parameters?: unknown }): Promise<{ effect: ActionEffect; reasons: string[] }> {
  const id = (a.parameters as Record<string, unknown> | null | undefined)?.runbookDocumentId;
  let steps: string[] = [];
  if (typeof id === 'string') {
    const doc = await prisma.knowledgeDocument.findFirst({ where: { id, organizationId }, select: { content: true } });
    if (!doc) throw badRequest('The runbook document does not exist');
    const plan = runbookPlan(doc.content);
    // A runbook nobody can itemise is not shown to be harmless.
    if (!plan.steps.length) return { effect: 'state_changing', reasons: ['the runbook has no recognisable steps, so its effect cannot be told'] };
    steps = plan.steps.map((s) => s.text);
  }
  return actionEffect(a.type, a.title, a.description, steps);
}

async function serviceNames(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const rows = unique.length ? await prisma.service.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, slug: true } }) : [];
  return new Map(rows.map((r) => [r.id, r]));
}

async function userNames(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const rows = unique.length ? await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
  return new Map(rows.map((r) => [r.id, r.name]));
}

const detailInclude = {
  approvals: { orderBy: { createdAt: 'asc' } },
  incident: { select: { id: true, number: true, title: true, severity: true, status: true } },
  investigation: { select: { id: true, question: true, summary: true } },
} satisfies Prisma.RemediationActionInclude;

type Detailed = Prisma.RemediationActionGetPayload<{ include: typeof detailInclude }>;

async function presentMany(rows: Detailed[]) {
  const [services, users] = await Promise.all([
    serviceNames(rows.map((r) => r.serviceId)),
    userNames(rows.flatMap((r) => [r.proposedById, r.requestedById, r.executedById, ...r.approvals.map((a) => a.approverId)])),
  ]);
  const person = (id: string | null) => (id ? { id, name: users.get(id) ?? 'Unknown user' } : null);
  return rows.map((r) => ({
    ...r,
    service: r.serviceId ? (services.get(r.serviceId) ?? null) : null,
    proposedBy: r.proposedByType === 'ai_agent' ? { id: null, name: 'OPSILUME AI' } : person(r.proposedById),
    requestedBy: person(r.requestedById),
    executedBy: person(r.executedById),
    // An approval counts only for the content it was given for.
    approvals: r.approvals.map((a) => ({ ...a, approver: person(a.approverId), counts: countsFor(r, a) })),
    approvalsGranted: r.approvals.filter((a) => countsFor(r, a)).length,
    currentHash: contentHash(r),
  }));
}

function countsFor(action: Content, approval: { decision: string; contentHash: string | null; supersededAt: Date | null }) {
  return approval.decision === 'approved' && !approval.supersededAt && approval.contentHash === contentHash(action);
}

async function load(organizationId: string, id: string) {
  const action = await prisma.remediationAction.findFirst({ where: { id, organizationId }, include: detailInclude });
  if (!action) throw notFound('Remediation action');
  return action;
}

const RISK_ORDER: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

/**
 * The proposer (a person or the AI) suggests a risk level, and that level decides how many
 * approvals are needed. This sets a floor they cannot go below: anything that changes what is
 * deployed or configured is at least MEDIUM, and so is any action on a tier-1 service.
 */
export async function effectiveRisk(organizationId: string, type: string, declared: RiskLevel, serviceId?: string | null, effect: ActionEffect = 'state_changing'): Promise<RiskLevel> {
  // A runbook or manual step that changes state is a change like any other.
  let floor: RiskLevel = ['rollback_deployment', 'config_change', 'scale_service', 'toggle_feature_flag'].includes(type) || (effect === 'state_changing' && ['run_runbook', 'manual', 'restart_service'].includes(type)) ? 'MEDIUM' : 'LOW';
  if (serviceId) {
    const service = await prisma.service.findFirst({ where: { id: serviceId, organizationId }, select: { tier: true } });
    if (service?.tier === 'TIER1') floor = 'MEDIUM';
  }
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(declared), RISK_ORDER.indexOf(floor))]!;
}

function requiredApprovals(settings: Awaited<ReturnType<typeof getSettings>>, risk: RiskLevel, effect: ActionEffect) {
  if (effect === 'read_only') return 0;
  // Never fewer than one for something that changes state, whatever the settings say.
  return Math.max(1, risk === 'HIGH' ? settings.approvalsHighRisk : risk === 'MEDIUM' ? settings.approvalsMediumRisk : settings.approvalsLowRisk);
}

/** Used by users (HTTP) and by the investigation pipeline (AI proposals). */
export async function proposeRemediation(
  organizationId: string,
  input: z.infer<typeof remediationInput>,
  proposer: { type: 'user'; userId: string; label: string } | { type: 'ai_agent'; label: string },
) {
  if (input.incidentId && !(await prisma.incident.findFirst({ where: { id: input.incidentId, organizationId }, select: { id: true } }))) throw badRequest('Incident does not exist');
  if (input.serviceId && !(await prisma.service.findFirst({ where: { id: input.serviceId, organizationId }, select: { id: true } }))) throw badRequest('Service does not exist');
  if (input.investigationId && !(await prisma.investigation.findFirst({ where: { id: input.investigationId, organizationId }, select: { id: true } }))) throw badRequest('Investigation does not exist');
  const settings = await getSettings(organizationId);
  const { effect, reasons } = await effectOf(organizationId, input);
  const risk = await effectiveRisk(organizationId, input.type, input.risk, input.serviceId, effect);
  const action = await prisma.remediationAction.create({
    data: {
      ...input,
      risk,
      effect,
      effectReasons: reasons,
      parameters: input.parameters as Prisma.InputJsonValue | undefined,
      organizationId,
      proposedByType: proposer.type,
      proposedById: proposer.type === 'user' ? proposer.userId : null,
      requiredApprovals: requiredApprovals(settings, risk, effect),
    },
  });
  if (action.incidentId) {
    await addIncidentEvent(action.incidentId, 'remediation', `Remediation proposed: ${action.title}`, proposer.type === 'user' ? { kind: 'user', actorId: proposer.userId, label: proposer.label } : { kind: 'ai_agent', label: proposer.label }, { actionId: action.id, risk: action.risk });
  }
  return action;
}

// ───────────────────────── Execution ─────────────────────────

interface ExecutionResult {
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
async function execute(action: RemediationAction, operator: { userId: string; label: string }, approvers: { approverId: string; approvedAt: Date }[], manualNotes?: string): Promise<ExecutionResult> {
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

/** Mirrors an executed action onto the service's history so later investigations can see it. */
async function recordEffects(action: RemediationAction, operator: { label: string }, result: ExecutionResult) {
  if (!action.serviceId) return;
  const params = (action.parameters ?? {}) as Record<string, unknown>;
  const via = result.mode === 'webhook' ? 'via remediation webhook' : 'manually';
  if (action.type === 'rollback_deployment') {
    const target = typeof params.deploymentId === 'string' ? await prisma.deployment.findFirst({ where: { id: params.deploymentId, organizationId: action.organizationId } }) : null;
    const toVersion = typeof params.toVersion === 'string' ? params.toVersion : null;
    if (target || toVersion) {
      await prisma.deployment.create({
        data: {
          organizationId: action.organizationId,
          serviceId: action.serviceId,
          version: toVersion ?? `rollback-of-${target!.version}`,
          environment: target?.environment ?? 'production',
          status: 'SUCCEEDED',
          isRollback: true,
          rollbackOfId: target?.id,
          deployedBy: operator.label,
          description: `Rollback executed ${via} from remediation "${action.title}"`,
          source: 'remediation',
          finishedAt: new Date(),
        },
      });
      if (target) await prisma.deployment.update({ where: { id: target.id }, data: { status: 'ROLLED_BACK' } });
      return;
    }
  }
  const typeMap: Record<string, string> = { restart_service: 'restart', scale_service: 'scaling', toggle_feature_flag: 'feature_flag', config_change: 'config_change', rollback_deployment: 'other', run_runbook: 'other', manual: 'other' };
  await prisma.serviceEvent.create({
    data: {
      organizationId: action.organizationId,
      serviceId: action.serviceId,
      type: typeMap[action.type] ?? 'other',
      title: `Remediation executed: ${action.title}`,
      details: `Executed ${via} by ${operator.label}.`,
      source: 'remediation',
      actor: operator.label,
      metadata: { actionId: action.id, parameters: params } as Prisma.InputJsonValue,
    },
  });
}

// ───────────────────────── Routes ─────────────────────────

export const remediationRouter = Router();

remediationRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = paginationQuery.extend({ status: csvEnum(['PROPOSED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'EXECUTED', 'FAILED', 'CANCELLED']), incidentId: z.string().optional(), investigationId: z.string().optional() }).parse(req.query);
  const where: Prisma.RemediationActionWhereInput = {
    organizationId,
    ...(q.status ? { status: { in: q.status } } : {}),
    ...(q.incidentId ? { incidentId: q.incidentId } : {}),
    ...(q.investigationId ? { investigationId: q.investigationId } : {}),
  };
  const [rows, total, counts, settings] = await Promise.all([
    prisma.remediationAction.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q), include: detailInclude }),
    prisma.remediationAction.count({ where }),
    prisma.remediationAction.groupBy({ by: ['status'], where: { organizationId }, _count: true }),
    getSettings(organizationId),
  ]);
  res.json({
    ...paged(await presentMany(rows), total, q),
    statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    executionMode: settings.remediationWebhookUrl ? 'webhook' : 'manual',
  });
});

remediationRouter.post('/', requirePermission('remediation:propose'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const action = await proposeRemediation(auth.organizationId, remediationInput.parse(req.body), { type: 'user', userId: auth.userId, label: auth.label });
  await audit(req, 'remediation.propose', 'remediation_action', action.id, { title: action.title, type: action.type, risk: action.risk });
  res.status(201).json((await presentMany([await load(auth.organizationId, action.id)]))[0]);
});

remediationRouter.get('/:id', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const [view] = await presentMany([await load(organizationId, param(req.params.id))]);
  const settings = await getSettings(organizationId);
  res.json({ ...view, executionMode: settings.remediationWebhookUrl ? 'webhook' : 'manual', allowSelfApproval: settings.allowSelfApproval });
});

remediationRouter.post('/:id/request-approval', requirePermission('remediation:propose'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const action = await load(auth.organizationId, param(req.params.id));
  if (action.status !== 'PROPOSED') throw conflict(`Only proposed actions can be submitted for approval (current status: ${action.status})`);
  if (action.effect === 'read_only') throw conflict('This is a read-only diagnostic: it needs no approval. Carry it out and record the result.');
  const settings = await getSettings(auth.organizationId);
  const hash = contentHash(action);
  // Atomic status guard: a concurrent request cannot submit the same action twice.
  const updated = await prisma.remediationAction.updateMany({
    where: { id: action.id, status: 'PROPOSED' },
    data: { status: 'PENDING_APPROVAL', requestedById: auth.userId, requestedAt: new Date(), requiredApprovals: requiredApprovals(settings, action.risk, 'state_changing'), contentHash: hash },
  });
  if (!updated.count) throw conflict('This action was already submitted');
  await audit(req, 'remediation.request_approval', 'remediation_action', action.id, { risk: action.risk, contentHash: hash });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `Approval requested for: ${action.title}`, auth, { actionId: action.id });
  await notifyRoles(action.risk === 'HIGH' ? ['OWNER', 'ADMIN'] : ['OWNER', 'ADMIN', 'ENGINEER'], { organizationId: auth.organizationId, type: 'remediation.approval_requested', title: `Approval needed: ${action.title}`, body: `${auth.label} requested approval for a ${action.risk.toLowerCase()}-risk action.`, link: `/remediation/${action.id}` }, auth.userId);
  res.json((await presentMany([await load(auth.organizationId, action.id)]))[0]);
});

// expectedHash is the currentHash the approver was shown. Sending it makes the approval fail if
// the action changed between reading it and deciding.
const decisionBody = z.object({ comment: z.string().trim().max(2000).optional(), expectedHash: z.string().length(64).optional() });

remediationRouter.post('/:id/approve', requirePermission('remediation:approve'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const { comment, expectedHash } = decisionBody.parse(req.body ?? {});
  const action = await load(auth.organizationId, param(req.params.id));
  if (action.status !== 'PENDING_APPROVAL') throw conflict(`This action is not awaiting approval (current status: ${action.status})`);
  const hash = contentHash(action);
  if (hash !== action.contentHash || (expectedHash && expectedHash !== hash)) throw conflict('This action changed after it was submitted or after you opened it. Reload it and review what you are approving.');
  if (action.risk === 'HIGH' && !can(auth, 'remediation:approve:high')) throw forbidden('High-risk actions must be approved by an admin or owner');
  const settings = await getSettings(auth.organizationId);
  if (!settings.allowSelfApproval && (action.requestedById === auth.userId || action.proposedById === auth.userId)) {
    throw forbidden('You cannot approve an action that you proposed or requested');
  }
  if (action.approvals.some((a) => a.approverId === auth.userId && !a.supersededAt)) throw conflict('You have already recorded a decision on this action');
  const result = await prisma.$transaction(async (tx) => {
    await tx.approval.create({ data: { actionId: action.id, approverId: auth.userId, decision: 'approved', comment, contentHash: hash } });
    const granted = await tx.approval.count({ where: { actionId: action.id, decision: 'approved', supersededAt: null, contentHash: hash } });
    if (granted >= action.requiredApprovals) {
      // Only while the content is still what was approved.
      await tx.remediationAction.updateMany({ where: { id: action.id, status: 'PENDING_APPROVAL', contentHash: hash }, data: { status: 'APPROVED' } });
    }
    return { granted, approved: granted >= action.requiredApprovals };
  });
  await audit(req, 'remediation.approve', 'remediation_action', action.id, { granted: result.granted, required: action.requiredApprovals, comment, contentHash: hash });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `${auth.label} approved: ${action.title} (${result.granted}/${action.requiredApprovals})`, auth, { actionId: action.id });
  if (result.approved) {
    await notifyUsers([action.requestedById], { organizationId: auth.organizationId, type: 'remediation.approved', title: `Approved: ${action.title}`, body: 'The action can now be executed.', link: `/remediation/${action.id}` });
  }
  res.json((await presentMany([await load(auth.organizationId, action.id)]))[0]);
});

remediationRouter.post('/:id/reject', requirePermission('remediation:approve'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const { comment } = decisionBody.extend({ comment: z.string().trim().min(3, 'Give a reason for rejecting').max(2000) }).parse(req.body ?? {});
  const action = await load(auth.organizationId, param(req.params.id));
  if (action.status !== 'PENDING_APPROVAL') throw conflict(`This action is not awaiting approval (current status: ${action.status})`);
  if (action.approvals.some((a) => a.approverId === auth.userId && !a.supersededAt)) throw conflict('You have already recorded a decision on this action');
  await prisma.$transaction([
    prisma.approval.create({ data: { actionId: action.id, approverId: auth.userId, decision: 'rejected', comment, contentHash: contentHash(action) } }),
    prisma.remediationAction.updateMany({ where: { id: action.id, status: 'PENDING_APPROVAL' }, data: { status: 'REJECTED' } }),
  ]);
  await audit(req, 'remediation.reject', 'remediation_action', action.id, { comment });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `${auth.label} rejected: ${action.title} — ${comment}`, auth, { actionId: action.id });
  await notifyUsers([action.requestedById], { organizationId: auth.organizationId, type: 'remediation.rejected', title: `Rejected: ${action.title}`, body: comment, link: `/remediation/${action.id}` });
  res.json((await presentMany([await load(auth.organizationId, action.id)]))[0]);
});

remediationRouter.post('/:id/execute', requirePermission('remediation:execute'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const body = z.object({ confirmManual: z.boolean().optional(), notes: z.string().trim().max(2000).optional() }).parse(req.body ?? {});
  const action = await load(auth.organizationId, param(req.params.id));
  const readOnly = action.effect === 'read_only';
  const hash = contentHash(action);
  // The effect is recomputed, not trusted from the row: text that now reads as state-changing is treated as such.
  const current = await effectOf(auth.organizationId, action);
  if (readOnly && current.effect !== 'read_only') {
    await prisma.remediationAction.update({ where: { id: action.id }, data: { effect: 'state_changing', effectReasons: current.reasons, requiredApprovals: Math.max(1, action.requiredApprovals) } });
    throw conflict('This action is no longer a read-only diagnostic and now needs approval.');
  }
  const settings = await getSettings(auth.organizationId);
  let approvers: { approverId: string; approvedAt: Date }[] = [];
  if (readOnly) {
    if (!['PROPOSED', 'APPROVED'].includes(action.status)) throw conflict(`This diagnostic cannot be recorded now (current status: ${action.status})`);
    if (!body.confirmManual) throw badRequest('A read-only diagnostic is carried out by a person. Do it, then confirm with confirmManual: true and your findings in notes.');
  } else {
    if (action.status !== 'APPROVED') throw conflict(`Only approved actions can be executed (current status: ${action.status})`);
    const valid = action.approvals.filter((a) => countsFor(action, a));
    if (hash !== action.contentHash || valid.length < Math.max(1, action.requiredApprovals)) {
      // The action is not what was approved. Its approvals no longer count and it starts again.
      await prisma.$transaction([
        prisma.approval.updateMany({ where: { actionId: action.id, supersededAt: null }, data: { supersededAt: new Date() } }),
        prisma.remediationAction.updateMany({ where: { id: action.id, status: 'APPROVED' }, data: { status: 'PROPOSED', contentHash: null } }),
      ]);
      await audit(req, 'remediation.approval_invalid', 'remediation_action', action.id, { approvedHash: action.contentHash, currentHash: hash, validApprovals: valid.length, required: action.requiredApprovals });
      throw conflict('This action is not the one that was approved: its content changed afterwards. The approvals no longer count; submit it for approval again.');
    }
    approvers = valid.map((a) => ({ approverId: a.approverId, approvedAt: a.createdAt }));
    if (!settings.remediationWebhookUrl && !body.confirmManual) {
      throw badRequest('No remediation webhook is configured. Carry out the action yourself, then confirm with confirmManual: true.');
    }
  }
  // Claim the action atomically so it cannot be executed twice, and only with the content that was checked.
  const claimed = await prisma.remediationAction.updateMany({
    where: { id: action.id, status: action.status, ...(readOnly ? {} : { contentHash: hash }) },
    data: { status: 'EXECUTING', executedById: auth.userId, attempts: { increment: 1 } },
  });
  if (!claimed.count) throw conflict('This action is already being executed');
  const mode = readOnly ? 'diagnostic' : settings.remediationWebhookUrl ? 'webhook' : 'manual';
  await audit(req, 'remediation.execute_start', 'remediation_action', action.id, { mode, effect: action.effect, contentHash: hash, attempt: action.attempts + 1, approvedBy: approvers.map((a) => a.approverId) });

  const startedAt = new Date();
  const result = await execute({ ...action, attempts: action.attempts + 1 }, { userId: auth.userId, label: auth.label }, approvers, body.notes);
  const record = { ...result, contentHash: hash, attempt: action.attempts + 1, approvedBy: approvers, startedAt, finishedAt: new Date() };
  await prisma.remediationAction.update({
    where: { id: action.id },
    data: { status: result.success ? 'EXECUTED' : 'FAILED', executedAt: new Date(), executionResult: record as unknown as Prisma.InputJsonValue },
  });
  if (result.success && !readOnly) await recordEffects(action, auth, result);
  await audit(req, result.success ? 'remediation.execute_success' : 'remediation.execute_failure', 'remediation_action', action.id, { mode: result.mode, outcome: result.outcome, summary: result.summary, contentHash: hash });
  if (action.incidentId) {
    const what = result.success ? (readOnly ? 'Diagnostic recorded' : 'Remediation executed') : result.outcome === 'unknown' ? 'Remediation outcome unknown' : 'Remediation failed';
    await addIncidentEvent(action.incidentId, 'remediation', `${what}: ${action.title} — ${result.summary}`, auth, { actionId: action.id, mode: result.mode, outcome: result.outcome });
  }
  res.json((await presentMany([await load(auth.organizationId, action.id)]))[0]);
});

const editBody = remediationInput.pick({ title: true, description: true, rationale: true, risk: true, serviceId: true, parameters: true }).partial();

/**
 * Editing is allowed until execution starts. Any change to what an approver was shown supersedes
 * every approval and returns the action to PROPOSED: an approval never carries over to different content.
 */
remediationRouter.patch('/:id', requirePermission('remediation:propose'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const patch = editBody.parse(req.body ?? {});
  const action = await load(auth.organizationId, param(req.params.id));
  if (!['PROPOSED', 'PENDING_APPROVAL', 'APPROVED'].includes(action.status)) throw conflict(`This action can no longer be edited (current status: ${action.status})`);
  if (patch.serviceId && !(await prisma.service.findFirst({ where: { id: patch.serviceId, organizationId: auth.organizationId }, select: { id: true } }))) throw badRequest('Service does not exist');
  const next = { ...action, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as RemediationAction;
  const { effect, reasons } = await effectOf(auth.organizationId, next);
  next.risk = await effectiveRisk(auth.organizationId, next.type, next.risk, next.serviceId, effect);
  const before = contentHash(action);
  const after = contentHash(next);
  const changed = before !== after;
  const settings = await getSettings(auth.organizationId);
  const superseded = changed ? action.approvals.filter((a) => !a.supersededAt).length : 0;
  const updated = await prisma.$transaction(async (tx) => {
    if (changed) await tx.approval.updateMany({ where: { actionId: action.id, supersededAt: null }, data: { supersededAt: new Date() } });
    return tx.remediationAction.updateMany({
      where: { id: action.id, status: action.status },
      data: {
        title: next.title, description: next.description, rationale: next.rationale, risk: next.risk, serviceId: next.serviceId,
        parameters: (next.parameters ?? undefined) as Prisma.InputJsonValue | undefined,
        effect, effectReasons: reasons, requiredApprovals: requiredApprovals(settings, next.risk, effect),
        ...(changed ? { status: 'PROPOSED' as const, contentHash: null, requestedById: null, requestedAt: null } : {}),
      },
    });
  });
  if (!updated.count) throw conflict('This action changed state; reload and try again');
  await audit(req, 'remediation.edit', 'remediation_action', action.id, { fields: Object.keys(patch), previousHash: before, newHash: after, supersededApprovals: superseded, previousStatus: action.status });
  if (changed && action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `Remediation edited: ${next.title}${superseded ? ` (${superseded} approval(s) no longer count)` : ''}`, auth, { actionId: action.id });
  res.json((await presentMany([await load(auth.organizationId, action.id)]))[0]);
});

/**
 * A failed execution can be sent back for another attempt. The approvals still have to match the
 * content when it is executed again. If the last attempt's outcome is unknown (timeout, dropped
 * connection, server error), a human must first confirm that the change was NOT applied:
 * otherwise a retry could apply it a second time.
 */
remediationRouter.post('/:id/retry', requirePermission('remediation:execute'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const body = z.object({ confirmNotApplied: z.boolean().optional() }).parse(req.body ?? {});
  const action = await load(auth.organizationId, param(req.params.id));
  if (action.status !== 'FAILED') throw conflict('Only failed actions can be retried');
  const last = (action.executionResult ?? {}) as { outcome?: string };
  const uncertain = last.outcome !== 'not_applied';
  if (uncertain && !body.confirmNotApplied) {
    throw conflict('The outcome of the last attempt is unknown: the change may have been applied. Check the target system, then retry with confirmNotApplied: true.');
  }
  const updated = await prisma.remediationAction.updateMany({ where: { id: action.id, organizationId: auth.organizationId, status: 'FAILED' }, data: { status: 'APPROVED' } });
  if (!updated.count) throw conflict('Only failed actions can be retried');
  await audit(req, 'remediation.retry', 'remediation_action', action.id, { previousOutcome: last.outcome ?? 'unknown', confirmedNotApplied: uncertain ? true : undefined, attempt: action.attempts });
  res.json((await presentMany([await load(auth.organizationId, param(req.params.id))]))[0]);
});

remediationRouter.post('/:id/cancel', requirePermission('remediation:propose'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const action = await load(auth.organizationId, param(req.params.id));
  if (!['PROPOSED', 'PENDING_APPROVAL', 'APPROVED'].includes(action.status)) throw conflict(`This action can no longer be cancelled (current status: ${action.status})`);
  const updated = await prisma.remediationAction.updateMany({ where: { id: action.id, status: action.status }, data: { status: 'CANCELLED' } });
  if (!updated.count) throw conflict('This action changed state; reload and try again');
  await audit(req, 'remediation.cancel', 'remediation_action', action.id);
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `Remediation cancelled: ${action.title}`, auth, { actionId: action.id });
  res.json((await presentMany([await load(auth.organizationId, action.id)]))[0]);
});

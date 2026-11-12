import type { Prisma, RemediationAction, RiskLevel } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { decrypt, hmacSha256Hex } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { csv, paged, paginate, paginationQuery, param } from '../lib/http';
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
  parameters: z.record(z.unknown()).optional(),
});

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
    proposedBy: r.proposedByType === 'ai_agent' ? { id: null, name: 'OpsPilot AI' } : person(r.proposedById),
    requestedBy: person(r.requestedById),
    executedBy: person(r.executedById),
    approvals: r.approvals.map((a) => ({ ...a, approver: person(a.approverId) })),
    approvalsGranted: r.approvals.filter((a) => a.decision === 'approved').length,
  }));
}

async function load(organizationId: string, id: string) {
  const action = await prisma.remediationAction.findFirst({ where: { id, organizationId }, include: detailInclude });
  if (!action) throw notFound('Remediation action');
  return action;
}

function requiredApprovals(settings: Awaited<ReturnType<typeof getSettings>>, risk: RiskLevel) {
  return risk === 'HIGH' ? settings.approvalsHighRisk : risk === 'MEDIUM' ? settings.approvalsMediumRisk : settings.approvalsLowRisk;
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
  const action = await prisma.remediationAction.create({
    data: {
      ...input,
      parameters: input.parameters as Prisma.InputJsonValue | undefined,
      organizationId,
      proposedByType: proposer.type,
      proposedById: proposer.type === 'user' ? proposer.userId : null,
      requiredApprovals: requiredApprovals(settings, input.risk),
    },
  });
  if (action.incidentId) {
    await addIncidentEvent(action.incidentId, 'remediation', `Remediation proposed: ${action.title}`, proposer.type === 'user' ? { kind: 'user', actorId: proposer.userId, label: proposer.label } : { kind: 'ai_agent', label: proposer.label }, { actionId: action.id, risk: action.risk });
  }
  return action;
}

// ───────────────────────── Execution ─────────────────────────

interface ExecutionResult {
  mode: 'webhook' | 'manual';
  success: boolean;
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
async function execute(action: RemediationAction, operator: { userId: string; label: string }, manualNotes?: string): Promise<ExecutionResult> {
  const settings = await getSettings(action.organizationId);
  if (!settings.remediationWebhookUrl) {
    return { mode: 'manual', success: true, summary: `Carried out manually and attested by ${operator.label}. OpsPilot did not change any external system.`, detail: manualNotes ? { notes: manualNotes } : undefined };
  }
  const body = JSON.stringify({
    event: 'remediation.execute',
    actionId: action.id,
    type: action.type,
    title: action.title,
    serviceId: action.serviceId,
    incidentId: action.incidentId,
    parameters: action.parameters,
    approvedAt: new Date().toISOString(),
    executedBy: operator.label,
  });
  const secret = settings.remediationWebhookSecretEncrypted ? decrypt(settings.remediationWebhookSecretEncrypted) : null;
  try {
    const res = await fetch(settings.remediationWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'opspilot', ...(secret ? { 'x-opspilot-signature': `sha256=${hmacSha256Hex(secret, body)}` } : {}) },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = (await res.text().catch(() => '')).slice(0, 2000);
    return {
      mode: 'webhook',
      success: res.ok,
      summary: res.ok ? `Dispatched to remediation webhook (HTTP ${res.status}).` : `Remediation webhook rejected the request (HTTP ${res.status}).`,
      detail: { status: res.status, response: text },
    };
  } catch (err) {
    return { mode: 'webhook', success: false, summary: `Remediation webhook could not be reached: ${(err as Error).message}` };
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
  const q = paginationQuery.extend({ status: csv, incidentId: z.string().optional(), investigationId: z.string().optional() }).parse(req.query);
  const where: Prisma.RemediationActionWhereInput = {
    organizationId,
    ...(q.status ? { status: { in: q.status as never } } : {}),
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
  const settings = await getSettings(auth.organizationId);
  // Atomic status guard: a concurrent request cannot submit the same action twice.
  const updated = await prisma.remediationAction.updateMany({
    where: { id: action.id, status: 'PROPOSED' },
    data: { status: 'PENDING_APPROVAL', requestedById: auth.userId, requestedAt: new Date(), requiredApprovals: requiredApprovals(settings, action.risk) },
  });
  if (!updated.count) throw conflict('This action was already submitted');
  await audit(req, 'remediation.request_approval', 'remediation_action', action.id, { risk: action.risk });
  if (action.incidentId) await addIncidentEvent(action.incidentId, 'remediation', `Approval requested for: ${action.title}`, auth, { actionId: action.id });
  await notifyRoles(action.risk === 'HIGH' ? ['OWNER', 'ADMIN'] : ['OWNER', 'ADMIN', 'ENGINEER'], { organizationId: auth.organizationId, type: 'remediation.approval_requested', title: `Approval needed: ${action.title}`, body: `${auth.label} requested approval for a ${action.risk.toLowerCase()}-risk action.`, link: `/remediation/${action.id}` }, auth.userId);
  res.json((await presentMany([await load(auth.organizationId, action.id)]))[0]);
});

const decisionBody = z.object({ comment: z.string().trim().max(2000).optional() });

remediationRouter.post('/:id/approve', requirePermission('remediation:approve'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const { comment } = decisionBody.parse(req.body ?? {});
  const action = await load(auth.organizationId, param(req.params.id));
  if (action.status !== 'PENDING_APPROVAL') throw conflict(`This action is not awaiting approval (current status: ${action.status})`);
  if (action.risk === 'HIGH' && !can(auth, 'remediation:approve:high')) throw forbidden('High-risk actions must be approved by an admin or owner');
  const settings = await getSettings(auth.organizationId);
  if (!settings.allowSelfApproval && (action.requestedById === auth.userId || action.proposedById === auth.userId)) {
    throw forbidden('You cannot approve an action that you proposed or requested');
  }
  if (action.approvals.some((a) => a.approverId === auth.userId)) throw conflict('You have already recorded a decision on this action');
  const result = await prisma.$transaction(async (tx) => {
    await tx.approval.create({ data: { actionId: action.id, approverId: auth.userId, decision: 'approved', comment } });
    const granted = await tx.approval.count({ where: { actionId: action.id, decision: 'approved' } });
    if (granted >= action.requiredApprovals) {
      await tx.remediationAction.updateMany({ where: { id: action.id, status: 'PENDING_APPROVAL' }, data: { status: 'APPROVED' } });
    }
    return { granted, approved: granted >= action.requiredApprovals };
  });
  await audit(req, 'remediation.approve', 'remediation_action', action.id, { granted: result.granted, required: action.requiredApprovals, comment });
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
  if (action.approvals.some((a) => a.approverId === auth.userId)) throw conflict('You have already recorded a decision on this action');
  await prisma.$transaction([
    prisma.approval.create({ data: { actionId: action.id, approverId: auth.userId, decision: 'rejected', comment } }),
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
  if (action.status !== 'APPROVED') throw conflict(`Only approved actions can be executed (current status: ${action.status})`);
  const settings = await getSettings(auth.organizationId);
  if (!settings.remediationWebhookUrl && !body.confirmManual) {
    throw badRequest('No remediation webhook is configured. Carry out the action yourself, then confirm with confirmManual: true.');
  }
  // Claim the action atomically so it cannot be executed twice.
  const claimed = await prisma.remediationAction.updateMany({ where: { id: action.id, status: 'APPROVED' }, data: { status: 'EXECUTING', executedById: auth.userId } });
  if (!claimed.count) throw conflict('This action is already being executed');
  await audit(req, 'remediation.execute_start', 'remediation_action', action.id, { mode: settings.remediationWebhookUrl ? 'webhook' : 'manual' });

  const result = await execute(action, { userId: auth.userId, label: auth.label }, body.notes);
  await prisma.remediationAction.update({
    where: { id: action.id },
    data: { status: result.success ? 'EXECUTED' : 'FAILED', executedAt: new Date(), executionResult: result as unknown as Prisma.InputJsonValue },
  });
  if (result.success) await recordEffects(action, auth, result);
  await audit(req, result.success ? 'remediation.execute_success' : 'remediation.execute_failure', 'remediation_action', action.id, { mode: result.mode, summary: result.summary });
  if (action.incidentId) {
    await addIncidentEvent(action.incidentId, 'remediation', `${result.success ? 'Remediation executed' : 'Remediation failed'}: ${action.title} — ${result.summary}`, auth, { actionId: action.id, mode: result.mode });
  }
  res.json((await presentMany([await load(auth.organizationId, action.id)]))[0]);
});

/** A failed execution can be sent back for another attempt without a new approval round. */
remediationRouter.post('/:id/retry', requirePermission('remediation:execute'), requireUser, async (req, res) => {
  const auth = userOf(req);
  const updated = await prisma.remediationAction.updateMany({ where: { id: param(req.params.id), organizationId: auth.organizationId, status: 'FAILED' }, data: { status: 'APPROVED' } });
  if (!updated.count) throw conflict('Only failed actions can be retried');
  await audit(req, 'remediation.retry', 'remediation_action', param(req.params.id));
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

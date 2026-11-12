import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { type InvestigationEvent, type InvestigationUsage, aiService } from '../integrations/aiService';
import { actionEffect } from '../lib/actionEffect';
import { audit, writeAudit } from '../lib/audit';
import { AppError, conflict, notFound } from '../lib/errors';
import { csvEnum, paged, paginate, paginationQuery, param } from '../lib/http';
import { logger } from '../lib/logger';
import { investigationsTotal } from '../lib/metrics';
import { notifyUsers } from '../lib/notify';
import { prisma } from '../lib/prisma';
import { authOf, can, requirePermission, signToolToken } from '../middleware/auth';
import { enqueue, registerProcessor } from '../queues';
import { addIncidentEvent, incidentKey, requireIncident } from './incidents';
import { REMEDIATION_TYPES, proposeRemediation } from './remediation';

// ───────────────────────── Report contract (mirrors services/ai/app/schemas.py) ─────────────────────────

const refs = z.array(z.string()).default([]);

const hypothesisSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(4000),
  confidence: z.number().min(0).max(1),
  status: z.enum(['likely', 'possible', 'unlikely']).default('possible'),
  evidenceRefs: refs,
  contradictingEvidenceRefs: refs,
  contradictions: z.array(z.string()).default([]),
  facts: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
});

const claimStatus = z.enum(['exact', 'rounded', 'calculated', 'estimate', 'uncited', 'unsupported']);
// Set by the AI service's claim checker (services/ai/app/claims.py); carried through unchanged.
const verificationSchema = z
  .object({
    status: z.enum(['verified', 'partly', 'unsupported', 'no_claims']),
    checks: z.array(z.object({ text: z.string(), kind: z.string(), status: claimStatus, detail: z.string(), evidenceRef: z.string().nullable().optional() })).default([]),
  })
  .nullable()
  .optional();
const statementSchema = z.object({ statement: z.string(), evidenceRefs: refs, verification: verificationSchema });
const OUTCOMES = ['HEALTHY', 'DEGRADED', 'INCIDENT', 'UNDETERMINED'] as const;

export const reportSchema = z.object({
  summary: z.string().min(1).max(6000),
  confidence: z.number().min(0).max(1),
  analysisMode: z.enum(['llm', 'heuristic', 'mock']),
  // Whether the evidence shows a fault at all. Computed by the AI service from the evidence.
  outcome: z.enum(OUTCOMES).nullable().optional(),
  assessment: z
    .object({
      outcome: z.enum(OUTCOMES),
      confidence: z.number().min(0).max(1),
      rationale: z.string().max(4000),
      supportingRefs: refs,
      signals: z.array(z.object({ level: z.enum(['strong', 'moderate', 'weak']), kind: z.string(), text: z.string(), evidenceRefs: refs })).default([]),
      missingTelemetry: z.array(z.string()).default([]),
    })
    .nullable()
    .optional(),
  observations: z.array(statementSchema).default([]),
  integrity: z
    .object({
      checked: z.number().int().min(0),
      supported: z.number().int().min(0),
      flagged: z.array(z.object({ where: z.string(), text: z.string(), status: claimStatus, detail: z.string() })).default([]),
    })
    .nullable()
    .optional(),
  // The agent never confirms a root cause; a human does that on the incident.
  rootCauseConfirmed: z.literal(false).default(false),
  timeline: z.array(z.object({ timestamp: z.string(), description: z.string(), evidenceRefs: refs })).default([]),
  facts: z.array(statementSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
  hypotheses: z.array(hypothesisSchema).max(8).default([]),
  nextSteps: z.array(z.string()).default([]),
  recommendedActions: z
    .array(
      z.object({
        type: z.enum(REMEDIATION_TYPES),
        title: z.string().min(4).max(200),
        description: z.string().min(4).max(5000),
        rationale: z.string().max(5000).optional().nullable(),
        risk: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
        // Recomputed here from the type and text; what the sender says is not relied on.
        effect: z.enum(['read_only', 'state_changing']).optional(),
        effectReasons: z.array(z.string()).optional(),
        serviceSlug: z.string().optional().nullable(),
        parameters: z.record(z.string(), z.unknown()).optional().nullable(),
        evidenceRefs: refs,
      }),
    )
    .max(6)
    .default([]),
});
export type InvestigationReport = z.infer<typeof reportSchema>;

const MAX_JSON_BYTES = 24_000;

/** Tool outputs can be large; keep what is stored per step bounded. */
function bounded(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  const json = JSON.stringify(value);
  if (json.length <= MAX_JSON_BYTES) return value as Prisma.InputJsonValue;
  return { truncated: true, originalBytes: json.length, preview: json.slice(0, MAX_JSON_BYTES) };
}

// ───────────────────────── Background processor ─────────────────────────

class Cancelled extends Error {}

export async function runInvestigation(investigationId: string) {
  const investigation = await prisma.investigation.findUnique({
    where: { id: investigationId },
    include: { organization: { select: { name: true } }, incident: { include: { services: { select: { service: { select: { id: true, name: true, slug: true } } } } } } },
  });
  if (!investigation || investigation.status !== 'QUEUED') return;
  const { organizationId } = investigation;
  await prisma.investigation.update({ where: { id: investigationId }, data: { status: 'RUNNING', startedAt: new Date() } });

  const abort = new AbortController();
  let stepIndex = 0;
  let provider = 'unknown';
  let finished = false;
  const evidenceRefs = new Set<string>();

  const assertNotCancelled = async () => {
    const current = await prisma.investigation.findUnique({ where: { id: investigationId }, select: { status: true } });
    if (current?.status === 'CANCELLED') {
      abort.abort();
      throw new Cancelled();
    }
  };

  const addStep = (step: Extract<InvestigationEvent, { type: 'step' }>['step']) =>
    prisma.investigationStep.create({
      data: {
        investigationId,
        index: stepIndex++,
        type: step.type,
        title: step.title.slice(0, 300),
        detail: step.detail?.slice(0, 8000),
        toolName: step.toolName,
        input: bounded(step.input),
        output: bounded(step.output),
        status: step.status ?? 'completed',
        durationMs: step.durationMs ?? undefined,
      },
    });

  const onEvent = async (event: InvestigationEvent) => {
    await assertNotCancelled();
    switch (event.type) {
      case 'meta':
        provider = event.provider;
        await prisma.investigation.update({ where: { id: investigationId }, data: { provider: event.provider, model: event.model } });
        break;
      case 'step':
        if (event.step.type === 'plan') {
          await prisma.investigation.update({ where: { id: investigationId }, data: { plan: bounded(event.step.output) } });
        }
        await addStep(event.step);
        break;
      case 'evidence': {
        const e = event.evidence;
        if (evidenceRefs.has(e.ref)) break;
        evidenceRefs.add(e.ref);
        const occurredAt = e.occurredAt ? new Date(e.occurredAt) : null;
        await prisma.evidence.create({
          data: {
            investigationId,
            ref: e.ref,
            kind: e.kind,
            title: e.title.slice(0, 300),
            summary: e.summary.slice(0, 4000),
            sourceType: e.sourceType,
            sourceId: e.sourceId,
            occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
            relevance: e.relevance ?? undefined,
            data: bounded(e.data),
          },
        });
        break;
      }
      case 'final': {
        const parsed = reportSchema.safeParse(event.report);
        if (!parsed.success) throw new Error(`AI service returned a malformed report: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        const report = await applyGuardrails(parsed.data, evidenceRefs, addStep);
        await persistFinal(investigationId, report, event.usage, event.engine);
        finished = true;
        break;
      }
      case 'error':
        throw new Error(event.message);
    }
  };

  try {
    await aiService.runInvestigation(
      {
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
      },
      onEvent,
      abort.signal,
    );
    if (!finished) throw new Error('The AI service ended the investigation without producing a report');
    investigationsTotal.inc({ status: 'completed', provider });
  } catch (err) {
    if (err instanceof Cancelled) {
      investigationsTotal.inc({ status: 'cancelled', provider });
      return;
    }
    const message = (err as Error).message.slice(0, 1000);
    logger.error({ err, investigationId }, 'investigation failed');
    await addStep({ type: 'error', title: 'Investigation failed', detail: message, status: 'failed' }).catch(() => undefined);
    // Do not overwrite a cancellation that raced with the failure.
    await prisma.investigation.updateMany({ where: { id: investigationId, status: 'RUNNING' }, data: { status: 'FAILED', error: message, completedAt: new Date() } });
    investigationsTotal.inc({ status: 'failed', provider });
    await notifyUsers([investigation.createdById], { organizationId, type: 'investigation.failed', title: 'Investigation failed', body: message.slice(0, 200), link: `/investigations/${investigationId}` });
  }
}


/**
 * Server-side guardrails, applied regardless of what the model produced:
 *  - every evidence reference must point at evidence that was actually collected;
 *  - a hypothesis with no supporting evidence cannot be rated "likely" and its confidence is capped;
 *  - overall confidence cannot exceed the best-supported hypothesis;
 *  - a production change resting on a hypothesis rated unlikely becomes a manual action;
 *  - a high-risk action offered next to a safer one moves to the next steps.
 */
async function applyGuardrails(
  report: InvestigationReport,
  known: Set<string>,
  addStep: (step: Extract<InvestigationEvent, { type: 'step' }>['step']) => Promise<unknown>,
): Promise<InvestigationReport> {
  const notes: string[] = [];
  const clean = (list: string[], where: string) => {
    const kept = list.filter((r) => known.has(r));
    if (kept.length !== list.length) notes.push(`Removed ${list.length - kept.length} reference(s) to non-existent evidence from ${where}.`);
    return kept;
  };
  const hypotheses = report.hypotheses.map((h) => {
    const evidence = clean(h.evidenceRefs, `hypothesis "${h.title}"`);
    let { confidence, status } = h;
    if (!evidence.length) {
      if (confidence > 0.3 || status === 'likely') notes.push(`Hypothesis "${h.title}" has no supporting evidence; confidence capped at 0.3.`);
      confidence = Math.min(confidence, 0.3);
      if (status === 'likely') status = 'possible';
    }
    return { ...h, evidenceRefs: evidence, contradictingEvidenceRefs: clean(h.contradictingEvidenceRefs, `the evidence against "${h.title}"`), confidence, status };
  });
  const ceiling = hypotheses.length ? Math.max(...hypotheses.map((h) => h.confidence)) : 0.2;
  let confidence = report.confidence;
  if (confidence > ceiling) {
    notes.push(`Overall confidence reduced from ${confidence.toFixed(2)} to ${ceiling.toFixed(2)} to match the strongest hypothesis.`);
    confidence = ceiling;
  }
  const result: InvestigationReport = {
    ...report,
    confidence,
    hypotheses: hypotheses.sort((a, b) => b.confidence - a.confidence),
    timeline: report.timeline.map((t) => ({ ...t, evidenceRefs: clean(t.evidenceRefs, 'the timeline') })),
    facts: report.facts.map((f) => ({ ...f, evidenceRefs: clean(f.evidenceRefs, 'a stated fact') })).filter((f) => {
      if (f.evidenceRefs.length) return true;
      notes.push(`Moved unsupported statement to assumptions: "${f.statement.slice(0, 80)}"`);
      report.assumptions.push(f.statement);
      return false;
    }),
    recommendedActions: report.recommendedActions.map((a) => ({ ...a, evidenceRefs: clean(a.evidenceRefs, `action "${a.title}"`) })),
  };
  result.assumptions = report.assumptions;

  // The same rules as services/ai/app/guardrails.py, applied again here.
  // What each action does is decided from its type and text, never taken from the sender.
  result.recommendedActions = result.recommendedActions.map((a) => {
    const { effect, reasons } = actionEffect(a.type, a.title, a.description);
    return { ...a, effect, effectReasons: reasons };
  });
  const withdraw = (a: (typeof result.recommendedActions)[number], reason: string) => {
    notes.push(`Action "${a.title.slice(0, 60)}" is not offered for approval: ${reason}. It is listed under next steps.`);
    result.nextSteps = [...result.nextSteps, `Considered and not recommended (${reason}): ${a.title}`.slice(0, 500)];
  };
  // 1. A production change must not rest on a hypothesis the report itself rates unlikely.
  //    It is withdrawn, not relabelled: as a "manual" action the same change would still be on offer.
  const held = new Set<string>();
  const doubted = new Set<string>();
  result.hypotheses.forEach((h, i) => h.evidenceRefs.forEach((r) => (h.status === 'unlikely' && i > 0 ? doubted : held).add(r)));
  held.forEach((r) => doubted.delete(r));
  result.recommendedActions = result.recommendedActions.filter((a) => {
    if (a.effect !== 'state_changing' || !a.evidenceRefs.some((r) => doubted.has(r))) return true;
    withdraw(a, 'it would change production on the strength of a hypothesis rated unlikely');
    return false;
  });
  // 1b. Without an incident and an established cause, nothing justifies changing production.
  const outcome = result.assessment?.outcome ?? result.outcome;
  if (outcome && outcome !== 'INCIDENT') {
    result.recommendedActions = result.recommendedActions.filter((a) => {
      if (a.effect !== 'state_changing') return true;
      withdraw(a, `it would change production, and the evidence supports ${outcome}, not an incident with an established cause`);
      return false;
    });
  }
  // 2. A high-risk option is not offered next to a safer one: it moves to the next steps.
  if (result.recommendedActions.some((a) => a.risk !== 'HIGH')) {
    const risky = result.recommendedActions.filter((a) => a.risk === 'HIGH');
    for (const a of risky) {
      notes.push(`High-risk action "${a.title.slice(0, 60)}" moved to next steps: a lower-risk action is proposed.`);
      result.nextSteps = [...result.nextSteps, `Higher-risk alternative, only if the lower-risk action is not possible: ${a.title}. ${a.description}`.slice(0, 600)];
    }
    result.recommendedActions = result.recommendedActions.filter((a) => a.risk !== 'HIGH');
  }
  if (notes.length) await addStep({ type: 'guardrail', title: 'Output guardrails adjusted the report', detail: [...new Set(notes)].join('\n') });
  return result;
}

async function persistFinal(
  investigationId: string,
  report: InvestigationReport,
  usage?: InvestigationUsage,
  engine?: { mode: string; provider: string; model: string | null; attemptedProvider: string | null },
) {
  const investigation = await prisma.investigation.findUniqueOrThrow({ where: { id: investigationId } });
  await prisma.$transaction([
    prisma.hypothesis.deleteMany({ where: { investigationId } }),
    prisma.hypothesis.createMany({
      data: report.hypotheses.map((h, i) => ({ investigationId, rank: i + 1, title: h.title, description: h.description, confidence: h.confidence, status: h.status, evidenceRefs: h.evidenceRefs, contradictingRefs: h.contradictingEvidenceRefs, contradictions: h.contradictions, facts: h.facts, assumptions: h.assumptions, gaps: h.gaps })),
    }),
    prisma.investigation.updateMany({
      where: { id: investigationId, status: 'RUNNING' },
      data: {
        status: 'COMPLETED',
        report: report as unknown as Prisma.InputJsonValue,
        summary: report.summary,
        confidence: report.confidence,
        outcome: report.assessment?.outcome ?? report.outcome ?? null,
        completedAt: new Date(),
        // The report itself says which engine wrote it; that is what the UI labels it with.
        analysisMode: report.analysisMode,
        ...(engine ? { provider: engine.provider, model: engine.model, attemptedProvider: engine.attemptedProvider } : {}),
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        llmCalls: usage?.llmCalls ?? 0,
        llmLatencyMs: usage?.llmLatencyMs ?? 0,
        estimatedCostUsd: usage?.estimatedCostUsd ?? null,
      },
    }),
  ]);
  const { organizationId, incidentId } = investigation;
  // Recommendations become PROPOSED remediation actions. They do nothing until a human
  // submits them for approval, another human approves, and a human executes.
  for (const action of report.recommendedActions) {
    try {
      const service = action.serviceSlug ? await prisma.service.findFirst({ where: { organizationId, slug: action.serviceSlug }, select: { id: true } }) : null;
      await proposeRemediation(
        organizationId,
        {
          type: action.type,
          title: action.title,
          description: action.description,
          rationale: [action.rationale, action.evidenceRefs.length ? `Evidence: ${action.evidenceRefs.join(', ')}` : null].filter(Boolean).join('\n'),
          risk: action.risk,
          incidentId,
          investigationId,
          serviceId: service?.id ?? null,
          parameters: action.parameters ?? undefined,
        },
        { type: 'ai_agent', label: 'OPSILUME AI' },
      );
    } catch (err) {
      logger.warn({ err, investigationId }, 'could not create proposed remediation from report');
    }
  }
  if (incidentId) {
    await addIncidentEvent(incidentId, 'investigation', `AI investigation completed (${Math.round(report.confidence * 100)}% confidence): ${report.summary.slice(0, 280)}`, { kind: 'ai_agent', label: 'OPSILUME AI' }, { investigationId });
  }
  await writeAudit({ organizationId, actorType: 'ai_agent', actorLabel: 'OPSILUME AI', action: 'investigation.complete', resourceType: 'investigation', resourceId: investigationId, metadata: { confidence: report.confidence, hypotheses: report.hypotheses.length, proposedActions: report.recommendedActions.length, mode: report.analysisMode } });
  await notifyUsers([investigation.createdById], { organizationId, type: 'investigation.completed', title: 'Investigation completed', body: report.summary.slice(0, 200), link: `/investigations/${investigationId}` });
}

registerProcessor('investigation', ({ investigationId }) => runInvestigation(investigationId));

// ───────────────────────── Routes ─────────────────────────

export const investigationsRouter = Router();

const createBody = z.object({
  question: z.string().trim().min(8, 'Describe what you want investigated').max(4000),
  incidentId: z.string().optional(),
  timeWindow: z.object({ from: z.coerce.date(), to: z.coerce.date() }).refine((w) => w.from < w.to, '"from" must be before "to"').optional(),
});

const listSelect = {
  id: true,
  question: true,
  status: true,
  provider: true,
  model: true,
  analysisMode: true,
  estimatedCostUsd: true,
  summary: true,
  confidence: true,
  outcome: true,
  error: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  createdById: true,
  incident: { select: { id: true, number: true, title: true, severity: true } },
  _count: { select: { evidence: true, hypotheses: true, steps: true } },
} satisfies Prisma.InvestigationSelect;

investigationsRouter.get('/', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const q = paginationQuery.extend({ status: csvEnum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']), incidentId: z.string().optional() }).parse(req.query);
  const where: Prisma.InvestigationWhereInput = { organizationId, ...(q.status ? { status: { in: q.status } } : {}), ...(q.incidentId ? { incidentId: q.incidentId } : {}) };
  const [rows, total] = await Promise.all([
    prisma.investigation.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q), select: listSelect }),
    prisma.investigation.count({ where }),
  ]);
  res.json(paged(rows, total, q));
});

/** Which model will run the next investigation; shown in the workspace before submitting. */
investigationsRouter.get('/ai-status', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  // ?verify=true asks the provider to confirm the key and model (a free metadata lookup).
  const verify = req.query.verify === 'true' && can(authOf(req), 'investigation:run');
  const usage = await usageToday(organizationId);
  const limits = { maxConcurrent: env.INVESTIGATION_MAX_CONCURRENT, dailyInvestigations: env.INVESTIGATION_DAILY_LIMIT, dailyCostUsd: env.AI_DAILY_COST_LIMIT_USD };
  try {
    res.json({ reachable: true, ...(await aiService.status(verify)), usageToday: usage, organizationLimits: limits });
  } catch (err) {
    res.json({ reachable: false, detail: (err as Error).message, usageToday: usage, organizationLimits: limits });
  }
});

/** What this organisation has used since midnight UTC. */
async function usageToday(organizationId: string) {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const [agg, running] = await Promise.all([
    prisma.investigation.aggregate({ where: { organizationId, createdAt: { gte: since } }, _count: true, _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true } }),
    prisma.investigation.count({ where: { organizationId, status: { in: ['QUEUED', 'RUNNING'] } } }),
  ]);
  return { investigations: agg._count, running, estimatedCostUsd: Math.round((agg._sum.estimatedCostUsd ?? 0) * 10_000) / 10_000, tokens: (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0) };
}

/** Spending guard: refuses new investigations once the organisation's limits are reached. */
async function assertWithinLimits(organizationId: string) {
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

investigationsRouter.post('/', requirePermission('investigation:run'), async (req, res) => {
  const auth = authOf(req);
  const body = createBody.parse(req.body);
  const incident = body.incidentId ? await requireIncident(auth.organizationId, body.incidentId) : null;
  await assertWithinLimits(auth.organizationId);
  const investigation = await prisma.investigation.create({
    data: {
      organizationId: auth.organizationId,
      incidentId: incident?.id,
      question: body.question,
      timeWindowStart: body.timeWindow?.from,
      timeWindowEnd: body.timeWindow?.to,
      createdById: auth.userId,
    },
    select: listSelect,
  });
  await audit(req, 'investigation.start', 'investigation', investigation.id, { incident: incident ? incidentKey(incident.number) : null });
  if (incident) await addIncidentEvent(incident.id, 'investigation', `AI investigation started: "${body.question.slice(0, 200)}"`, auth, { investigationId: investigation.id });
  try {
    await enqueue('investigation', { investigationId: investigation.id });
  } catch (err) {
    // Never leave a row that looks queued when nothing will ever pick it up.
    await prisma.investigation.update({ where: { id: investigation.id }, data: { status: 'FAILED', error: (err as Error).message, completedAt: new Date() } });
    throw err;
  }
  res.status(202).json(await prisma.investigation.findUnique({ where: { id: investigation.id }, select: listSelect }));
});

investigationsRouter.get('/:id', requirePermission('read'), async (req, res) => {
  const { organizationId } = authOf(req);
  const investigation = await prisma.investigation.findFirst({
    where: { id: param(req.params.id), organizationId },
    include: {
      incident: { select: { id: true, number: true, title: true, severity: true, status: true } },
      steps: { orderBy: { index: 'asc' } },
      evidence: { orderBy: { createdAt: 'asc' } },
      hypotheses: { orderBy: { rank: 'asc' } },
      remediations: { orderBy: { createdAt: 'asc' }, select: { id: true, title: true, type: true, risk: true, status: true, effect: true } },
    },
  });
  if (!investigation) throw notFound('Investigation');
  const creator = investigation.createdById ? await prisma.user.findUnique({ where: { id: investigation.createdById }, select: { id: true, name: true } }) : null;
  res.json({ ...investigation, createdBy: creator });
});

investigationsRouter.post('/:id/cancel', requirePermission('investigation:run'), async (req, res) => {
  const { organizationId } = authOf(req);
  const updated = await prisma.investigation.updateMany({
    where: { id: param(req.params.id), organizationId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  if (!updated.count) throw conflict('Only queued or running investigations can be cancelled');
  await audit(req, 'investigation.cancel', 'investigation', param(req.params.id));
  res.json({ id: param(req.params.id), status: 'CANCELLED' });
});

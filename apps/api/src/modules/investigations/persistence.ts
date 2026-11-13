import type { Prisma } from '@prisma/client';
import type { InvestigationEvent, InvestigationUsage } from '../../integrations/aiService';
import { writeAudit } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { notifyUsers } from '../../lib/notify';
import { prisma } from '../../lib/prisma';
import { addIncidentEvent } from '../incidents';
import { proposeRemediation } from '../remediation';
import type { StepInput } from './guardrails';
import type { InvestigationReport } from './schema';

/** Everything an investigation writes to the database while it runs and when it finishes. */

const MAX_JSON_BYTES = 24_000;

/** Tool outputs can be large; keep what is stored per step bounded. */
export function bounded(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  const json = JSON.stringify(value);
  if (json.length <= MAX_JSON_BYTES) return value as Prisma.InputJsonValue;
  return { truncated: true, originalBytes: json.length, preview: json.slice(0, MAX_JSON_BYTES) };
}

/** Returns a function that appends steps to an investigation in the order they arrive. */
export function stepWriter(investigationId: string) {
  let stepIndex = 0;
  return (step: StepInput) =>
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
}

export const saveEngine = (investigationId: string, provider: string, model: string | null) => prisma.investigation.update({ where: { id: investigationId }, data: { provider, model } });

export const savePlan = (investigationId: string, plan: unknown) => prisma.investigation.update({ where: { id: investigationId }, data: { plan: bounded(plan) } });

export function saveEvidence(investigationId: string, e: Extract<InvestigationEvent, { type: 'evidence' }>['evidence']) {
  const occurredAt = e.occurredAt ? new Date(e.occurredAt) : null;
  return prisma.evidence.create({
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
}

/** Do not overwrite a cancellation that raced with the failure. */
export const markFailed = (investigationId: string, message: string) =>
  prisma.investigation.updateMany({ where: { id: investigationId, status: 'RUNNING' }, data: { status: 'FAILED', error: message, completedAt: new Date() } });

export async function persistFinal(
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

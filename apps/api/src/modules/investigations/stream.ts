import type { InvestigationEvent } from '../../integrations/aiService';
import { prisma } from '../../lib/prisma';
import { applyGuardrails } from './guardrails';
import { persistFinal, saveEngine, saveEvidence, savePlan, stepWriter } from './persistence';
import { reportSchema } from './schema';

/** Thrown out of the stream when the investigation was cancelled while it was running. */
export class Cancelled extends Error {}

/**
 * Consumes the event stream of one investigation: records steps and evidence as they arrive,
 * and on the final event validates the report, applies the guardrails and stores the result.
 * Before every event it checks whether the investigation was cancelled, and aborts the request
 * to the AI service if so.
 */
export function eventConsumer(investigationId: string, abort: AbortController) {
  const state = { provider: 'unknown', finished: false };
  const evidenceRefs = new Set<string>();
  // Reference of each deployment evidence item by the deployment's id, to tell what a rollback acts on.
  const deploymentRefs = new Map<string, string>();
  const addStep = stepWriter(investigationId);

  const assertNotCancelled = async () => {
    const current = await prisma.investigation.findUnique({ where: { id: investigationId }, select: { status: true } });
    if (current?.status === 'CANCELLED') {
      abort.abort();
      throw new Cancelled();
    }
  };

  const onEvent = async (event: InvestigationEvent) => {
    await assertNotCancelled();
    switch (event.type) {
      case 'meta':
        state.provider = event.provider;
        await saveEngine(investigationId, event.provider, event.model);
        break;
      case 'step':
        if (event.step.type === 'plan') await savePlan(investigationId, event.step.output);
        await addStep(event.step);
        break;
      case 'evidence': {
        const e = event.evidence;
        if (evidenceRefs.has(e.ref)) break;
        evidenceRefs.add(e.ref);
        if (e.kind === 'deployment' && e.sourceId) deploymentRefs.set(e.sourceId, e.ref);
        await saveEvidence(investigationId, e);
        break;
      }
      case 'final': {
        const parsed = reportSchema.safeParse(event.report);
        if (!parsed.success) throw new Error(`AI service returned a malformed report: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        const report = await applyGuardrails(parsed.data, evidenceRefs, addStep, deploymentRefs);
        await persistFinal(investigationId, report, event.usage, event.engine);
        state.finished = true;
        break;
      }
      case 'error':
        throw new Error(event.message);
    }
  };

  return { onEvent, addStep, state };
}

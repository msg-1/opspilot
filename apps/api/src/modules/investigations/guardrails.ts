import { GUARDRAIL_LIMITS as LIMITS } from '../../generated/contracts';
import type { InvestigationEvent } from '../../integrations/aiService';
import { actionEffect } from '../../lib/actionEffect';
import type { InvestigationReport } from './schema';

export type StepInput = Extract<InvestigationEvent, { type: 'step' }>['step'];

/**
 * Server-side guardrails, applied regardless of what the model produced:
 *  - every evidence reference must point at evidence that was actually collected;
 *  - a hypothesis with no supporting evidence cannot be rated "likely" and its confidence is capped;
 *  - overall confidence cannot exceed the best-supported hypothesis;
 *  - what each action would do is decided here from its type and text;
 *  - a production change resting on a hypothesis rated unlikely is withdrawn;
 *  - a production change is withdrawn when the outcome is not an incident;
 *  - a high-risk action offered next to a safer one moves to the next steps.
 *
 * This pass is independent of the AI service's own guardrails on purpose: a report might arrive
 * that was never checked. The limits and wording come from contracts/guardrails.json and the
 * behaviour is pinned by contracts/fixtures/guardrail-cases.json, which both sides run.
 */
export async function applyGuardrails(
  report: InvestigationReport,
  known: Set<string>,
  addStep: (step: StepInput) => Promise<unknown>,
  deploymentRefs: Map<string, string> = new Map(),
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
      if (confidence > LIMITS.unsupportedHypothesisCap || status === 'likely') notes.push(`Hypothesis "${h.title}" has no supporting evidence; confidence capped at ${LIMITS.unsupportedHypothesisCap}.`);
      confidence = Math.min(confidence, LIMITS.unsupportedHypothesisCap);
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
    result.nextSteps = [...result.nextSteps, LIMITS.nextStepPrefixes.withdrawn.replace('{reason}', reason).replace('{title}', a.title).slice(0, 500)];
  };
  // 1. A production change must not rest on a hypothesis the report itself rates unlikely.
  //    It is withdrawn, not relabelled: as a "manual" action the same change would still be on offer.
  const held = new Set<string>();
  const doubted = new Set<string>();
  result.hypotheses.forEach((h, i) => h.evidenceRefs.forEach((r) => (h.status === 'unlikely' && i > 0 ? doubted : held).add(r)));
  held.forEach((r) => doubted.delete(r));
  result.recommendedActions = result.recommendedActions.filter((a) => {
    if (a.effect !== 'state_changing') return true;
    // A rollback rests on the deployment it rolls back, not on every record it cites (the
    // previous version's deployment is cited as the target, whatever else that record supports).
    const id = a.type === 'rollback_deployment' ? (a.parameters as { deploymentId?: unknown } | null | undefined)?.deploymentId : undefined;
    const subject = typeof id === 'string' ? deploymentRefs.get(id) : undefined;
    const restsOn = subject ? [subject] : a.evidenceRefs;
    if (!restsOn.some((r) => doubted.has(r))) return true;
    withdraw(a, LIMITS.withdrawalReasons.unlikelyHypothesis);
    return false;
  });
  // 1b. Without an incident and an established cause, nothing justifies changing production.
  const outcome = result.assessment?.outcome ?? result.outcome;
  if (outcome && outcome !== LIMITS.outcomeAllowingProductionChanges) {
    result.recommendedActions = result.recommendedActions.filter((a) => {
      if (a.effect !== 'state_changing') return true;
      withdraw(a, LIMITS.withdrawalReasons.noIncident.replace('{outcome}', outcome));
      return false;
    });
  }
  // 2. A high-risk option is not offered next to a safer one: it moves to the next steps.
  if (result.recommendedActions.some((a) => a.risk !== 'HIGH')) {
    const risky = result.recommendedActions.filter((a) => a.risk === 'HIGH');
    for (const a of risky) {
      notes.push(`High-risk action "${a.title.slice(0, 60)}" moved to next steps: a lower-risk action is proposed.`);
      result.nextSteps = [...result.nextSteps, LIMITS.nextStepPrefixes.highRisk.replace('{title}', a.title).replace('{description}', a.description).slice(0, 600)];
    }
    result.recommendedActions = result.recommendedActions.filter((a) => a.risk !== 'HIGH');
  }
  if (notes.length) await addStep({ type: 'guardrail', title: 'Output guardrails adjusted the report', detail: [...new Set(notes)].join('\n') });
  return result;
}

import type { RiskLevel } from '@prisma/client';
import { type ActionEffect, actionEffect, runbookPlan } from '../../lib/actionEffect';
import { badRequest } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { getSettings } from '../organization';

/**
 * Effect classification, and what follows from it: the lowest risk an action may carry and the
 * number of approvals it needs. The rules themselves are in lib/actionEffect.ts, generated from
 * contracts/action-effects.json.
 */

/** Effect of an action, reading the runbook it points at (parameters.runbookDocumentId) when there is one. */
export async function effectOf(organizationId: string, a: { type: string; title: string; description: string; parameters?: unknown }): Promise<{ effect: ActionEffect; reasons: string[] }> {
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

export function requiredApprovals(settings: Awaited<ReturnType<typeof getSettings>>, risk: RiskLevel, effect: ActionEffect) {
  if (effect === 'read_only') return 0;
  // Never fewer than one for something that changes state, whatever the settings say.
  return Math.max(1, risk === 'HIGH' ? settings.approvalsHighRisk : risk === 'MEDIUM' ? settings.approvalsMediumRisk : settings.approvalsLowRisk);
}

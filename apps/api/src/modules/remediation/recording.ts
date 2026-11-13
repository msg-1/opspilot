import type { Prisma, RemediationAction } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import type { ExecutionResult } from './execution';

/** Recording what an execution attempt did: the outcome on the action, and its effect on the service's history. */

export interface ExecutionRecord extends ExecutionResult {
  contentHash: string;
  attempt: number;
  approvedBy: { approverId: string; approvedAt: Date }[];
  startedAt: Date;
  finishedAt: Date;
}

/** EXECUTING → EXECUTED or FAILED, with the full record of the attempt. */
export const recordOutcome = (actionId: string, record: ExecutionRecord) =>
  prisma.remediationAction.update({ where: { id: actionId }, data: { status: record.success ? 'EXECUTED' : 'FAILED', executedAt: new Date(), executionResult: record as unknown as Prisma.InputJsonValue } });

/** Mirrors an executed action onto the service's history so later investigations can see it. */
export async function recordEffects(action: RemediationAction, operator: { label: string }, result: ExecutionResult) {
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

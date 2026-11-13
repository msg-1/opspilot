import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { type Content, contentHash } from './content';

/**
 * Approval management. An approval counts only for the content it was given for, and only
 * until that content changes: editing an action supersedes its approvals, and so does finding,
 * at execution, that the action is not the one that was approved. Superseded approvals stay
 * on record.
 */

type ApprovalRow = { decision: string; contentHash: string | null; supersededAt: Date | null };

export function countsFor(action: Content, approval: ApprovalRow) {
  return approval.decision === 'approved' && !approval.supersededAt && approval.contentHash === contentHash(action);
}

/** The approvals that count for the action as it is now. */
export const validApprovals = <A extends ApprovalRow>(action: Content & { approvals: A[] }) => action.approvals.filter((a) => countsFor(action, a));

/**
 * PROPOSED → PENDING_APPROVAL, recording the hash that is being put up for approval. The status
 * is part of the condition, so a concurrent request cannot submit the same action twice.
 * Returns false when it was already submitted.
 */
export async function submitForApproval(actionId: string, requestedById: string, requiredApprovals: number, hash: string): Promise<boolean> {
  const updated = await prisma.remediationAction.updateMany({
    where: { id: actionId, status: 'PROPOSED' },
    data: { status: 'PENDING_APPROVAL', requestedById, requestedAt: new Date(), requiredApprovals, contentHash: hash },
  });
  return updated.count > 0;
}

/** Records an approval for exactly this hash; the action becomes APPROVED once enough count, and only while its content is still that hash. */
export function recordApproval(action: { id: string; requiredApprovals: number }, approverId: string, hash: string, comment?: string) {
  return prisma.$transaction(async (tx) => {
    await tx.approval.create({ data: { actionId: action.id, approverId, decision: 'approved', comment, contentHash: hash } });
    const granted = await tx.approval.count({ where: { actionId: action.id, decision: 'approved', supersededAt: null, contentHash: hash } });
    if (granted >= action.requiredApprovals) {
      // Only while the content is still what was approved.
      await tx.remediationAction.updateMany({ where: { id: action.id, status: 'PENDING_APPROVAL', contentHash: hash }, data: { status: 'APPROVED' } });
    }
    return { granted, approved: granted >= action.requiredApprovals };
  });
}

export function recordRejection(action: Content & { id: string }, approverId: string, comment: string) {
  return prisma.$transaction([
    prisma.approval.create({ data: { actionId: action.id, approverId, decision: 'rejected', comment, contentHash: contentHash(action) } }),
    prisma.remediationAction.updateMany({ where: { id: action.id, status: 'PENDING_APPROVAL' }, data: { status: 'REJECTED' } }),
  ]);
}

/** Marks every current approval of an action as no longer counting. Usable inside a transaction. */
export const supersedeApprovals = (actionId: string, db: Prisma.TransactionClient | typeof prisma = prisma) =>
  db.approval.updateMany({ where: { actionId, supersededAt: null }, data: { supersededAt: new Date() } });

/** The action is not what was approved: its approvals stop counting and it starts again from PROPOSED. */
export function invalidateApproval(actionId: string) {
  return prisma.$transaction([supersedeApprovals(actionId), prisma.remediationAction.updateMany({ where: { id: actionId, status: 'APPROVED' }, data: { status: 'PROPOSED', contentHash: null } })]);
}

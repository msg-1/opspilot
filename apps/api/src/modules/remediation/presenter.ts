import type { Prisma } from '@prisma/client';
import { notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { countsFor } from './approvals';
import { contentHash } from './content';

/** Loading an action with its approvals, and the shape in which the API returns it. */

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

export const detailInclude = {
  approvals: { orderBy: { createdAt: 'asc' } },
  incident: { select: { id: true, number: true, title: true, severity: true, status: true } },
  investigation: { select: { id: true, question: true, summary: true } },
} satisfies Prisma.RemediationActionInclude;

export type Detailed = Prisma.RemediationActionGetPayload<{ include: typeof detailInclude }>;

export async function presentMany(rows: Detailed[]) {
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

export async function load(organizationId: string, id: string) {
  const action = await prisma.remediationAction.findFirst({ where: { id, organizationId }, include: detailInclude });
  if (!action) throw notFound('Remediation action');
  return action;
}

/** One action as the API returns it. */
export const present = async (organizationId: string, id: string) => (await presentMany([await load(organizationId, id)]))[0];

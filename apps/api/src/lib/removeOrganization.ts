import { prisma } from './prisma';

/**
 * Removing one organisation and everything that belongs to it, for the end of a trial. Used by
 * `npm run org:remove` (scripts/remove-organization.ts); there is deliberately no HTTP route.
 *
 * Every tenant table hangs off Organization with ON DELETE CASCADE, so deleting the row removes
 * the organisation's data and nothing else. That is checked rather than trusted: inside the
 * same transaction the rows of every other organisation are counted before and after, and any
 * difference rolls the whole removal back. User accounts are not tenant data. They are kept,
 * unless they belonged to no other organisation and the caller asks for them to go too.
 */

const TENANT_TABLES = ['membership', 'service', 'incident', 'investigation', 'remediationAction', 'deployment', 'logEntry', 'metricSample', 'alertRule', 'knowledgeDocument', 'apiKey', 'auditLog'] as const;
type TenantTable = (typeof TENANT_TABLES)[number];
type Db = Pick<typeof prisma, TenantTable | 'organization' | 'user' | 'refreshToken'>;

const count = (db: Db, table: TenantTable, where: object) => (db[table] as unknown as { count: (args: { where: object }) => Promise<number> }).count({ where });

async function tally(db: Db, where: object) {
  return Object.fromEntries(await Promise.all(TENANT_TABLES.map(async (t) => [t, await count(db, t, where)] as const))) as Record<TenantTable, number>;
}

/** What an organisation holds, and which accounts belong to it alone. Reads only. */
export async function organizationFootprint(slug: string) {
  const organization = await prisma.organization.findUnique({ where: { slug }, select: { id: true, name: true, slug: true, createdAt: true } });
  if (!organization) return null;
  const members = await prisma.membership.findMany({ where: { organizationId: organization.id }, select: { role: true, user: { select: { id: true, email: true, _count: { select: { memberships: true } } } } } });
  return {
    organization,
    counts: await tally(prisma, { organizationId: organization.id }),
    // Accounts that would be left belonging to nothing.
    soleMembers: members.filter((m) => m.user._count.memberships === 1).map((m) => ({ id: m.user.id, email: m.user.email, role: m.role })),
    sharedMembers: members.filter((m) => m.user._count.memberships > 1).length,
  };
}

export async function removeOrganization(slug: string, options: { confirm: string; deleteSoleMembers?: boolean }) {
  if (options.confirm !== slug) throw new Error(`Not removed: the confirmation "${options.confirm}" is not the slug "${slug}".`);
  const before = await organizationFootprint(slug);
  if (!before) throw new Error(`There is no organisation with the slug "${slug}".`);
  const { id } = before.organization;
  const soleIds = before.soleMembers.map((m) => m.id);
  return prisma.$transaction(
    async (tx) => {
      const others = { organizationId: { not: id } };
      const [othersBefore, organizationsBefore, usersBefore] = [await tally(tx, others), await tx.organization.count(), await tx.user.count()];
      await tx.organization.delete({ where: { id } });
      // Sessions carry the organisation's id without being tied to it in the schema; they go with it.
      await tx.refreshToken.deleteMany({ where: { organizationId: id } });
      // Only accounts that belonged to this organisation and to no other, re-checked inside the transaction.
      const removedUsers = options.deleteSoleMembers && soleIds.length ? (await tx.user.deleteMany({ where: { id: { in: soleIds }, memberships: { none: {} } } })).count : 0;
      const [othersAfter, organizationsAfter, usersAfter, left] = [await tally(tx, others), await tx.organization.count(), await tx.user.count(), await tally(tx, { organizationId: id })];
      const changed = TENANT_TABLES.filter((t) => othersBefore[t] !== othersAfter[t]);
      const remaining = TENANT_TABLES.filter((t) => left[t] > 0);
      if (changed.length || remaining.length || organizationsAfter !== organizationsBefore - 1 || usersAfter !== usersBefore - removedUsers) {
        throw new Error(`Nothing was removed: the check after deleting did not hold (other organisations changed in: ${changed.join(', ') || 'none'}; rows left behind in: ${remaining.join(', ') || 'none'}).`);
      }
      return { organization: before.organization, removed: before.counts, removedUsers, keptUsers: before.soleMembers.length - removedUsers + before.sharedMembers };
    },
    { isolationLevel: 'RepeatableRead', timeout: 120_000 },
  );
}

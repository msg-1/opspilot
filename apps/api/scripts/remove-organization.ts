/**
 * Removes one organisation and everything in it. For the end of a trial.
 *
 *   npm run org:remove -- <slug>                      show what would be removed (removes nothing)
 *   npm run org:remove -- <slug> --confirm <slug>     remove it
 *   … --delete-sole-members                           also delete accounts that belong to no other organisation
 *
 * It never touches another organisation: the removal is one transaction that is rolled back
 * unless every other organisation's rows are exactly as they were. See docs/customer-pilot-guide.md.
 */
import { prisma } from '../src/lib/prisma';
import { organizationFootprint, removeOrganization } from '../src/lib/removeOrganization';

const say = (line = '') => process.stdout.write(`${line}\n`);

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--confirm');
  const confirm = args.includes('--confirm') ? args[args.indexOf('--confirm') + 1] : undefined;
  if (!slug) {
    say('Usage: npm run org:remove -- <slug> [--confirm <slug>] [--delete-sole-members]');
    process.exitCode = 2;
    return;
  }
  const database = new URL(process.env.DATABASE_URL ?? 'postgresql://unknown/unknown');
  say(`Database: ${database.hostname}${database.pathname}`);
  const footprint = await organizationFootprint(slug);
  if (!footprint) throw new Error(`There is no organisation with the slug "${slug}".`);
  say(`Organisation: ${footprint.organization.name} (${slug}), created ${footprint.organization.createdAt.toISOString()}\n`);
  for (const [table, n] of Object.entries(footprint.counts)) say(`  ${String(n).padStart(9)}  ${table}`);
  say(`\nAccounts that belong only to this organisation: ${footprint.soleMembers.length}${footprint.soleMembers.length ? ` (${footprint.soleMembers.map((m) => m.email).join(', ')})` : ''}`);
  say(`Accounts that also belong to another organisation (always kept): ${footprint.sharedMembers}`);
  if (!confirm) {
    say(`\nNothing was removed. To remove it: npm run org:remove -- ${slug} --confirm ${slug}`);
    return;
  }
  const result = await removeOrganization(slug, { confirm, deleteSoleMembers: args.includes('--delete-sole-members') });
  say(`\nRemoved "${result.organization.name}" and everything in it. Accounts deleted: ${result.removedUsers}; accounts kept: ${result.keptUsers}.`);
  say('Every other organisation was checked and is unchanged.');
}

main()
  .catch((err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

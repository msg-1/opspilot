/**
 * A temporary dataset for manual acceptance testing: "Acme Commerce", six services, eight
 * incidents and the telemetry behind them. Local only. See docs/manual-demo-testing.md.
 *
 *   npm run demo:seed              create the dataset (does nothing if it already exists)
 *   npm run demo:status            what exists, by category
 *   npm run demo:reset             show what would be removed
 *   npm run demo:reset -- --yes    remove it
 *
 * Isolation: everything lives in one dedicated organisation, found by its slug AND by a marker
 * row written in the same statement that creates it. Every table that holds tenant data carries
 * that organisation's id, so "the demo data" is exactly "the rows of that organisation". Existing
 * accounts are attached to it by membership rows; no user row is created, changed or deleted.
 *
 * What this script writes is telemetry and records (logs, metrics, deployments, incidents).
 * It never writes an investigation, a report, evidence, an approval or an execution result:
 * those come only from running the product.
 */
import { createHash } from 'node:crypto';
import type { LogLevel, Prisma } from '@prisma/client';
import { fingerprint } from '../src/lib/logParsing';
import { prisma } from '../src/lib/prisma';

const SLUG = 'acme-commerce-demo';
const NAME = 'Acme Commerce';
const MARKER = 'manual-demo-dataset';
const MARK_STARTED = 'demo.seed.started';
const MARK_COMPLETED = 'demo.seed.completed';
/** Existing seeded accounts (npm run db:seed) and the role each gets in the demo organisation. */
const ACCOUNTS: [email: string, role: 'OWNER' | 'ADMIN' | 'ENGINEER' | 'VIEWER', key: string][] = [
  ['demo@example.com', 'OWNER', 'owner'],
  ['marcus@example.com', 'ADMIN', 'admin'],
  ['lena@example.com', 'ENGINEER', 'sre'],
  ['tomas@example.com', 'ENGINEER', 'dev'],
  ['aiko@example.com', 'VIEWER', 'viewer'],
];

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const say = (line = '') => process.stdout.write(`${line}\n`);

// ───────────────────────── Safety ─────────────────────────

/** This script only ever runs against a database on this machine. */
function assertLocal() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Run this through npm (it reads the repository .env).');
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'host.docker.internal'].includes(host)) {
    throw new Error(`Refusing to run: the database host "${host}" is not local. The manual-testing dataset is for a local database only.`);
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run with NODE_ENV=production.');
}

/** The demo organisation, and whether it carries the marker this script writes when creating it. */
async function findDemo() {
  const org = await prisma.organization.findUnique({ where: { slug: SLUG } });
  if (!org) return null;
  const marks = await prisma.auditLog.findMany({ where: { organizationId: org.id, action: { in: [MARK_STARTED, MARK_COMPLETED] }, resourceType: MARKER }, select: { action: true, metadata: true, createdAt: true } });
  return { org, marked: marks.some((m) => m.action === MARK_STARTED), completed: marks.find((m) => m.action === MARK_COMPLETED) ?? null };
}

const REFUSE_UNMARKED = `An organisation with the slug "${SLUG}" exists but was not created by this script (it has no marker). Nothing was changed. Rename or remove it yourself before using the demo dataset.`;

// ───────────────────────── Counting ─────────────────────────

/** Row counts by category. `mine` selects the demo organisation, otherwise everything else. */
async function counts(db: Prisma.TransactionClient | typeof prisma, organizationId: string, mine: boolean) {
  const own = mine ? { organizationId } : { organizationId: { not: organizationId } };
  const entries: [string, Promise<number>][] = [
    ['memberships', db.membership.count({ where: own })],
    ['teams', db.team.count({ where: own })],
    ['team members', db.teamMember.count({ where: { team: own } })],
    ['services', db.service.count({ where: own })],
    ['service dependencies', db.serviceDependency.count({ where: { service: own } })],
    ['repositories', db.repository.count({ where: own })],
    ['commits', db.commit.count({ where: { repository: own } })],
    ['pull requests', db.pullRequest.count({ where: { repository: own } })],
    ['deployments', db.deployment.count({ where: own })],
    ['service events', db.serviceEvent.count({ where: own })],
    ['metric samples', db.metricSample.count({ where: own })],
    ['log entries', db.logEntry.count({ where: own })],
    ['alert rules', db.alertRule.count({ where: own })],
    ['alerts', db.alert.count({ where: own })],
    ['incidents', db.incident.count({ where: own })],
    ['incident services', db.incidentService.count({ where: { incident: own } })],
    ['incident timeline events', db.incidentEvent.count({ where: { incident: own } })],
    ['knowledge documents', db.knowledgeDocument.count({ where: own })],
    ['knowledge chunks', db.knowledgeChunk.count({ where: own })],
    ['investigations', db.investigation.count({ where: own })],
    ['investigation steps', db.investigationStep.count({ where: { investigation: own } })],
    ['evidence items', db.evidence.count({ where: { investigation: own } })],
    ['hypotheses', db.hypothesis.count({ where: { investigation: own } })],
    ['remediation actions', db.remediationAction.count({ where: own })],
    ['approvals', db.approval.count({ where: { action: own } })],
    ['notifications', db.notification.count({ where: own })],
    ['audit log entries', db.auditLog.count({ where: own })],
    ['api keys', db.apiKey.count({ where: own })],
    ['invitations', db.invitation.count({ where: own })],
    ['sessions', db.refreshToken.count({ where: own })],
    ['organisation settings', db.organizationSettings.count({ where: own })],
    ['github integrations', db.githubIntegration.count({ where: own })],
  ];
  const out: Record<string, number> = {};
  // One at a time: inside a transaction there is a single connection.
  for (const [name, query] of entries) out[name] = await query;
  return out;
}

/** Everything outside the demo organisation that a faulty cleanup could damage, as one comparable value. */
async function outsideWorld(db: Prisma.TransactionClient, organizationId: string) {
  const users = await db.user.findMany({ select: { id: true, email: true, passwordHash: true, isActive: true, updatedAt: true }, orderBy: { id: 'asc' } });
  return JSON.stringify({
    rows: await counts(db, organizationId, false),
    organisations: await db.organization.count({ where: { id: { not: organizationId } } }),
    users: createHash('sha256').update(JSON.stringify(users)).digest('hex'),
    userCount: users.length,
  });
}

function table(rows: Record<string, number>, skipZero = false) {
  for (const [name, n] of Object.entries(rows)) if (!skipZero || n) say(`  ${String(n).padStart(7)}  ${name}`);
}

/** Says which engine an investigation started now would use. A model costs money; the dataset is meant for the rule-based engine. */
async function engineNote() {
  try {
    const { aiService } = await import('../src/integrations/aiService');
    const { llm } = await aiService.status();
    if (llm.provider === 'heuristic' || !llm.available) return say('\nInvestigation engine: rule-based (no model is called, nothing is billed).');
    say(`\nWARNING: the AI service would use a model (${llm.provider}${llm.model ? ` / ${llm.model}` : ''}). An investigation started now may be billed.`);
    say('  Switch to the rule-based engine first: AI_PROVIDER=deterministic docker compose --profile app up -d ai');
  } catch {
    say('\nInvestigation engine: could not be checked (the AI service is not reachable). Before investigating, make sure it runs with AI_PROVIDER=deterministic.');
  }
}

// ───────────────────────── status ─────────────────────────

async function status() {
  const demo = await findDemo();
  if (!demo) return say(`No demo dataset: there is no organisation "${SLUG}". Create it with: npm run demo:seed`);
  if (!demo.marked) return say(REFUSE_UNMARKED);
  say(`Demo dataset "${demo.org.name}" (${SLUG}), created ${demo.org.createdAt.toISOString()}${demo.completed ? '' : '\n  INCOMPLETE: seeding did not finish. Run: npm run demo:reset -- --yes && npm run demo:seed'}`);
  const hours = (Date.now() - demo.org.createdAt.getTime()) / HOUR;
  if (hours > 6) say(`  The telemetry is anchored to the time of seeding, ${hours.toFixed(0)} hours ago. Charts for "last hour" will be empty. Re-anchor with: npm run demo:reset -- --yes && npm run demo:seed`);
  say('\nRecords in the demo organisation:');
  table(await counts(prisma, demo.org.id, true), true);
  const members = await prisma.membership.findMany({ where: { organizationId: demo.org.id }, select: { role: true, user: { select: { email: true } } }, orderBy: { createdAt: 'asc' } });
  say('\nAccounts that can open it (existing accounts; their credentials are untouched):');
  for (const m of members) say(`  ${m.role.padEnd(9)} ${m.user.email}`);
  const incidents = await prisma.incident.findMany({ where: { organizationId: demo.org.id }, orderBy: { number: 'asc' }, select: { number: true, title: true, status: true, severity: true, _count: { select: { investigations: true, remediations: true } } } });
  say('\nIncidents:');
  for (const i of incidents) say(`  INC-${i.number}  ${i.severity}  ${i.status.padEnd(13)} ${i.title}  (investigations: ${i._count.investigations}, actions: ${i._count.remediations})`);
  await engineNote();
}

// ───────────────────────── reset ─────────────────────────

async function reset(confirmed: boolean) {
  assertLocal();
  const demo = await findDemo();
  if (!demo) return say(`Nothing to remove: there is no organisation "${SLUG}".`);
  if (!demo.marked) throw new Error(REFUSE_UNMARKED);
  const id = demo.org.id;
  const before = await counts(prisma, id, true);
  say(`${confirmed ? 'Removing' : 'Would remove'} the demo organisation "${demo.org.name}" (${SLUG}, id ${id}) and only its records:`);
  table(before, true);
  if (!confirmed) return say('\nNothing was deleted. To remove these records: npm run demo:reset -- --yes');

  await prisma.$transaction(
    async (tx) => {
      const world = await outsideWorld(tx, id);
      const own = { organizationId: id };
      // Children before parents. Every statement is scoped to the demo organisation's id.
      await tx.approval.deleteMany({ where: { action: own } });
      await tx.remediationAction.deleteMany({ where: own });
      await tx.hypothesis.deleteMany({ where: { investigation: own } });
      await tx.evidence.deleteMany({ where: { investigation: own } });
      await tx.investigationStep.deleteMany({ where: { investigation: own } });
      await tx.investigation.deleteMany({ where: own });
      await tx.knowledgeChunk.deleteMany({ where: own });
      await tx.knowledgeDocument.deleteMany({ where: own });
      await tx.alert.deleteMany({ where: own });
      await tx.alertRule.deleteMany({ where: own });
      await tx.incidentEvent.deleteMany({ where: { incident: own } });
      await tx.incidentService.deleteMany({ where: { incident: own } });
      await tx.incident.deleteMany({ where: own });
      await tx.metricSample.deleteMany({ where: own });
      await tx.logEntry.deleteMany({ where: own });
      await tx.serviceEvent.deleteMany({ where: own });
      await tx.deployment.deleteMany({ where: own });
      await tx.commit.deleteMany({ where: { repository: own } });
      await tx.pullRequest.deleteMany({ where: { repository: own } });
      await tx.repository.deleteMany({ where: own });
      await tx.githubIntegration.deleteMany({ where: own });
      await tx.serviceDependency.deleteMany({ where: { service: own } });
      await tx.service.deleteMany({ where: own });
      await tx.teamMember.deleteMany({ where: { team: own } });
      await tx.team.deleteMany({ where: own });
      await tx.notification.deleteMany({ where: own });
      await tx.apiKey.deleteMany({ where: own });
      await tx.invitation.deleteMany({ where: own });
      // Sessions that were switched into the demo organisation. The accounts themselves stay.
      await tx.refreshToken.deleteMany({ where: own });
      await tx.membership.deleteMany({ where: own });
      await tx.auditLog.deleteMany({ where: own });
      await tx.organizationSettings.deleteMany({ where: own });
      await tx.organization.delete({ where: { id } });

      const left = Object.entries(await counts(tx, id, true)).filter(([, n]) => n > 0);
      if (left.length) throw new Error(`Rows of the demo organisation remain (${left.map(([k, n]) => `${k}: ${n}`).join(', ')}). Rolled back; nothing was deleted.`);
      if ((await outsideWorld(tx, id)) !== world) throw new Error('A record outside the demo organisation would have been affected. Rolled back; nothing was deleted.');
    },
    // A snapshot: the before/after comparison sees only what this transaction itself did.
    { isolationLevel: 'RepeatableRead', timeout: 180_000, maxWait: 20_000 },
  );
  say(`\nRemoved ${Object.values(before).reduce((a, b) => a + b, 0)} records and the organisation. Verified inside the same transaction: no row of any other organisation and no user account changed.`);
  say('Anyone signed in to the demo organisation is signed out of it; their accounts and other organisations are as they were.');
}

// ───────────────────────── seed ─────────────────────────

async function seed() {
  assertLocal();
  const existing = await findDemo();
  if (existing && !existing.marked) throw new Error(REFUSE_UNMARKED);
  if (existing) {
    say(existing.completed ? `The demo dataset already exists; nothing was created. To rebuild it anchored to now: npm run demo:reset -- --yes && npm run demo:seed\n` : 'A previous seed did not finish. Run: npm run demo:reset -- --yes && npm run demo:seed\n');
    return status();
  }
  const accounts = await prisma.user.findMany({ where: { email: { in: ACCOUNTS.map((a) => a[0]) }, isActive: true }, select: { id: true, email: true, name: true } });
  const owner = accounts.find((a) => a.email === ACCOUNTS[0]![0]);
  if (!owner) throw new Error(`The existing demo account ${ACCOUNTS[0]![0]} was not found. Create the standard demo accounts first with: npm run db:seed`);

  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  // Deterministic pseudo-random numbers: every seed produces the same shape of data.
  let state = 20261113;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const between = (a: number, b: number) => a + rand() * (b - a);
  const int = (a: number, b: number) => Math.floor(between(a, b));
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;
  const sha = (text: string) => createHash('sha1').update(`acme:${text}`).digest('hex');

  // The organisation and its marker are created together: it never exists unmarked.
  const org = await prisma.organization.create({
    data: {
      name: NAME,
      slug: SLUG,
      settings: { create: {} },
      auditLogs: { create: { actorType: 'system', actorLabel: 'demo dataset script', action: MARK_STARTED, resourceType: MARKER, metadata: { marker: MARKER } } },
    },
  });
  const organizationId = org.id;
  const people: Record<string, { id: string; name: string }> = {};
  for (const [email, role, key] of ACCOUNTS) {
    const user = accounts.find((a) => a.email === email);
    if (!user) continue;
    people[key] = { id: user.id, name: user.name };
    await prisma.membership.create({ data: { userId: user.id, organizationId, role } });
  }
  const who = (key: string) => people[key] ?? people.owner!;

  // ── Teams ──
  const teams: Record<string, string> = {};
  for (const t of [
    { slug: 'platform', name: 'Platform', description: 'Edge, data stores and shared infrastructure', members: [['owner', true, false], ['sre', false, true]] },
    { slug: 'commerce', name: 'Commerce', description: 'Orders, inventory and customer notifications', members: [['dev', true, true], ['viewer', false, false]] },
    { slug: 'payments', name: 'Payments', description: 'Card authorisation and capture', members: [['admin', true, true]] },
  ] as const) {
    const members = t.members.filter(([k]) => people[k]).map(([k, isLead, onCall]) => ({ userId: people[k]!.id, isLead, onCall }));
    teams[t.slug] = (await prisma.team.create({ data: { organizationId, slug: t.slug, name: t.name, description: t.description, members: { create: members } } })).id;
  }

  // ── Services and what depends on what ──
  // Health is not set here for long: the worker recomputes it every minute from firing alerts
  // and active incidents. The values below are what that computation arrives at.
  const serviceDefs = [
    { slug: 'api-gateway', name: 'API Gateway', tier: 'TIER1', team: 'platform', language: 'Go', health: 'DEGRADED', note: '1 alert firing', tags: ['edge', 'customer-facing'], description: 'Public entry point. Authenticates requests and orchestrates checkout across orders, payments and inventory.' },
    { slug: 'shop-orders', name: 'Shop Orders', tier: 'TIER1', team: 'commerce', language: 'TypeScript', health: 'HEALTHY', note: 'All alert rules within thresholds', tags: ['orders', 'critical-path'], description: 'Creates and stores orders in PostgreSQL. Publishes order events for notifications.' },
    { slug: 'shop-payments', name: 'Shop Payments', tier: 'TIER1', team: 'payments', language: 'Kotlin', health: 'DEGRADED', note: '1 alert firing', tags: ['pci', 'critical-path'], description: 'Card authorisation and capture through the external payment gateway (PayGate).' },
    { slug: 'shop-inventory', name: 'Shop Inventory', tier: 'TIER2', team: 'commerce', language: 'Go', health: 'DOWN', note: 'Active SEV1 incident', tags: ['catalogue'], description: 'Stock levels and reservations. Reads through a Redis cache in front of PostgreSQL.' },
    { slug: 'shop-notifications', name: 'Shop Notifications', tier: 'TIER3', team: 'commerce', language: 'Python', health: 'UNKNOWN', note: 'No telemetry received in the last 15 minutes', tags: ['async'], description: 'Order confirmation e-mails and SMS, driven by order events.' },
    { slug: 'shop-redis', name: 'Shop Redis', tier: 'TIER2', team: 'platform', language: 'Redis', health: 'DOWN', note: 'Critical alert firing: Redis unavailable', tags: ['datastore', 'cache'], description: 'Redis 7 primary with one replica. Stock cache and reservation locks for shop-inventory. maxmemory 2 GB.' },
  ] as const;
  const services: Record<string, string> = {};
  for (const s of serviceDefs) {
    const created = await prisma.service.create({
      data: {
        organizationId, slug: s.slug, name: s.name, tier: s.tier, language: s.language, description: s.description, tags: [...s.tags], ownerTeamId: teams[s.team], health: s.health, healthNote: s.note, healthAt: new Date(),
        repoUrl: s.slug === 'shop-redis' ? null : `https://github.com/acme-commerce/${s.slug}`,
        runbookUrl: null,
      },
    });
    services[s.slug] = created.id;
  }
  const deps: [string, string, string, string][] = [
    ['api-gateway', 'shop-orders', 'sync', 'POST /api/orders, GET /api/orders/:id'],
    ['api-gateway', 'shop-payments', 'sync', 'POST /api/checkout: authorise and capture'],
    ['api-gateway', 'shop-inventory', 'sync', 'GET /api/stock, stock reservation during checkout'],
    ['shop-orders', 'shop-notifications', 'async', 'order.created and order.shipped events'],
    ['shop-inventory', 'shop-redis', 'datastore', 'Stock cache and reservation locks'],
  ];
  await prisma.serviceDependency.createMany({ data: deps.map(([a, b, kind, description]) => ({ serviceId: services[a]!, dependsOnId: services[b]!, kind, description })) });

  // ── The story, as offsets back from now ──
  // The database incident is more than 24 hours before the quiet one on the same service: an
  // investigation is shown the alerts of the preceding 24 hours, and those would not be quiet.
  const DB = { change: 40 * HOUR + 12 * MIN, onset: 40 * HOUR + 6 * MIN, incident: 40 * HOUR, restore: 38 * HOUR + 40 * MIN, recovered: 38 * HOUR + 34 * MIN, resolved: 38 * HOUR + 30 * MIN };
  const QUIET = { incident: 9 * HOUR, resolved: 8 * HOUR };
  const SILENT = { lastTelemetry: 30 * HOUR, incident: 3 * HOUR, mitigated: 1 * HOUR };
  const PAY = { deploy: 58 * MIN, onset: 54 * MIN, incident: 52 * MIN };
  const REDIS = { warning: 70 * MIN, down: 27 * MIN, incident: 24 * MIN };
  const ramp = (at: number, from: number, to: number, over: number) => (at > from || at < to ? 0 : Math.min(1, (from - at) / over));
  const kDb = (at: number) => ramp(at, DB.onset, DB.recovered, 6 * MIN);
  const kPay = (at: number) => ramp(at, PAY.onset, 0, 4 * MIN);
  const kRedis = (at: number) => ramp(at, REDIS.down, 0, MIN);

  // ── Repositories, commits and pull requests (sample data, flagged isMock) ──
  const repos: Record<string, string> = {};
  for (const slug of ['api-gateway', 'shop-orders', 'shop-payments', 'shop-inventory']) {
    repos[slug] = (await prisma.repository.create({ data: { organizationId, fullName: `acme-commerce/${slug}`, serviceId: services[slug], isMock: true, lastSyncedAt: new Date() } })).id;
  }
  interface Change { repo: string; at: number; number: number; title: string; body: string; author: string; labels: string[]; files: [string, number, number][] }
  const changes: Change[] = [
    { repo: 'shop-payments', at: PAY.deploy + 3 * HOUR, number: 214, author: 'marcus-oyelaran', labels: ['payments', 'provider'], title: 'Move card authorisation to PayGate API v2', body: 'PayGate retires API v1 next quarter. Switches the authorisation client to v2 and the new request signature.\n\nThe v2 endpoint is enabled per merchant account by PayGate. Verified against the sandbox account.', files: [['src/main/kotlin/gateway/PayGateClient.kt', 96, 71], ['src/main/kotlin/gateway/Signature.kt', 44, 12], ['src/main/resources/application-production.yaml', 2, 2], ['src/test/kotlin/gateway/PayGateClientTest.kt', 120, 40]] },
    { repo: 'shop-payments', at: 6 * DAY + 2 * HOUR, number: 211, author: 'marcus-oyelaran', labels: ['reliability'], title: 'Retry idempotent captures once on gateway 5xx', body: 'Bounded retry with jitter. Authorisations are never retried.', files: [['src/main/kotlin/capture/CaptureClient.kt', 31, 8]] },
    { repo: 'shop-orders', at: DB.restore + 20 * MIN, number: 388, author: 'tomas-herrera', labels: ['config', 'database'], title: 'Pin DB_POOL_MAX=40 in the release configuration', body: 'The pool limit was lowered at runtime for the database maintenance window and starved order writes. Pins the limit in the release so a runtime override cannot go below it unnoticed.', files: [['config/production.yaml', 3, 1], ['src/db/pool.ts', 9, 2]] },
    { repo: 'shop-orders', at: 4 * DAY + 3 * HOUR, number: 385, author: 'tomas-herrera', labels: ['feature'], title: 'Order history endpoint with pagination', body: 'Adds GET /orders?customer=… with keyset pagination.', files: [['src/orders/history.repository.ts', 77, 0], ['src/orders/history.controller.ts', 39, 0]] },
    { repo: 'shop-inventory', at: 2 * DAY + HOUR, number: 97, author: 'tomas-herrera', labels: ['performance'], title: 'Batch stock lookups through a Redis pipeline', body: 'Reduces round trips for multi-item carts.', files: [['internal/cache/pipeline.go', 88, 14]] },
    { repo: 'api-gateway', at: 3 * DAY + 2 * HOUR, number: 143, author: 'lena-fischer', labels: ['config'], title: 'Per-route upstream timeouts', body: 'Checkout 8 s, stock 2 s, everything else 5 s.', files: [['config/routes.yaml', 12, 4]] },
  ];
  const commitOf = (c: Pick<Change, 'repo' | 'number'>) => sha(`${c.repo}#${c.number}`);
  for (const c of changes) {
    const mergedAt = ago(c.at);
    await prisma.commit.create({
      data: {
        repositoryId: repos[c.repo]!, sha: commitOf(c), message: `${c.title} (#${c.number})\n\n${c.body}`, authorLogin: c.author, authorName: c.author, committedAt: mergedAt,
        additions: c.files.reduce((a, f) => a + f[1], 0), deletions: c.files.reduce((a, f) => a + f[2], 0),
        filesChanged: c.files.map(([filename, additions, deletions]) => ({ filename, additions, deletions, status: additions && !deletions ? 'added' : 'modified' })),
      },
    });
    await prisma.pullRequest.create({
      data: { repositoryId: repos[c.repo]!, number: c.number, title: c.title, body: c.body, state: 'merged', authorLogin: c.author, baseBranch: 'main', headBranch: `${c.author}/${c.number}`, mergeCommitSha: commitOf(c), labels: c.labels, openedAt: new Date(mergedAt.getTime() - int(3, 30) * HOUR), mergedAt, closedAt: mergedAt, additions: c.files.reduce((a, f) => a + f[1], 0), deletions: c.files.reduce((a, f) => a + f[2], 0), changedFiles: c.files.length },
    });
  }

  // ── Deployments ──
  const deployments: Prisma.DeploymentCreateManyInput[] = [];
  const deploy = (slug: string, version: string, at: number, extra: Partial<Prisma.DeploymentCreateManyInput> = {}) =>
    deployments.push({ organizationId, serviceId: services[slug]!, version, environment: 'production', status: 'SUCCEEDED', deployedBy: 'deploy-bot', source: 'api', branch: 'main', startedAt: ago(at), finishedAt: ago(at - 3 * MIN), ...extra });
  // The problematic release, and the healthy one before it.
  deploy('shop-payments', 'v3.8.0', PAY.deploy, { commitSha: commitOf({ repo: 'shop-payments', number: 214 }), description: 'Card authorisation through PayGate API v2 (#214)', deployedBy: who('admin').name });
  deploy('shop-payments', 'v3.7.2', 6 * DAY, { commitSha: commitOf({ repo: 'shop-payments', number: 211 }), description: 'Capture retries (#211)' });
  deploy('shop-payments', 'v3.7.1', 15 * DAY, { description: 'Dependency updates' });
  // The recovery deployment after the database latency incident.
  deploy('shop-orders', 'v5.2.4', DB.restore - 2 * MIN, { commitSha: commitOf({ repo: 'shop-orders', number: 388 }), description: 'Pin DB_POOL_MAX=40 in the release configuration (#388)', deployedBy: who('dev').name });
  deploy('shop-orders', 'v5.2.3', 4 * DAY, { commitSha: commitOf({ repo: 'shop-orders', number: 385 }), description: 'Order history endpoint (#385)' });
  // A failed deployment: the canary never passed, so the previous version kept serving.
  deploy('shop-inventory', 'v2.5.0', 2 * DAY, { status: 'FAILED', commitSha: commitOf({ repo: 'shop-inventory', number: 97 }), description: 'Redis pipeline for stock lookups (#97). Canary failed its health check; the pipeline stopped and v2.4.6 kept serving.' });
  deploy('shop-inventory', 'v2.4.6', 8 * DAY, { description: 'Reservation expiry fix' });
  deploy('api-gateway', 'v1.19.0', 3 * DAY, { commitSha: commitOf({ repo: 'api-gateway', number: 143 }), description: 'Per-route upstream timeouts (#143)' });
  deploy('shop-notifications', 'v1.4.2', 11 * DAY, { description: 'SMS template refresh' });
  // Older history, so the deployment trend in analytics is not empty.
  for (let d = 16; d < 45; d++) {
    for (const slug of ['api-gateway', 'shop-orders', 'shop-payments', 'shop-inventory', 'shop-notifications']) {
      if (rand() < 0.2) deploy(slug, `v${int(1, 5)}.${int(0, 20)}.${int(0, 9)}`, d * DAY + between(1, 9) * HOUR, { status: rand() < 0.08 ? 'FAILED' : 'SUCCEEDED' });
    }
  }
  await prisma.deployment.createMany({ data: deployments });

  // ── Service events ──
  await prisma.serviceEvent.createMany({
    data: [
      { organizationId, serviceId: services['shop-orders']!, type: 'config_change', title: 'DB_POOL_MAX lowered from 40 to 12', details: 'Runtime override applied ahead of the PostgreSQL maintenance window, to free connections for the migration tooling.', actor: who('sre').name, source: 'manual', occurredAt: ago(DB.change) },
      { organizationId, serviceId: services['shop-orders']!, type: 'config_change', title: 'DB_POOL_MAX restored to 40', details: 'Override removed after order writes began timing out waiting for a connection.', actor: who('sre').name, source: 'manual', occurredAt: ago(DB.restore) },
      { organizationId, serviceId: services['shop-notifications']!, type: 'infrastructure', title: 'Moved to the new node pool', details: 'Workload rescheduled onto node pool np-2. The log shipper and metrics agent run as node add-ons.', actor: who('sre').name, source: 'manual', occurredAt: ago(SILENT.lastTelemetry) },
      { organizationId, serviceId: services['shop-inventory']!, type: 'feature_flag', title: 'Flag bulk_stock_import enabled for the wholesale channel', actor: who('dev').name, source: 'api', occurredAt: ago(2 * DAY + 5 * HOUR) },
      { organizationId, serviceId: services['shop-redis']!, type: 'maintenance', title: 'Replica rebuilt after disk replacement', actor: who('sre').name, source: 'manual', occurredAt: ago(6 * DAY) },
      { organizationId, serviceId: services['api-gateway']!, type: 'scaling', title: 'Autoscaler added 1 gateway replica (4 → 5)', actor: 'autoscaler', source: 'api', occurredAt: ago(40 * MIN) },
    ],
  });

  // ── Metrics: three days, one sample a minute for the last three hours, one every five before ──
  const metrics: Prisma.MetricSampleCreateManyInput[] = [];
  const noise = (v: number, pct = 0.06) => Math.max(0, v * (1 + (rand() - 0.5) * 2 * pct));
  const sample = (slug: string, metric: string, value: number, at: number) => metrics.push({ organizationId, serviceId: services[slug]!, metric, value: Math.round(value * 100) / 100, timestamp: ago(at) });
  const emit = (at: number) => {
    const db = kDb(at);
    const pay = kPay(at);
    const redis = kRedis(at);
    const daily = 1 + 0.08 * Math.sin(((now - at) / DAY) * 2 * Math.PI);
    const std = (slug: string, rps: number, err: number, p95: number, cpu: number, mem: number) => {
      sample(slug, 'requests_per_min', noise(rps * daily), at);
      sample(slug, 'error_rate', noise(err, 0.15), at);
      sample(slug, 'latency_p95_ms', noise(p95), at);
      sample(slug, 'cpu_percent', noise(cpu), at);
      sample(slug, 'memory_percent', noise(mem, 0.02), at);
    };
    std('api-gateway', 2600 * (1 - 0.12 * pay - 0.1 * redis), 0.3 + 3 * db + 4.6 * pay + 3.4 * redis, 85 + 700 * db + 110 * pay + 380 * redis, 41, 46);
    std('shop-orders', 380 * (1 - 0.35 * db - 0.2 * pay), 0.3 + 13 * db, 170 + 2900 * db, 36 - 10 * db, 55);
    const pool = at <= DB.change && at > DB.restore ? 12 : 40;
    const used = pool === 12 ? 12 : noise(22, 0.12);
    sample('shop-orders', 'db_connections', used, at);
    sample('shop-orders', 'db_pool_usage_percent', (used / pool) * 100, at);
    std('shop-payments', 210 * (1 - 0.25 * pay), 0.5 + 21 * pay, 290 + 180 * pay, 28 + 6 * pay, 49);
    sample('shop-payments', 'db_connections', noise(9, 0.12), at);
    sample('shop-payments', 'db_pool_usage_percent', noise(30, 0.1), at);
    std('shop-inventory', 820 * (1 - 0.4 * redis), 0.2 + 37 * redis, 48 + 2050 * redis, 30, 40);
    sample('shop-inventory', 'db_connections', noise(7, 0.12), at);
    sample('shop-inventory', 'db_pool_usage_percent', noise(35, 0.1), at);
    // shop-notifications stopped sending telemetry when it moved node pool.
    if (at >= SILENT.lastTelemetry) {
      std('shop-notifications', 55, 0.4, 380, 17, 34);
      sample('shop-notifications', 'queue_depth', noise(12, 0.3), at);
    }
    // Redis: memory climbs to the limit, then the process is gone. Only the probe keeps reporting.
    const up = at > REDIS.down;
    sample('shop-redis', 'redis_up', up ? 1 : 0, at);
    if (up) {
      const climb = at < REDIS.warning ? (REDIS.warning - at) / (REDIS.warning - REDIS.down) : 0;
      sample('shop-redis', 'memory_percent', noise(71 + 27 * climb, 0.01), at);
      sample('shop-redis', 'cpu_percent', noise(12 + 30 * climb), at);
      sample('shop-redis', 'redis_connected_clients', noise(64, 0.05), at);
    }
  };
  for (let at = 0; at <= 3 * HOUR; at += MIN) emit(at);
  for (let at = 3 * HOUR + 5 * MIN; at <= 3 * DAY; at += 5 * MIN) emit(at);
  for (let i = 0; i < metrics.length; i += 5000) await prisma.metricSample.createMany({ data: metrics.slice(i, i + 5000) });

  // ── Logs: two days of ordinary traffic, and the three failures ──
  const logs: Prisma.LogEntryCreateManyInput[] = [];
  const log = (slug: string, level: LogLevel, message: string, at: number, attributes?: Prisma.InputJsonValue, traceId?: string) => {
    if (at < 0) return;
    logs.push({ organizationId, serviceId: services[slug]!, level, message, timestamp: ago(at), environment: 'production', host: `${slug}-${int(1, 5)}`, traceId, fingerprint: fingerprint(message), attributes });
  };
  const trace = () => sha(String(rand())).slice(0, 32);
  const ordinary: [string, LogLevel, () => string][] = [
    ['api-gateway', 'INFO', () => `GET /api/products?page=${int(1, 40)} 200 ${int(8, 90)}ms`],
    ['api-gateway', 'INFO', () => `POST /api/checkout 200 ${int(180, 420)}ms`],
    ['api-gateway', 'INFO', () => `GET /api/stock/SKU-${int(1000, 9999)} 200 ${int(6, 40)}ms`],
    ['shop-orders', 'INFO', () => `order created order_id=${int(510000, 529999)} total_cents=${int(900, 42000)} duration=${int(90, 240)}ms`],
    ['shop-orders', 'INFO', () => `order history served customer=${int(1000, 99999)} rows=${int(1, 25)} duration=${int(12, 60)}ms`],
    ['shop-orders', 'DEBUG', () => `published order.created order_id=${int(510000, 529999)}`],
    ['shop-payments', 'INFO', () => `payment authorised provider=paygate amount_cents=${int(900, 42000)} latency=${int(160, 380)}ms`],
    ['shop-payments', 'INFO', () => `capture settled order=${int(510000, 529999)} provider_ref=pg_${sha(String(rand())).slice(0, 10)}`],
    ['shop-inventory', 'INFO', () => `stock served sku=SKU-${int(1000, 9999)} source=cache latency=${int(1, 6)}ms`],
    ['shop-inventory', 'INFO', () => `reserved sku=SKU-${int(1000, 9999)} qty=${int(1, 4)} order=${int(510000, 529999)}`],
    ['shop-notifications', 'INFO', () => `sent order confirmation email order_id=${int(510000, 529999)} provider_latency=${int(120, 600)}ms`],
    ['shop-redis', 'INFO', () => `Background saving terminated with success`],
    ['shop-redis', 'INFO', () => `${int(100, 900)} changes in 300 seconds. Saving...`],
    ['shop-payments', 'WARN', () => `provider responded slowly latency=${int(900, 1500)}ms attempt=1`],
    ['shop-inventory', 'WARN', () => `stock below threshold sku=SKU-${int(1000, 9999)} remaining=${int(1, 5)}`],
    ['api-gateway', 'WARN', () => `rate limit applied client=${int(10, 250)}.${int(0, 255)}.x.x route=/api/products`],
  ];
  for (let at = 0; at <= 2 * DAY; at += 25_000) {
    const [slug, level, make] = pick(ordinary);
    if (slug === 'shop-notifications' && at < SILENT.lastTelemetry) continue; // silent since the move
    if (slug === 'shop-redis' && at < REDIS.down) continue; // the process is gone
    if (level === 'WARN' && rand() > 0.35) continue;
    // During a failure, the successes of the failing service become rare.
    if (level !== 'WARN' && ((slug === 'shop-orders' && kDb(at) > 0.5) || (slug === 'shop-payments' && kPay(at) > 0.5) || (slug === 'shop-inventory' && kRedis(at) > 0.5)) && rand() < 0.75) continue;
    log(slug, level, make(), at + between(0, 25_000));
  }

  // 1. Database latency on shop-orders, the day before yesterday: the pool was lowered, order writes queued for a connection.
  log('shop-orders', 'INFO', 'configuration reloaded: DB_POOL_MAX=12 (was 40) source=runtime-override', DB.change - 5000, { pool: { max: 12, previous: 40 } });
  for (let at = DB.onset; at >= DB.recovered; at -= 5000) {
    if (rand() > kDb(at) * 0.85) continue;
    const t = trace();
    const waited = int(3000, 3040);
    log('shop-orders', 'ERROR', `timeout acquiring connection from pool after ${waited}ms (active=12 idle=0 waiting=${int(14, 120)})`, at, { pool: { max: 12, active: 12, idle: 0 }, route: pick(['POST /orders', 'POST /orders', 'GET /orders']) }, t);
    if (rand() < 0.5) log('shop-orders', 'ERROR', `POST /orders failed: ConnectionAcquireTimeoutError order_draft=${int(440000, 449999)} duration=${waited + int(5, 40)}ms`, at - 40, { errorType: 'ConnectionAcquireTimeoutError', status: 503 }, t);
    if (rand() < 0.3) log('shop-orders', 'WARN', `slow query: INSERT INTO orders ... took ${int(1800, 4200)}ms (waited ${int(1500, 3000)}ms for a connection)`, at + 300, { table: 'orders' }, t);
    if (rand() < 0.35) log('api-gateway', 'ERROR', `upstream shop-orders returned 503 for POST /api/orders after ${waited + int(20, 90)}ms`, at - 80, { upstream: 'shop-orders', status: 503 }, t);
  }
  log('shop-orders', 'INFO', 'configuration reloaded: DB_POOL_MAX=40 (was 12) source=runtime-override', DB.restore - 5000, { pool: { max: 40, previous: 12 } });
  log('shop-orders', 'INFO', 'starting shop-orders version=v5.2.4 commit=' + commitOf({ repo: 'shop-orders', number: 388 }).slice(0, 7), DB.restore - 3 * MIN);
  log('shop-orders', 'INFO', 'connection pool recovered: active=18 idle=22 waiting=0', DB.recovered);
  log('shop-orders', 'INFO', 'order backlog drained: 0 requests waiting, error rate back to baseline', DB.recovered - 2 * MIN);

  // 2. The bad deployment: shop-payments v3.8.0 calls a gateway API the merchant account does not have.
  log('shop-payments', 'INFO', 'starting shop-payments version=v3.8.0 commit=' + commitOf({ repo: 'shop-payments', number: 214 }).slice(0, 7), PAY.deploy - 2 * MIN);
  log('shop-payments', 'INFO', 'payment gateway client initialised provider=paygate api=v2 signature=hmac-sha256', PAY.deploy - 2 * MIN - 2000, { provider: 'paygate', apiVersion: 'v2' });
  for (let at = PAY.onset; at >= 0; at -= 4000) {
    if (rand() > kPay(at) * 0.8) continue;
    const t = trace();
    const order = int(510000, 529999);
    log('shop-payments', 'ERROR', `card authorisation failed: gateway responded 400 unsupported_api_version (provider=paygate api=v2 merchant=acme-live)`, at, { provider: 'paygate', apiVersion: 'v2', gatewayStatus: 400, gatewayCode: 'unsupported_api_version' }, t);
    if (rand() < 0.55) log('shop-payments', 'ERROR', `POST /payments/authorise 500 PaymentGatewayError order=${order} duration=${int(140, 420)}ms`, at - 30, { errorType: 'PaymentGatewayError', status: 500 }, t);
    if (rand() < 0.4) log('api-gateway', 'ERROR', `upstream shop-payments returned 500 for POST /api/checkout after ${int(160, 480)}ms`, at - 60, { upstream: 'shop-payments', status: 500 }, t);
    if (rand() < 0.25) log('shop-orders', 'WARN', `payment step failed for order ${order}; order left in pending_payment`, at - 90, { order }, t);
  }

  // 3. Redis runs out of memory and is killed; shop-inventory cannot reach its cache.
  for (let at = REDIS.warning; at > REDIS.down; at -= 90_000) {
    log('shop-redis', 'WARN', `memory usage ${int(90, 99)}% of maxmemory (2gb), eviction policy noeviction`, at, { maxmemory: '2gb', policy: 'noeviction' });
    if (at < REDIS.down + 12 * MIN) log('shop-redis', 'ERROR', "Can't save in background: fork: Cannot allocate memory", at - 20_000);
  }
  log('shop-redis', 'FATAL', 'Out Of Memory allocating 16384 bytes!', REDIS.down + 3000);
  for (let at = REDIS.down; at >= 0; at -= 3000) {
    if (rand() > kRedis(at) * 0.8) continue;
    const t = trace();
    log('shop-inventory', 'ERROR', `redis connection refused: connect ECONNREFUSED shop-redis:6379 (attempt ${int(1, 4)})`, at, { dependency: 'shop-redis', errorCode: 'ECONNREFUSED' }, t);
    if (rand() < 0.5) log('shop-inventory', 'ERROR', `GET /stock/SKU-${int(1000, 9999)} failed: request timeout after 2000ms waiting for cache`, at - 40, { errorType: 'RequestTimeout', status: 504 }, t);
    if (rand() < 0.35) log('api-gateway', 'ERROR', `upstream shop-inventory returned 504 for GET /api/stock after ${int(2000, 2060)}ms`, at - 70, { upstream: 'shop-inventory', status: 504 }, t);
    if (rand() < 0.08) log('shop-inventory', 'WARN', `cache unavailable, falling back to database for sku=SKU-${int(1000, 9999)} (slow path)`, at + 200);
  }
  for (let i = 0; i < logs.length; i += 5000) await prisma.logEntry.createMany({ data: logs.slice(i, i + 5000) });

  // ── Alert rules, and the alerts that the latest samples breach ──
  const rule = (slug: string, name: string, metric: string, threshold: number, severity: 'SEV1' | 'SEV2' | 'SEV3', comparator = 'gt') =>
    prisma.alertRule.create({ data: { organizationId, serviceId: services[slug]!, name, metric, threshold, severity, comparator, windowMinutes: 5 } });
  const rules = {
    payments: await rule('shop-payments', 'Payment error rate high', 'error_rate', 5, 'SEV2'),
    gateway: await rule('api-gateway', 'Gateway error rate high', 'error_rate', 4, 'SEV2'),
    inventory: await rule('shop-inventory', 'Inventory error rate high', 'error_rate', 5, 'SEV2'),
    redis: await rule('shop-redis', 'Redis unavailable', 'redis_up', 1, 'SEV1', 'lt'),
    orders: await rule('shop-orders', 'Order error rate high', 'error_rate', 5, 'SEV2'),
    ordersLatency: await rule('shop-orders', 'Order p95 latency high', 'latency_p95_ms', 1500, 'SEV3'),
  };

  // ── Incidents ──
  let counter = 0;
  interface Event { type: string; message: string; by?: string; system?: boolean; at: number }
  interface Inc {
    title: string; description: string; severity: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4'; status: 'INVESTIGATING' | 'MITIGATED' | 'RESOLVED' | 'CLOSED'; source: 'manual' | 'alert';
    services: string[]; start: number; ack?: number; mitigated?: number; resolved?: number; closed?: number; assignee: string; commander?: string; impact?: string; rootCause?: string; resolution?: string; events: Event[];
  }
  const open = async (i: Inc) => {
    const event = (e: Event) => ({ type: e.type, message: e.message, actorType: e.system ? 'system' : 'user', actorId: e.system ? null : who(e.by ?? i.assignee).id, actorLabel: e.system ? 'OPSILUME monitoring' : who(e.by ?? i.assignee).name, createdAt: ago(e.at) });
    const created = await prisma.incident.create({
      data: {
        organizationId, number: ++counter, title: i.title, description: i.description, severity: i.severity, status: i.status, source: i.source, customerImpact: i.impact, rootCause: i.rootCause, resolution: i.resolution,
        createdById: i.source === 'alert' ? null : who(i.commander ?? 'sre').id, assigneeId: who(i.assignee).id, commanderId: i.commander ? who(i.commander).id : null,
        startedAt: ago(i.start), createdAt: ago(i.start), acknowledgedAt: i.ack ? ago(i.ack) : null, mitigatedAt: i.mitigated ? ago(i.mitigated) : null, resolvedAt: i.resolved ? ago(i.resolved) : null, closedAt: i.closed ? ago(i.closed) : null,
        services: { create: i.services.map((s) => ({ serviceId: services[s]! })) },
        events: { create: [{ type: 'created', message: `Incident opened as ${i.severity}`, actorType: i.source === 'alert' ? 'system' : 'user', actorId: i.source === 'alert' ? null : who(i.commander ?? 'sre').id, actorLabel: i.source === 'alert' ? 'OPSILUME monitoring' : who(i.commander ?? 'sre').name, createdAt: ago(i.start) }, ...i.events.map(event)] },
      },
    });
    return created.id;
  };
  const incidents = {
    inventoryTimeout: await open({
      title: 'Inventory service timeouts on stock lookups', severity: 'SEV3', status: 'CLOSED', source: 'manual', services: ['shop-inventory'], assignee: 'dev', commander: 'sre',
      description: 'Stock lookups for large carts timed out at the gateway (2 s limit). Small carts were unaffected.',
      impact: 'About 3% of product pages showed "stock unavailable" for 80 minutes.',
      rootCause: 'A table rewrite during routine maintenance dropped the index on reservations(sku, expires_at). Cache misses fell through to sequential scans.',
      resolution: 'Recreated the index concurrently and added it to the schema drift check.',
      start: 13 * DAY, ack: 13 * DAY - 9 * MIN, mitigated: 13 * DAY - 60 * MIN, resolved: 13 * DAY - 80 * MIN, closed: 12 * DAY,
      events: [{ type: 'status_change', message: 'Status changed from OPEN to INVESTIGATING', at: 13 * DAY - 9 * MIN }, { type: 'update', message: 'Root cause recorded', at: 13 * DAY - 55 * MIN }, { type: 'status_change', message: 'Status changed from INVESTIGATING to RESOLVED', at: 13 * DAY - 80 * MIN }],
    }),
    paymentErrors: await open({
      title: 'Payment service elevated error rate', severity: 'SEV2', status: 'CLOSED', source: 'alert', services: ['shop-payments', 'api-gateway'], assignee: 'admin', commander: 'owner',
      description: 'Payment error rate rose to 9% for card authorisations. Captures were unaffected.',
      impact: 'Roughly 1 in 11 checkouts failed at the payment step for 45 minutes.',
      rootCause: 'Regional outage at the payment gateway PayGate (their incident PG-7731). Authorisations routed to the affected region returned 503.',
      resolution: 'Failed over to the secondary PayGate region with the payment_region flag. No code change.',
      start: 9 * DAY, ack: 9 * DAY - 3 * MIN, mitigated: 9 * DAY - 31 * MIN, resolved: 9 * DAY - 45 * MIN, closed: 8 * DAY,
      events: [{ type: 'alert', message: 'Alert firing: Payment error rate high (error_rate averaged 9.1% over 5m)', system: true, at: 9 * DAY }, { type: 'status_change', message: 'Status changed from OPEN to INVESTIGATING', at: 9 * DAY - 3 * MIN }, { type: 'comment', message: 'PayGate status page confirms a regional outage. Failing over.', at: 9 * DAY - 20 * MIN }, { type: 'status_change', message: 'Status changed from INVESTIGATING to RESOLVED', at: 9 * DAY - 45 * MIN }],
    }),
    notificationDelays: await open({
      title: 'Notification delivery delays', severity: 'SEV3', status: 'RESOLVED', source: 'manual', services: ['shop-notifications'], assignee: 'dev', commander: 'sre',
      description: 'Order confirmation e-mails arrived up to 40 minutes late. No e-mails were lost.',
      impact: 'Support received 60 "where is my confirmation" contacts.',
      rootCause: 'The e-mail provider throttled the account after a template change doubled message size.',
      resolution: 'Compressed inline images and asked the provider to raise the sending quota.',
      start: 5 * DAY, ack: 5 * DAY - 18 * MIN, mitigated: 5 * DAY - 90 * MIN, resolved: 5 * DAY - 2 * HOUR,
      events: [{ type: 'status_change', message: 'Status changed from OPEN to INVESTIGATING', at: 5 * DAY - 18 * MIN }, { type: 'comment', message: 'Queue depth is climbing but nothing is failing. Looks like throttling on the provider side.', at: 5 * DAY - 40 * MIN }, { type: 'status_change', message: 'Status changed from INVESTIGATING to RESOLVED', at: 5 * DAY - 2 * HOUR }],
    }),
    dbLatency: await open({
      title: 'Database latency affecting order processing', severity: 'SEV2', status: 'RESOLVED', source: 'alert', services: ['shop-orders'], assignee: 'dev', commander: 'sre',
      description: 'Order creation became slow and then started failing with 503. p95 latency for POST /orders rose from under 200 ms to about 3 s.',
      impact: 'About 13% of orders failed and the rest were slow for roughly 90 minutes.',
      start: DB.incident, ack: DB.incident - 4 * MIN, mitigated: DB.restore, resolved: DB.resolved,
      events: [
        { type: 'alert', message: 'Alert firing: Order error rate high (error_rate averaged 11.8% over 5m)', system: true, at: DB.incident },
        { type: 'status_change', message: 'Status changed from OPEN to INVESTIGATING', at: DB.incident - 4 * MIN },
        { type: 'comment', message: 'PostgreSQL itself looks fine: CPU normal, plenty of free connections on the server side.', by: 'sre', at: DB.incident - 25 * MIN },
        { type: 'comment', message: 'Order writes are back to normal. Leaving this open for a proper investigation of the cause.', at: DB.recovered - 3 * MIN },
        { type: 'status_change', message: 'Status changed from INVESTIGATING to RESOLVED', at: DB.resolved },
      ],
    }),
    quiet: await open({
      title: 'Reports of slow order confirmation, not reproduced', severity: 'SEV4', status: 'RESOLVED', source: 'manual', services: ['shop-orders'], assignee: 'dev', commander: 'sre',
      description: 'Support forwarded two customer reports that the order confirmation page was slow to appear. Opened to check whether shop-orders had a problem.',
      resolution: 'Nothing found by hand at the time. Closed as not reproduced.',
      start: QUIET.incident, ack: QUIET.incident - 10 * MIN, resolved: QUIET.resolved,
      events: [{ type: 'status_change', message: 'Status changed from OPEN to INVESTIGATING', at: QUIET.incident - 10 * MIN }, { type: 'comment', message: 'Could not reproduce from three regions. Dashboards look ordinary to me.', at: QUIET.incident - 35 * MIN }, { type: 'status_change', message: 'Status changed from INVESTIGATING to RESOLVED', at: QUIET.resolved }],
    }),
    silent: await open({
      title: 'Order confirmation e-mails reported missing', severity: 'SEV3', status: 'MITIGATED', source: 'manual', services: ['shop-notifications'], assignee: 'dev', commander: 'sre',
      description: 'Support reports customers not receiving order confirmations since this morning. shop-notifications shows nothing on its dashboards: no logs and no metrics at all.',
      impact: 'Unknown number of confirmations affected. Orders themselves are placed correctly.',
      start: SILENT.incident, ack: SILENT.incident - 12 * MIN, mitigated: SILENT.mitigated,
      events: [
        { type: 'status_change', message: 'Status changed from OPEN to INVESTIGATING', at: SILENT.incident - 12 * MIN },
        { type: 'comment', message: 'I cannot tell whether the service is failing or just not reporting. The dashboards have been empty since yesterday.', at: SILENT.incident - 30 * MIN },
        { type: 'comment', message: 'Re-sent the confirmations for today from the orders table by hand. Marking as mitigated; cause still unknown.', at: SILENT.mitigated + 2 * MIN },
        { type: 'status_change', message: 'Status changed from INVESTIGATING to MITIGATED', at: SILENT.mitigated },
      ],
    }),
    badDeploy: await open({
      title: 'Checkout failing at payment after shop-payments v3.8.0', severity: 'SEV2', status: 'INVESTIGATING', source: 'alert', services: ['shop-payments'], assignee: 'admin', commander: 'sre',
      description: 'Card authorisations are failing with HTTP 500 from shop-payments. The gateway shows elevated 500s on POST /api/checkout. Began minutes after a deployment of shop-payments.',
      impact: 'About 1 in 5 checkouts fail at the payment step. Browsing, cart and stock are unaffected by this.',
      start: PAY.incident, ack: PAY.incident - 3 * MIN,
      events: [
        { type: 'alert', message: 'Alert firing: Payment error rate high (error_rate averaged 19.6% over 5m)', system: true, at: PAY.incident },
        { type: 'status_change', message: 'Status changed from OPEN to INVESTIGATING', by: 'sre', at: PAY.incident - 3 * MIN },
        { type: 'assignment', message: `Assigned to ${who('admin').name}`, by: 'sre', at: PAY.incident - 4 * MIN },
        { type: 'comment', message: 'PayGate status page is green and the sandbox works. Whatever this is, it is on our side or specific to our live account.', at: PAY.incident - 15 * MIN },
      ],
    }),
    redisOutage: await open({
      // On shop-inventory, where the symptoms are. shop-redis is its dependency; an investigation
      // treats a service named in the incident as the subject, never as an independent cause.
      title: 'Redis dependency outage: stock lookups failing', severity: 'SEV1', status: 'INVESTIGATING', source: 'alert', services: ['shop-inventory'], assignee: 'sre', commander: 'owner',
      description: 'Stock lookups from shop-inventory are timing out at the gateway and its error rate is far above normal. The Redis availability probe is also alerting.',
      impact: 'Stock availability is missing on product pages and about 2 in 5 stock requests fail. Checkout cannot reserve stock.',
      start: REDIS.incident, ack: REDIS.incident - 2 * MIN,
      events: [
        { type: 'alert', message: 'Alert firing: Redis unavailable (redis_up averaged 0 over 5m)', system: true, at: REDIS.incident },
        { type: 'alert', message: 'Alert firing: Inventory error rate high (error_rate averaged 36.9% over 5m)', system: true, at: REDIS.incident - MIN },
        { type: 'status_change', message: 'Status changed from OPEN to INVESTIGATING', at: REDIS.incident - 2 * MIN },
        { type: 'comment', message: 'The primary is not answering PING. The replica is up but read-only. Not touching anything until we know why it went down.', at: REDIS.incident - 9 * MIN },
      ],
    }),
  };
  await prisma.organization.update({ where: { id: organizationId }, data: { incidentCounter: counter } });

  await prisma.alert.createMany({
    data: [
      { organizationId, ruleId: rules.payments.id, serviceId: services['shop-payments']!, value: 19.6, message: 'Payment error rate high: error_rate averaged 19.6% over 5m (threshold > 5%)', incidentId: incidents.badDeploy, startedAt: ago(PAY.incident) },
      { organizationId, ruleId: rules.gateway.id, serviceId: services['api-gateway']!, value: 7.9, message: 'Gateway error rate high: error_rate averaged 7.9% over 5m (threshold > 4%)', startedAt: ago(PAY.incident - 2 * MIN) },
      { organizationId, ruleId: rules.redis.id, serviceId: services['shop-redis']!, value: 0, message: 'Redis unavailable: redis_up averaged 0 over 5m (threshold < 1)', incidentId: incidents.redisOutage, startedAt: ago(REDIS.incident) },
      { organizationId, ruleId: rules.inventory.id, serviceId: services['shop-inventory']!, value: 36.9, message: 'Inventory error rate high: error_rate averaged 36.9% over 5m (threshold > 5%)', incidentId: incidents.redisOutage, startedAt: ago(REDIS.incident - MIN) },
      { organizationId, ruleId: rules.orders.id, serviceId: services['shop-orders']!, value: 11.8, status: 'resolved', message: 'Order error rate high: error_rate averaged 11.8% over 5m (threshold > 5%)', incidentId: incidents.dbLatency, startedAt: ago(DB.incident), resolvedAt: ago(DB.recovered - 4 * MIN) },
      { organizationId, ruleId: rules.ordersLatency.id, serviceId: services['shop-orders']!, value: 2890, status: 'resolved', message: 'Order p95 latency high: latency_p95_ms averaged 2890ms over 5m (threshold > 1500ms)', incidentId: incidents.dbLatency, startedAt: ago(DB.incident - MIN), resolvedAt: ago(DB.recovered - 4 * MIN) },
    ],
  });

  // ── Knowledge base ──
  const docs: { title: string; type: string; service?: string; tags: string[]; incidentId?: string; content: string }[] = [
    {
      title: 'Runbook: shop-redis unavailable', type: 'runbook', service: 'shop-redis', tags: ['redis', 'cache', 'inventory'],
      content: `# Runbook: shop-redis unavailable\n\n## Symptoms\n- The \`redis_up\` probe reports 0.\n- shop-inventory logs \`redis connection refused\` and stock lookups time out at the gateway after 2 s.\n- Before an out-of-memory crash, shop-redis logs \`memory usage NN% of maxmemory\` and \`Can't save in background: fork: Cannot allocate memory\`.\n\n## Diagnose first\n1. Check whether the primary answers: \`redis-cli -h shop-redis PING\`.\n2. Check memory and the eviction policy: \`redis-cli INFO memory\` and \`redis-cli CONFIG GET maxmemory-policy\`.\n3. Check replication: \`redis-cli INFO replication\` on the replica.\n4. Look at the last lines of the primary's log for \`Out Of Memory\`.\n\n## Mitigation\n- Restart the primary. The stock cache is rebuilt from PostgreSQL on demand; reservation locks held at the time are lost and expire on their own.\n- If memory was the cause, restarting alone lasts only until it fills again: raise \`maxmemory\` or set the eviction policy to \`allkeys-lru\`. This changes how the cache behaves and needs review.\n- Do not run \`FLUSHALL\` on the replica to "clean up": it is the only copy of the reservation locks while the primary is down.\n\n## After mitigation\n- Verify \`redis_up\` is 1 and the shop-inventory error rate is under 1% for 15 minutes.`,
    },
    {
      title: 'Runbook: Rolling back a service deployment', type: 'runbook', tags: ['rollback', 'deploy'],
      content: `# Runbook: Rolling back a service deployment\n\n## When to roll back\nRoll back first and investigate second when a failure began within an hour of a deployment to the affected service and the previous version was healthy.\n\n## Procedure\n1. Identify the last version that worked on the Deployments page.\n2. Request approval for a "Rollback deployment" action in OPSILUME. A rollback needs one approver who is not the requester.\n3. Run \`deployctl rollback <service> --to <version>\`.\n4. Watch error rate and latency for 15 minutes.\n\n## Caveats\n- Database migrations are not rolled back automatically.\n- shop-payments v3.7.x uses PayGate API v1; v3.8.0 and later use v2.`,
    },
    {
      title: 'Runbook: shop-orders database connection pool exhaustion', type: 'runbook', service: 'shop-orders', tags: ['database', 'pool', 'orders'],
      content: `# Runbook: shop-orders database connection pool exhaustion\n\n## Symptoms\n- shop-orders logs \`timeout acquiring connection from pool\` or \`ConnectionAcquireTimeoutError\`.\n- p95 latency climbs to about the pool acquire timeout (3000 ms).\n- \`db_connections\` is flat at exactly the configured maximum and \`db_pool_usage_percent\` is 100.\n- CPU on shop-orders drops: requests are waiting, not working.\n\n## How to confirm\n1. Compare \`db_connections\` with \`DB_POOL_MAX\` (logged as "configuration reloaded: DB_POOL_MAX=N").\n2. Check PostgreSQL: free connections and normal CPU mean the limit is on the client side.\n\n## Mitigation\n- Restore \`DB_POOL_MAX\` to 40.\n- Restarting pods alone does not help; the pool refills to the same limit.`,
    },
    {
      title: 'Architecture: Checkout flow', type: 'architecture', tags: ['architecture', 'checkout'],
      content: `# Architecture: Checkout flow\n\n## Request path\nThe API Gateway orchestrates checkout. For each order it:\n1. Reserves stock through shop-inventory (which reads through shop-redis).\n2. Creates the order in shop-orders (PostgreSQL).\n3. Authorises the card through shop-payments, which calls the external gateway PayGate.\n4. shop-orders publishes \`order.created\`; shop-notifications sends the confirmation asynchronously.\n\n## Capacity notes\n- shop-orders: connection pool of 40 against PostgreSQL.\n- shop-redis: 2 GB maxmemory, one replica.\n- Gateway timeouts: checkout 8 s, stock 2 s.\n\n## Failure modes\n- If shop-redis is down, stock lookups fall back to PostgreSQL and mostly time out.\n- If shop-payments fails, orders stay in \`pending_payment\`.`,
    },
    {
      title: 'Postmortem: Payment service elevated error rate (PayGate regional outage)', type: 'postmortem', service: 'shop-payments', tags: ['postmortem', 'payments', 'provider'], incidentId: incidents.paymentErrors,
      content: `# Postmortem: Payment service elevated error rate\n\n## Summary\nCard authorisations failed at 9% for 45 minutes during a regional outage at PayGate.\n\n## Root cause\nPayGate incident PG-7731. Authorisations routed to the affected region returned 503. Nothing had changed on our side.\n\n## What we learned\n- A provider outage shows as gateway 503 responses in shop-payments logs, with no recent deployment.\n- Failing over with the \`payment_region\` flag takes two minutes.\n\n## Actions\n- Added the secondary region to the health probe.`,
    },
  ];
  const docIds: string[] = [];
  for (const d of docs) {
    docIds.push((await prisma.knowledgeDocument.create({ data: { organizationId, title: d.title, type: d.type, content: d.content, tags: d.tags, serviceId: d.service ? services[d.service] : null, incidentId: d.incidentId, createdById: who('sre').id } })).id);
  }

  // ── Remediation proposals, through the product's own proposal code ──
  // Proposed by people, as people would. Nothing is approved and nothing is executed here.
  const { proposeRemediation, contentHash } = await import('../src/modules/remediation');
  const { requiredApprovals } = await import('../src/modules/remediation/effect');
  const { submitForApproval } = await import('../src/modules/remediation/approvals');
  const { addIncidentEvent } = await import('../src/modules/incidents');
  const { getSettings } = await import('../src/modules/organization');
  const { writeAudit } = await import('../src/lib/audit');
  const propose = (by: string, input: Parameters<typeof proposeRemediation>[1]) => proposeRemediation(organizationId, input, { type: 'user', userId: who(by).id, label: who(by).name });
  /** What POST /remediations/:id/request-approval does, with the same functions. */
  const submit = async (action: Awaited<ReturnType<typeof propose>>, by: string) => {
    const hash = contentHash(action);
    await submitForApproval(action.id, who(by).id, requiredApprovals(await getSettings(organizationId), action.risk, 'state_changing'), hash);
    await writeAudit({ organizationId, actorType: 'user', actorId: who(by).id, actorLabel: who(by).name, action: 'remediation.request_approval', resourceType: 'remediation_action', resourceId: action.id, metadata: { risk: action.risk, contentHash: hash, via: MARKER } });
    await addIncidentEvent(action.incidentId!, 'remediation', `Approval requested for: ${action.title}`, { kind: 'user', actorId: who(by).id, label: who(by).name }, { actionId: action.id });
  };
  const diagnostic = await propose('sre', {
    type: 'manual', risk: 'LOW', incidentId: incidents.redisOutage, serviceId: services['shop-redis'],
    title: 'Check memory and replication status of shop-redis',
    description: 'Read the output of `redis-cli INFO memory` and `redis-cli INFO replication` on the replica, and inspect the last 50 lines of the primary\'s log. Record the configured memory limit, the memory policy in force and whether the log ends with an out-of-memory message.',
    rationale: 'The primary stopped answering after memory warnings. We should know whether it ran out of memory before deciding what to do about it.',
  });
  const restart = await propose('sre', {
    type: 'restart_service', risk: 'MEDIUM', incidentId: incidents.redisOutage, serviceId: services['shop-redis'],
    title: 'Restart the shop-redis primary',
    description: 'Restart the shop-redis primary pod. The stock cache is rebuilt from PostgreSQL on demand. Reservation locks held at the time of the crash are lost and expire on their own within 15 minutes.',
    rationale: 'shop-redis is down and shop-inventory cannot serve stock. Restarting the primary restores the cache path.',
    parameters: { target: 'shop-redis-primary', replicas: 1 },
  });
  await submit(restart, 'sre');
  const resize = await propose('dev', {
    type: 'config_change', risk: 'HIGH', incidentId: incidents.redisOutage, serviceId: services['shop-redis'],
    title: 'Raise shop-redis maxmemory to 4 GB and switch eviction to allkeys-lru',
    description: 'Set maxmemory to 4gb and maxmemory-policy to allkeys-lru on shop-redis, then restart the primary and the replica. With allkeys-lru Redis may evict reservation locks under memory pressure, which can allow the same stock to be reserved twice.',
    rationale: 'The crash followed memory climbing to the 2 GB limit with the noeviction policy. A larger limit and an eviction policy would prevent a repeat, at the cost of changing how reservation locks behave.',
    parameters: { maxmemory: '4gb', maxmemoryPolicy: 'allkeys-lru', previous: { maxmemory: '2gb', maxmemoryPolicy: 'noeviction' } },
  });
  await submit(resize, 'dev');

  // Queue embedding jobs for the worker. Without it the documents stay "pending" and can be
  // indexed from Knowledge → Reindex all.
  let indexing = 'queued for the worker';
  try {
    const { enqueue, closeQueues } = await import('../src/queues');
    for (const id of docIds) await enqueue('knowledge-index', { documentId: id });
    await closeQueues();
  } catch (err) {
    indexing = `not queued (${(err as Error).message}); use "Reindex all" on the Knowledge page`;
  }

  const created = await counts(prisma, organizationId, true);
  await prisma.auditLog.create({ data: { organizationId, actorType: 'system', actorLabel: 'demo dataset script', action: MARK_COMPLETED, resourceType: MARKER, metadata: { marker: MARKER, anchoredAt: new Date(now).toISOString() } } });

  say(`Seeded "${NAME}" (${SLUG}).\n`);
  table(created, true);
  say(`\nKnowledge documents: ${indexing}.`);
  say('\nRemediation proposals (none approved, none executed):');
  for (const a of [diagnostic, restart, resize]) {
    const fresh = await prisma.remediationAction.findUniqueOrThrow({ where: { id: a.id }, select: { title: true, effect: true, risk: true, status: true, requiredApprovals: true } });
    say(`  ${fresh.effect.padEnd(14)} ${fresh.risk.padEnd(6)} ${fresh.status.padEnd(16)} approvals required: ${fresh.requiredApprovals}  ${fresh.title}`);
  }
  say(`\nOpen http://localhost:3000, sign in with the existing demo account (${owner.email}) and switch to "${NAME}" in the organisation menu.`);
  say('What to try, and what to expect: docs/manual-demo-testing.md');
  await engineNote();
}

// ───────────────────────── entry ─────────────────────────

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  if (command === 'seed') return seed();
  if (command === 'status') return status();
  if (command === 'reset') return reset(flags.includes('--yes'));
  say('Usage: demo-data.ts seed | status | reset [--yes]');
  process.exitCode = 2;
}

main()
  .catch((err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

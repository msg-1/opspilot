/**
 * Demo data: "Meridian Commerce", an online retailer with eight services and one active
 * incident (checkout failures that began shortly after a checkout-service deployment).
 * Everything is anchored to the current time so the dashboards look live right after seeding.
 *
 *   npm run db:seed              recreate the demo organisation (other organisations untouched)
 *   node dist/prisma/seed.js --if-empty    only seed when the database has no organisations
 */
import { createHash } from 'node:crypto';
import { type LogLevel, type Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { fingerprint } from '../src/lib/logParsing';

const prisma = new PrismaClient();
const DEMO_SLUG = 'meridian-demo';
export const DEMO_PASSWORD = 'OpsPilot-demo-1';

const now = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(now - ms);

// Deterministic pseudo-random numbers so every seed run produces the same shape of data.
let state = 20261112;
const rand = () => {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 0xffffffff;
};
const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;
const between = (a: number, b: number) => a + rand() * (b - a);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');

// The incident: deployment at T-62m, errors from T-55m.
const DEPLOY_AT = 62 * MIN;
const INCIDENT_AT = 52 * MIN;
const ERRORS_FROM = 56 * MIN;

async function main() {
  const ifEmpty = process.argv.includes('--if-empty');
  if (ifEmpty && (await prisma.organization.count()) > 0) {
    console.log('Database already has data; skipping seed.');
    return;
  }
  const existing = await prisma.organization.findUnique({ where: { slug: DEMO_SLUG } });
  if (existing) {
    console.log('Removing previous demo organisation…');
    await prisma.organization.delete({ where: { id: existing.id } });
  }

  // ── Organisation & people ──
  const org = await prisma.organization.create({ data: { name: 'Meridian Commerce', slug: DEMO_SLUG, settings: { create: {} } } });
  const organizationId = org.id;
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const people = [
    { key: 'priya', name: 'Priya Raman', email: 'demo@opspilot.dev', title: 'Head of Platform', role: 'OWNER' as const },
    { key: 'marcus', name: 'Marcus Oyelaran', email: 'marcus@opspilot.dev', title: 'Engineering Manager, Payments', role: 'ADMIN' as const },
    { key: 'lena', name: 'Lena Fischer', email: 'lena@opspilot.dev', title: 'Senior SRE', role: 'ENGINEER' as const },
    { key: 'tomas', name: 'Tomás Herrera', email: 'tomas@opspilot.dev', title: 'Backend Engineer', role: 'ENGINEER' as const },
    { key: 'aiko', name: 'Aiko Tanaka', email: 'aiko@opspilot.dev', title: 'Support Lead', role: 'VIEWER' as const },
  ];
  const users: Record<string, string> = {};
  for (const p of people) {
    const user = await prisma.user.upsert({
      where: { email: p.email },
      create: { email: p.email, name: p.name, title: p.title, passwordHash },
      update: { name: p.name, title: p.title, passwordHash, isActive: true },
    });
    users[p.key] = user.id;
    await prisma.membership.create({ data: { userId: user.id, organizationId, role: p.role } });
  }

  const teamDefs = [
    { slug: 'platform', name: 'Platform', description: 'Edge, gateway, data stores and shared infrastructure', members: [['priya', true, false], ['lena', false, true]] },
    { slug: 'payments', name: 'Payments', description: 'Checkout, payment processing and order capture', members: [['marcus', true, false], ['tomas', false, true]] },
    { slug: 'storefront', name: 'Storefront', description: 'Customer-facing web, catalogue and notifications', members: [['tomas', false, false], ['lena', false, false]] },
  ] as const;
  const teams: Record<string, string> = {};
  for (const t of teamDefs) {
    const team = await prisma.team.create({
      data: { organizationId, slug: t.slug, name: t.name, description: t.description, members: { create: t.members.map(([k, isLead, onCall]) => ({ userId: users[k]!, isLead, onCall })) } },
    });
    teams[t.slug] = team.id;
  }

  // ── Services & dependencies ──
  const serviceDefs = [
    { slug: 'web-storefront', name: 'Web Storefront', tier: 'TIER1', team: 'storefront', language: 'TypeScript', description: 'Next.js storefront that customers browse and buy from.', tags: ['frontend', 'customer-facing'] },
    { slug: 'api-gateway', name: 'API Gateway', tier: 'TIER1', team: 'platform', language: 'Go', description: 'Edge gateway: routing, authentication and rate limiting for all public APIs.', tags: ['edge'] },
    { slug: 'checkout-service', name: 'Checkout Service', tier: 'TIER1', team: 'payments', language: 'TypeScript', description: 'Cart validation, order creation and checkout orchestration. Owns the orders database.', tags: ['orders', 'critical-path'] },
    { slug: 'payment-service', name: 'Payment Service', tier: 'TIER1', team: 'payments', language: 'Kotlin', description: 'Card authorisation and capture through the external payment provider.', tags: ['pci', 'critical-path'] },
    { slug: 'inventory-service', name: 'Inventory Service', tier: 'TIER2', team: 'storefront', language: 'Go', description: 'Stock levels and reservations.', tags: ['catalogue'] },
    { slug: 'notification-service', name: 'Notification Service', tier: 'TIER3', team: 'storefront', language: 'Python', description: 'Order confirmation emails and SMS, driven by queue events.', tags: ['async'] },
    { slug: 'orders-db', name: 'Orders Database', tier: 'TIER1', team: 'platform', language: 'PostgreSQL', description: 'Primary PostgreSQL cluster for orders. max_connections = 200.', tags: ['datastore'] },
    { slug: 'session-cache', name: 'Session Cache', tier: 'TIER2', team: 'platform', language: 'Redis', description: 'Redis cluster for sessions and cart state.', tags: ['datastore'] },
  ] as const;
  const services: Record<string, string> = {};
  for (const s of serviceDefs) {
    const service = await prisma.service.create({
      data: {
        organizationId,
        slug: s.slug,
        name: s.name,
        tier: s.tier,
        language: s.language,
        description: s.description,
        tags: [...s.tags],
        ownerTeamId: teams[s.team],
        repoUrl: s.tier !== 'TIER1' || s.slug.endsWith('-db') ? null : `https://github.com/meridian-commerce/${s.slug}`,
      },
    });
    services[s.slug] = service.id;
  }
  const deps: [string, string, string, string][] = [
    ['web-storefront', 'api-gateway', 'sync', 'All API calls'],
    ['api-gateway', 'checkout-service', 'sync', '/checkout, /orders'],
    ['api-gateway', 'inventory-service', 'sync', '/stock'],
    ['api-gateway', 'session-cache', 'datastore', 'Session lookup'],
    ['checkout-service', 'orders-db', 'datastore', 'Order writes and order-summary reads'],
    ['checkout-service', 'payment-service', 'sync', 'Authorise and capture'],
    ['checkout-service', 'inventory-service', 'sync', 'Reserve stock'],
    ['checkout-service', 'session-cache', 'datastore', 'Cart state'],
    ['checkout-service', 'notification-service', 'async', 'order.created events'],
    ['inventory-service', 'orders-db', 'datastore', 'Reservation records'],
  ];
  await prisma.serviceDependency.createMany({ data: deps.map(([a, b, kind, description]) => ({ serviceId: services[a]!, dependsOnId: services[b]!, kind, description })) });

  // ── Repositories, commits, pull requests (sample data, flagged isMock) ──
  const culpritSha = sha('checkout-pool-change');
  const repoDefs = ['checkout-service', 'payment-service', 'api-gateway', 'inventory-service'];
  const repos: Record<string, string> = {};
  for (const slug of repoDefs) {
    const repo = await prisma.repository.create({ data: { organizationId, fullName: `meridian-commerce/${slug}`, serviceId: services[slug], isMock: true, lastSyncedAt: new Date() } });
    repos[slug] = repo.id;
  }
  interface Change { repo: string; at: number; title: string; body: string; author: string; files: [string, number, number][]; sha?: string; number: number; labels: string[] }
  const changes: Change[] = [
    {
      repo: 'checkout-service', at: 4 * HOUR, number: 482, sha: culpritSha, author: 'tomas-herrera', labels: ['performance', 'database'],
      title: 'Add order-summary join and right-size DB pool',
      body: 'Adds the order summary endpoint used by the new confirmation page (joins orders, order_items and shipments).\n\nAlso lowers `DB_POOL_MAX` from 40 to 10: the DBA team asked services to stay under the per-service connection budget ahead of the orders-db upgrade. Load test on staging looked fine at 50 rps.',
      files: [['src/db/pool.ts', 6, 4], ['config/production.yaml', 2, 2], ['src/orders/summary.repository.ts', 84, 0], ['src/orders/summary.controller.ts', 41, 0], ['test/orders/summary.spec.ts', 66, 0]],
    },
    { repo: 'checkout-service', at: 2 * DAY, number: 479, author: 'marcus-oyelaran', labels: ['bug'], title: 'Fix rounding in multi-currency totals', body: 'Uses minor units end to end.', files: [['src/pricing/total.ts', 18, 11], ['test/pricing/total.spec.ts', 40, 2]] },
    { repo: 'checkout-service', at: 5 * DAY, number: 476, author: 'tomas-herrera', labels: ['observability'], title: 'Add trace ids to checkout logs', body: 'Propagates W3C trace context.', files: [['src/lib/logger.ts', 22, 6]] },
    { repo: 'payment-service', at: 5 * HOUR, number: 311, author: 'marcus-oyelaran', labels: ['dependencies'], title: 'Upgrade provider SDK to 7.4.1', body: 'Routine SDK upgrade. No API changes. Changelog reviewed.', files: [['build.gradle.kts', 1, 1], ['gradle.lockfile', 14, 14]] },
    { repo: 'payment-service', at: 3 * DAY, number: 309, author: 'lena-fischer', labels: ['reliability'], title: 'Retry idempotent captures on provider 5xx', body: 'Adds bounded retry with jitter (max 2 attempts).', files: [['src/main/kotlin/capture/CaptureClient.kt', 37, 9]] },
    { repo: 'api-gateway', at: 26 * HOUR, number: 204, author: 'lena-fischer', labels: ['config'], title: 'Raise upstream timeout for /checkout to 8s', body: 'Matches the storefront client timeout.', files: [['config/routes.yaml', 2, 2]] },
    { repo: 'inventory-service', at: 7 * HOUR, number: 158, author: 'tomas-herrera', labels: ['feature'], title: 'Add low-stock threshold flag', body: 'Behind `low_stock_banner` flag, default off.', files: [['internal/stock/threshold.go', 55, 3], ['internal/flags/flags.go', 4, 0]] },
  ];
  for (const c of changes) {
    const commitSha = c.sha ?? sha(`${c.repo}:${c.number}`);
    const mergedAt = ago(c.at);
    await prisma.commit.create({
      data: {
        repositoryId: repos[c.repo]!, sha: commitSha, message: `${c.title} (#${c.number})\n\n${c.body}`, authorLogin: c.author, authorName: c.author, committedAt: mergedAt,
        additions: c.files.reduce((a, f) => a + f[1], 0), deletions: c.files.reduce((a, f) => a + f[2], 0),
        filesChanged: c.files.map(([filename, additions, deletions]) => ({ filename, additions, deletions, status: additions && !deletions ? 'added' : 'modified' })),
      },
    });
    await prisma.pullRequest.create({
      data: { repositoryId: repos[c.repo]!, number: c.number, title: c.title, body: c.body, state: 'merged', authorLogin: c.author, baseBranch: 'main', headBranch: `${c.author}/${c.number}`, mergeCommitSha: commitSha, labels: c.labels, openedAt: new Date(mergedAt.getTime() - between(2, 20) * HOUR), mergedAt, closedAt: mergedAt, additions: c.files.reduce((a, f) => a + f[1], 0), deletions: c.files.reduce((a, f) => a + f[2], 0), changedFiles: c.files.length },
    });
  }

  // ── Deployments ──
  const deployments: Prisma.DeploymentCreateManyInput[] = [];
  const deploy = (slug: string, version: string, at: number, extra: Partial<Prisma.DeploymentCreateManyInput> = {}) =>
    deployments.push({ organizationId, serviceId: services[slug]!, version, environment: 'production', status: 'SUCCEEDED', deployedBy: 'deploy-bot', source: 'api', branch: 'main', startedAt: ago(at), finishedAt: ago(at - 4 * MIN), ...extra });
  deploy('checkout-service', 'v2.14.0', DEPLOY_AT, { commitSha: culpritSha, description: 'Order summary endpoint; DB pool right-sizing (#482)', deployedBy: 'Tomás Herrera' });
  deploy('checkout-service', 'v2.13.2', 2 * DAY - HOUR, { commitSha: sha('checkout-service:479'), description: 'Multi-currency rounding fix (#479)' });
  deploy('checkout-service', 'v2.13.1', 5 * DAY - HOUR, { commitSha: sha('checkout-service:476'), description: 'Trace ids in logs (#476)' });
  deploy('payment-service', 'v5.8.0', 3 * HOUR + 20 * MIN, { commitSha: sha('payment-service:311'), description: 'Provider SDK 7.4.1 (#311)', deployedBy: 'Marcus Oyelaran' });
  deploy('payment-service', 'v5.7.4', 3 * DAY - 2 * HOUR, { commitSha: sha('payment-service:309'), description: 'Capture retries (#309)' });
  deploy('api-gateway', 'v1.42.0', 25 * HOUR, { commitSha: sha('api-gateway:204'), description: 'Checkout upstream timeout 8s (#204)' });
  deploy('inventory-service', 'v3.3.0', 6 * HOUR + 30 * MIN, { commitSha: sha('inventory-service:158'), description: 'Low-stock threshold flag (#158)' });
  deploy('web-storefront', 'v8.21.0', 28 * HOUR, { description: 'New order confirmation page' });
  deploy('notification-service', 'v1.9.3', 9 * DAY, { description: 'Template refresh' });
  // Older history so analytics has a deployment trend.
  for (let d = 3; d < 45; d++) {
    for (const slug of ['checkout-service', 'payment-service', 'api-gateway', 'web-storefront', 'inventory-service']) {
      if (rand() < 0.22) deploy(slug, `v${Math.floor(between(1, 8))}.${Math.floor(between(0, 30))}.${Math.floor(between(0, 9))}`, d * DAY + between(1, 9) * HOUR, { status: rand() < 0.06 ? 'FAILED' : 'SUCCEEDED' });
    }
  }
  await prisma.deployment.createMany({ data: deployments });

  // ── Service events ──
  await prisma.serviceEvent.createMany({
    data: [
      { organizationId, serviceId: services['inventory-service']!, type: 'feature_flag', title: 'Flag low_stock_banner enabled for 10% of traffic', actor: 'Tomás Herrera', source: 'api', occurredAt: ago(5 * HOUR) },
      { organizationId, serviceId: services['orders-db']!, type: 'maintenance', title: 'Scheduled minor version upgrade announced for Saturday', details: 'Per-service connection budgets published: checkout 40, inventory 20, reporting 10.', actor: 'Lena Fischer', source: 'manual', occurredAt: ago(3 * DAY) },
      { organizationId, serviceId: services['api-gateway']!, type: 'scaling', title: 'Autoscaler added 2 gateway replicas (6 → 8)', actor: 'autoscaler', source: 'api', occurredAt: ago(48 * MIN) },
      { organizationId, serviceId: services['checkout-service']!, type: 'restart', title: '3 pods restarted by liveness probe', details: 'Liveness probe /healthz timed out after 5s on checkout-7d9f-2, -5 and -8.', actor: 'kubelet', source: 'api', occurredAt: ago(41 * MIN) },
      { organizationId, serviceId: services['session-cache']!, type: 'config_change', title: 'maxmemory-policy changed to allkeys-lru', actor: 'Lena Fischer', source: 'manual', occurredAt: ago(6 * DAY) },
    ],
  });

  // ── Metrics ──
  const metrics: Prisma.MetricSampleCreateManyInput[] = [];
  interface Profile { rps: number; err: number; p95: number; cpu: number; mem: number; conns?: number }
  const profiles: Record<string, Profile> = {
    'web-storefront': { rps: 2100, err: 0.3, p95: 240, cpu: 38, mem: 52 },
    'api-gateway': { rps: 3400, err: 0.4, p95: 95, cpu: 44, mem: 41 },
    'checkout-service': { rps: 420, err: 0.4, p95: 180, cpu: 35, mem: 58, conns: 22 },
    'payment-service': { rps: 180, err: 0.6, p95: 310, cpu: 29, mem: 47 },
    'inventory-service': { rps: 900, err: 0.2, p95: 60, cpu: 31, mem: 39, conns: 8 },
    'notification-service': { rps: 60, err: 0.5, p95: 420, cpu: 18, mem: 33 },
  };
  const noise = (v: number, pct = 0.08) => Math.max(0, v * (1 + (rand() - 0.5) * 2 * pct));
  const sample = (slug: string, metric: string, value: number, at: number) => metrics.push({ organizationId, serviceId: services[slug]!, metric, value: Math.round(value * 100) / 100, timestamp: ago(at) });
  // 0 before the bad deploy takes effect, ramping to 1 over ~8 minutes afterwards.
  const impact = (at: number) => (at > ERRORS_FROM ? 0 : Math.min(1, (ERRORS_FROM - at) / (8 * MIN)));
  const emit = (at: number) => {
    const k = impact(at);
    const daily = 1 + 0.25 * Math.sin(((now - at) / DAY) * 2 * Math.PI);
    for (const [slug, p] of Object.entries(profiles)) {
      let { err, p95, cpu } = p;
      let rps = p.rps * daily;
      let conns = p.conns;
      if (slug === 'checkout-service') {
        err += k * 17.5;
        p95 += k * 4100;
        cpu -= k * 12; // threads blocked waiting for a connection, not burning CPU
        rps *= 1 - k * 0.2;
        conns = at > DEPLOY_AT - 3 * MIN ? 22 : 10; // new pool limit is pinned at 10
      } else if (slug === 'api-gateway') {
        err += k * 5.8;
        p95 += k * 900;
      } else if (slug === 'web-storefront') {
        err += k * 3.1;
        p95 += k * 600;
      } else if (slug === 'payment-service') {
        rps *= 1 - k * 0.45; // fewer checkouts reach payment
      } else if (slug === 'notification-service') {
        rps *= 1 - k * 0.4;
      }
      sample(slug, 'requests_per_min', noise(rps), at);
      sample(slug, 'error_rate', noise(err, 0.2), at);
      sample(slug, 'latency_p95_ms', noise(p95), at);
      sample(slug, 'latency_p50_ms', noise(p95 * 0.42), at);
      sample(slug, 'cpu_percent', noise(cpu), at);
      sample(slug, 'memory_percent', noise(p.mem, 0.03), at);
      if (conns !== undefined) sample(slug, 'db_connections', slug === 'checkout-service' && conns === 10 ? 10 : noise(conns, 0.15), at);
    }
  };
  for (let at = 0; at <= 6 * HOUR; at += MIN) emit(at);
  for (let at = 6 * HOUR + 5 * MIN; at <= 48 * HOUR; at += 5 * MIN) emit(at);
  for (let i = 0; i < metrics.length; i += 5000) await prisma.metricSample.createMany({ data: metrics.slice(i, i + 5000) });

  // ── Logs ──
  const logs: Prisma.LogEntryCreateManyInput[] = [];
  const log = (slug: string, level: LogLevel, message: string, at: number, attributes?: Prisma.InputJsonValue, traceId?: string) =>
    logs.push({ organizationId, serviceId: services[slug]!, level, message, timestamp: ago(at), environment: 'production', host: `${slug}-${Math.floor(between(1, 9))}`, traceId, fingerprint: fingerprint(message), attributes });
  const trace = () => sha(String(rand())).slice(0, 32);
  const baseline: [string, LogLevel, () => string][] = [
    ['api-gateway', 'INFO', () => `GET /api/products?page=${Math.floor(between(1, 40))} 200 ${Math.floor(between(8, 90))}ms`],
    ['api-gateway', 'INFO', () => `POST /api/cart/items 201 ${Math.floor(between(12, 70))}ms`],
    ['checkout-service', 'INFO', () => `order created order_id=${Math.floor(between(880000, 899999))} total_cents=${Math.floor(between(900, 42000))} duration=${Math.floor(between(90, 260))}ms`],
    ['checkout-service', 'DEBUG', () => `cart validated items=${Math.floor(between(1, 9))} user_id=${Math.floor(between(1000, 99999))}`],
    ['payment-service', 'INFO', () => `payment authorised provider=stripe amount_cents=${Math.floor(between(900, 42000))} latency=${Math.floor(between(180, 420))}ms`],
    ['inventory-service', 'INFO', () => `reserved sku=SKU-${Math.floor(between(1000, 9999))} qty=${Math.floor(between(1, 4))}`],
    ['notification-service', 'INFO', () => `sent order confirmation email order_id=${Math.floor(between(880000, 899999))}`],
    ['web-storefront', 'INFO', () => `rendered /product/${Math.floor(between(100, 999))} in ${Math.floor(between(30, 160))}ms`],
    ['payment-service', 'WARN', () => `provider responded slowly latency=${Math.floor(between(900, 1600))}ms attempt=1`],
    ['inventory-service', 'WARN', () => `stock below threshold sku=SKU-${Math.floor(between(1000, 9999))} remaining=${Math.floor(between(1, 5))}`],
    ['api-gateway', 'WARN', () => `rate limit applied client_ip=10.2.${Math.floor(between(0, 255))}.${Math.floor(between(1, 254))} route=/api/search`],
    ['notification-service', 'ERROR', () => `smtp temporary failure code=451 recipient_domain=example.org, will retry`],
  ];
  // Six hours of ordinary traffic (sampled).
  for (let at = 0; at <= 6 * HOUR; at += 20_000) {
    const [slug, level, make] = pick(baseline);
    if (level === 'ERROR' && rand() > 0.12) continue;
    if (level === 'WARN' && rand() > 0.5) continue;
    // During the incident, successful checkouts and payments become rare.
    if (impact(at) > 0.5 && (slug === 'checkout-service' || slug === 'payment-service' || slug === 'notification-service') && level === 'INFO' && rand() < 0.6) continue;
    log(slug, level, make(), at + between(0, 20_000));
  }
  // Deployment markers.
  log('checkout-service', 'INFO', 'starting checkout-service version=v2.14.0 commit=' + culpritSha.slice(0, 7), DEPLOY_AT - 3 * MIN);
  log('checkout-service', 'INFO', 'database pool initialised max=10 min=2 acquire_timeout=3000ms', DEPLOY_AT - 3 * MIN + 2000, { pool: { max: 10, min: 2, acquireTimeoutMs: 3000 } });
  log('checkout-service', 'INFO', 'database pool initialised max=40 min=5 acquire_timeout=3000ms', 2 * DAY - HOUR, { pool: { max: 40, min: 5, acquireTimeoutMs: 3000 } });
  log('payment-service', 'INFO', 'starting payment-service version=v5.8.0 provider_sdk=7.4.1', 3 * HOUR + 18 * MIN);
  // The incident burst.
  for (let at = ERRORS_FROM; at >= 0; at -= 4000) {
    const k = impact(at);
    if (rand() > k) continue;
    const t = trace();
    const waited = Math.floor(between(3000, 3050));
    log('checkout-service', 'ERROR', `timeout acquiring connection from pool after ${waited}ms (active=10 idle=0 waiting=${Math.floor(between(18, 140))})`, at, { pool: { max: 10, active: 10, idle: 0 }, route: pick(['POST /checkout', 'GET /orders/:id/summary', 'POST /checkout']) }, t);
    if (rand() < 0.55) log('checkout-service', 'ERROR', `POST /checkout failed: ConnectionAcquireTimeoutError order_draft=${Math.floor(between(440000, 449999))} duration=${waited + Math.floor(between(5, 40))}ms`, at - 30, { errorType: 'ConnectionAcquireTimeoutError' }, t);
    if (rand() < 0.4) log('api-gateway', 'ERROR', `upstream checkout-service returned 503 for POST /api/checkout after ${waited + Math.floor(between(20, 90))}ms`, at - 60, { upstream: 'checkout-service', status: 503 }, t);
    if (rand() < 0.18) log('checkout-service', 'WARN', `slow query: order summary join took ${Math.floor(between(1800, 5200))}ms rows=${Math.floor(between(1, 60))}`, at + 500, { query: 'orders ⨝ order_items ⨝ shipments', route: 'GET /orders/:id/summary' });
    if (rand() < 0.12) log('web-storefront', 'ERROR', `checkout request failed with status 503, showing retry banner session=${sha(String(rand())).slice(0, 12)}`, at - 120, undefined, t);
    if (rand() < 0.05) log('api-gateway', 'WARN', `circuit breaker half-open for upstream checkout-service failures=${Math.floor(between(20, 60))}`, at);
  }
  log('checkout-service', 'FATAL', 'liveness probe failed: /healthz did not respond within 5000ms, pod will be restarted', 41 * MIN + 5000);
  log('checkout-service', 'FATAL', 'liveness probe failed: /healthz did not respond within 5000ms, pod will be restarted', 41 * MIN + 2000);
  for (let i = 0; i < logs.length; i += 5000) await prisma.logEntry.createMany({ data: logs.slice(i, i + 5000) });

  // ── Alert rules & firing alerts ──
  const rule = (slug: string, name: string, metric: string, threshold: number, severity: 'SEV1' | 'SEV2' | 'SEV3', comparator = 'gt') =>
    prisma.alertRule.create({ data: { organizationId, serviceId: services[slug]!, name, metric, threshold, severity, comparator, windowMinutes: 5 } });
  const checkoutErr = await rule('checkout-service', 'Checkout error rate high', 'error_rate', 5, 'SEV2');
  const checkoutLat = await rule('checkout-service', 'Checkout p95 latency high', 'latency_p95_ms', 1500, 'SEV3');
  const gatewayErr = await rule('api-gateway', 'Gateway error rate high', 'error_rate', 4, 'SEV2');
  await rule('payment-service', 'Payment error rate high', 'error_rate', 5, 'SEV1');
  await rule('checkout-service', 'Checkout throughput low', 'requests_per_min', 100, 'SEV2', 'lt');
  await rule('orders-db', 'Orders DB connections near limit', 'db_connections', 180, 'SEV2');

  // ── Incidents ──
  let counter = 0;
  interface Past { title: string; severity: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4'; services: string[]; daysAgo: number; ackMin: number; resolveMin: number; rootCause: string; resolution: string; assignee: string }
  const past: Past[] = [
    { title: 'Checkout latency from database pool saturation during flash sale', severity: 'SEV2', services: ['checkout-service', 'orders-db'], daysAgo: 37, ackMin: 6, resolveMin: 74, assignee: 'lena', rootCause: 'A flash sale tripled checkout traffic. With DB_POOL_MAX=20 the checkout pool saturated and requests queued for connections until they timed out.', resolution: 'Raised DB_POOL_MAX from 20 to 40 and added the pool-wait dashboard panel. Follow-up: alert on pool wait time.' },
    { title: 'Payment authorisations failing with provider 5xx', severity: 'SEV1', services: ['payment-service'], daysAgo: 21, ackMin: 3, resolveMin: 48, assignee: 'marcus', rootCause: 'Regional outage at the payment provider (their incident PI-2291).', resolution: 'Failed over to the secondary provider region; added capture retries (#309).' },
    { title: 'Order confirmation emails delayed by 40 minutes', severity: 'SEV3', services: ['notification-service'], daysAgo: 16, ackMin: 22, resolveMin: 130, assignee: 'tomas', rootCause: 'SMTP relay throttled us after a template change doubled message size.', resolution: 'Compressed inline images and raised relay quota.' },
    { title: 'Gateway 502s after certificate rotation', severity: 'SEV2', services: ['api-gateway'], daysAgo: 29, ackMin: 4, resolveMin: 35, assignee: 'lena', rootCause: 'Two gateway replicas kept the old upstream certificate bundle in memory.', resolution: 'Rolling restart of the gateway; rotation runbook now includes a restart step.' },
    { title: 'Stock counts stale on product pages', severity: 'SEV3', services: ['inventory-service', 'web-storefront'], daysAgo: 12, ackMin: 15, resolveMin: 95, assignee: 'tomas', rootCause: 'Cache invalidation events were dropped while the session cache was failing over.', resolution: 'Replayed events and added a reconciliation job.' },
    { title: 'Session cache evictions logging customers out', severity: 'SEV2', services: ['session-cache', 'api-gateway'], daysAgo: 6, ackMin: 5, resolveMin: 52, assignee: 'lena', rootCause: 'maxmemory reached with noeviction policy after a traffic spike.', resolution: 'Switched to allkeys-lru and increased memory by 50%.' },
    { title: 'Slow search results for long queries', severity: 'SEV4', services: ['web-storefront'], daysAgo: 9, ackMin: 60, resolveMin: 400, assignee: 'tomas', rootCause: 'Unbounded wildcard expansion in the search query builder.', resolution: 'Capped expansion terms.' },
    { title: 'Checkout failing for carts with gift cards', severity: 'SEV3', services: ['checkout-service', 'payment-service'], daysAgo: 44, ackMin: 12, resolveMin: 160, assignee: 'marcus', rootCause: 'Gift-card balance call returned a new field type the checkout parser rejected.', resolution: 'Made the parser tolerant and added a contract test.' },
    { title: 'Inventory reservations timing out', severity: 'SEV3', services: ['inventory-service', 'orders-db'], daysAgo: 52, ackMin: 9, resolveMin: 88, assignee: 'lena', rootCause: 'Missing index on reservations(sku, expires_at) after a table rewrite.', resolution: 'Recreated the index concurrently.' },
  ];
  past.sort((a, b) => b.daysAgo - a.daysAgo);
  const pastIds: Record<string, string> = {};
  for (const p of past) {
    const startedAt = ago(p.daysAgo * DAY + between(1, 9) * HOUR);
    const at = (m: number) => new Date(startedAt.getTime() + m * MIN);
    const incident = await prisma.incident.create({
      data: {
        organizationId, number: ++counter, title: p.title, severity: p.severity, status: 'CLOSED', source: 'manual', createdById: users.lena, assigneeId: users[p.assignee], commanderId: users.priya,
        rootCause: p.rootCause, resolution: p.resolution, startedAt, acknowledgedAt: at(p.ackMin), mitigatedAt: at(p.resolveMin * 0.7), resolvedAt: at(p.resolveMin), closedAt: at(p.resolveMin + 600), createdAt: startedAt,
        services: { create: p.services.map((s) => ({ serviceId: services[s]! })) },
        events: {
          create: [
            { type: 'created', message: `Incident opened as ${p.severity}`, actorLabel: 'Lena Fischer', actorId: users.lena, createdAt: startedAt },
            { type: 'status_change', message: 'Status changed from OPEN to INVESTIGATING', actorLabel: people.find((x) => x.key === p.assignee)!.name, actorId: users[p.assignee], createdAt: at(p.ackMin) },
            { type: 'update', message: 'Root cause recorded', actorLabel: people.find((x) => x.key === p.assignee)!.name, actorId: users[p.assignee], createdAt: at(p.resolveMin * 0.6) },
            { type: 'status_change', message: 'Status changed from INVESTIGATING to RESOLVED', actorLabel: people.find((x) => x.key === p.assignee)!.name, actorId: users[p.assignee], createdAt: at(p.resolveMin) },
          ],
        },
      },
    });
    pastIds[p.title] = incident.id;
  }

  const startedAt = ago(INCIDENT_AT);
  const active = await prisma.incident.create({
    data: {
      organizationId, number: ++counter, title: 'Checkout requests failing with 503s', severity: 'SEV2', status: 'INVESTIGATING', source: 'alert',
      description: 'Customers report that placing an order fails with "Something went wrong". Gateway shows elevated 503s on POST /api/checkout. Started around the time the checkout error-rate alert fired.',
      customerImpact: 'Roughly 1 in 5 checkout attempts fail. Browsing and cart are unaffected.',
      assigneeId: users.tomas, commanderId: users.lena, startedAt, acknowledgedAt: ago(INCIDENT_AT - 4 * MIN), createdAt: startedAt,
      services: { create: [{ serviceId: services['checkout-service']! }, { serviceId: services['api-gateway']! }] },
      events: {
        create: [
          { type: 'created', message: 'Incident opened as SEV2', actorType: 'system', actorLabel: 'OpsPilot monitoring', createdAt: startedAt },
          { type: 'alert', message: 'Alert firing: Checkout error rate high (error_rate averaged 14.2% over 5m)', actorType: 'system', actorLabel: 'OpsPilot monitoring', createdAt: startedAt },
          { type: 'status_change', message: 'Status changed from OPEN to INVESTIGATING', actorId: users.lena, actorLabel: 'Lena Fischer', createdAt: ago(INCIDENT_AT - 4 * MIN) },
          { type: 'assignment', message: 'Assigned to Tomás Herrera', actorId: users.lena, actorLabel: 'Lena Fischer', createdAt: ago(INCIDENT_AT - 5 * MIN) },
          { type: 'comment', message: 'Payment provider status page is green. @Marcus Oyelaran can you confirm nothing odd on the payment side after this morning’s SDK upgrade?', actorId: users.lena, actorLabel: 'Lena Fischer', createdAt: ago(INCIDENT_AT - 9 * MIN) },
          { type: 'comment', message: 'Payment auth success rate is normal for the requests that reach us — volume is just down ~45%.', actorId: users.marcus, actorLabel: 'Marcus Oyelaran', createdAt: ago(INCIDENT_AT - 14 * MIN) },
        ],
      },
    },
  });
  await prisma.organization.update({ where: { id: organizationId }, data: { incidentCounter: counter } });
  await prisma.alert.createMany({
    data: [
      { organizationId, ruleId: checkoutErr.id, serviceId: services['checkout-service']!, value: 14.2, message: 'Checkout error rate high: error_rate averaged 14.2% over 5m (threshold > 5%)', incidentId: active.id, startedAt },
      { organizationId, ruleId: checkoutLat.id, serviceId: services['checkout-service']!, value: 3890, message: 'Checkout p95 latency high: latency_p95_ms averaged 3890ms over 5m (threshold > 1500ms)', incidentId: active.id, startedAt: ago(INCIDENT_AT - MIN) },
      { organizationId, ruleId: gatewayErr.id, serviceId: services['api-gateway']!, value: 5.6, message: 'Gateway error rate high: error_rate averaged 5.6% over 5m (threshold > 4%)', incidentId: active.id, startedAt: ago(INCIDENT_AT - 3 * MIN) },
    ],
  });
  const health = (slug: string, h: 'HEALTHY' | 'DEGRADED', note: string) => prisma.service.update({ where: { id: services[slug]! }, data: { health: h, healthNote: note, healthAt: new Date() } });
  await health('checkout-service', 'DEGRADED', '2 alerts firing');
  await health('api-gateway', 'DEGRADED', '1 alert firing');
  for (const slug of ['web-storefront', 'payment-service', 'inventory-service', 'notification-service']) await health(slug, 'HEALTHY', 'All alert rules within thresholds');

  // A past, fully executed remediation so the approvals history is not empty.
  const poolIncident = pastIds['Checkout latency from database pool saturation during flash sale']!;
  const requestedAt = ago(37 * DAY - 40 * MIN);
  await prisma.remediationAction.create({
    data: {
      organizationId, incidentId: poolIncident, type: 'config_change', title: 'Raise checkout DB_POOL_MAX from 20 to 40', description: 'Set DB_POOL_MAX=40 for checkout-service in production and roll the deployment.', rationale: 'Pool wait time is the dominant contributor to checkout latency; orders-db has headroom (62 of 200 connections in use).', risk: 'MEDIUM', status: 'EXECUTED', serviceId: services['checkout-service'], parameters: { key: 'DB_POOL_MAX', from: 20, to: 40 },
      proposedByType: 'user', proposedById: users.lena, requestedById: users.lena, requestedAt, requiredApprovals: 1, executedById: users.lena, executedAt: new Date(requestedAt.getTime() + 14 * MIN),
      executionResult: { mode: 'manual', success: true, summary: 'Carried out manually and attested by Lena Fischer. OpsPilot did not change any external system.' }, createdAt: new Date(requestedAt.getTime() - 5 * MIN),
      approvals: { create: { approverId: users.marcus!, decision: 'approved', comment: 'Headroom confirmed on the DB side.', createdAt: new Date(requestedAt.getTime() + 6 * MIN) } },
    },
  });

  // ── Knowledge base ──
  const docs: { title: string; type: string; service?: string; tags: string[]; incidentId?: string; content: string }[] = [
    {
      title: 'Runbook: Checkout service database connection pool exhaustion', type: 'runbook', service: 'checkout-service', tags: ['database', 'pool', 'checkout'],
      content: `# Runbook: Checkout service database connection pool exhaustion

## Symptoms
- Checkout error rate rises; gateway returns 503 for \`POST /api/checkout\`.
- Checkout logs contain \`timeout acquiring connection from pool\` or \`ConnectionAcquireTimeoutError\`.
- p95 latency climbs to roughly the pool acquire timeout (3000 ms) plus normal handling time.
- The \`db_connections\` metric for checkout-service is flat at exactly the configured pool maximum.
- CPU on checkout pods *drops*: requests are waiting, not working.

## How to confirm
1. Compare \`db_connections\` with the configured \`DB_POOL_MAX\` (logged at startup as "database pool initialised max=N").
2. Check orders-db itself: if it has free connections and normal CPU, the bottleneck is the client-side pool, not the database.
3. Look for slow queries holding connections for a long time (\`slow query\` warnings).

## Common causes
- \`DB_POOL_MAX\` lowered or left too small for current traffic. The checkout budget on orders-db is 40 connections.
- A new slow query that holds connections longer, reducing effective pool capacity.
- A traffic spike (sales, campaigns).

## Mitigation
- **Fastest:** roll back the checkout-service deployment that changed the pool size or introduced the slow query.
- **Alternative:** raise \`DB_POOL_MAX\` back to 40 (config change + rolling restart). Do not exceed 40 without the platform team: orders-db allows 200 connections shared by all services.
- Restarting pods alone does not help; the pool refills to the same limit.

## After mitigation
- Verify error rate < 1% and p95 < 400 ms for 15 minutes.
- Add the offending query to the slow-query review.`,
    },
    {
      title: 'Runbook: Rolling back a service deployment', type: 'runbook', tags: ['rollback', 'deploy'],
      content: `# Runbook: Rolling back a service deployment

## When to roll back
Roll back first, investigate second, when an incident started within an hour of a deployment to the affected service and the previous version was healthy.

## Procedure
1. Identify the last known-good version on the Deployments page.
2. Request approval for a "Rollback deployment" remediation in OpsPilot. SEV1/SEV2 rollbacks need one approver who is not the requester.
3. Run \`deployctl rollback <service> --to <version>\` or trigger the "Rollback" pipeline with the version.
4. Watch error rate and latency for 15 minutes.

## Caveats
- Database migrations are not rolled back automatically. Check the release notes for schema changes first.
- checkout-service and payment-service must stay within one minor version of each other.`,
    },
    {
      title: 'Runbook: Payment provider timeouts and 5xx', type: 'runbook', service: 'payment-service', tags: ['payments', 'provider'],
      content: `# Runbook: Payment provider timeouts and 5xx

## Symptoms
- payment-service logs \`provider responded slowly\` or \`provider 5xx\`.
- Payment error rate above 5% (SEV1 alert).
- Checkout succeeds up to the payment step, then fails.

## How to tell it apart from a checkout problem
If checkout fails *before* reaching payment (payment request volume drops but payment success rate stays normal), the problem is upstream of payment-service.

## Mitigation
- Check the provider status page.
- Fail over to the secondary provider region with the \`payment_region\` flag.
- Captures are idempotent and retried twice automatically.`,
    },
    {
      title: 'Architecture: Order placement flow', type: 'architecture', tags: ['architecture', 'checkout', 'orders'],
      content: `# Architecture: Order placement flow

## Request path
Web Storefront → API Gateway → Checkout Service → (Orders Database, Payment Service, Inventory Service, Session Cache).

Checkout Service is the orchestrator. For each order it:
1. Loads the cart from the session cache.
2. Reserves stock through Inventory Service.
3. Writes the order to the Orders Database inside a transaction.
4. Authorises payment through Payment Service.
5. Publishes \`order.created\`; Notification Service sends the confirmation asynchronously.

## Capacity notes
- Orders Database: PostgreSQL, max_connections 200. Budgets: checkout 40, inventory 20, reporting 10, headroom for migrations.
- Checkout pods: 12 replicas. Each has its own connection pool, sized by \`DB_POOL_MAX\` *per pod group via pgbouncer*, so the effective limit for the service equals \`DB_POOL_MAX\`.
- Gateway upstream timeout for /checkout is 8 s; storefront client timeout is 10 s.

## Failure modes
- If Checkout cannot get a database connection within 3 s it fails the request with 503.
- If Payment Service is down, orders stay in \`pending_payment\` and are retried.`,
    },
    {
      title: 'Policy: Incident severity levels and response', type: 'policy', tags: ['policy', 'severity', 'on-call'],
      content: `# Policy: Incident severity levels and response

| Severity | Definition | Response |
|---|---|---|
| SEV1 | Revenue-critical path down for most customers | Page on-call immediately, incident commander required, updates every 15 minutes |
| SEV2 | Critical path degraded or down for some customers | Page on-call, updates every 30 minutes |
| SEV3 | Non-critical feature impaired | Handle in business hours |
| SEV4 | Minor or cosmetic | Backlog |

## Production changes during incidents
Every production change made to mitigate an incident needs an approved remediation action. High-risk actions (data changes, capacity changes on shared data stores) need two approvers, one of whom is an admin.`,
    },
    {
      title: 'Postmortem: Checkout latency from database pool saturation during flash sale', type: 'postmortem', service: 'checkout-service', tags: ['postmortem', 'database', 'pool'], incidentId: pastIds['Checkout latency from database pool saturation during flash sale'],
      content: `# Postmortem: Checkout latency from database pool saturation during flash sale

## Summary
During the spring flash sale, checkout p95 latency rose from 200 ms to over 3 s and 9% of checkouts failed for 74 minutes.

## Root cause
Checkout traffic tripled. \`DB_POOL_MAX\` was 20, so the pool saturated: requests queued for a connection and timed out after 3 s with \`timeout acquiring connection from pool\`. The database itself was healthy (62 of 200 connections in use).

## What we learned
- A flat \`db_connections\` line at the pool maximum together with falling CPU is the signature of pool exhaustion.
- Restarting pods did not help.
- We had no alert on pool wait time.

## Actions
- Raised \`DB_POOL_MAX\` to 40 (done).
- Published per-service connection budgets on orders-db: checkout 40.
- Any change to pool sizing must be load-tested at 3x peak traffic, not at average traffic.`,
    },
  ];
  const docIds: string[] = [];
  for (const d of docs) {
    const doc = await prisma.knowledgeDocument.create({ data: { organizationId, title: d.title, type: d.type, content: d.content, tags: d.tags, serviceId: d.service ? services[d.service] : null, incidentId: d.incidentId, createdById: users.lena } });
    docIds.push(doc.id);
  }

  // Queue embedding jobs for the worker. If Redis is not running the documents stay "pending"
  // and can be indexed later from Knowledge → Reindex all.
  try {
    const { enqueue, closeQueues } = await import('../src/queues');
    if (process.env.QUEUE_INLINE !== 'true') {
      for (const id of docIds) await enqueue('knowledge-index', { documentId: id });
      await closeQueues();
    }
  } catch (err) {
    console.warn(`Could not queue knowledge indexing (${(err as Error).message}). Use "Reindex all" in the Knowledge page.`);
  }

  console.log(`\nSeeded "${org.name}":`);
  console.log(`  ${Object.keys(services).length} services, ${deployments.length} deployments, ${logs.length} log entries, ${metrics.length} metric samples`);
  console.log(`  ${past.length + 1} incidents (1 active: INC-${counter}), ${docs.length} knowledge documents`);
  console.log(`\nSign in at http://localhost:3000 with:`);
  for (const p of people) console.log(`  ${p.role.padEnd(8)} ${p.email}`);
  console.log(`  password (all demo users): ${DEMO_PASSWORD}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

// Creates the demo organisation in OPSILUME: services and their dependencies, alert rules,
// deployment history, a runbook, and an ingestion key for the demo services. Safe to run again.
import { chmodSync, writeFileSync } from 'node:fs';
import { ACCOUNT, ENV_FILE, STATE_FILE, Session, log } from './lib.mjs';

const SERVICES = [
  { name: 'Shop Gateway', tier: 'TIER1', language: 'Node.js', description: 'Public edge of the demo shop. Forwards to shop-orders.' },
  { name: 'Shop Orders', tier: 'TIER1', language: 'Node.js', description: 'Orders in PostgreSQL, read-through cache in Redis, payment through shop-payments.' },
  { name: 'Shop Payments', tier: 'TIER1', language: 'Node.js', description: 'Charges once per order. Idempotency keys live in Redis.' },
  { name: 'Shop Postgres', tier: 'TIER2', description: 'PostgreSQL used by shop-orders.' },
  { name: 'Shop Redis', tier: 'TIER2', description: 'Redis used by shop-orders (cache) and shop-payments (idempotency keys).' },
  { name: 'Shop Inventory', tier: 'TIER3', lifecycle: 'EXPERIMENTAL', description: 'Registered in the catalogue but not instrumented: it sends no logs, metrics or traces.' },
];
const DEPENDS = {
  'shop-gateway': [['shop-orders', 'sync']],
  'shop-orders': [['shop-payments', 'sync'], ['shop-postgres', 'datastore'], ['shop-redis', 'datastore']],
  'shop-payments': [['shop-redis', 'datastore']],
};
// SEV1 rules make a service DOWN while they fire; the others make it DEGRADED.
const RULES = [
  ...['shop-gateway', 'shop-orders', 'shop-payments', 'shop-postgres', 'shop-redis'].map((service) => ({ service, name: `${service} is not reachable`, metric: 'up', comparator: 'lt', threshold: 1, windowMinutes: 1, severity: 'SEV1' })),
  ...['shop-gateway', 'shop-orders', 'shop-payments'].map((service) => ({ service, name: `${service} error rate above 5%`, metric: 'error_rate', comparator: 'gt', threshold: 5, windowMinutes: 1, severity: 'SEV2' })),
  { service: 'shop-orders', name: 'shop-orders p95 latency above 800 ms', metric: 'latency_p95_ms', comparator: 'gt', threshold: 800, windowMinutes: 1, severity: 'SEV3' },
  { service: 'shop-orders', name: 'shop-orders requests waiting for a database connection', metric: 'queue_depth', comparator: 'gt', threshold: 2, windowMinutes: 1, severity: 'SEV3' },
];
const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
const DEPLOYMENTS = [
  { service: 'shop-orders', version: 'v1.3.9', commitSha: 'abababab1309', startedAt: daysAgo(10), description: 'Routine dependency update' },
  { service: 'shop-orders', version: 'v1.4.0', commitSha: 'abababab1400', startedAt: daysAgo(3), description: 'Order history pagination' },
  { service: 'shop-gateway', version: 'v2.1.0', commitSha: 'cdcdcdcd2100', startedAt: daysAgo(5), description: 'Request timeouts' },
  { service: 'shop-payments', version: 'v3.0.2', commitSha: 'efefefef3002', startedAt: daysAgo(6), description: 'Idempotency key expiry' },
];
const RUNBOOK = `# Runbook: shop-orders cache and database pool

## Diagnose
1. Check the shop-orders dashboard for p95 latency and requests waiting for a database connection
2. Compare the database pool gauge (db_pool_in_use) with the pool size
3. Read the shop-orders warnings for "cache read failed" to see whether Redis is answering

## Mitigate
- Flush the order:* keys in shop-redis if cached orders are stale
- Restart shop-orders to release stuck database connections
- Roll back shop-orders to the previous version if errors began with a deployment

Mitigation steps change production and need approval. The diagnostic steps do not.
`;

const s = new Session();
const me = await s.signIn();
log(`signed in as ${ACCOUNT.email} (organisation "${me.organization?.name ?? ACCOUNT.organizationName}")`);

const existing = new Map((await s.get('/services?limit=100')).data.map((x) => [x.slug, x]));
for (const def of SERVICES) {
  const slug = def.name.toLowerCase().replace(/\s+/g, '-');
  if (!existing.has(slug)) existing.set(slug, await s.post('/services', def));
}
const id = (slug) => existing.get(slug).id;
for (const [slug, deps] of Object.entries(DEPENDS)) {
  await s.must('PUT', `/services/${id(slug)}/dependencies`, { dependencies: deps.map(([dep, kind]) => ({ serviceId: id(dep), kind })) });
}
log(`services: ${[...existing.keys()].filter((k) => k.startsWith('shop-')).join(', ')}`);

const rules = new Set((await s.get('/monitoring/alert-rules')).data.map((r) => r.name));
for (const rule of RULES) if (!rules.has(rule.name)) await s.post('/monitoring/alert-rules', rule);

const deployed = (await s.get('/deployments?limit=100')).data;
for (const d of DEPLOYMENTS) {
  if (!deployed.some((x) => x.version === d.version && (x.service?.slug ?? x.serviceSlug) === d.service)) await s.post('/deployments', { ...d, deployedBy: 'demo-setup', branch: 'main' });
}

const docs = (await s.get('/knowledge/documents?limit=100')).data;
let runbook = docs.find((d) => d.title === 'Runbook: shop-orders cache and database pool');
if (!runbook) runbook = await s.post('/knowledge/documents', { title: 'Runbook: shop-orders cache and database pool', type: 'runbook', content: RUNBOOK, service: 'shop-orders', tags: ['demo'] });

// The key is written to a git-ignored file readable only by its owner, and is never printed.
const key = await s.post('/api-keys', { name: `demo-telemetry-${Date.now()}`, scopes: ['ingest:logs', 'ingest:metrics', 'ingest:deployments', 'ingest:events', 'tools:read'] });
writeFileSync(ENV_FILE, `# Written by demo/scripts/setup.mjs. Git-ignored. Ingestion key of the demo organisation.\nOPSPILOT_API_KEY=${key.secret}\n`, { mode: 0o600 });
chmodSync(ENV_FILE, 0o600);
writeFileSync(STATE_FILE, `${JSON.stringify({ email: ACCOUNT.email, organizationId: me.organization?.id ?? null, services: Object.fromEntries([...existing].filter(([k]) => k.startsWith('shop-')).map(([k, v]) => [k, v.id])), runbookId: runbook.id, createdAt: new Date().toISOString() }, null, 2)}\n`);
log('demo organisation is ready: alert rules, deployment history, runbook and ingestion key written to demo/.env.demo');

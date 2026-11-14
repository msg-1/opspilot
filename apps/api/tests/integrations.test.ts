import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration status as an organisation sees it. The point of every test here is the
// difference between "something was saved" and "it works": status must follow what happened
// (data accepted or rejected, a check answered or not), and nothing shown may hold a secret.
// GitHub and the remediation webhook are local HTTP servers; the AI service is a double.
const ai = vi.hoisted(() => ({ reachable: true }));
vi.mock('../src/integrations/aiService', () => ({
  aiService: {
    status: async () => {
      if (!ai.reachable) throw new Error('AI service is not reachable at http://ai:8000');
      return { llm: { provider: 'heuristic', model: null, available: false }, embeddings: { provider: 'test', model: 'unit', dimensions: 768 } };
    },
    embed: async (texts: string[]) => ({ provider: 'test', model: 'unit', dimensions: 768, vectors: texts.map(() => [1, ...new Array(767).fill(0)]) }),
    runInvestigation: async (_r: never, onEvent: (e: unknown) => Promise<void>) => {
      await onEvent({ type: 'final', report: { summary: 'Nothing conclusive was found.', confidence: 0.1, analysisMode: 'heuristic', timeline: [], facts: [], assumptions: [], uncertainties: [], hypotheses: [], nextSteps: [], recommendedActions: [] } });
    },
  },
}));

import * as contract from '../src/contracts/api';
import { tracesConfig } from '../src/integrations/traces';
import { netConfig } from '../src/lib/netguard';
import { githubConfig } from '../src/modules/github';
import { resetCheckCooldown, resetIntegrationProbes } from '../src/modules/integrations';
import { api, createApiKey, createOrg, createService, prisma } from './helpers';

type Org = Awaited<ReturnType<typeof createOrg>>;
type View = { id: string; status: string; statusDetail: string; lastReceivedAt: string | null; lastError: { message: string } | null; lastCheck: { ok: boolean; detail: string } | null; facts: { label: string; value: string }[]; setup: { canCheck: boolean } };

const TOKEN = 'ghp_thisIsASecretTokenValue0123456789abcd';
const WEBHOOK_SECRET = 'whsec-0123456789-very-secret';

// A stand-in for api.github.com and for the organisation's webhook receiver.
let server: Server;
let base: string;
const github = { tokenValid: true, repoMissing: false };
const hook = { status: 200, delayMs: 0, received: [] as { headers: Record<string, unknown>; body: Record<string, unknown> }[] };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/hook') {
        hook.received.push({ headers: req.headers, body: JSON.parse(raw || '{}') });
        setTimeout(() => json(hook.status, { echoed: 'the receiver may say anything here: internal-hostname.corp' }), hook.delayMs);
        return;
      }
      const authorised = req.headers.authorization === `Bearer ${TOKEN}` && github.tokenValid;
      if (req.url === '/user') return authorised ? json(200, { login: 'acme-bot' }) : json(401, { message: `Bad credentials for ${req.headers.authorization}` });
      if (req.url?.startsWith('/repos/acme/checkout')) return github.repoMissing ? json(404, { message: 'Not Found' }) : json(200, { full_name: 'acme/checkout', default_branch: 'main', html_url: 'https://github.com/acme/checkout', private: true });
      if (req.url === '/api/services') return json(200, { data: [] });
      json(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  githubConfig.baseUrl = base;
});
afterAll(async () => {
  githubConfig.baseUrl = 'https://api.github.com';
  netConfig.allowPrivate = false;
  tracesConfig.url = '';
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  Object.assign(github, { tokenValid: true, repoMissing: false });
  Object.assign(hook, { status: 200, delayMs: 0, received: [] });
  ai.reachable = true;
  netConfig.allowPrivate = false;
  tracesConfig.url = '';
  resetCheckCooldown();
  resetIntegrationProbes();
});

const overview = async (agent: Org['owner']) => (await agent.get('/api/v1/integrations').expect(200)).body as { integrations: View[]; unresolvedServices: { ref: string; sources: string[]; count: number | null; linkable: boolean; registered: boolean }[]; onboarding: { complete: boolean; steps: { id: string; done: boolean; detail: string }[] } };
const one = async (agent: Org['owner'], id: string) => (await overview(agent)).integrations.find((i) => i.id === id)!;
const steps = async (agent: Org['owner']) => Object.fromEntries((await overview(agent)).onboarding.steps.map((s) => [s.id, s.done]));
const send = (key: string, path: string, body: unknown) => api().post(`/api/v1/${path}`).set('x-api-key', key).send(body as object);

describe('integration discovery', () => {
  it('lists exactly the sources that exist, says what each provides and needs, and matches its contract', async () => {
    const org = await createOrg();
    const body = (await org.owner.get('/api/v1/integrations').expect(200)).body;
    const parsed = contract.IntegrationOverview.safeParse(body);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    expect(body.integrations.map((i: View) => i.id)).toEqual(['logs', 'metrics', 'deployments', 'events', 'github', 'remediation_webhook', 'traces', 'analysis_engine']);
    for (const i of body.integrations) {
      expect(i.provides.length).toBeGreaterThan(40);
      expect(i.requires.length).toBeGreaterThan(0);
    }
    // A new organisation: nothing is configured, and nothing claims to be.
    expect(Object.fromEntries(body.integrations.map((i: View) => [i.id, i.status]))).toEqual({
      logs: 'not_configured', metrics: 'not_configured', deployments: 'not_configured', events: 'not_configured',
      github: 'not_configured', remediation_webhook: 'not_configured', traces: 'not_configured', analysis_engine: 'connected',
    });
    expect(body.onboarding).toMatchObject({ complete: false });
    expect(body.onboarding.steps.map((s: { id: string; done: boolean }) => [s.id, s.done])).toEqual([['services', false], ['source', false], ['connect', false], ['data', false], ['associate', false], ['investigate', false]]);
    // Everyone in the organisation can read it; nobody outside can.
    expect((await (await org.member('VIEWER')).agent.get('/api/v1/integrations')).status).toBe(200);
    expect((await api().get('/api/v1/integrations')).status).toBe(401);
  });

  it('reports the installation-level services by what they answer, without saying where they are', async () => {
    const org = await createOrg();
    expect(await one(org.owner, 'analysis_engine')).toMatchObject({ status: 'connected', statusDetail: expect.stringContaining('rule-based engine') });
    ai.reachable = false;
    resetIntegrationProbes();
    const engine = await one(org.owner, 'analysis_engine');
    expect(engine).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(engine)).not.toContain('ai:8000');

    tracesConfig.url = base;
    resetIntegrationProbes();
    expect(await one(org.owner, 'traces')).toMatchObject({ status: 'connected' });
    tracesConfig.url = 'http://127.0.0.1:9';
    resetIntegrationProbes();
    const traces = await one(org.owner, 'traces');
    expect(traces).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(traces)).not.toContain('127.0.0.1');
  });
});

describe('ingestion: a key is not data', () => {
  it('moves from not configured to configured to connected to delivering as things really happen', async () => {
    const org = await createOrg();
    await createService(org.owner, 'Checkout');
    expect((await one(org.owner, 'logs')).status).toBe('not_configured');

    const key = await createApiKey(org.owner, ['ingest:logs', 'ingest:metrics']);
    // A key exists. Nothing has been sent with it.
    expect(await one(org.owner, 'logs')).toMatchObject({ status: 'configured', lastReceivedAt: null });
    expect(await steps(org.owner)).toMatchObject({ services: true, source: true, connect: false, data: false });

    // The key is used, but what it sends is refused: connected is not delivering.
    expect((await send(key, 'logs', { logs: [] })).status).toBe(400);
    const rejected = await one(org.owner, 'logs');
    expect(rejected).toMatchObject({ status: 'degraded', lastReceivedAt: null });
    expect(rejected.statusDetail).toContain('Nothing has been accepted yet');
    expect(rejected.lastError!.message).toContain('logs');
    expect(await steps(org.owner)).toMatchObject({ connect: true, data: false });

    await send(key, 'logs', { service: 'checkout', logs: [{ level: 'error', message: 'timeout acquiring connection from pool' }, { level: 'info', message: 'request served' }] }).expect(202);
    const delivering = await one(org.owner, 'logs');
    expect(delivering).toMatchObject({ status: 'delivering' });
    expect(delivering.statusDetail).toContain('2 log lines in the last 24 hours');
    expect(delivering.lastReceivedAt).toBeTruthy();
    expect(delivering.facts).toContainEqual({ label: 'Services sending', value: '1 of 1' });
    expect(await steps(org.owner)).toMatchObject({ connect: true, data: true, associate: true, investigate: false });
    // Metrics share the key and have received nothing: each source is judged on its own.
    expect((await one(org.owner, 'metrics')).status).toBe('connected');

    // A first investigation completes the list.
    await org.owner.post('/api/v1/investigations').send({ question: 'Why is checkout slow today?' }).expect(202);
    expect((await overview(org.owner)).onboarding).toMatchObject({ complete: true });
  });

  it('says so when data arrives for services nobody registered, and lets the lines be given to a service afterwards', async () => {
    const org = await createOrg();
    const key = await createApiKey(org.owner, ['ingest:logs', 'ingest:metrics', 'ingest:deployments']);
    await send(key, 'logs', { service: 'payments-api', logs: [{ level: 'error', message: 'card declined upstream' }, { level: 'error', message: 'card declined upstream' }] }).expect(202);
    // Accepted, and useless as it stands: no investigation of any service can find these lines.
    const logs = await one(org.owner, 'logs');
    expect(logs.status).toBe('degraded');
    expect(logs.statusDetail).toContain('none of them belongs to a registered service');
    // Metrics for an unknown service are dropped; the request still succeeds, so the sender never learns.
    expect((await send(key, 'monitoring/metrics', { samples: [{ service: 'payments-api', metric: 'error_rate', value: 4 }] })).body).toMatchObject({ accepted: 0, rejected: 1 });
    const metrics = await one(org.owner, 'metrics');
    expect(metrics.status).toBe('degraded');
    expect(metrics.lastError!.message).toContain('1 of 1 samples in the last request were dropped');
    // A deployment for an unknown service is refused outright.
    expect((await send(key, 'deployments', { service: 'payments-api', version: 'v1.0.0' })).status).toBe(404);
    expect((await one(org.owner, 'deployments')).lastError!.message).toContain('Service not found');

    const before = await overview(org.owner);
    expect(before.unresolvedServices).toEqual([expect.objectContaining({ ref: 'payments-api', count: 2, linkable: true, registered: false, sources: expect.arrayContaining(['logs', 'metrics', 'deployments']) })]);
    expect(before.onboarding.steps.find((s) => s.id === 'associate')).toMatchObject({ done: false, detail: expect.stringContaining('matches no registered service') });

    // Registering the service under that name fixes what comes next…
    const service = (await org.owner.post('/api/v1/services').send({ name: 'Payments API', slug: 'payments-api', tier: 'TIER2' }).expect(201)).body;
    await send(key, 'monitoring/metrics', { samples: [{ service: 'payments-api', metric: 'error_rate', value: 4 }] }).expect(202);
    await send(key, 'deployments', { service: 'payments-api', version: 'v1.0.0' }).expect(201);
    expect((await one(org.owner, 'metrics')).status).toBe('delivering');
    expect((await one(org.owner, 'deployments')).status).toBe('delivering');
    // …and the two lines stored before it can be given to it.
    expect((await overview(org.owner)).unresolvedServices).toEqual([expect.objectContaining({ ref: 'payments-api', sources: ['logs'], registered: true })]);
    const viewer = await org.member('VIEWER');
    expect((await viewer.agent.post('/api/v1/integrations/unresolved-services/link').send({ ref: 'payments-api', service: 'payments-api' })).status).toBe(403);
    expect((await org.owner.post('/api/v1/integrations/unresolved-services/link').send({ ref: 'payments-api', service: 'payments-api' }).expect(200)).body).toMatchObject({ linked: 2 });
    expect(await prisma.logEntry.count({ where: { organizationId: org.organizationId, serviceId: service.id } })).toBe(2);
    const after = await overview(org.owner);
    expect(after.unresolvedServices).toEqual([]);
    expect((await one(org.owner, 'logs')).status).toBe('delivering');
    expect((await org.owner.post('/api/v1/integrations/unresolved-services/link').send({ ref: 'payments-api', service: 'payments-api' })).status).toBe(400);
    expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: 'integration.link_service' } })).toBe(1);
  });

  it('turns stale when a continuous source goes quiet, and never shows what a rejected request contained', async () => {
    const org = await createOrg();
    const service = await createService(org.owner, 'Checkout');
    const key = await createApiKey(org.owner, ['ingest:logs', 'ingest:metrics', 'ingest:events']);
    // Data that stopped two days ago.
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    await prisma.metricSample.create({ data: { organizationId: org.organizationId, serviceId: service.id, metric: 'error_rate', value: 1, timestamp: twoDaysAgo } });
    const stale = await one(org.owner, 'metrics');
    expect(stale.status).toBe('degraded');
    expect(stale.statusDetail).toContain('No data for 2 days');
    expect((await steps(org.owner)).data).toBe(false);
    // An event-driven source is not stale for being quiet.
    await prisma.serviceEvent.create({ data: { organizationId: org.organizationId, serviceId: service.id, type: 'restart', title: 'Restarted', occurredAt: twoDaysAgo } });
    expect((await one(org.owner, 'events')).status).toBe('delivering');

    // A rejected payload full of things that must not be repeated.
    const secret = 'password=hunter2 token=sk-ant-api03-abcdefghijklmnop';
    expect((await send(key, 'logs', { logs: [{ level: 'error', message: 42, attributes: { secret } }] })).status).toBe(400);
    expect((await send(key, 'monitoring/metrics', { samples: [{ service: secret, metric: 'Not Snake Case', value: 1 }] })).status).toBe(400);
    // One of our own error messages quotes what the caller sent. The quoted part is not kept.
    const withDeploys = await createApiKey(org.owner, ['ingest:deployments']);
    expect((await send(withDeploys, 'deployments', { service: 'checkout', version: 'v2', rollbackOf: 'hunter2-not-a-version' })).status).toBe(400);
    expect((await one(org.owner, 'deployments')).lastError!.message).toContain('(value omitted)');
    const shown = JSON.stringify(await overview(org.owner));
    expect(shown).not.toContain('hunter2');
    expect(shown).not.toContain('sk-ant');
    expect((await one(org.owner, 'logs')).lastError!.message).toMatch(/^The request was rejected: logs\.0\.message: /);
    // Neither the key nor its hash is anywhere in what the page receives.
    expect(shown).not.toContain(key);
    expect(shown).not.toContain(key.slice(4, 20));
  });

  it('keeps one organisation out of another', async () => {
    const [a, b] = [await createOrg('Org A'), await createOrg('Org B')];
    await createService(a.owner, 'Checkout');
    const keyA = await createApiKey(a.owner, ['ingest:logs']);
    await send(keyA, 'logs', { service: 'checkout', logs: [{ message: 'only in A' }] }).expect(202);
    await send(keyA, 'logs', { service: 'orphan-in-a', logs: [{ message: 'unlinked in A' }] }).expect(202);
    expect((await one(a.owner, 'logs')).status).toBe('degraded'); // because of the unknown name
    // B sees nothing of it.
    const seenByB = await overview(b.owner);
    expect(seenByB.integrations.find((i) => i.id === 'logs')).toMatchObject({ status: 'not_configured', lastReceivedAt: null, lastError: null });
    expect(seenByB.unresolvedServices).toEqual([]);
    // B cannot give A's lines to one of its own services, nor to one of A's.
    const serviceB = await createService(b.owner, 'Billing');
    expect((await b.owner.post('/api/v1/integrations/unresolved-services/link').send({ ref: 'orphan-in-a', service: serviceB.slug })).status).toBe(400);
    expect((await b.owner.post('/api/v1/integrations/unresolved-services/link').send({ ref: 'orphan-in-a', service: 'checkout' })).status).toBe(404);
    expect(await prisma.logEntry.count({ where: { organizationId: a.organizationId, serviceId: null } })).toBe(1);
    expect(await prisma.integrationState.count({ where: { organizationId: b.organizationId } })).toBe(0);
  });
});

describe('GitHub: a saved token is not a working integration', () => {
  it('validates before saving, checks again on request, and follows what GitHub answers', async () => {
    const org = await createOrg();
    // A token GitHub rejects is not stored, and the refusal does not echo it.
    const refused = await org.owner.put('/api/v1/github/integration').send({ token: 'ghp_wrongwrongwrongwrongwrongwrongwrong00' });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain('ghp_wrong');
    expect((await one(org.owner, 'github')).status).toBe('not_configured');

    await org.owner.put('/api/v1/github/integration').send({ token: TOKEN }).expect(200);
    const saved = await one(org.owner, 'github');
    expect(saved).toMatchObject({ status: 'connected', setup: { canCheck: true } });
    expect(saved.statusDetail).toContain('No repository is connected yet');

    const check = (await org.owner.post('/api/v1/integrations/github/check').expect(200)).body;
    expect(contract.IntegrationCheck.safeParse(check).success).toBe(true);
    expect(check).toMatchObject({ ok: true, detail: expect.stringContaining('Authenticated as acme-bot') });
    expect((await one(org.owner, 'github')).lastCheck).toMatchObject({ ok: true });

    // The token is revoked at GitHub. Nothing changed here, so only a check can find out.
    github.tokenValid = false;
    resetCheckCooldown();
    const failed = (await org.owner.post('/api/v1/integrations/github/check').expect(200)).body;
    expect(failed).toMatchObject({ ok: false, detail: expect.stringContaining('GitHub rejected the token') });
    const broken = await one(org.owner, 'github');
    expect(broken).toMatchObject({ status: 'unavailable', lastCheck: { ok: false } });
    // Neither the token nor GitHub's own error text (which quoted the header) is shown or stored.
    const everything = JSON.stringify([failed, await overview(org.owner), await prisma.integrationState.findMany({ where: { organizationId: org.organizationId } }), await prisma.auditLog.findMany({ where: { organizationId: org.organizationId } })]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('Bad credentials');

    // Fixed at GitHub: checking again clears it. Checks cannot be fired in quick succession.
    github.tokenValid = true;
    expect((await org.owner.post('/api/v1/integrations/github/check')).status).toBe(429);
    resetCheckCooldown();
    await org.owner.post('/api/v1/integrations/github/check').expect(200);
    expect((await one(org.owner, 'github')).status).toBe('connected');

    // Only people who may manage integrations can run a check; an API key never can.
    const engineer = await org.member('ENGINEER');
    expect((await engineer.agent.post('/api/v1/integrations/github/check')).status).toBe(403);
    const key = await createApiKey(org.owner, ['tools:read']);
    expect([401, 403]).toContain((await api().post('/api/v1/integrations/github/check').set('x-api-key', key)).status);
    expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: 'integration.check' } })).toBe(3);
  });
});

describe('remediation webhook: an address is not a receiver', () => {
  const save = (org: Org, extra: Record<string, unknown> = {}) => org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: `${base}/hook`, ...extra });

  it('is a complete way of working when absent, and is judged by a test request when present', async () => {
    const org = await createOrg();
    const absent = await one(org.owner, 'remediation_webhook');
    expect(absent).toMatchObject({ status: 'not_configured', setup: { canCheck: false } });
    expect(absent.statusDetail).toContain('carried out by a person');
    expect((await org.owner.post('/api/v1/integrations/remediation-webhook/check')).status).toBe(409);

    netConfig.allowPrivate = true;
    await save(org, { remediationWebhookSecret: WEBHOOK_SECRET }).expect(200);
    expect(await one(org.owner, 'remediation_webhook')).toMatchObject({ status: 'configured', setup: { canCheck: true }, lastCheck: null });

    const ok = (await org.owner.post('/api/v1/integrations/remediation-webhook/check').expect(200)).body;
    expect(ok).toMatchObject({ ok: true, detail: 'The receiver answered the test request (HTTP 200).' });
    expect((await one(org.owner, 'remediation_webhook')).status).toBe('connected');
    // What was sent: a ping, signed, carrying no action and nothing that could be executed.
    expect(hook.received).toHaveLength(1);
    expect(hook.received[0]!.body).toEqual({ event: 'ping', organization: org.slug, sentAt: expect.any(String) });
    expect(hook.received[0]!.headers['x-opspilot-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(hook.received[0]!.headers['x-opspilot-event']).toBe('ping');

    for (const [arrange, expected] of [
      [() => (hook.status = 500), 'The receiver refused the test request (HTTP 500).'],
      [() => (hook.status = 302), 'Redirects are not followed'],
    ] as const) {
      arrange();
      resetCheckCooldown();
      const result = (await org.owner.post('/api/v1/integrations/remediation-webhook/check').expect(200)).body;
      expect(result.ok).toBe(false);
      expect(result.detail).toContain(expected);
      expect((await one(org.owner, 'remediation_webhook')).status).toBe('unavailable');
    }
    // The receiver's own answer, the address and the secret appear nowhere.
    const everything = JSON.stringify([await overview(org.owner), await prisma.integrationState.findMany({ where: { organizationId: org.organizationId } }), await prisma.auditLog.findMany({ where: { organizationId: org.organizationId, action: 'integration.check' } })]);
    for (const forbidden of ['internal-hostname', WEBHOOK_SECRET, '/hook', new URL(base).port]) expect(everything).not.toContain(forbidden);

    // Changing the address makes the earlier result say nothing about the new one.
    hook.status = 200;
    await save(org).expect(200);
    expect(await one(org.owner, 'remediation_webhook')).toMatchObject({ status: 'configured', lastCheck: null });
  });

  it('refuses to send the test request to a private address, and says why without making the request', async () => {
    const org = await createOrg();
    // Saved while private targets were allowed (or the name now resolves somewhere else).
    netConfig.allowPrivate = true;
    await save(org).expect(200);
    netConfig.allowPrivate = false;
    const result = (await org.owner.post('/api/v1/integrations/remediation-webhook/check').expect(200)).body;
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('private, loopback or link-local') });
    expect(hook.received).toHaveLength(0);
    // Cloud metadata and other internal targets cannot be saved in the first place.
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:6379/', 'http://[::1]/', 'ftp://example.com/x', 'https://user:pass@example.com/hook']) {
      expect((await org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: url })).status).toBe(400);
    }
    // Only admins and owners, and only people.
    const engineer = await org.member('ENGINEER');
    expect((await engineer.agent.post('/api/v1/integrations/remediation-webhook/check')).status).toBe(403);
  });
});

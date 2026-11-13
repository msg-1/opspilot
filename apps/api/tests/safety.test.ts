import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvestigationEvent } from '../src/integrations/aiService';

// Runbook and remediation safety, trace retrieval and the report fields added for healthy-state
// conclusions and checked figures. The AI service is a scripted double; nothing calls a model.
const ai = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('../src/integrations/aiService', () => ({
  aiService: {
    status: async () => ({ llm: { provider: 'heuristic', model: null, available: false }, embeddings: { provider: 'test', model: 'unit', dimensions: 768 } }),
    embed: async (texts: string[]) => ({ provider: 'test', model: 'unit', dimensions: 768, vectors: texts.map(() => [1, ...new Array(767).fill(0)]) }),
    runInvestigation: async (_request: never, onEvent: (e: InvestigationEvent) => Promise<void>) => {
      for (const event of ai.events) await onEvent(event as InvestigationEvent);
    },
  },
}));

import { env } from '../src/config/env';
import { tracesConfig } from '../src/integrations/traces';
import { actionEffect, runbookPlan } from '../src/lib/actionEffect';
import { netConfig } from '../src/lib/netguard';
import { contentHash } from '../src/modules/remediation';
import { api, createApiKey, createOrg, createService, prisma } from './helpers';

type Org = Awaited<ReturnType<typeof createOrg>>;

// A stand-in for the organisation's remediation webhook.
let hook: Server;
let received: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
let respond = { status: 200, delayMs: 0 };

beforeAll(async () => {
  netConfig.allowPrivate = true;
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      setTimeout(() => res.writeHead(respond.status).end('{}'), respond.delayMs);
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  netConfig.allowPrivate = false;
  await new Promise((resolve) => hook.close(resolve));
});
beforeEach(() => {
  received = [];
  respond = { status: 200, delayMs: 0 };
  env.REMEDIATION_WEBHOOK_TIMEOUT_MS = 30_000;
  ai.events = [];
});

const useWebhook = (org: Org) => org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook` }).expect(200);
const FLUSH = { type: 'run_runbook', title: 'Flush the order cache', description: 'Purge every order:* key in orders-cache.', risk: 'LOW', parameters: { cache: 'orders-cache', pattern: 'order:*' } };
const CHECK = { type: 'manual', title: 'Check cache hit ratio', description: 'Compare the hit ratio with yesterday and read the cache log.', risk: 'LOW' };
const auditOf = async (id: string) => (await prisma.auditLog.findMany({ where: { resourceId: id }, orderBy: { createdAt: 'asc' } })).map((a) => ({ action: a.action, actor: a.actorId, meta: a.metadata as Record<string, unknown> | null }));

async function approved(org: Org, body: Record<string, unknown> = FLUSH) {
  const approver = await org.member('ADMIN');
  const action = (await org.owner.post('/api/v1/remediations').send(body).expect(201)).body;
  const base = `/api/v1/remediations/${action.id}`;
  await org.owner.post(`${base}/request-approval`).expect(200);
  const after = (await approver.agent.post(`${base}/approve`).send({ expectedHash: action.currentHash }).expect(200)).body;
  expect(after.status).toBe('APPROVED');
  return { base, action, approver };
}

describe('action effects', () => {
  it('agrees with the AI service on what every kind of action does', () => {
    const cases = JSON.parse(readFileSync(join(__dirname, '../../../contracts/fixtures/action-effects.json'), 'utf8')) as { type: string; title: string; description: string; effect: string }[];
    const wrong = cases.filter((c) => actionEffect(c.type, c.title, c.description).effect !== c.effect).map((c) => `${c.title} → ${actionEffect(c.type, c.title, c.description).effect}`);
    expect(wrong).toEqual([]);
    expect(cases.length).toBeGreaterThan(20);
  });

  it('turns a runbook into a plan whose steps are labelled by what they do', async () => {
    const org = await createOrg();
    const doc = (
      await org.owner.post('/api/v1/knowledge/documents').send({
        title: 'Runbook: orders cache',
        type: 'runbook',
        content: '# Orders cache\n\n## Diagnose\n1. Check the hit ratio on the cache dashboard\n2. Compare key counts with yesterday\n\n## Mitigate\n- Flush the order:* keys\n- Restart the cache node if memory stays above 90%\n\n```\nredis-cli --scan --pattern "order:*"\nredis-cli FLUSHDB\n```\n\nBackground text that is not a step.',
      })
    ).body;
    const plan = (await org.owner.get(`/api/v1/knowledge/documents/${doc.id}/plan`).expect(200)).body;
    expect(plan.steps.map((s: { section: string; text: string; effect: string }) => `${s.section}: ${s.text.slice(0, 24)} → ${s.effect}`)).toEqual([
      'Diagnose: Check the hit ratio on t → read_only',
      'Diagnose: Compare key counts with  → read_only',
      'Mitigate: Flush the order:* keys → state_changing',
      'Mitigate: Restart the cache node i → state_changing',
      // Commands are judged as commands; one that cannot be recognised is not assumed harmless.
      'Mitigate: redis-cli --scan --patte → state_changing',
      'Mitigate: redis-cli FLUSHDB → state_changing',
    ]);
    expect(plan).toMatchObject({ effect: 'state_changing', stateChanging: 4, readOnly: 2 });
    expect(runbookPlan('Just prose, no steps.')).toMatchObject({ effect: 'state_changing', steps: [] });
    expect(runbookPlan('- Check the dashboard\n- Read the logs').effect).toBe('read_only');
    // Reading the plan is read access and scoped to the organisation.
    const other = await createOrg();
    await other.owner.get(`/api/v1/knowledge/documents/${doc.id}/plan`).expect(404);
    expect((await (await org.member('VIEWER')).agent.get(`/api/v1/knowledge/documents/${doc.id}/plan`)).status).toBe(200);

    // An action that points at a runbook takes its effect from the runbook's steps, not from its own innocent title.
    const linked = (await org.owner.post('/api/v1/remediations').send({ type: 'run_runbook', title: 'Follow the orders cache runbook', description: 'Review the dashboard as described.', risk: 'LOW', parameters: { runbookDocumentId: doc.id } })).body;
    expect(linked).toMatchObject({ effect: 'state_changing', risk: 'MEDIUM', requiredApprovals: 1 });
    expect(linked.effectReasons.join(' ')).toContain('clears a queue, cache or data');
    await other.owner.post('/api/v1/remediations').send({ type: 'run_runbook', title: 'Follow the orders cache runbook', description: 'Review it.', parameters: { runbookDocumentId: doc.id } }).expect(400);
  });
});

describe('read-only diagnostics', () => {
  it('need no approval, are recorded by a person and are never sent to the webhook', async () => {
    const org = await createOrg();
    await useWebhook(org);
    const engineer = await org.member('ENGINEER');
    const action = (await org.owner.post('/api/v1/remediations').send(CHECK).expect(201)).body;
    expect(action).toMatchObject({ effect: 'read_only', requiredApprovals: 0, risk: 'LOW', status: 'PROPOSED' });
    const base = `/api/v1/remediations/${action.id}`;
    expect((await org.owner.post(`${base}/request-approval`)).body.error.message).toContain('needs no approval');
    // It is still a person who does it and says so.
    expect((await engineer.agent.post(`${base}/execute`).send({})).status).toBe(400);
    const done = (await engineer.agent.post(`${base}/execute`).send({ confirmManual: true, notes: 'Hit ratio 94%, same as yesterday.' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'EXECUTED', executedBy: { id: engineer.userId }, executionResult: { mode: 'diagnostic', outcome: 'applied', detail: { findings: 'Hit ratio 94%, same as yesterday.' } } });
    expect(done.executionResult.summary).toContain('Nothing was changed');
    expect(received).toHaveLength(0);
    expect((await engineer.agent.post(`${base}/execute`).send({ confirmManual: true })).status).toBe(409);
    expect((await auditOf(action.id)).map((a) => a.action)).toEqual(['remediation.propose', 'remediation.execute_start', 'remediation.execute_success']);
    // A viewer cannot record it, and neither can an API key with every scope.
    const another = (await org.owner.post('/api/v1/remediations').send(CHECK)).body;
    expect((await (await org.member('VIEWER')).agent.post(`/api/v1/remediations/${another.id}/execute`).send({ confirmManual: true })).status).toBe(403);
  });

  it('stop being read-only the moment their text describes a change', async () => {
    const org = await createOrg();
    const action = (await org.owner.post('/api/v1/remediations').send(CHECK)).body;
    const edited = (await org.owner.patch(`/api/v1/remediations/${action.id}`).send({ description: 'Compare the hit ratio, then flush the cache.' }).expect(200)).body;
    expect(edited).toMatchObject({ effect: 'state_changing', risk: 'MEDIUM', requiredApprovals: 1, status: 'PROPOSED' });
    expect((await org.owner.post(`/api/v1/remediations/${action.id}/execute`).send({ confirmManual: true })).status).toBe(409);
    // Even if the stored label were stale, execution recomputes it from the text.
    const stale = (await org.owner.post('/api/v1/remediations').send(CHECK)).body;
    await prisma.remediationAction.update({ where: { id: stale.id }, data: { description: 'Restart the cache node.' } });
    const refused = await org.owner.post(`/api/v1/remediations/${stale.id}/execute`).send({ confirmManual: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('no longer a read-only diagnostic');
    expect(await prisma.remediationAction.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ effect: 'state_changing', status: 'PROPOSED', requiredApprovals: 1 });
  });
});

describe('state-changing actions', () => {
  it('cannot run without explicit approval by a person other than the proposer, and never by a machine', async () => {
    const org = await createOrg();
    await useWebhook(org);
    await org.owner.patch('/api/v1/settings').send({ approvalsLowRisk: 1 });
    const action = (await org.owner.post('/api/v1/remediations').send(FLUSH).expect(201)).body;
    // Filed as a runbook step at LOW risk; what it does decides, not what it is called.
    expect(action).toMatchObject({ effect: 'state_changing', risk: 'MEDIUM', requiredApprovals: 1 });
    const base = `/api/v1/remediations/${action.id}`;
    expect((await org.owner.post(`${base}/execute`).send({ confirmManual: true })).status).toBe(409);
    await org.owner.post(`${base}/request-approval`).expect(200);
    expect((await org.owner.post(`${base}/execute`).send({ confirmManual: true })).status).toBe(409);
    expect((await org.owner.post(`${base}/approve`).send({})).status).toBe(403); // the proposer
    // Machines: an API key with every scope, and the AI's tool token, are refused on approve and execute.
    const key = await createApiKey(org.owner, ['ingest:logs', 'ingest:deployments', 'ingest:events', 'ingest:metrics', 'tools:read']);
    for (const path of ['approve', 'execute', 'retry']) expect([401, 403]).toContain((await api().post(`${base}/${path}`).set('x-api-key', key).send({ confirmManual: true })).status);
    expect([401, 403]).toContain((await api().patch(base).set('x-api-key', key).send({ title: 'Changed by a machine' })).status);
    expect(received).toHaveLength(0);
    expect((await org.owner.get(base)).body).toMatchObject({ status: 'PENDING_APPROVAL', approvalsGranted: 0 });
  });

  it('run once after approval, and the record says who approved exactly what', async () => {
    const org = await createOrg();
    await useWebhook(org);
    const service = await createService(org.owner, 'Orders');
    const { base, action, approver } = await approved(org, { ...FLUSH, serviceId: service.id });
    const done = (await org.owner.post(`${base}/execute`).send({}).expect(200)).body;
    expect(done).toMatchObject({ status: 'EXECUTED', attempts: 1, executionResult: { mode: 'webhook', outcome: 'applied', contentHash: action.currentHash, attempt: 1 } });
    expect(done.executionResult.approvedBy).toEqual([expect.objectContaining({ approverId: approver.userId })]);
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toMatchObject({ actionId: action.id, idempotencyKey: action.id, contentHash: action.currentHash, parameters: FLUSH.parameters, effect: 'state_changing' });
    const trail = await auditOf(action.id);
    expect(trail.map((a) => a.action)).toEqual(['remediation.propose', 'remediation.request_approval', 'remediation.approve', 'remediation.execute_start', 'remediation.execute_success']);
    expect(trail[2]).toMatchObject({ actor: approver.userId, meta: { contentHash: action.currentHash } });
    expect(trail[3]!.meta).toMatchObject({ contentHash: action.currentHash, approvedBy: [approver.userId], mode: 'webhook' });
    expect(trail[4]!.meta).toMatchObject({ outcome: 'applied' });
    expect((await org.owner.post(`${base}/execute`).send({})).status).toBe(409);
    expect(received).toHaveLength(1);
  });

  it('lose their approval when anything an approver was shown is changed', async () => {
    const org = await createOrg();
    await useWebhook(org);
    const { base, action, approver } = await approved(org);
    // The requester widens the scope after approval.
    const edited = (await org.owner.patch(base).send({ parameters: { cache: 'orders-cache', pattern: '*' } }).expect(200)).body;
    expect(edited).toMatchObject({ status: 'PROPOSED', approvalsGranted: 0 });
    expect(edited.currentHash).not.toBe(action.currentHash);
    expect(edited.approvals).toEqual([expect.objectContaining({ decision: 'approved', counts: false })]);
    expect(edited.approvals[0].supersededAt).toBeTruthy();
    expect((await org.owner.post(`${base}/execute`).send({})).status).toBe(409);
    expect(received).toHaveLength(0);
    // It must be submitted and approved again, and an approver who still has the old version open is stopped.
    await org.owner.post(`${base}/request-approval`).expect(200);
    const stale = await approver.agent.post(`${base}/approve`).send({ expectedHash: action.currentHash });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toContain('changed after it was submitted or after you opened it');
    await approver.agent.post(`${base}/approve`).send({ expectedHash: edited.currentHash }).expect(200);
    expect((await org.owner.post(`${base}/execute`).send({}).expect(200)).body.status).toBe('EXECUTED');
    expect(received[0]!.body).toMatchObject({ parameters: { pattern: '*' }, contentHash: edited.currentHash });
    const edit = (await auditOf(action.id)).find((a) => a.action === 'remediation.edit')!;
    expect(edit.meta).toMatchObject({ previousHash: action.currentHash, newHash: edited.currentHash, supersededApprovals: 1, previousStatus: 'APPROVED' });
    // An edit that changes nothing an approver saw (the rationale) keeps the approval.
    const second = await approved(org);
    expect((await org.owner.patch(second.base).send({ rationale: 'Added context for the record.' })).body).toMatchObject({ status: 'APPROVED', approvalsGranted: 1 });
  });

  it('are refused at execution if their content is not what was approved, however it changed', async () => {
    const org = await createOrg();
    await useWebhook(org);
    const { base, action } = await approved(org);
    // Changed underneath the API (a bug, a script, a direct database write).
    await prisma.remediationAction.update({ where: { id: action.id }, data: { parameters: { cache: 'orders-cache', pattern: '*' } } });
    const refused = await org.owner.post(`${base}/execute`).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('not the one that was approved');
    expect(received).toHaveLength(0);
    expect((await org.owner.get(base)).body).toMatchObject({ status: 'PROPOSED', approvalsGranted: 0 });
    expect((await auditOf(action.id)).find((a) => a.action === 'remediation.approval_invalid')!.meta).toMatchObject({ approvedHash: action.currentHash, validApprovals: 0 });

    // Approval of one action authorises no other, even one with identical content.
    const twin = (await org.owner.post('/api/v1/remediations').send(FLUSH)).body;
    expect(twin.currentHash).toBe(action.currentHash);
    expect((await org.owner.post(`/api/v1/remediations/${twin.id}/execute`).send({})).status).toBe(409);
    await prisma.remediationAction.update({ where: { id: twin.id }, data: { status: 'APPROVED', contentHash: twin.currentHash } }); // status forged, no approval rows
    expect((await org.owner.post(`/api/v1/remediations/${twin.id}/execute`).send({})).status).toBe(409);
    expect(received).toHaveLength(0);
    // The hash covers what matters and ignores key order.
    const base0 = { type: 'config_change', title: 't', description: 'd', risk: 'LOW' as const, serviceId: null };
    expect(contentHash({ ...base0, parameters: { a: 1, b: { c: 2, d: 3 } } })).toBe(contentHash({ ...base0, parameters: { b: { d: 3, c: 2 }, a: 1 } }));
    for (const change of [{ title: 'x' }, { description: 'x' }, { risk: 'HIGH' as const }, { serviceId: 's' }, { type: 'manual' }, { parameters: { a: 2 } }]) {
      expect(contentHash({ ...base0, parameters: { a: 1 }, ...change })).not.toBe(contentHash({ ...base0, parameters: { a: 1 } }));
    }
  });

  it('are dispatched once when execution is requested twice at the same moment', async () => {
    const org = await createOrg();
    await useWebhook(org);
    const { base } = await approved(org);
    respond.delayMs = 150;
    const results = await Promise.all([org.owner.post(`${base}/execute`).send({}), org.owner.post(`${base}/execute`).send({}), org.owner.post(`${base}/execute`).send({})]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(received).toHaveLength(1);
    expect((await org.owner.get(base)).body).toMatchObject({ status: 'EXECUTED', attempts: 1 });
  });

  it('record an unknown outcome on timeout and are not retried until a person confirms nothing was applied', async () => {
    const org = await createOrg();
    await useWebhook(org);
    const service = await createService(org.owner, 'Orders');
    const { base, action } = await approved(org, { ...FLUSH, serviceId: service.id });
    env.REMEDIATION_WEBHOOK_TIMEOUT_MS = 200;
    respond.delayMs = 900;
    const timedOut = (await org.owner.post(`${base}/execute`).send({}).expect(200)).body;
    // The request was sent. It is not reported as executed, and not as a clean failure either.
    expect(timedOut).toMatchObject({ status: 'FAILED', executionResult: { success: false, outcome: 'unknown', mode: 'webhook' } });
    expect(timedOut.executionResult.summary).toContain('whether the change was applied is unknown');
    expect(await prisma.serviceEvent.count({ where: { organizationId: org.organizationId } })).toBe(0); // no effect is recorded for something that may not have happened
    expect((await auditOf(action.id)).at(-1)).toMatchObject({ action: 'remediation.execute_failure', meta: { outcome: 'unknown' } });

    const blocked = await org.owner.post(`${base}/retry`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('the change may have been applied');
    expect((await org.owner.post(`${base}/execute`).send({})).status).toBe(409);
    await org.owner.post(`${base}/retry`).send({ confirmNotApplied: true }).expect(200);
    respond.delayMs = 0;
    const done = (await org.owner.post(`${base}/execute`).send({}).expect(200)).body;
    expect(done).toMatchObject({ status: 'EXECUTED', attempts: 2, executionResult: { outcome: 'applied', attempt: 2 } });
    // Both attempts carried the same idempotency key, so a receiver that did apply the first can refuse the second.
    expect(received.map((r) => [r.headers['idempotency-key'], r.body.attempt])).toEqual([[action.id, 1], [action.id, 2]]);
    expect((await auditOf(action.id)).find((a) => a.action === 'remediation.retry')!.meta).toMatchObject({ previousOutcome: 'unknown', confirmedNotApplied: true });
    expect(await prisma.serviceEvent.count({ where: { organizationId: org.organizationId, source: 'remediation' } })).toBe(1);
  });

  it('distinguish a refusal from a failure that may have been half-applied', async () => {
    const org = await createOrg();
    await useWebhook(org);
    const first = await approved(org);
    respond.status = 500;
    expect((await org.owner.post(`${first.base}/execute`).send({})).body).toMatchObject({ status: 'FAILED', executionResult: { outcome: 'unknown', detail: { status: 500 } } });
    expect((await org.owner.post(`${first.base}/retry`).send({})).status).toBe(409);
    const second = await approved(org);
    respond.status = 403;
    const refused = (await org.owner.post(`${second.base}/execute`).send({})).body;
    expect(refused).toMatchObject({ status: 'FAILED', executionResult: { outcome: 'not_applied' } });
    expect(refused.executionResult.summary).toContain('Nothing was applied');
    await org.owner.post(`${second.base}/retry`).send({}).expect(200); // nothing was applied, so no confirmation is needed
    // A retry does not skip the binding: the content is checked again when it is executed.
    await prisma.remediationAction.update({ where: { id: second.action.id }, data: { title: 'Flush everything' } });
    expect((await org.owner.post(`${second.base}/execute`).send({})).status).toBe(409);
    // An unreachable webhook: the connection failed, so the outcome is unknown rather than assumed clean.
    const third = await approved(org);
    await prisma.organizationSettings.update({ where: { organizationId: org.organizationId }, data: { remediationWebhookUrl: 'http://127.0.0.1:9/hook' } });
    expect((await org.owner.post(`${third.base}/execute`).send({})).body).toMatchObject({ status: 'FAILED', executionResult: { outcome: 'unknown' } });
  });
});

describe('trace retrieval', () => {
  let jaeger: Server;
  let asked: string[] = [];
  const micros = (msAgo: number) => (Date.now() - msAgo) * 1000;
  const span = (traceID: string, spanID: string, parent: string | null, process: string, operationName: string, startMsAgo: number, durationMs: number, tags: Record<string, unknown> = {}) => ({
    traceID, spanID, operationName, processID: process, startTime: micros(startMsAgo), duration: durationMs * 1000,
    references: parent ? [{ refType: 'CHILD_OF', traceID, spanID: parent }] : [], tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
  });
  const processes = { p1: { serviceName: 'gateway' }, p2: { serviceName: 'orders' }, p3: { serviceName: 'payments' } };

  beforeAll(async () => {
    jaeger = createServer((req, res) => {
      asked.push(req.url!);
      const data = [
        { traceID: 't-slow', processes, spans: [span('t-slow', 'a', null, 'p1', 'GET /orders', 60_000, 1900), span('t-slow', 'b', 'a', 'p2', 'GET /orders', 59_990, 1880), span('t-slow', 'c', 'b', 'p2', 'pg.query:SELECT orders', 59_980, 1850, { 'db.system': 'postgresql', 'net.peer.name': 'demo-postgres' })] },
        { traceID: 't-fast', processes, spans: [span('t-fast', 'a', null, 'p1', 'GET /orders', 50_000, 40), span('t-fast', 'b', 'a', 'p2', 'GET /orders', 49_995, 30)] },
        // Listed out of order on purpose: the failed spans must come back from the entry point down.
        { traceID: 't-fail', processes, spans: [
          span('t-fail', 'c', 'b', 'p3', 'set', 39_985, 2, { error: true, 'span.kind': 'client', 'db.system.name': 'redis', 'server.address': 'demo-redis', 'otel.status_description': 'connect ECONNREFUSED redis:6379' }),
          span('t-fail', 'a', null, 'p1', 'POST /checkout', 40_000, 120, { 'http.status_code': 502, 'span.kind': 'server', 'server.address': 'gateway.example' }),
          span('t-fail', 'b', 'a', 'p3', 'POST /pay', 39_990, 100, { error: true, 'span.kind': 'server', 'server.address': 'payments.example' }),
        ] },
        { traceID: 't-other', processes, spans: [span('t-other', 'a', null, 'p3', 'GET /health', 30_000, 5)] },
      ];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
    });
    await new Promise<void>((resolve) => jaeger.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    tracesConfig.url = '';
    await new Promise((resolve) => jaeger.close(resolve));
  });

  it('summarises where time was spent and which span failed, for a service of the caller only', async () => {
    const org = await createOrg();
    await createService(org.owner, 'Gateway');
    const key = await createApiKey(org.owner, ['tools:read']);
    const traces = (query: string) => api().get(`/api/v1/tools/traces?${query}`).set('x-api-key', key);

    tracesConfig.url = '';
    const none = (await traces('service=gateway').expect(200)).body;
    expect(none).toMatchObject({ available: false, traces: [] });
    expect(none.note).toContain('No trace store is connected');

    tracesConfig.url = `http://127.0.0.1:${(jaeger.address() as AddressInfo).port}`;
    asked = [];
    const body = (await traces('service=gateway&from=1h').expect(200)).body;
    // The window is sampled in slices, because a trace store returns the most recent traces first.
    expect(asked).toHaveLength(4);
    expect(asked.every((u) => u.includes('/api/traces?service=gateway'))).toBe(true);
    const starts = asked.map((u) => Number(new URL(u, 'http://x').searchParams.get('start'))).sort((a, b) => a - b);
    expect(new Set(starts).size).toBe(4);
    expect(Number(new URL(asked[0]!, 'http://x').searchParams.get('end'))).toBeLessThan((Date.now() - 7000) * 1000); // the last seconds are left out: spans may still be arriving
    expect(body).toMatchObject({ available: true, service: 'gateway', sampled: 3, failed: 1 });
    // The failed trace first, then the slowest. A trace that never touched the service is left out.
    expect(body.traces.map((t: { traceId: string }) => t.traceId)).toEqual(['t-fail', 't-slow', 't-fast']);
    // From the entry point down: the last failed span is the deepest, where the failure starts. A
    // server span has no peer (its address attributes name itself); the outgoing call does.
    expect(body.traces[0].errorSpans).toEqual([
      { service: 'gateway', operation: 'POST /checkout', message: 'HTTP 502', system: null, peer: null },
      { service: 'payments', operation: 'POST /pay', message: null, system: null, peer: null },
      { service: 'payments', operation: 'set', message: 'connect ECONNREFUSED redis:6379', system: 'redis', peer: 'demo-redis' },
    ]);
    // Self time, not total time: the gateway span lasted longest, the database query is where the time went.
    expect(body.traces[1]).toMatchObject({ durationMs: 1900, rootService: 'gateway', spanCount: 3, services: ['gateway', 'orders'], slowestSpan: { service: 'orders', operation: 'pg.query:SELECT orders', durationMs: 1850, selfMs: 1850, system: 'postgresql', peer: 'demo-postgres' } });
    expect(body.p95Ms).toBe(1900);
    expect((await traces('service=gateway&errorsOnly=true')).body.traces.map((t: { traceId: string }) => t.traceId)).toEqual(['t-fail']);

    // The trace store knows nothing of tenants: a service that is not the caller's is refused before it is asked.
    asked = [];
    const other = await createOrg();
    const otherKey = await createApiKey(other.owner, ['tools:read']);
    expect((await api().get('/api/v1/tools/traces?service=gateway').set('x-api-key', otherKey)).status).toBe(404);
    expect(asked).toHaveLength(0);
    // An unreachable trace store is reported, not hidden.
    tracesConfig.url = 'http://127.0.0.1:9';
    expect((await traces('service=gateway')).body).toMatchObject({ available: false, traces: [] });
    // A window that ended moments ago has nothing settled to read yet, and says so.
    tracesConfig.url = `http://127.0.0.1:${(jaeger.address() as AddressInfo).port}`;
    const tooRecent = (await traces(`service=gateway&from=${encodeURIComponent(new Date(Date.now() - 3000).toISOString())}`)).body;
    expect(tooRecent).toMatchObject({ available: true, sampled: 0 });
    expect(tooRecent.note).toContain('too recent');
  });
});

describe('investigation reports', () => {
  const evidence = (ref: string, kind: string, title: string) => ({ type: 'evidence', evidence: { ref, kind, title, summary: `${title} summary`, sourceType: kind, sourceId: `${kind}-${ref}` } });

  it('judge a rollback by the deployment it rolls back, not by the previous version it cites', async () => {
    // From the demo run: the correct rollback cited the previous version's deployment, which was
    // also the only evidence of a hypothesis rated unlikely, and was withdrawn for it.
    const org = await createOrg();
    await createService(org.owner, 'Orders');
    const hypothesis = (title: string, confidence: number, status: string, evidenceRefs: string[]) => ({ title, description: 'd', confidence, status, evidenceRefs, facts: [], assumptions: [], gaps: [] });
    const rollback = (deploymentId: string, toVersion: string) => ({ type: 'rollback_deployment', title: `Roll back orders to ${toVersion}`, description: 'Return to the previous version.', risk: 'MEDIUM', serviceSlug: 'orders', parameters: { deploymentId, toVersion }, evidenceRefs: ['E1', 'E2', 'E3'] });
    const run = async (action: Record<string, unknown>) => {
      ai.events = [
        evidence('E1', 'deployment', 'Deployment of orders v1.5.0'),
        evidence('E2', 'deployment', 'Rollback of orders v1.4.0'),
        evidence('E3', 'log_pattern', '300× ERROR in orders'),
        {
          type: 'final',
          report: {
            summary: 'Errors began after v1.5.0.', confidence: 0.57, analysisMode: 'heuristic', outcome: 'INCIDENT',
            assessment: { outcome: 'INCIDENT', confidence: 0.9, rationale: 'A failure is evident.', supportingRefs: ['E3'], signals: [], missingTelemetry: [] },
            hypotheses: [hypothesis('Regression introduced by v1.5.0', 0.57, 'likely', ['E1', 'E3']), hypothesis('Regression introduced by the earlier v1.4.0 deployment', 0.2, 'unlikely', ['E2'])],
            facts: [], timeline: [], assumptions: [], uncertainties: ['x'], nextSteps: [], recommendedActions: [action],
          },
        },
      ];
      const started = await org.owner.post('/api/v1/investigations').send({ question: 'Why is orders returning errors?' });
      return (await org.owner.get(`/api/v1/investigations/${started.body.id}`)).body;
    };
    // The evidence helper gives each item the source id "<kind>-<ref>".
    const kept = await run(rollback('deployment-E1', 'v1.4.0'));
    expect(kept.report.recommendedActions.map((a: { type: string }) => a.type)).toEqual(['rollback_deployment']);
    expect(kept.remediations).toEqual([expect.objectContaining({ type: 'rollback_deployment', status: 'PROPOSED', effect: 'state_changing' })]);
    // Rolling back the deployment that the unlikely hypothesis is about is withdrawn.
    const withdrawn = await run(rollback('deployment-E2', 'v1.3.9'));
    expect(withdrawn.report.recommendedActions).toEqual([]);
    expect(withdrawn.report.nextSteps.join(' ')).toContain('Considered and not recommended (it would change production on the strength of a hypothesis rated unlikely)');
    expect(withdrawn.remediations).toEqual([]);
  });

  it('store a healthy conclusion with the evidence it rests on, and carry claim verification to the reader', async () => {
    const org = await createOrg();
    await createService(org.owner, 'Billing');
    ai.events = [
      evidence('E1', 'metric_baseline', '2 metric(s) for billing show no notable change'),
      evidence('E2', 'log_pattern', '6× WARN in billing'),
      {
        type: 'final',
        report: {
          summary: 'No material evidence of a fault.', confidence: 0, analysisMode: 'heuristic', outcome: 'HEALTHY',
          assessment: { outcome: 'HEALTHY', confidence: 0.82, rationale: 'No material evidence of a fault in the window examined: metrics held steady.', supportingRefs: ['E1'], signals: [{ level: 'weak', kind: 'logs', text: '6× WARN in billing', evidenceRefs: ['E2'] }], missingTelemetry: ['Traces were not examined.'] },
          observations: [{ statement: 'Noticed, but not evidence of a fault on its own: 6× WARN in billing.', evidenceRefs: ['E2'], verification: { status: 'verified', checks: [{ text: '6', kind: 'number', status: 'exact', detail: 'E2 holds 6', evidenceRef: 'E2' }] } }],
          facts: [{ statement: 'Error rate averaged 44%.', evidenceRefs: ['E1'], verification: { status: 'unsupported', checks: [{ text: '44%', kind: 'number', status: 'unsupported', detail: 'no cited evidence holds this value' }] } }],
          integrity: { checked: 2, supported: 1, flagged: [{ where: 'fact 1', text: '44%', status: 'unsupported', detail: 'no cited evidence holds this value' }] },
          hypotheses: [], timeline: [], assumptions: [], uncertainties: ['x'], nextSteps: [],
          // A production change proposed for a healthy service is withdrawn here too, even if the AI service let it through.
          recommendedActions: [
            { type: 'restart_service', title: 'Restart billing', description: 'Restart the pods.', risk: 'LOW', serviceSlug: 'billing', evidenceRefs: ['E2'], effect: 'read_only' },
            { type: 'manual', title: 'Read the warning lines', description: 'Check what the retries say.', risk: 'LOW', serviceSlug: 'billing', evidenceRefs: ['E2'] },
          ],
        },
      },
    ];
    const started = await org.owner.post('/api/v1/investigations').send({ question: 'Is billing healthy right now?' });
    const inv = (await org.owner.get(`/api/v1/investigations/${started.body.id}`)).body;
    expect(inv).toMatchObject({ status: 'COMPLETED', outcome: 'HEALTHY', confidence: 0 });
    expect(inv.report.assessment).toMatchObject({ outcome: 'HEALTHY', confidence: 0.82, supportingRefs: ['E1'], missingTelemetry: ['Traces were not examined.'] });
    expect(inv.report.observations[0].verification.status).toBe('verified');
    expect(inv.report.facts[0].verification).toMatchObject({ status: 'unsupported', checks: [{ text: '44%', status: 'unsupported' }] });
    expect(inv.report.integrity).toMatchObject({ checked: 2, supported: 1, flagged: [{ where: 'fact 1', text: '44%' }] });
    // The label the sender put on the restart is ignored; it is a production change and is withdrawn.
    expect(inv.report.recommendedActions.map((a: { title: string; effect: string }) => `${a.title} [${a.effect}]`)).toEqual(['Read the warning lines [read_only]']);
    expect(inv.report.nextSteps.join(' ')).toContain('Considered and not recommended (it would change production, and the evidence supports HEALTHY');
    expect(inv.remediations.map((r: { type: string }) => r.type)).toEqual(['manual']);
    expect((await org.owner.get(`/api/v1/remediations/${inv.remediations[0].id}`)).body).toMatchObject({ effect: 'read_only', requiredApprovals: 0, proposedByType: 'ai_agent' });
    expect((await org.owner.get('/api/v1/investigations')).body.data[0]).toMatchObject({ outcome: 'HEALTHY' });
  });
});

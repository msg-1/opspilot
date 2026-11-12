import { createHmac } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvestigationEvent } from '../src/integrations/aiService';

// The Python AI service is replaced by a scripted double; everything else (HTTP, database,
// pgvector queries, job processors) is real.
const ai = vi.hoisted(() => ({
  embedFails: false,
  events: [] as unknown[],
  requests: [] as { toolToken: string; question: string; incident?: { key: string } }[],
  duringRun: undefined as undefined | (() => Promise<void>),
}));

vi.mock('../src/integrations/aiService', () => {
  // Tiny deterministic "embedding": one dimension per known word, so related texts are close.
  const vocabulary = ['pool', 'connection', 'timeout', 'database', 'payment', 'provider', 'email', 'smtp', 'rollback', 'deploy'];
  const vector = (text: string) => {
    const v = new Array(768).fill(0);
    vocabulary.forEach((w, i) => (v[i] = (text.toLowerCase().match(new RegExp(w, 'g')) ?? []).length));
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / norm);
  };
  return {
    aiService: {
      status: async () => ({ llm: { provider: 'heuristic', model: null, available: false }, embeddings: { provider: 'test', model: 'vocab', dimensions: 768 } }),
      embed: async (texts: string[]) => {
        if (ai.embedFails) throw new Error('AI service is not reachable');
        return { provider: 'test', model: 'vocab', dimensions: 768, vectors: texts.map(vector) };
      },
      runInvestigation: async (request: never, onEvent: (e: InvestigationEvent) => Promise<void>) => {
        ai.requests.push(request);
        for (const [i, event] of ai.events.entries()) {
          if (i === 1 && ai.duringRun) await ai.duringRun();
          await onEvent(event as InvestigationEvent);
        }
      },
    },
  };
});

import { netConfig } from '../src/lib/netguard';
import { githubConfig } from '../src/modules/github';
import { api, createApiKey, createOrg, createService, minutesAgo, prisma } from './helpers';

beforeEach(() => {
  ai.embedFails = false;
  ai.events = [];
  ai.requests = [];
  ai.duringRun = undefined;
});

const RUNBOOK = `# Checkout pool runbook

## Symptoms
Requests fail with timeout acquiring a connection from the database pool.

## Mitigation
Roll back the deployment that lowered the pool size, or raise DB_POOL_MAX.`;

describe('knowledge base', () => {
  it('chunks, embeds and retrieves documents with hybrid search', async () => {
    const org = await createOrg();
    const other = await createOrg();
    const doc = (await org.owner.post('/api/v1/knowledge/documents').send({ title: 'Checkout pool runbook', type: 'runbook', content: RUNBOOK, tags: ['Pool'] })).body;
    await org.owner.post('/api/v1/knowledge/documents').send({ title: 'Email delivery guide', type: 'guide', content: '# Email\n\nSMTP relays throttle large email batches.' });
    await other.owner.post('/api/v1/knowledge/documents').send({ title: 'Other org pool notes', content: 'database pool connection timeout secrets of another organisation' });
    expect(doc).toMatchObject({ indexStatus: 'indexed', chunkCount: 2, embeddingModel: 'test:vocab', tags: ['pool'] });
    const stored = await prisma.$queryRaw<{ dims: number }[]>`SELECT vector_dims("embedding") AS dims FROM "KnowledgeChunk" WHERE "documentId" = ${doc.id}`;
    expect(stored.map((s) => s.dims)).toEqual([768, 768]);

    const search = (await org.owner.post('/api/v1/knowledge/search').send({ query: 'connection pool timeout' })).body;
    expect(search.mode).toBe('hybrid');
    expect(search.hits[0]).toMatchObject({ title: 'Checkout pool runbook', heading: 'Checkout pool runbook › Symptoms', matchedBy: ['vector', 'keyword'] });
    expect(search.hits.every((h: { title: string }) => h.title !== 'Other org pool notes')).toBe(true);
    expect((await org.owner.post('/api/v1/knowledge/search').send({ query: 'smtp', types: ['runbook'] })).body.hits).toHaveLength(0);

    // Editing content re-indexes; deleting removes chunks.
    const edited = (await org.owner.patch(`/api/v1/knowledge/documents/${doc.id}`).send({ content: '# One\n\nOnly the payment provider now.' })).body;
    expect(edited.chunkCount).toBe(1);
    await org.owner.delete(`/api/v1/knowledge/documents/${doc.id}`).expect(204);
    expect(await prisma.knowledgeChunk.count({ where: { documentId: doc.id } })).toBe(0);
  });

  it('stays keyword-searchable when the AI service is down, and says so', async () => {
    const org = await createOrg();
    ai.embedFails = true;
    const doc = (await org.owner.post('/api/v1/knowledge/documents').send({ title: 'Checkout pool runbook', content: RUNBOOK })).body;
    expect(doc).toMatchObject({ indexStatus: 'failed', chunkCount: 2, embeddingModel: null });
    expect(doc.indexError).toContain('not reachable');
    const search = (await org.owner.post('/api/v1/knowledge/search').send({ query: 'database pool' })).body;
    expect(search.mode).toBe('keyword');
    expect(search.note).toContain('Semantic search unavailable');
    expect(search.hits[0].matchedBy).toEqual(['keyword']);
    ai.embedFails = false;
    await org.owner.post(`/api/v1/knowledge/documents/${doc.id}/reindex`).expect(202);
    expect((await org.owner.get(`/api/v1/knowledge/documents/${doc.id}`)).body.indexStatus).toBe('indexed');
  });
});

const evidence = (ref: string, kind: string, title: string) => ({ type: 'evidence', evidence: { ref, kind, title, summary: `${title} summary`, sourceType: kind, sourceId: `${kind}-1`, occurredAt: minutesAgo(30) } });
const report = (overrides: Record<string, unknown> = {}) => ({
  summary: 'Errors began after v2 was deployed.',
  confidence: 0.95,
  analysisMode: 'llm',
  timeline: [{ timestamp: minutesAgo(30), description: 'v2 deployed', evidenceRefs: ['E1'] }],
  facts: [{ statement: 'v2 was deployed 5 minutes before errors.', evidenceRefs: ['E1'] }, { statement: 'Aliens were involved.', evidenceRefs: ['E77'] }],
  assumptions: [],
  uncertainties: ['Diff not reviewed'],
  hypotheses: [
    { title: 'Regression in v2', description: 'Pool size lowered.', confidence: 0.7, status: 'likely', evidenceRefs: ['E1', 'E2', 'E99'], facts: [], assumptions: [], gaps: [] },
    { title: 'Cosmic rays', description: 'Unsupported.', confidence: 0.9, status: 'likely', evidenceRefs: ['E404'], facts: [], assumptions: [], gaps: [] },
  ],
  nextSteps: ['Review the diff'],
  recommendedActions: [{ type: 'rollback_deployment', title: 'Roll back checkout to v1', description: 'Roll back to the previous version.', risk: 'MEDIUM', serviceSlug: 'checkout', parameters: { toVersion: 'v1' }, evidenceRefs: ['E1'] }],
  ...overrides,
});

describe('investigations', () => {
  it('persists steps, evidence and hypotheses, applies guardrails, and proposes (never executes) remediation', async () => {
    const org = await createOrg();
    const service = await createService(org.owner, 'Checkout');
    const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout is failing', serviceIds: [service.id] })).body;
    ai.events = [
      { type: 'meta', provider: 'anthropic', model: 'claude-opus-5-5' },
      { type: 'step', step: { type: 'plan', title: 'Investigation plan', output: { objective: 'Find cause', steps: [] } } },
      { type: 'step', step: { type: 'tool_call', title: 'list_deployments', toolName: 'list_deployments', input: { services: ['checkout'] }, output: { big: 'x'.repeat(40_000) }, durationMs: 12 } },
      evidence('E1', 'deployment', 'Deployment of checkout v2'),
      evidence('E2', 'log_pattern', '300× ERROR in checkout'),
      evidence('E1', 'deployment', 'duplicate ref is ignored'),
      { type: 'final', report: report(), usage: { inputTokens: 1000, outputTokens: 200 } },
    ];
    const started = await org.owner.post('/api/v1/investigations').send({ question: 'Why is checkout failing?', incidentId: incident.id });
    expect(started.status).toBe(202);
    const inv = (await org.owner.get(`/api/v1/investigations/${started.body.id}`)).body;

    expect(inv).toMatchObject({ status: 'COMPLETED', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 200 });
    expect(ai.requests[0]).toMatchObject({ question: 'Why is checkout failing?', incident: { key: 'INC-1' } });
    expect(inv.evidence.map((e: { ref: string }) => e.ref)).toEqual(['E1', 'E2']);
    expect(inv.steps.find((s: { toolName: string }) => s.toolName === 'list_deployments').output.truncated).toBe(true);
    // Guardrails: invented references removed, unsupported hypothesis capped, overall confidence lowered.
    const [top, second] = inv.hypotheses;
    expect(top).toMatchObject({ title: 'Regression in v2', evidenceRefs: ['E1', 'E2'], confidence: 0.7 });
    expect(second).toMatchObject({ title: 'Cosmic rays', evidenceRefs: [], status: 'possible' });
    expect(second.confidence).toBeLessThanOrEqual(0.3);
    expect(inv.confidence).toBe(0.7);
    expect(inv.report.rootCauseConfirmed).toBe(false);
    expect(inv.report.facts).toHaveLength(1);
    expect(inv.report.assumptions).toContain('Aliens were involved.');
    expect(inv.steps.some((s: { type: string }) => s.type === 'guardrail')).toBe(true);

    // The recommendation exists only as a proposal attributed to the AI.
    expect(inv.remediations).toEqual([expect.objectContaining({ type: 'rollback_deployment', status: 'PROPOSED' })]);
    const action = (await org.owner.get(`/api/v1/remediations/${inv.remediations[0].id}`)).body;
    expect(action).toMatchObject({ proposedByType: 'ai_agent', proposedBy: { name: 'OpsPilot AI' }, service: { slug: 'checkout' } });
    expect(await prisma.deployment.count({ where: { organizationId: org.organizationId } })).toBe(0);
    const timeline = (await org.owner.get(`/api/v1/incidents/${incident.id}`)).body.timeline.map((e: { type: string }) => e.type);
    expect(timeline.filter((t: string) => t === 'investigation')).toHaveLength(2);
    const audit = (await org.owner.get('/api/v1/audit-logs?action=investigation')).body.data.map((a: { action: string; actorType: string }) => `${a.action}:${a.actorType}`);
    expect(audit).toEqual(expect.arrayContaining(['investigation.start:user', 'investigation.complete:ai_agent']));
  });

  it('records which engine wrote the report, what it used and what it cost', async () => {
    const org = await createOrg();
    const withContradiction = report({ hypotheses: [{ title: 'Regression in v2', description: 'Pool size lowered.', confidence: 0.7, status: 'likely', evidenceRefs: ['E1'], contradictingEvidenceRefs: ['E2', 'E404'], contradictions: ['Errors also appear on one host that was not redeployed.'], facts: [], assumptions: [], gaps: ['Error rate per version'] }], facts: [], recommendedActions: [] });
    ai.events = [
      { type: 'meta', provider: 'anthropic', model: 'claude-haiku-5-5' },
      evidence('E1', 'deployment', 'Deployment of checkout v2'),
      evidence('E2', 'log_pattern', 'Errors on host 7'),
      { type: 'final', report: withContradiction, usage: { inputTokens: 5200, outputTokens: 1030, cacheReadTokens: 2900, cacheWriteTokens: 1400, llmCalls: 4, llmLatencyMs: 8400, estimatedCostUsd: 0.001239 }, engine: { mode: 'llm', provider: 'anthropic', model: 'claude-haiku-5-5', attemptedProvider: 'anthropic' } },
    ];
    const live = (await org.owner.post('/api/v1/investigations').send({ question: 'Why is checkout failing today?' })).body;
    const detail = (await org.owner.get(`/api/v1/investigations/${live.id}`)).body;
    expect(detail).toMatchObject({ analysisMode: 'llm', provider: 'anthropic', model: 'claude-haiku-5-5', attemptedProvider: 'anthropic', inputTokens: 5200, outputTokens: 1030, cacheReadTokens: 2900, llmCalls: 4, llmLatencyMs: 8400, estimatedCostUsd: 0.001239 });
    // Evidence against a hypothesis is stored, and invented references to it are removed too.
    expect(detail.hypotheses[0]).toMatchObject({ contradictingRefs: ['E2'], contradictions: ['Errors also appear on one host that was not redeployed.'] });

    // When the model fails and rules take over, the record says so instead of crediting the model.
    ai.events = [
      { type: 'meta', provider: 'anthropic', model: 'claude-haiku-5-5' },
      { type: 'final', report: report({ analysisMode: 'heuristic', hypotheses: [], facts: [], timeline: [], recommendedActions: [], confidence: 0.1 }), usage: { inputTokens: 0, outputTokens: 0, llmCalls: 1, estimatedCostUsd: 0 }, engine: { mode: 'heuristic', provider: 'heuristic', model: null, attemptedProvider: 'anthropic' } },
    ];
    const fallback = (await org.owner.post('/api/v1/investigations').send({ question: 'Why is checkout failing today?' })).body;
    expect((await org.owner.get(`/api/v1/investigations/${fallback.id}`)).body).toMatchObject({ analysisMode: 'heuristic', provider: 'heuristic', model: null, attemptedProvider: 'anthropic' });

    ai.events = [{ type: 'final', report: report({ analysisMode: 'mock', hypotheses: [], facts: [], timeline: [], recommendedActions: [], confidence: 0.1 }), engine: { mode: 'mock', provider: 'mock', model: 'mock-scripted', attemptedProvider: 'mock' } }];
    const mock = (await org.owner.post('/api/v1/investigations').send({ question: 'Why is checkout failing today?' })).body;
    expect((await org.owner.get(`/api/v1/investigations/${mock.id}`)).body.analysisMode).toBe('mock');

    const status = (await org.owner.get('/api/v1/investigations/ai-status')).body;
    expect(status.usageToday).toMatchObject({ investigations: 3, running: 0, estimatedCostUsd: 0.0012, tokens: 6230 });
    expect(status.organizationLimits).toEqual({ maxConcurrent: 3, dailyInvestigations: 50, dailyCostUsd: 5 });
    const analytics = (await org.owner.get('/api/v1/analytics/overview?from=1d')).body.investigations;
    expect(analytics).toMatchObject({ total: 3, estimatedCostUsd: 0.0012, tokens: 6230 });
  });

  it('refuses new investigations once the organisation reaches its limits', async () => {
    const org = await createOrg();
    const other = await createOrg();
    ai.events = [{ type: 'final', report: report({ hypotheses: [], facts: [], timeline: [], recommendedActions: [], confidence: 0.1 }) }];
    const start = (agent = org.owner) => agent.post('/api/v1/investigations').send({ question: 'Why is checkout failing today?' });
    const running = await Promise.all([1, 2, 3].map(() => prisma.investigation.create({ data: { organizationId: org.organizationId, question: 'still running', status: 'RUNNING', startedAt: new Date() } })));
    const concurrent = await start();
    expect(concurrent.status).toBe(429);
    expect(concurrent.body.error).toMatchObject({ code: 'limit_reached' });
    expect(concurrent.body.error.message).toContain('already in progress');
    await prisma.investigation.updateMany({ where: { id: { in: running.map((r) => r.id) } }, data: { status: 'COMPLETED', estimatedCostUsd: 2.5 } });
    const overBudget = await start();
    expect(overBudget.status).toBe(429);
    expect(overBudget.body.error.message).toContain("Today's estimated model spend ($7.50) has reached the daily limit of $5.00");
    // Limits are per organisation, and yesterday's spend does not count.
    expect((await start(other.owner)).status).toBe(202);
    await prisma.investigation.updateMany({ where: { organizationId: org.organizationId }, data: { createdAt: new Date(Date.now() - 26 * 3600_000) } });
    expect((await start()).status).toBe(202);
  });

  it('marks the investigation failed when the AI service errors or returns a malformed report', async () => {
    const org = await createOrg();
    ai.events = [{ type: 'meta', provider: 'openai', model: 'gpt' }, { type: 'error', message: 'model exploded' }];
    const a = (await org.owner.post('/api/v1/investigations').send({ question: 'Why is everything failing?' })).body;
    expect((await org.owner.get(`/api/v1/investigations/${a.id}`)).body).toMatchObject({ status: 'FAILED', error: 'model exploded' });
    ai.events = [{ type: 'final', report: { summary: '', confidence: 7 } }];
    const b = (await org.owner.post('/api/v1/investigations').send({ question: 'Why is everything failing?' })).body;
    const failed = (await org.owner.get(`/api/v1/investigations/${b.id}`)).body;
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toContain('malformed report');
    ai.events = [{ type: 'meta', provider: 'heuristic', model: null }];
    const c = (await org.owner.post('/api/v1/investigations').send({ question: 'Why is everything failing?' })).body;
    expect((await org.owner.get(`/api/v1/investigations/${c.id}`)).body.error).toContain('without producing a report');
  });

  it('stops when cancelled mid-run and does not record a result', async () => {
    const org = await createOrg();
    ai.events = [{ type: 'meta', provider: 'heuristic', model: null }, evidence('E1', 'deployment', 'x'), { type: 'final', report: report() }];
    ai.duringRun = async () => {
      const running = await prisma.investigation.findFirstOrThrow({ where: { organizationId: org.organizationId } });
      await org.owner.post(`/api/v1/investigations/${running.id}/cancel`).expect(200);
    };
    const started = (await org.owner.post('/api/v1/investigations').send({ question: 'Why is everything failing?' })).body;
    const inv = (await org.owner.get(`/api/v1/investigations/${started.id}`)).body;
    expect(inv).toMatchObject({ status: 'CANCELLED', report: null });
    expect(inv.evidence).toHaveLength(0);
  });

  it('gives the agent a read-only token scoped to one organisation and to the running investigation', async () => {
    const [org, other] = await Promise.all([createOrg(), createOrg()]);
    await createService(org.owner, 'Checkout');
    await createService(other.owner, 'Other Secret Service');
    const seen: Record<string, number | string[]> = {};
    ai.events = [{ type: 'meta', provider: 'heuristic', model: null }, { type: 'final', report: report({ hypotheses: [], recommendedActions: [], facts: [], timeline: [], confidence: 0.1 }) }];
    // Called while the investigation is RUNNING, exactly when the real agent uses its token.
    ai.duringRun = async () => {
      const auth = { Authorization: `Bearer ${ai.requests[0]!.toolToken}` };
      seen.services = (await api().get('/api/v1/tools/services').set(auth)).body.services.map((s: { slug: string }) => s.slug);
      seen.anomalies = (await api().get('/api/v1/tools/logs/anomalies?from=1h').set(auth)).status;
      seen.knowledge = (await api().post('/api/v1/tools/knowledge/search').set(auth).send({ query: 'pool' })).status;
      // Useless outside the tool API: it cannot read the main API or change anything.
      seen.incidents = (await api().get('/api/v1/incidents').set(auth)).status;
      seen.propose = (await api().post('/api/v1/remediations').set(auth).send({})).status;
      seen.create = (await api().post('/api/v1/incidents').set(auth).send({ title: 'agent-created incident' })).status;
    };
    await org.owner.post('/api/v1/investigations').send({ question: 'Why is everything failing?' });
    expect(seen).toEqual({ services: ['checkout'], anomalies: 200, knowledge: 200, incidents: 401, propose: 401, create: 401 });
    // Once the investigation has finished the token is dead, well before its 30-minute expiry.
    expect((await api().get('/api/v1/tools/services').set({ Authorization: `Bearer ${ai.requests[0]!.toolToken}` })).status).toBe(401);
    const toolAudit = await prisma.auditLog.findMany({ where: { organizationId: org.organizationId, action: 'ai_tool.call' } });
    expect(toolAudit.length).toBeGreaterThanOrEqual(2);
    // MCP-style access with an API key
    const key = await createApiKey(org.owner, ['tools:read']);
    expect((await api().get('/api/v1/tools/deployments').set('x-api-key', key)).status).toBe(200);
    expect((await api().get('/api/v1/tools/deployments').set('x-api-key', await createApiKey(org.owner, ['ingest:logs']))).status).toBe(403);
  });
});

describe('remediation approvals', () => {
  const propose = (agent: Awaited<ReturnType<typeof createOrg>>['owner'], extra: Record<string, unknown> = {}) =>
    agent.post('/api/v1/remediations').send({ type: 'restart_service', title: 'Restart checkout pods', description: 'Rolling restart of checkout.', risk: 'LOW', ...extra });

  it('requires an independent human approval before execution and records everything', async () => {
    const org = await createOrg();
    const requester = await org.member('ENGINEER', 'Rita Requester');
    const approver = await org.member('ENGINEER', 'Andy Approver');
    const viewer = await org.member('VIEWER');
    const service = await createService(org.owner, 'Checkout');
    const old = (await org.owner.post('/api/v1/deployments').send({ service: 'checkout', version: 'v2' })).body;
    const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout is failing', serviceIds: [service.id] })).body;
    const action = (await propose(requester.agent, { type: 'rollback_deployment', title: 'Roll back checkout to v1', risk: 'MEDIUM', serviceId: service.id, incidentId: incident.id, parameters: { deploymentId: old.id, toVersion: 'v1' } })).body;
    const url = `/api/v1/remediations/${action.id}`;
    expect(action).toMatchObject({ status: 'PROPOSED', requiredApprovals: 1 });

    expect((await approver.agent.post(`${url}/approve`)).status).toBe(409); // not yet submitted
    expect((await requester.agent.post(`${url}/execute`).send({ confirmManual: true })).status).toBe(409);
    await requester.agent.post(`${url}/request-approval`).expect(200);
    expect((await requester.agent.post(`${url}/request-approval`)).status).toBe(409);
    expect((await requester.agent.post(`${url}/approve`)).status).toBe(403); // no self-approval
    expect((await viewer.agent.post(`${url}/approve`)).status).toBe(403);
    expect((await approver.agent.get('/api/v1/notifications')).body.data[0].type).toBe('remediation.approval_requested');

    const approved = (await approver.agent.post(`${url}/approve`).send({ comment: 'Looks right' })).body;
    expect(approved).toMatchObject({ status: 'APPROVED', approvalsGranted: 1 });
    expect((await approver.agent.post(`${url}/approve`)).status).toBe(409);
    // Without a webhook the operator must attest that they did it themselves.
    expect((await requester.agent.post(`${url}/execute`).send({})).status).toBe(400);
    const executed = (await requester.agent.post(`${url}/execute`).send({ confirmManual: true, notes: 'ran deployctl rollback' })).body;
    expect(executed).toMatchObject({ status: 'EXECUTED', executionResult: { mode: 'manual', success: true } });
    expect(executed.executionResult.summary).toContain('did not change any external system');
    expect((await requester.agent.post(`${url}/execute`).send({ confirmManual: true })).status).toBe(409); // not twice

    const deployments = (await org.owner.get('/api/v1/deployments?service=checkout')).body.data;
    expect(deployments.find((d: { isRollback: boolean }) => d.isRollback)).toMatchObject({ version: 'v1', source: 'remediation', rollbackOfId: old.id });
    expect(deployments.find((d: { id: string }) => d.id === old.id).status).toBe('ROLLED_BACK');
    const audit = (await org.owner.get(`/api/v1/audit-logs?resourceId=${action.id}`)).body.data.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['remediation.propose', 'remediation.request_approval', 'remediation.approve', 'remediation.execute_start', 'remediation.execute_success']));
    const timeline = (await org.owner.get(`/api/v1/incidents/${incident.id}`)).body.timeline.filter((e: { type: string }) => e.type === 'remediation');
    expect(timeline).toHaveLength(4);
  });

  it('needs two approvals including an admin for high-risk actions, and supports rejection and cancellation', async () => {
    const org = await createOrg();
    const engineer = await org.member('ENGINEER');
    const engineer2 = await org.member('ENGINEER');
    const admin = await org.member('ADMIN');
    const high = (await propose(engineer.agent, { risk: 'HIGH', type: 'config_change', title: 'Raise DB max_connections' })).body;
    const url = `/api/v1/remediations/${high.id}`;
    expect(high.requiredApprovals).toBe(2);
    await engineer.agent.post(`${url}/request-approval`).expect(200);
    expect((await engineer2.agent.post(`${url}/approve`)).status).toBe(403); // engineers cannot approve HIGH
    expect((await admin.agent.post(`${url}/approve`)).body).toMatchObject({ status: 'PENDING_APPROVAL', approvalsGranted: 1 });
    expect((await org.owner.post(`${url}/approve`)).body.status).toBe('APPROVED');
    await engineer.agent.post(`${url}/cancel`).expect(200);
    expect((await engineer.agent.post(`${url}/execute`).send({ confirmManual: true })).status).toBe(409);

    const rejected = (await propose(engineer.agent)).body;
    await engineer.agent.post(`/api/v1/remediations/${rejected.id}/request-approval`);
    expect((await engineer2.agent.post(`/api/v1/remediations/${rejected.id}/reject`).send({})).status).toBe(400); // reason required
    expect((await engineer2.agent.post(`/api/v1/remediations/${rejected.id}/reject`).send({ comment: 'Too risky during peak' })).body.status).toBe('REJECTED');
    expect((await org.owner.get('/api/v1/remediations?status=REJECTED')).body.data).toHaveLength(1);

    // Self-approval is a deliberate, audited organisation setting.
    await org.owner.patch('/api/v1/settings').send({ allowSelfApproval: true }).expect(200);
    const own = (await propose(engineer.agent)).body;
    await engineer.agent.post(`/api/v1/remediations/${own.id}/request-approval`);
    expect((await engineer.agent.post(`/api/v1/remediations/${own.id}/approve`)).body.status).toBe('APPROVED');
  });

  describe('with a remediation webhook', () => {
    let server: Server;
    let received: { headers: Record<string, unknown>; body: string }[] = [];
    let status = 200;
    beforeAll(async () => {
      netConfig.allowPrivate = true; // the stand-in webhook listens on 127.0.0.1
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          received.push({ headers: req.headers, body });
          res.writeHead(status).end('{"queued":true}');
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    });
    afterAll(async () => {
      netConfig.allowPrivate = false;
      await new Promise((r) => server.close(r));
    });

    it('refuses private, loopback and metadata addresses, and re-checks at execution time', async () => {
      const org = await createOrg();
      const approver = await org.member('ADMIN');
      const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
      netConfig.allowPrivate = false;
      for (const url of [local, 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/x', 'http://[::1]:8000/', 'http://user:pw@93.184.216.34/']) {
        const res = await org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: url });
        expect(res.status, url).toBe(400);
      }
      expect((await org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: 'ftp://93.184.216.34/x' })).status).toBe(400);
      expect((await org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: 'https://93.184.216.34/hook' })).status).toBe(200);

      // A URL saved while private targets were allowed must still be refused when they are not.
      netConfig.allowPrivate = true;
      await org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: local }).expect(200);
      const action = (await propose(org.owner)).body;
      await org.owner.post(`/api/v1/remediations/${action.id}/request-approval`);
      await approver.agent.post(`/api/v1/remediations/${action.id}/approve`);
      netConfig.allowPrivate = false;
      received = [];
      const result = (await org.owner.post(`/api/v1/remediations/${action.id}/execute`).send({})).body;
      expect(result.status).toBe('FAILED');
      expect(result.executionResult.summary).toContain('private, loopback or link-local');
      expect(received).toHaveLength(0);
      netConfig.allowPrivate = true;
    });

    it('dispatches a signed request, records failures, and allows retry', async () => {
      const org = await createOrg();
      const approver = await org.member('ADMIN');
      const service = await createService(org.owner, 'Checkout');
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
      const settings = (await org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: url, remediationWebhookSecret: 'webhook-secret-123456' })).body.settings;
      expect(settings).toMatchObject({ remediationWebhookUrl: url, remediationWebhookSecretSet: true });
      expect(JSON.stringify(settings)).not.toContain('webhook-secret-123456');
      const action = (await propose(org.owner, { serviceId: service.id, parameters: { replicas: 3 } })).body;
      const base = `/api/v1/remediations/${action.id}`;
      await org.owner.post(`${base}/request-approval`);
      await approver.agent.post(`${base}/approve`);
      received = [];
      status = 500;
      expect((await org.owner.post(`${base}/execute`).send({})).body).toMatchObject({ status: 'FAILED', executionResult: { mode: 'webhook', success: false } });
      expect(await prisma.serviceEvent.count({ where: { organizationId: org.organizationId } })).toBe(0);
      status = 200;
      await org.owner.post(`${base}/retry`).expect(200);
      const executed = (await org.owner.post(`${base}/execute`).send({})).body;
      expect(executed.status).toBe('EXECUTED');
      // Only the status code is kept: the webhook's response body is never stored or returned.
      expect(executed.executionResult.detail).toEqual({ status: 200 });
      const last = received.at(-1)!;
      expect(last.headers['x-opspilot-signature']).toBe(`sha256=${createHmac('sha256', 'webhook-secret-123456').update(last.body).digest('hex')}`);
      expect(JSON.parse(last.body)).toMatchObject({ event: 'remediation.execute', type: 'restart_service', parameters: { replicas: 3 } });
      expect((await org.owner.get('/api/v1/service-events')).body.data[0]).toMatchObject({ type: 'restart', source: 'remediation' });
    });
  });
});

describe('GitHub integration', () => {
  let server: Server;
  const seen: { url: string; auth?: string }[] = [];
  const original = githubConfig.baseUrl;
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url!, auth: req.headers.authorization });
      const send = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers.authorization === 'Bearer bad-token-bad-token-bad-token') return send(401, { message: 'Bad credentials' });
      if (req.url === '/user') return send(200, { login: 'octo-user' });
      if (req.url === '/repos/acme/missing') return send(404, { message: 'Not Found' });
      if (req.url === '/repos/acme/shop') return send(200, { full_name: 'acme/shop', default_branch: 'main', html_url: 'https://github.com/acme/shop', private: true });
      if (req.url?.startsWith('/repos/acme/shop/commits?')) return send(200, [{ sha: 'a'.repeat(40), html_url: 'https://github.com/acme/shop/commit/a', author: { login: 'dev1' }, commit: { message: 'Lower pool size', author: { name: 'Dev One', date: minutesAgo(50) }, committer: { date: minutesAgo(50) } } }]);
      if (req.url === `/repos/acme/shop/commits/${'a'.repeat(40)}`) return send(200, { stats: { additions: 4, deletions: 2 }, files: [{ filename: 'config/pool.yaml', additions: 4, deletions: 2, status: 'modified' }] });
      if (req.url?.startsWith('/repos/acme/shop/pulls?')) return send(200, [{ number: 7, title: 'Lower pool size', body: 'Saves connections', state: 'closed', merged_at: minutesAgo(50), closed_at: minutesAgo(50), created_at: minutesAgo(300), updated_at: minutesAgo(50), user: { login: 'dev1' }, html_url: 'https://github.com/acme/shop/pull/7', base: { ref: 'main' }, head: { ref: 'pool' }, merge_commit_sha: 'a'.repeat(40), labels: [{ name: 'config' }] }]);
      send(404, { message: 'Not Found' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    githubConfig.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    githubConfig.baseUrl = original;
    await new Promise((r) => server.close(r));
  });

  it('validates and encrypts the token, syncs commits and pull requests through the REST adapter', async () => {
    const org = await createOrg();
    await createService(org.owner, 'Shop');
    expect((await org.owner.get('/api/v1/github/integration')).body).toMatchObject({ mode: 'public', tokenSource: 'none' });
    expect((await org.owner.put('/api/v1/github/integration').send({ token: 'bad-token-bad-token-bad-token' })).status).toBe(400);
    const saved = (await org.owner.put('/api/v1/github/integration').send({ token: 'good-token-good-token-good-token', webhookSecret: 'hook-secret-hook-secret' })).body;
    expect(saved).toMatchObject({ mode: 'token', tokenSource: 'organization', accountLogin: 'octo-user', webhookSecretSet: true });
    const row = await prisma.githubIntegration.findUniqueOrThrow({ where: { organizationId: org.organizationId } });
    expect(row.tokenEncrypted).not.toContain('good-token');
    expect(JSON.stringify(saved)).not.toContain('good-token');

    expect((await org.owner.post('/api/v1/github/repositories').send({ fullName: 'acme/missing' })).status).toBe(400);
    expect((await org.owner.post('/api/v1/github/repositories').send({ fullName: 'not a repo' })).status).toBe(400);
    const repo = (await org.owner.post('/api/v1/github/repositories').send({ fullName: 'acme/shop', service: 'shop' })).body;
    expect(repo).toMatchObject({ fullName: 'acme/shop', isMock: false });
    expect(seen.at(-1)!.auth).toBe('Bearer good-token-good-token-good-token');
    const commits = (await org.owner.get('/api/v1/github/commits?service=shop')).body.data;
    expect(commits[0]).toMatchObject({ message: 'Lower pool size', additions: 4, authorLogin: 'dev1' });
    expect(commits[0].filesChanged[0].filename).toBe('config/pool.yaml');
    expect((await org.owner.get('/api/v1/github/pull-requests?state=merged')).body.data[0]).toMatchObject({ number: 7, labels: ['config'] });
    // Synced changes are visible to the agent, linked to the service.
    const key = await createApiKey(org.owner, ['tools:read']);
    const changes = (await api().get('/api/v1/tools/code-changes?service=shop&from=2h').set('x-api-key', key)).body;
    expect(changes.commits[0]).toMatchObject({ service: 'shop', sampleData: false, files: ['config/pool.yaml'] });
    expect((await org.owner.get('/api/v1/github/integration')).body.lastSyncStatus).toBe('ok');
  });

  it('labels sample repositories and never calls GitHub for them', async () => {
    const org = await createOrg();
    const before = seen.length;
    const repo = (await org.owner.post('/api/v1/github/repositories').send({ fullName: 'demo/sample-repo', sample: true })).body;
    expect(repo.isMock).toBe(true);
    expect(seen.length).toBe(before);
    const commits = (await org.owner.get('/api/v1/github/commits')).body;
    expect(commits.meta.total).toBeGreaterThan(10);
    expect(commits.data.every((c: { repository: { isMock: boolean } }) => c.repository.isMock)).toBe(true);
    await org.owner.post('/api/v1/github/sync').send({}).expect(202); // idempotent
    expect((await org.owner.get('/api/v1/github/commits')).body.meta.total).toBe(commits.meta.total);
  });

  it('accepts only correctly signed webhooks', async () => {
    const org = await createOrg();
    await org.owner.put('/api/v1/github/integration').send({ webhookSecret: 'hook-secret-hook-secret' });
    await org.owner.post('/api/v1/github/repositories').send({ fullName: 'acme/shop' });
    await prisma.commit.deleteMany({ where: { repository: { organizationId: org.organizationId } } });
    const payload = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'acme/shop' }, commits: [{ id: 'b'.repeat(40), message: 'Hotfix', timestamp: new Date().toISOString(), author: { name: 'Dev', username: 'dev1' }, modified: ['src/a.ts'] }] });
    const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    const post = (signature: string, event = 'push') => api().post(`/api/v1/webhooks/github/${org.slug}`).set('content-type', 'application/json').set('x-github-event', event).set('x-hub-signature-256', signature).send(payload);
    expect((await post(sign('wrong-secret'))).status).toBe(401);
    expect((await post('')).status).toBe(401);
    expect((await post(sign('hook-secret-hook-secret'))).body).toEqual({ ok: true, handled: 1 });
    expect((await post(sign('hook-secret-hook-secret'), 'ping')).body.message).toBe('pong');
    expect((await org.owner.get('/api/v1/github/commits?q=Hotfix')).body.meta.total).toBe(1);
  });
});

describe('analytics, dashboard and postmortems', () => {
  it('computes reliability metrics from recorded data and exports CSV', async () => {
    const org = await createOrg();
    const service = await createService(org.owner, 'Checkout');
    await org.owner.post('/api/v1/deployments').send({ service: 'checkout', version: 'v1', startedAt: minutesAgo(600) });
    await org.owner.post('/api/v1/deployments').send({ service: 'checkout', version: 'v2', startedAt: minutesAgo(130) });
    const incident = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout, "quoted" failure', severity: 'SEV1', serviceIds: [service.id], startedAt: minutesAgo(120) })).body;
    await prisma.incident.update({ where: { id: incident.id }, data: { acknowledgedAt: new Date(Date.now() - 110 * 60_000), resolvedAt: new Date(Date.now() - 60 * 60_000), status: 'RESOLVED', rootCause: 'Bad deploy' } });

    const overview = (await org.owner.get('/api/v1/analytics/overview?from=7d')).body;
    expect(overview.incidents).toMatchObject({ total: 1, open: 0, bySeverity: { SEV1: 1, SEV2: 0, SEV3: 0, SEV4: 0 } });
    expect(overview.incidents.mttaMinutes.median).toBe(10);
    expect(overview.incidents.mttrMinutes.median).toBe(60);
    expect(overview.incidents.topServices[0]).toMatchObject({ name: 'Checkout', incidents: 1 });
    // v2 was followed by an incident within 6 hours; v1 was not.
    expect(overview.deployments).toMatchObject({ total: 2, failedChanges: 1, changeFailureRate: 50 });

    const csv = await org.owner.get('/api/v1/analytics/incidents.csv?from=7d');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[1]).toContain('"INC-1","Checkout, ""quoted"" failure","SEV1","RESOLVED","Checkout"');
    const audit = await org.owner.get('/api/v1/audit-logs?format=csv');
    expect(audit.text).toContain('report.export');

    const dashboard = (await org.owner.get('/api/v1/dashboard')).body;
    expect(dashboard.counts).toMatchObject({ activeIncidents: 0, incidentsThisWeek: 1, deploymentsLast24h: 2, mttrMinutes30d: 60 });
    expect(dashboard.recentDeployments).toHaveLength(2);

    const pm = await org.owner.post(`/api/v1/incidents/${incident.id}/postmortem`);
    expect(pm.status).toBe(201);
    const doc = (await org.owner.get(`/api/v1/knowledge/documents/${pm.body.id}`)).body;
    expect(doc).toMatchObject({ type: 'postmortem', indexStatus: 'indexed', incidentId: incident.id });
    expect(doc.content).toContain('Bad deploy');
    expect((await org.owner.post(`/api/v1/incidents/${incident.id}/postmortem`)).body).toEqual({ id: pm.body.id, created: false });
    expect((await org.owner.get('/api/v1/system/status')).body).toMatchObject({ database: true, ai: { reachable: true } });
  });
});

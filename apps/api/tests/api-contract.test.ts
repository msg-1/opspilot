import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { InvestigationEvent } from '../src/integrations/aiService';

// What the API really returns, checked against the response contracts the web app's types are
// generated from (src/contracts/api.ts). If a handler stops returning a field the web app
// uses, or changes its type, this fails here rather than in a browser.
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

import * as contract from '../src/contracts/api';
import { api, createApiKey, createOrg, createService, minutesAgo } from './helpers';

function conforms(name: string, schema: z.ZodType, value: unknown) {
  const parsed = schema.safeParse(value);
  expect(parsed.success ? [] : parsed.error.issues.map((i) => `${name}.${i.path.join('.')}: ${i.message}`), `${name} does not match its contract`).toEqual([]);
}

describe('API responses match the contracts the web app is generated from', () => {
  it('session, incidents, services, deployments, logs and members', async () => {
    const org = await createOrg();
    await org.member('ENGINEER');
    const service = await createService(org.owner, 'Checkout');
    const key = await createApiKey(org.owner, ['ingest:logs']);
    await org.owner.post('/api/v1/deployments').send({ service: 'checkout', version: 'v1.0.0', commitSha: 'abcdef1234567', startedAt: minutesAgo(60) }).expect(201);
    await api().post('/api/v1/logs').set('x-api-key', key).send({ service: 'checkout', logs: [{ level: 'error', message: 'timeout acquiring connection', traceId: 'trace-1', attributes: { pool: 10 } }] }).expect(202);
    const created = (await org.owner.post('/api/v1/incidents').send({ title: 'Checkout failing after deploy', description: 'Customers cannot pay.', serviceIds: [service.id] }).expect(201)).body;
    await org.owner.post(`/api/v1/incidents/${created.id}/comments`).send({ message: 'Looking at the pool.' });

    conforms('Session', contract.Session, (await org.owner.get('/api/v1/auth/me').expect(200)).body);
    conforms('IncidentList', contract.IncidentList, (await org.owner.get('/api/v1/incidents').expect(200)).body);
    const incident = (await org.owner.get(`/api/v1/incidents/${created.id}`).expect(200)).body;
    expect(incident.timeline.length).toBeGreaterThan(0);
    conforms('IncidentDetail', contract.IncidentDetail, incident);
    conforms('Paged<Service>', contract.paged(contract.Service), (await org.owner.get('/api/v1/services').expect(200)).body);
    conforms('Paged<Deployment>', contract.paged(contract.Deployment), (await org.owner.get('/api/v1/deployments').expect(200)).body);
    const logs = (await org.owner.get('/api/v1/logs?from=1h').expect(200)).body;
    expect(logs.data.length).toBe(1);
    conforms('Paged<LogEntry>', contract.paged(contract.LogEntry), logs);
    const members = (await org.owner.get('/api/v1/members').expect(200)).body;
    expect(members.data.length).toBe(2);
    for (const member of members.data) conforms('Member', contract.Member, member);
  });

  it('an investigation with its report, evidence and steps, and a remediation through approval and execution', async () => {
    const org = await createOrg();
    const approver = await org.member('ADMIN');
    await createService(org.owner, 'Checkout');
    const evidence = (ref: string, kind: string, title: string, sourceId: string) => ({ type: 'evidence', evidence: { ref, kind, title, summary: `${title} summary`, sourceType: kind, sourceId, occurredAt: minutesAgo(30), relevance: 0.6, data: { version: 'v2' } } });
    ai.events = [
      { type: 'meta', provider: 'heuristic', model: null },
      { type: 'step', step: { type: 'plan', title: 'Investigation plan', output: { objective: 'Find the cause', services: ['checkout'], windowFrom: minutesAgo(120), windowTo: minutesAgo(0), steps: [{ description: 'Look at logs', tool: 'find_log_anomalies' }] } } },
      { type: 'step', step: { type: 'tool_call', title: 'list_deployments', toolName: 'list_deployments', input: { services: ['checkout'] }, output: { deployments: [] }, durationMs: 12 } },
      evidence('E1', 'deployment', 'Deployment of checkout v2 (succeeded)', 'dep-1'),
      evidence('E2', 'log_pattern', '300× ERROR in checkout', 'fp-1'),
      {
        type: 'final',
        engine: { mode: 'heuristic', provider: 'heuristic', model: null, attemptedProvider: null },
        usage: { inputTokens: 0, outputTokens: 0 },
        report: {
          summary: 'Errors began after v2 was deployed.', confidence: 0.6, analysisMode: 'heuristic', outcome: 'INCIDENT',
          assessment: { outcome: 'INCIDENT', confidence: 0.89, rationale: 'A failure is evident.', supportingRefs: ['E2'], signals: [{ level: 'strong', kind: 'logs', text: '300× ERROR in checkout', evidenceRefs: ['E2'] }], missingTelemetry: ['Traces were not examined.'] },
          observations: [{ statement: 'Most recent deployment on record: v2.', evidenceRefs: ['E1'], verification: { status: 'no_claims', checks: [] } }],
          integrity: { checked: 3, supported: 2, flagged: [{ where: 'fact 1', text: '44%', status: 'unsupported', detail: 'no cited evidence holds this value' }] },
          timeline: [{ timestamp: minutesAgo(30), description: 'v2 deployed', evidenceRefs: ['E1'] }],
          facts: [{ statement: 'Error rate reached 44%.', evidenceRefs: ['E2'], verification: { status: 'unsupported', checks: [{ text: '44%', kind: 'number', status: 'unsupported', detail: 'no cited evidence holds this value' }] } }],
          assumptions: ['Timing is treated as a signal.'], uncertainties: ['Diff not reviewed.'], nextSteps: ['Review the diff'],
          hypotheses: [{ title: 'Regression in v2', description: 'Pool size lowered.', confidence: 0.6, status: 'likely', evidenceRefs: ['E1', 'E2'], contradictingEvidenceRefs: [], contradictions: [], facts: [], assumptions: [], gaps: [] }],
          recommendedActions: [{ type: 'rollback_deployment', title: 'Roll back checkout to v1', description: 'Return to the previous version.', rationale: 'Errors began after v2.', risk: 'MEDIUM', serviceSlug: 'checkout', parameters: { deploymentId: 'dep-1', toVersion: 'v1' }, evidenceRefs: ['E1'] }],
        },
      },
    ];
    const started = (await org.owner.post('/api/v1/investigations').send({ question: 'Why is checkout failing today?' }).expect(202)).body;
    conforms('InvestigationSummary (202)', contract.InvestigationSummary, started);
    conforms('Paged<InvestigationSummary>', contract.paged(contract.InvestigationSummary), (await org.owner.get('/api/v1/investigations').expect(200)).body);
    const detail = (await org.owner.get(`/api/v1/investigations/${started.id}`).expect(200)).body;
    expect(detail).toMatchObject({ status: 'COMPLETED', outcome: 'INCIDENT' });
    expect([detail.evidence.length, detail.steps.length, detail.hypotheses.length, detail.remediations.length]).toEqual([2, 2, 1, 1]);
    conforms('InvestigationDetail', contract.InvestigationDetail, detail);

    // The proposed rollback, through every state the remediation page shows.
    const base = `/api/v1/remediations/${detail.remediations[0].id}`;
    conforms('RemediationDetail (proposed)', contract.RemediationDetail, (await org.owner.get(base).expect(200)).body);
    conforms('Remediation (submitted)', contract.Remediation, (await org.owner.post(`${base}/request-approval`).expect(200)).body);
    const approved = (await approver.agent.post(`${base}/approve`).send({ comment: 'Looks right.' }).expect(200)).body;
    conforms('Remediation (approved)', contract.Remediation, approved);
    expect(approved.approvals).toHaveLength(1);
    const executed = (await org.owner.post(`${base}/execute`).send({ confirmManual: true, notes: 'Rolled back by hand.' }).expect(200)).body;
    expect(executed).toMatchObject({ status: 'EXECUTED', executionResult: { outcome: 'applied', attempt: 1 } });
    conforms('Remediation (executed)', contract.Remediation, executed);
    conforms('RemediationDetail (executed)', contract.RemediationDetail, (await org.owner.get(base).expect(200)).body);
    conforms('RemediationList', contract.RemediationList, (await org.owner.get('/api/v1/remediations').expect(200)).body);
  });
});

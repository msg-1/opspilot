import type { IncidentDetail, InvestigationDetail, InvestigationSummary, Paged, RemediationDetail, Session } from '@/lib/types';

// What the API returns, typed by the types generated from the API's response contracts. A
// field the API stops returning, or returns differently, breaks these fixtures at compile time,
// so the page tests cannot keep passing against a shape that no longer exists.

const ALL = ['read', 'incident:write', 'investigation:run', 'remediation:propose', 'remediation:approve', 'remediation:approve:high', 'remediation:execute', 'member:manage', 'integration:manage', 'settings:manage', 'service:write'];
const ROLE_PERMISSIONS: Record<Session['role'], string[]> = {
  OWNER: ALL,
  ADMIN: ALL,
  ENGINEER: ['read', 'service:write', 'incident:write', 'investigation:run', 'remediation:propose', 'remediation:approve', 'remediation:execute'],
  VIEWER: ['read'],
};

export function session(role: Session['role'] = 'ADMIN', user: { id: string; name: string } = { id: 'user-ada', name: 'Ada Admin' }): Session {
  return {
    user: { ...user, email: `${user.id}@example.com`, title: null },
    organization: { id: 'org-1', name: 'Acme Shop', slug: 'acme-shop' },
    role,
    permissions: ROLE_PERMISSIONS[role],
    organizations: [{ id: 'org-1', name: 'Acme Shop', slug: 'acme-shop', role }],
  };
}

export const incident: IncidentDetail = {
  id: 'inc-1',
  key: 'INC-42',
  number: 42,
  title: 'Checkout returns 500 after the v2.4.0 deploy',
  description: 'Customers cannot complete payment.',
  severity: 'SEV1',
  status: 'INVESTIGATING',
  environment: 'production',
  source: 'manual',
  customerImpact: null,
  rootCause: null,
  resolution: null,
  startedAt: '2026-11-10T09:00:00.000Z',
  acknowledgedAt: '2026-11-10T09:04:00.000Z',
  mitigatedAt: null,
  resolvedAt: null,
  durationMinutes: 95,
  services: [{ id: 'svc-checkout', name: 'Checkout', slug: 'checkout' }],
  assignee: { id: 'user-eve', name: 'Eve Engineer' },
  commander: null,
  createdBy: { id: 'user-ada', name: 'Ada Admin' },
  timeline: [
    { id: 'ev-1', type: 'created', message: 'Incident opened', actorType: 'user', actorLabel: 'Ada Admin', metadata: null, createdAt: '2026-11-10T09:00:00.000Z' },
    { id: 'ev-2', type: 'comment', message: 'Error rate is climbing on checkout.', actorType: 'user', actorLabel: 'Eve Engineer', metadata: null, createdAt: '2026-11-10T09:10:00.000Z' },
    { id: 'ev-3', type: 'investigation', message: 'AI investigation started: "What changed before checkout began failing?"', actorType: 'user', actorLabel: 'Ada Admin', metadata: { investigationId: 'inv-1' }, createdAt: '2026-11-10T09:12:00.000Z' },
    { id: 'ev-4', type: 'remediation', message: 'Remediation proposed: Roll back checkout to v2.3.1', actorType: 'ai_agent', actorLabel: 'OPSILUME AI', metadata: { actionId: 'act-1' }, createdAt: '2026-11-10T09:14:00.000Z' },
  ],
  investigations: [{ id: 'inv-1', question: 'What changed before checkout began failing?', status: 'COMPLETED', summary: 'Errors began two minutes after v2.4.0 was deployed.', confidence: 0.62, provider: 'heuristic', model: null, createdAt: '2026-11-10T09:12:00.000Z', completedAt: '2026-11-10T09:13:00.000Z' }],
  remediations: [{ id: 'act-1', title: 'Roll back checkout to v2.3.1', type: 'rollback_deployment', risk: 'MEDIUM', status: 'PENDING_APPROVAL', proposedByType: 'ai_agent', createdAt: '2026-11-10T09:14:00.000Z' }],
  alerts: [],
  postmortem: null,
};

const summary: InvestigationSummary = {
  id: 'inv-1',
  question: 'What changed before checkout began failing?',
  status: 'COMPLETED',
  provider: 'heuristic',
  model: null,
  analysisMode: 'heuristic',
  attemptedProvider: null,
  estimatedCostUsd: null,
  summary: 'Errors began two minutes after v2.4.0 was deployed.',
  confidence: 0.62,
  outcome: 'INCIDENT',
  error: null,
  createdAt: '2026-11-10T09:12:00.000Z',
  startedAt: '2026-11-10T09:12:01.000Z',
  completedAt: '2026-11-10T09:13:00.000Z',
  incident: { id: 'inc-1', number: 42, title: incident.title, severity: 'SEV1' },
  _count: { evidence: 3, hypotheses: 1, steps: 3 },
};

export const investigationList: Paged<InvestigationSummary> = { data: [summary], meta: { page: 1, pageSize: 15, total: 1, totalPages: 1 } };

const { _count: _counts, ...summaryFields } = summary;

/** A completed rule-based investigation: one supported hypothesis, one flagged figure, one proposed rollback. */
export const investigation: InvestigationDetail = {
  ...summaryFields,
  plan: { objective: 'Find what changed before the errors began', services: ['checkout'], windowFrom: '2026-11-10T07:00:00.000Z', windowTo: '2026-11-10T09:12:00.000Z', steps: [{ description: 'Look for new error patterns', tool: 'find_log_anomalies' }] },
  report: {
    summary: 'Errors began two minutes after v2.4.0 was deployed (E1, E2).',
    confidence: 0.62,
    analysisMode: 'heuristic',
    rootCauseConfirmed: false,
    outcome: 'INCIDENT',
    assessment: {
      outcome: 'INCIDENT',
      confidence: 0.86,
      rationale: 'A new error pattern appeared and the error rate rose well above its baseline.',
      supportingRefs: ['E2'],
      signals: [
        { level: 'strong', kind: 'logs', text: '312 new ERROR lines in checkout', evidenceRefs: ['E2'] },
        { level: 'weak', kind: 'metrics', text: 'CPU slightly raised', evidenceRefs: ['E3'] },
      ],
      missingTelemetry: ['Traces were not examined.'],
    },
    observations: [{ statement: 'Latency stayed within its usual range.', evidenceRefs: ['E3'], verification: { status: 'no_claims', checks: [] } }],
    integrity: { checked: 3, supported: 2, flagged: [{ where: 'fact 2', text: '44%', status: 'unsupported', detail: 'no cited evidence holds this value' }] },
    timeline: [{ timestamp: '2026-11-10T08:58:00.000Z', description: 'v2.4.0 deployed to production', evidenceRefs: ['E1'] }],
    facts: [
      { statement: 'v2.4.0 was deployed at 08:58.', evidenceRefs: ['E1'], verification: { status: 'verified', checks: [{ text: 'v2.4.0', kind: 'version', status: 'exact', detail: 'found in E1', evidenceRef: 'E1' }] } },
      { statement: 'The error rate reached 44%.', evidenceRefs: ['E2'], verification: { status: 'unsupported', checks: [{ text: '44%', kind: 'number', status: 'unsupported', detail: 'no cited evidence holds this value' }] } },
    ],
    assumptions: ['The timing of the deployment is treated as a signal, not as proof.'],
    uncertainties: ['The diff of v2.4.0 was not reviewed.'],
    nextSteps: ['Review the connection pool change in v2.4.0'],
    hypotheses: [],
    recommendedActions: [],
  },
  steps: [
    { id: 'st-1', index: 0, type: 'plan', title: 'Investigation plan', detail: null, toolName: null, input: null, output: null, status: 'completed', durationMs: null, createdAt: '2026-11-10T09:12:02.000Z' },
    { id: 'st-2', index: 1, type: 'tool_call', title: 'Looked for new error patterns', detail: null, toolName: 'find_log_anomalies', input: { services: ['checkout'], from_time: '2h' }, output: { anomalies: [{ fingerprint: 'fp-1', count: 312 }] }, status: 'completed', durationMs: 48, createdAt: '2026-11-10T09:12:05.000Z' },
    { id: 'st-3', index: 2, type: 'guardrail', title: 'Lowered confidence: rule-based analysis is capped', detail: null, toolName: null, input: null, output: null, status: 'completed', durationMs: null, createdAt: '2026-11-10T09:12:50.000Z' },
  ],
  evidence: [
    { id: 'e-1', ref: 'E1', kind: 'deployment', title: 'Deployment of checkout v2.4.0 (succeeded)', summary: 'Deployed by ci at 08:58 from main.', sourceType: 'deployment', sourceId: 'dep-9', occurredAt: '2026-11-10T08:58:00.000Z', relevance: 0.8, data: { version: 'v2.4.0' } },
    { id: 'e-2', ref: 'E2', kind: 'log_pattern', title: '312× ERROR in checkout: timeout acquiring connection', summary: 'First seen 09:00, not present in the previous 24 hours.', sourceType: 'log_pattern', sourceId: 'fp-1', occurredAt: '2026-11-10T09:00:00.000Z', relevance: 0.9, data: { fingerprint: 'fp-1', count: 312 } },
    { id: 'e-3', ref: 'E3', kind: 'metric', title: 'latency_p95_ms steady', summary: 'Within 5% of the baseline.', sourceType: 'metric', sourceId: null, occurredAt: null, relevance: 0.3, data: null },
  ],
  hypotheses: [
    {
      id: 'h-1', rank: 1, title: 'v2.4.0 reduced the database connection pool', description: 'The new error pattern (E2) began right after the deployment (E1).', confidence: 0.62, status: 'likely',
      evidenceRefs: ['E1', 'E2'], contradictingRefs: [], contradictions: [], facts: ['Timeouts acquiring a connection began at 09:00 (E2).'], assumptions: ['The pool size changed in this release.'], gaps: ['The diff of v2.4.0.'],
    },
  ],
  remediations: [{ id: 'act-1', title: 'Roll back checkout to v2.3.1', type: 'rollback_deployment', risk: 'MEDIUM', status: 'PROPOSED', effect: 'state_changing' }],
  createdBy: { id: 'user-ada', name: 'Ada Admin' },
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  llmCalls: 0,
  llmLatencyMs: 0,
};

/** A rollback proposed by the AI, submitted for approval by Eve, waiting for one approval. */
export const remediation: RemediationDetail = {
  id: 'act-1',
  title: 'Roll back checkout to v2.3.1',
  type: 'rollback_deployment',
  risk: 'MEDIUM',
  status: 'PENDING_APPROVAL',
  effect: 'state_changing',
  description: 'Redeploy checkout v2.3.1, the last version before the errors began.',
  rationale: 'Errors began two minutes after v2.4.0 was deployed.',
  parameters: { deploymentId: 'dep-9', toVersion: 'v2.3.1' },
  requiredApprovals: 1,
  approvalsGranted: 0,
  proposedByType: 'ai_agent',
  proposedBy: { id: null, name: 'OPSILUME AI' },
  requestedBy: { id: 'user-eve', name: 'Eve Engineer' },
  requestedAt: '2026-11-10T09:20:00.000Z',
  executedBy: null,
  executedAt: null,
  executionResult: null,
  effectReasons: ['a rollback changes what is running'],
  currentHash: 'hash-of-what-the-approver-sees',
  attempts: 0,
  service: { id: 'svc-checkout', name: 'Checkout', slug: 'checkout' },
  incident: { id: 'inc-1', number: 42, title: incident.title, severity: 'SEV1', status: 'INVESTIGATING' },
  investigation: { id: 'inv-1', question: 'What changed before checkout began failing?', summary: 'Errors began two minutes after v2.4.0 was deployed.' },
  approvals: [],
  createdAt: '2026-11-10T09:14:00.000Z',
  executionMode: 'webhook',
  allowSelfApproval: false,
};

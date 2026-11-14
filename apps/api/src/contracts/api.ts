import { z } from 'zod';
import { ACTION_EFFECTS, ANALYSIS_MODES, OUTCOMES } from '../generated/contracts';
import { assessmentObject, integrityObject, reportSchema, statementSchema, verificationObject } from '../modules/investigations/schema';

/**
 * The API's responses, as the web app relies on them. This is the authoritative definition:
 *
 *   - tests/api-contract.test.ts validates what the API really returns against these schemas;
 *   - `npm run contracts` exports them to contracts/api.schema.json and generates
 *     apps/web/src/lib/generated/api.ts, the only place the web app gets these types from.
 *
 * A schema lists the fields the web app may use. The API may return more; a field listed here
 * must be present, with this type. Timestamps are ISO-8601 strings on the wire.
 */

const timestamp = z.string().describe('ISO-8601 timestamp');
const json = z.record(z.string(), z.unknown());

export const Ref = z.object({ id: z.string(), name: z.string() });
export const ServiceRef = Ref.extend({ slug: z.string() });
export const PageMeta = z.object({ page: z.number(), pageSize: z.number(), total: z.number(), totalPages: z.number() });

export const Session = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string(), title: z.string().nullable() }),
  organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  role: z.enum(['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER']),
  permissions: z.array(z.string()),
  organizations: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), role: z.string() })),
});

export const Incident = z.object({
  id: z.string(),
  key: z.string(),
  number: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  severity: z.string(),
  status: z.string(),
  environment: z.string(),
  source: z.string(),
  customerImpact: z.string().nullable(),
  rootCause: z.string().nullable(),
  resolution: z.string().nullable(),
  startedAt: timestamp,
  acknowledgedAt: timestamp.nullable(),
  mitigatedAt: timestamp.nullable(),
  resolvedAt: timestamp.nullable(),
  durationMinutes: z.number(),
  services: z.array(ServiceRef),
  assignee: Ref.nullable(),
  commander: Ref.nullable(),
  createdBy: Ref.nullable(),
});

export const TimelineEvent = z.object({
  id: z.string(),
  type: z.string(),
  message: z.string(),
  actorType: z.string(),
  actorLabel: z.string().nullable(),
  metadata: json.nullable(),
  createdAt: timestamp,
});

/** GET /incidents/:id adds what happened on the incident and what was done about it. */
export const IncidentDetail = Incident.extend({
  timeline: z.array(TimelineEvent),
  investigations: z.array(z.object({ id: z.string(), question: z.string(), status: z.string(), summary: z.string().nullable(), confidence: z.number().nullable(), provider: z.string().nullable(), model: z.string().nullable(), createdAt: timestamp, completedAt: timestamp.nullable() })),
  remediations: z.array(z.object({ id: z.string(), title: z.string(), type: z.string(), risk: z.string(), status: z.string(), proposedByType: z.string(), createdAt: timestamp })),
  alerts: z.array(z.object({ id: z.string(), message: z.string(), status: z.string(), startedAt: timestamp })),
  postmortem: z.object({ id: z.string(), title: z.string() }).nullable(),
});

export const InvestigationSummary = z.object({
  id: z.string(),
  question: z.string(),
  status: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  analysisMode: z.enum(ANALYSIS_MODES).nullable().describe('Which engine wrote the report: a real model, the scripted mock, or the rule-based engine'),
  attemptedProvider: z.string().nullable().describe('The provider that was asked first, when the rule-based engine had to stand in for it'),
  estimatedCostUsd: z.number().nullable(),
  summary: z.string().nullable(),
  confidence: z.number().nullable(),
  outcome: z.enum(OUTCOMES).nullable().describe('Whether the evidence shows a fault at all'),
  error: z.string().nullable(),
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  incident: z.object({ id: z.string(), number: z.number(), title: z.string(), severity: z.string() }).nullable(),
  _count: z.object({ evidence: z.number(), hypotheses: z.number(), steps: z.number() }),
});

export const Evidence = z.object({
  id: z.string(),
  ref: z.string(),
  kind: z.string(),
  title: z.string(),
  summary: z.string(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  occurredAt: timestamp.nullable(),
  relevance: z.number().nullable(),
  data: json.nullable(),
});

export const Hypothesis = z.object({
  id: z.string(),
  rank: z.number(),
  title: z.string(),
  description: z.string(),
  confidence: z.number(),
  status: z.string(),
  evidenceRefs: z.array(z.string()),
  contradictingRefs: z.array(z.string()),
  contradictions: z.array(z.string()),
  facts: z.array(z.string()),
  assumptions: z.array(z.string()),
  gaps: z.array(z.string()),
});

export const Step = z.object({
  id: z.string(),
  index: z.number(),
  type: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  toolName: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  status: z.string(),
  durationMs: z.number().nullable(),
  createdAt: timestamp,
});

/** The stored report is exactly what passed the report contract and the guardrails. */
export const Report = reportSchema;
export const Statement = statementSchema;
export const Verification = verificationObject;
export const Assessment = assessmentObject;
export const Integrity = integrityObject;

export const RemediationSummary = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  risk: z.string(),
  status: z.string(),
  effect: z.enum(ACTION_EFFECTS).describe('What carrying it out would do: only look, or change something'),
});

/** GET /investigations/:id: everything the run recorded. The collections replace the counts. */
export const InvestigationDetail = InvestigationSummary.omit({ _count: true }).extend({
  plan: z.object({ objective: z.string(), services: z.array(z.string()), windowFrom: z.string(), windowTo: z.string(), steps: z.array(z.object({ description: z.string(), tool: z.string() })) }).nullable(),
  report: Report.nullable(),
  steps: z.array(Step),
  evidence: z.array(Evidence),
  hypotheses: z.array(Hypothesis),
  remediations: z.array(RemediationSummary),
  createdBy: Ref.nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  llmCalls: z.number(),
  llmLatencyMs: z.number(),
});

export const ExecutionResult = z.object({
  mode: z.string(),
  success: z.boolean(),
  outcome: z.enum(['applied', 'not_applied', 'unknown']).optional().describe('applied, certainly not applied, or unknown (the change may or may not have been made)'),
  summary: z.string(),
  detail: json.optional(),
  contentHash: z.string().optional(),
  attempt: z.number().optional(),
});

export const Approval = z.object({
  id: z.string(),
  decision: z.string(),
  comment: z.string().nullable(),
  createdAt: timestamp,
  approver: Ref.nullable(),
  counts: z.boolean().describe('Whether this approval still counts: it was given for the current content and has not been superseded'),
  supersededAt: timestamp.nullable(),
});

export const Remediation = RemediationSummary.extend({
  description: z.string(),
  rationale: z.string().nullable(),
  parameters: json.nullable(),
  requiredApprovals: z.number(),
  approvalsGranted: z.number(),
  proposedByType: z.string(),
  proposedBy: z.object({ id: z.string().nullable(), name: z.string() }).nullable(),
  requestedBy: Ref.nullable(),
  requestedAt: timestamp.nullable(),
  executedBy: Ref.nullable(),
  executedAt: timestamp.nullable(),
  executionResult: ExecutionResult.nullable(),
  effectReasons: z.array(z.string()).nullable(),
  currentHash: z.string().describe('Hash of exactly what an approver is shown; sent back with the approval'),
  attempts: z.number(),
  service: ServiceRef.nullable(),
  incident: z.object({ id: z.string(), number: z.number(), title: z.string(), severity: z.string(), status: z.string() }).nullable(),
  investigation: z.object({ id: z.string(), question: z.string(), summary: z.string().nullable() }).nullable(),
  approvals: z.array(Approval),
  createdAt: timestamp,
});

/** GET /remediations/:id adds how actions are carried out in this organisation. */
export const RemediationDetail = Remediation.extend({ executionMode: z.enum(['webhook', 'manual']), allowSelfApproval: z.boolean() });

export const Deployment = z.object({
  id: z.string(),
  version: z.string(),
  environment: z.string(),
  status: z.string(),
  commitSha: z.string().nullable(),
  branch: z.string().nullable(),
  deployedBy: z.string().nullable(),
  description: z.string().nullable(),
  source: z.string(),
  isRollback: z.boolean(),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  service: ServiceRef,
});

export const Service = ServiceRef.extend({
  description: z.string().nullable(),
  tier: z.string(),
  lifecycle: z.string(),
  language: z.string().nullable(),
  repoUrl: z.string().nullable(),
  runbookUrl: z.string().nullable(),
  health: z.string(),
  healthNote: z.string().nullable(),
  tags: z.array(z.string()),
  ownerTeam: Ref.nullable(),
  ownerTeamId: z.string().nullable(),
});

export const LogEntry = z.object({
  id: z.string(),
  timestamp,
  level: z.string(),
  message: z.string(),
  environment: z.string(),
  host: z.string().nullable(),
  traceId: z.string().nullable(),
  fingerprint: z.string(),
  attributes: json.nullable(),
  service: ServiceRef.nullable(),
});

export const Member = z.object({
  id: z.string(),
  role: z.string(),
  joinedAt: timestamp,
  user: z.object({ id: z.string(), name: z.string(), email: z.string(), title: z.string().nullable(), lastLoginAt: timestamp.nullable() }),
  teams: z.array(z.object({ id: z.string(), name: z.string(), isLead: z.boolean(), onCall: z.boolean() })),
});

export const paged = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), meta: PageMeta });
const statusCounts = z.record(z.string(), z.number()).describe('How many there are in each status, over the whole list rather than the page');

/** GET /incidents and GET /remediations: a page, plus counts for the status filter. */
export const IncidentList = paged(Incident).extend({ statusCounts });
export const RemediationList = paged(Remediation).extend({ statusCounts, executionMode: z.enum(['webhook', 'manual']) });

/** One source of data, or one thing OPSILUME calls out to, and whether it works. Texts are written by the API. */
export const Integration = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['push', 'pull', 'outbound', 'engine']),
  scope: z.enum(['organization', 'installation']),
  provides: z.string(),
  requires: z.array(z.string()),
  status: z.enum(['not_configured', 'configured', 'connected', 'delivering', 'degraded', 'unavailable']),
  statusDetail: z.string(),
  lastReceivedAt: timestamp.nullable(),
  lastError: z.object({ at: timestamp, message: z.string() }).nullable(),
  lastCheck: z.object({ at: timestamp, ok: z.boolean(), detail: z.string() }).nullable(),
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
  setup: z.object({ endpoint: z.string().nullable(), apiKeyScope: z.string().nullable(), example: z.string().nullable(), settingsTab: z.enum(['keys', 'github', 'organisation']).nullable(), canCheck: z.boolean() }),
});

/** GET /integrations */
export const IntegrationOverview = z.object({
  generatedAt: timestamp,
  integrations: z.array(Integration),
  unresolvedServices: z.array(z.object({ ref: z.string(), sources: z.array(z.string()), count: z.number().nullable(), lastSeenAt: timestamp.nullable(), linkable: z.boolean(), registered: z.boolean() })),
  onboarding: z.object({ complete: z.boolean(), steps: z.array(z.object({ id: z.string(), title: z.string(), done: z.boolean(), detail: z.string(), href: z.string() })) }),
});

/** POST /integrations/github/check and /integrations/remediation-webhook/check */
export const IntegrationCheck = z.object({ ok: z.boolean(), detail: z.string() });

/** Every response type the web app gets from the API, by the name it is generated under. */
export const API_CONTRACT = {
  Ref, ServiceRef, PageMeta, Session, Incident, IncidentDetail, IncidentList, TimelineEvent, InvestigationSummary, InvestigationDetail, Evidence, Hypothesis, Step,
  Report, Statement, Verification, Assessment, Integrity, RemediationSummary, Remediation, RemediationDetail, RemediationList, ExecutionResult, Approval,
  Deployment, Service, LogEntry, Member, Integration, IntegrationOverview, IntegrationCheck,
} as const;

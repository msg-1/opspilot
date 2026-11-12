export interface Paged<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface Ref {
  id: string;
  name: string;
}
export interface ServiceRef extends Ref {
  slug: string;
}

export interface Incident {
  id: string;
  key: string;
  number: number;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  environment: string;
  source: string;
  customerImpact: string | null;
  rootCause: string | null;
  resolution: string | null;
  startedAt: string;
  acknowledgedAt: string | null;
  mitigatedAt: string | null;
  resolvedAt: string | null;
  durationMinutes: number;
  services: ServiceRef[];
  assignee: Ref | null;
  commander: Ref | null;
  createdBy: Ref | null;
}

export interface TimelineEvent {
  id: string;
  type: string;
  message: string;
  actorType: string;
  actorLabel: string | null;
  metadata: Record<string, string> | null;
  createdAt: string;
}

export interface InvestigationSummary {
  id: string;
  question: string;
  status: string;
  provider: string | null;
  model: string | null;
  /** Which engine wrote the report: a real model, the scripted mock, or the rule-based engine */
  analysisMode?: 'llm' | 'mock' | 'heuristic' | null;
  attemptedProvider?: string | null;
  estimatedCostUsd?: number | null;
  summary: string | null;
  confidence: number | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt: string | null;
  incident?: { id: string; number: number; title: string; severity: string } | null;
  _count?: { evidence: number; hypotheses: number; steps: number };
}

export interface Evidence {
  id: string;
  ref: string;
  kind: string;
  title: string;
  summary: string;
  sourceType: string | null;
  sourceId: string | null;
  occurredAt: string | null;
  relevance: number | null;
  data: Record<string, unknown> | null;
}

export interface Hypothesis {
  id: string;
  rank: number;
  title: string;
  description: string;
  confidence: number;
  status: string;
  evidenceRefs: string[];
  contradictingRefs: string[];
  contradictions: string[];
  facts: string[];
  assumptions: string[];
  gaps: string[];
}

export interface Step {
  id: string;
  index: number;
  type: string;
  title: string;
  detail: string | null;
  toolName: string | null;
  input: unknown;
  output: unknown;
  status: string;
  durationMs: number | null;
  createdAt: string;
}

export interface Report {
  summary: string;
  confidence: number;
  analysisMode: 'llm' | 'heuristic' | 'mock';
  timeline: { timestamp: string; description: string; evidenceRefs: string[] }[];
  facts: { statement: string; evidenceRefs: string[] }[];
  assumptions: string[];
  uncertainties: string[];
  nextSteps: string[];
}

export interface RemediationSummary {
  id: string;
  title: string;
  type: string;
  risk: string;
  status: string;
  proposedByType?: string;
  createdAt?: string;
}

export interface Remediation extends RemediationSummary {
  description: string;
  rationale: string | null;
  parameters: Record<string, unknown> | null;
  requiredApprovals: number;
  approvalsGranted: number;
  proposedByType: string;
  proposedBy: { id: string | null; name: string } | null;
  requestedBy: Ref | null;
  requestedAt: string | null;
  executedBy: Ref | null;
  executedAt: string | null;
  executionResult: { mode: string; success: boolean; summary: string; detail?: Record<string, unknown> } | null;
  service: ServiceRef | null;
  incident: { id: string; number: number; title: string; severity: string; status: string } | null;
  investigation: { id: string; question: string; summary: string | null } | null;
  approvals: { id: string; decision: string; comment: string | null; createdAt: string; approver: Ref | null }[];
  createdAt: string;
  executionMode?: 'webhook' | 'manual';
  allowSelfApproval?: boolean;
}

export interface Deployment {
  id: string;
  version: string;
  environment: string;
  status: string;
  commitSha: string | null;
  branch: string | null;
  deployedBy: string | null;
  description: string | null;
  source: string;
  isRollback: boolean;
  startedAt: string;
  finishedAt: string | null;
  service: ServiceRef;
}

export interface Service extends ServiceRef {
  description: string | null;
  tier: string;
  lifecycle: string;
  language: string | null;
  repoUrl: string | null;
  runbookUrl: string | null;
  health: string;
  healthNote: string | null;
  tags: string[];
  ownerTeam: Ref | null;
  ownerTeamId: string | null;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  environment: string;
  host: string | null;
  traceId: string | null;
  fingerprint: string;
  attributes: Record<string, unknown> | null;
  service: ServiceRef | null;
}

export interface Member {
  id: string;
  role: string;
  joinedAt: string;
  user: { id: string; name: string; email: string; title: string | null; lastLoginAt: string | null };
  teams: { id: string; name: string; isLead: boolean; onCall: boolean }[];
}

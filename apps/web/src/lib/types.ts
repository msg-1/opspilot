// The shapes the API returns. They are generated from the API's response contracts
// (apps/api/src/contracts/api.ts) by `npm run contracts`; CI fails when the generated file is
// stale, and the API's own tests check real responses against the same contracts. Nothing
// here is written by hand except a few names for parts of the generated types.
import type { Assessment, Verification } from './generated/api';

export type {
  Approval,
  Assessment,
  Deployment,
  Evidence,
  ExecutionResult,
  Hypothesis,
  Incident,
  IncidentDetail,
  IncidentList,
  Integrity,
  InvestigationDetail,
  InvestigationSummary,
  LogEntry,
  Member,
  PageMeta,
  Paged,
  Ref,
  Remediation,
  RemediationDetail,
  RemediationList,
  RemediationSummary,
  Report,
  Service,
  ServiceRef,
  Session,
  Statement,
  Step,
  TimelineEvent,
  Verification,
} from './generated/api';

/** Whether the evidence shows a fault at all. */
export type Outcome = Assessment['outcome'];
/** One figure in a statement, and whether the cited evidence holds it. */
export type ClaimCheck = Verification['checks'][number];

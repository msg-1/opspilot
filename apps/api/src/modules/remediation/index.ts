/**
 * Remediation lifecycle:
 *   PROPOSED → PENDING_APPROVAL → APPROVED → EXECUTING → EXECUTED | FAILED
 *                              ↘ REJECTED            (CANCELLED from any pre-execution state)
 * Nothing here can be triggered by the AI agent: it may only create PROPOSED actions.
 * Approval and execution are restricted to signed-in humans (requireUser).
 *
 * Effect. Every action is read_only or state_changing, decided from its type and its text
 * (lib/actionEffect.ts), never from what the proposer says.
 *   read_only       a diagnostic. Needs no approval; a human records that it was done. It is
 *                   never sent to the webhook, so a misjudged text cannot change anything.
 *   state_changing  needs at least one approval, whatever the organisation's settings say.
 *
 * Binding. An approval is given for exact content: a hash of type, title, description, risk,
 * service and parameters. Editing an action supersedes its approvals and returns it to PROPOSED.
 * Execution recomputes the hash and counts only approvals given for that hash.
 *
 * Outcome. A webhook that times out or fails mid-flight leaves the outcome UNKNOWN, and the
 * record says so. Such an action can be retried only after a human confirms the change was not
 * applied; the idempotency key stays the same across attempts so a receiver can refuse a repeat.
 *
 * By responsibility:
 *   routes.ts      HTTP routes
 *   proposals.ts   creating a proposed action; request validation
 *   content.ts     action hashing
 *   effect.ts      effect classification, risk floor, approvals required
 *   approvals.ts   approval management and binding
 *   execution.ts   webhook dispatch and manual attestation
 *   recording.ts   recording the outcome and its effect on the service history
 *   presenter.ts   loading an action and shaping the response
 */
export { REMEDIATION_TYPES } from '../../generated/contracts';
export { contentHash } from './content';
export { effectiveRisk } from './effect';
export { proposeRemediation, remediationInput } from './proposals';
export { remediationRouter } from './routes';

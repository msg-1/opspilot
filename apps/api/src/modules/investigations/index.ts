/**
 * Investigations, by responsibility:
 *   routes.ts       HTTP routes
 *   validation.ts   request validation
 *   limits.ts       per-organisation spending limits
 *   runner.ts       orchestration of one run (the queue processor)
 *   stream.ts       consumption of the AI service's event stream
 *   guardrails.ts   the API's independent check of the report
 *   persistence.ts  what a run writes to the database
 *   schema.ts       the report contract
 */
import './runner'; // registers the queue processor

export { applyGuardrails } from './guardrails';
export { investigationsRouter } from './routes';
export { runInvestigation } from './runner';
export { type InvestigationReport, reportSchema } from './schema';

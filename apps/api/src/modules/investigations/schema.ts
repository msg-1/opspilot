import { z } from 'zod';
import { ACTION_EFFECTS, ANALYSIS_MODES, CLAIM_KINDS, CLAIM_STATUSES, HYPOTHESIS_STATUSES, OUTCOMES, REMEDIATION_TYPES, RISK_LEVELS, SIGNAL_LEVELS, VERIFICATION_STATUSES } from '../../generated/contracts';

/**
 * The investigation report as the API accepts it from the AI service. The authoritative
 * definition is the AI service's (services/ai/app/schemas.py, exported to
 * contracts/report.schema.json); tests/contract.test.ts checks that this schema describes the
 * same fields and the same closed sets. The closed sets themselves come from contracts/enums.json.
 */

const refs = z.array(z.string()).default([]);

const hypothesisSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(4000),
  confidence: z.number().min(0).max(1),
  status: z.enum(HYPOTHESIS_STATUSES).default('possible'),
  evidenceRefs: refs,
  contradictingEvidenceRefs: refs,
  contradictions: z.array(z.string()).default([]),
  facts: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
});

const claimStatus = z.enum(CLAIM_STATUSES);
// Set by the AI service's claim checker (services/ai/app/claims.py); carried through unchanged.
const verificationSchema = z
  .object({
    status: z.enum(VERIFICATION_STATUSES),
    checks: z.array(z.object({ text: z.string(), kind: z.enum(CLAIM_KINDS), status: claimStatus, detail: z.string(), evidenceRef: z.string().nullable().optional() })).default([]),
  })
  .nullable()
  .optional();
const statementSchema = z.object({ statement: z.string(), evidenceRefs: refs, verification: verificationSchema });

export const reportSchema = z.object({
  summary: z.string().min(1).max(6000),
  confidence: z.number().min(0).max(1),
  analysisMode: z.enum(ANALYSIS_MODES),
  // Whether the evidence shows a fault at all. Computed by the AI service from the evidence.
  outcome: z.enum(OUTCOMES).nullable().optional(),
  assessment: z
    .object({
      outcome: z.enum(OUTCOMES),
      confidence: z.number().min(0).max(1),
      rationale: z.string().max(4000),
      supportingRefs: refs,
      signals: z.array(z.object({ level: z.enum(SIGNAL_LEVELS), kind: z.string(), text: z.string(), evidenceRefs: refs })).default([]),
      missingTelemetry: z.array(z.string()).default([]),
    })
    .nullable()
    .optional(),
  observations: z.array(statementSchema).default([]),
  integrity: z
    .object({
      checked: z.number().int().min(0),
      supported: z.number().int().min(0),
      flagged: z.array(z.object({ where: z.string(), text: z.string(), status: claimStatus, detail: z.string() })).default([]),
    })
    .nullable()
    .optional(),
  // The agent never confirms a root cause; a human does that on the incident.
  rootCauseConfirmed: z.literal(false).default(false),
  timeline: z.array(z.object({ timestamp: z.string(), description: z.string(), evidenceRefs: refs })).default([]),
  facts: z.array(statementSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
  hypotheses: z.array(hypothesisSchema).max(8).default([]),
  nextSteps: z.array(z.string()).default([]),
  recommendedActions: z
    .array(
      z.object({
        type: z.enum(REMEDIATION_TYPES),
        title: z.string().min(4).max(200),
        description: z.string().min(4).max(5000),
        rationale: z.string().max(5000).optional().nullable(),
        risk: z.enum(RISK_LEVELS).default('MEDIUM'),
        // Recomputed here from the type and text; what the sender says is not relied on.
        effect: z.enum(ACTION_EFFECTS).optional(),
        effectReasons: z.array(z.string()).optional(),
        serviceSlug: z.string().optional().nullable(),
        parameters: z.record(z.string(), z.unknown()).optional().nullable(),
        evidenceRefs: refs,
      }),
    )
    .max(6)
    .default([]),
});
export type InvestigationReport = z.infer<typeof reportSchema>;

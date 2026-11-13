# Shared contracts

What the AI service (Python), the API (TypeScript) and the web app (TypeScript) have to agree on is defined here once. Each side either has its representation **generated** from these files or is **checked** against them by its own test suite. CI regenerates everything and fails if a committed file would change.

```bash
npm run contracts          # regenerate everything below
npm run contracts:check    # the same, then fail if anything changed (what CI does)
```

## What is defined where

| Contract | Authoritative definition | TypeScript | Python |
|---|---|---|---|
| Closed value sets (remediation types, outcomes, risk levels, claim statuses, …) | `enums.json` | **generated** → `apps/api/src/generated/contracts.ts`, `apps/web/src/lib/generated/contracts.ts`; used by the Zod schemas | **generated** → `services/ai/app/generated/contracts.py`; used by the pydantic models |
| Action effects: what makes an action read-only or state-changing | `action-effects.json` (the rules as data) | generated; applied by `apps/api/src/lib/actionEffect.ts` | generated; applied by `services/ai/app/effects.py` |
| Guardrail limits and wording (confidence caps, withdrawal reasons) | `guardrails.json` | generated; used by the API's guardrail pass | generated; used by `services/ai/app/guardrails.py` |
| Investigation report | `services/ai/app/schemas.py` (`InvestigationReport`), exported to `report.schema.json` | the API's Zod `reportSchema` is **checked** against the export: same fields, same closed sets | the export is checked to be current |
| Agent tools: method, path, parameters sent, response fields read | `services/ai/app/tools.py` and the evidence extractors, exported to `tools.json` | the API is **checked**: every tool is called with exactly those parameters against a real database and must return those fields | the export is checked to be current |
| API responses used by the web app | `apps/api/src/contracts/` (Zod), exported to `api.schema.json` | **generated** → `apps/web/src/lib/generated/api.ts`; API tests validate real responses against the schemas | – |

## Fixtures both sides run

| File | Run by | What it pins down |
|---|---|---|
| `fixtures/action-effects.json` | `services/ai/tests/test_reliability.py`, `apps/api/tests/safety.test.ts` | 25 actions and the effect each must be given |
| `fixtures/guardrail-cases.json` | `services/ai/tests/test_contracts.py`, `apps/api/tests/contract.test.ts` | Guardrail behaviour both implementations must show: invented citations removed, an unsupported hypothesis capped, a change resting on an unlikely hypothesis withdrawn, a rollback judged by the deployment it rolls back, a high-risk alternative moved to next steps, no production change without an incident |
| `fixtures/report.contract.json` | written by `services/ai/tests/test_agent.py`, read by `apps/api/tests/contract.test.ts` | A complete report as the AI service really emits it; the API must accept it and keep every field |

## Two guardrail passes, one definition

The API applies its guardrails to whatever the AI service returns, independently. That second pass is deliberate (a report might arrive that was never checked) and stays. What is shared is the definition: the limits and wording come from `guardrails.json`, the effect rules from `action-effects.json`, and the behaviour is pinned by the same cases on both sides.

Rules only the AI service applies, because only it holds the full evidence while the report is written: the outcome assessment, rollback-target validation against deployment evidence, and the checking of figures. The API re-applies: citation resolution, the cap on unsupported hypotheses, the overall confidence ceiling, action effects, and the three withdrawal rules.

## Changing a contract

1. Edit the authoritative definition (the JSON here, or the Python model, tool or API schema).
2. `npm run contracts`.
3. Add or extend a fixture case if behaviour changes.
4. Run both test suites. Commit the definition and the generated files together.

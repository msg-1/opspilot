# OPSILUME (repository: opspilot) — notes for Claude Code

AI-assisted incident investigation platform. OPSILUME is the product's working name; the repository and all identifiers keep `opspilot`. npm workspaces monorepo plus one Python service.

## Layout

- `apps/api` — Express 5 + TypeScript + Prisma (PostgreSQL, pgvector). System of record. `src/modules/<feature>.ts` holds routes and logic per feature; the two large features are directories split by responsibility (`modules/investigations/`, `modules/remediation/`, each re-exported from its `index.ts`). `src/lib` shared helpers; `src/queues` BullMQ; `src/integrations` outbound clients (AI service, GitHub); `src/contracts` the response contracts the web app's types are generated from; `src/generated` generated, never edited.
- `apps/web` — Next.js 15 App Router + Tailwind 4. Client-rendered pages under `src/app/(app)`, auth pages under `src/app/(auth)`. `/api/*` is proxied to the API (`next.config.ts`).
- `services/ai` — FastAPI + LangGraph. Embeddings, the investigation agent, evals, the MCP server. Stateless: it reaches data only through the API's `/api/v1/tools`. The rule-based engine is `app/rules.py` (one function per rule) orchestrated by `app/heuristics.py`.
- `contracts/` — the single definition of what the AI service, the API and the web app must agree on (see `contracts/README.md`). `npm run contracts` regenerates; CI fails when a generated file is stale.
- `infra/` — Postgres init, Prometheus, Grafana. `docs/` — keep in sync with the code.
- `demo/` — three instrumented services, failure scenarios and an end-to-end runner (Compose profile `demo`). Not part of the npm workspaces.

## Commands

```bash
npm run infra:up            # Postgres + Redis
npm run dev                 # api, worker, web, ai
npm test                    # api + web tests (API tests need Postgres; they use opspilot_test)
npm run test:ai             # pytest
npm run evals -- --heuristic
npm run demo:up && npm run demo:e2e   # local microservices demo, rule-based engine only (about 25 minutes)
npm run test:e2e            # needs the stack running and a fresh `npm run db:seed`
npm run lint && npm run typecheck
npm run contracts            # regenerate shared contracts and frontend API types (contracts:check fails if stale)
npm run tracing:up && npm run trace -- --latest   # local traces of the platform itself (docs/tracing.md)
cd services/ai && uv run ruff check .
```

## Rules that are easy to get wrong

- **Migrations:** never run plain `prisma migrate dev`. Prisma cannot model the HNSW index on `KnowledgeChunk.embedding` and will generate `DROP INDEX "KnowledgeChunk_embedding_hnsw_idx"`. Use `npm run db:migrate:new -w @opspilot/api -- --name <name>` (create-only), delete that DROP line, then `npm run db:migrate`.
- **Tenancy:** every query filters by `organizationId` from `req.auth`. Use `authOf(req)`; never take an organisation id from the request body or path. Cross-tenant references must be validated (see `assertServices`, `assertMembers`).
- **Permissions:** add new ones in `src/lib/permissions.ts`; guard routes with `requirePermission`. Approve/execute routes also use `requireUser` so API keys and the AI tool token can never reach them.
- **The AI agent is read-only.** It gets a short-lived token valid only under `/api/v1/tools`. New agent capabilities are new GET tools there plus a `ToolSpec` in `services/ai/app/tools.py`. Do not add write tools.
- **Evidence cannot be invented.** Evidence items are created only by `services/ai/app/evidence.py` from tool results. Reports are checked in `guardrails.py` (Python) and again in `modules/investigations/guardrails.ts` (Node).
- **Outcome is computed, not authored.** `services/ai/app/assessment.py` decides HEALTHY / DEGRADED / INCIDENT / UNDETERMINED from the evidence for every engine. Do not let a prompt or a rule set it directly, and do not add a metric rule without an absolute floor (a percentage on a near-zero value is noise).
- **Action effects** are decided from type and text by rules defined once, in `contracts/action-effects.json`, and applied by `services/ai/app/effects.py` and `apps/api/src/lib/actionEffect.ts`. Change the JSON, run `npm run contracts`, and extend `contracts/fixtures/action-effects.json`, which both test suites check. Unclear means state-changing.
- **Withdraw, do not relabel.** An action the evidence does not support is removed from the proposals and listed in next steps. Never downgrade a production change to `manual`.
- **Approvals are bound to content** (`contentHash` in `modules/remediation/content.ts`). Anything that edits an action must supersede its approvals (`approvals.ts`). A webhook timeout or 5xx is outcome `unknown`, never success and never a clean failure (`execution.ts`).
- **Figures are checked** by `services/ai/app/claims.py`. When it flags something wrong on real output, fix the validator and add the case to `tests/test_reliability.py`.
- **The demo must never call a paid model.** `demo/scripts` start the AI service with `AI_PROVIDER=deterministic` and refuse to run otherwise. Keep it that way.
- **Naming.** The product is OPSILUME in anything a person reads; identifiers (packages, headers, env vars, database, repository) stay `opspilot`. See `docs/branding/opsilume-branding.md`.
- **Shared contracts.** Closed value sets, guardrail limits and action-effect rules live in `contracts/*.json` and are generated into both languages; never edit `generated/` files or re-declare one of those values by hand. The report (`services/ai/app/schemas.py`) and the agent tools are exported from Python and the API is tested against the export (`apps/api/tests/contract.test.ts`). The API keeps its own, independent guardrail pass (`modules/investigations/guardrails.ts`); do not remove it.
- **Frontend API types are generated.** `apps/web/src/lib/types.ts` only re-exports `lib/generated/api.ts`, which comes from `apps/api/src/contracts/api.ts`. To use a new response field in the web app, add it to the contract, run `npm run contracts`, and let `apps/api/tests/api-contract.test.ts` prove the API returns it.
- **Rule-based engine.** Each rule in `services/ai/app/rules.py` has its own tests (`tests/test_rules.py`); `tests/test_heuristics_golden.py` pins every report the engine produces. Regenerate the snapshot (`OPSPILOT_WRITE_GOLDEN=1`) only for an intended change, and say so in the commit.
- **Spans carry ids and counts only.** No question text, tool arguments, log lines, prompts, error messages, credentials or anything identifying a person. Both services scrub every span on export; the cases are in `contracts/fixtures/span-scrubbing.json`. See `docs/tracing.md`.
- **Next.js page files** may only export the page component. Shared components go in `src/components`.
- **Audit:** mutating routes call `audit(req, action, resourceType, id, metadata)`. Never put secrets in metadata.
- **Pinned majors:** TypeScript 5.9, Prisma 6, Next 15, Zod 3, Vitest 3 (see docs/decisions.md). Do not bump majors casually.
- **Claude API:** the Anthropic provider (`services/ai/app/llm.py`) uses the official SDK with adaptive thinking (no `thinking`/`temperature`/`budget_tokens`, no forced `tool_choice`), `output_config.effort`, prompt caching on the tool loop, and `messages.parse` for structured output. Model, limits and prices come from configuration (`config.py`), never from literals in the code. Provider tests use a mocked API (`tests/test_claude_provider.py`); never add a test that calls the real API. Never print, log or return an API key.
- **Engine labelling:** `analysisMode` (`llm` | `mock` | `heuristic`) must be carried through to the UI. Mock or rule-based output is never presented as model output.

## Git workflow

GitFlow: `feature/*` and `bugfix/*` from `develop` → `develop`; `release/*` from `develop` → `main` + back-merge; `hotfix/*` from `main` → `main` + back-merge. Merge commits (`--no-ff`), never rebase or force-push `main`/`develop`. Details in `docs/git-workflow.md` and `docs/release-process.md`.

- Conventional Commits: `feat`, `fix`, `security`, `refactor`, `test`, `docs`, `chore`.
- **No AI or tool attribution anywhere**: no `Co-Authored-By` trailers, no "generated with" lines, in commits, pull requests or documents. The `.githooks/commit-msg` check enforces this.
- Do not push, create a remote, merge into `main`, tag, or change branch protection without the owner's explicit approval.

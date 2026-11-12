# OpsPilot — notes for Claude Code

AI-assisted incident investigation platform. npm workspaces monorepo plus one Python service.

## Layout

- `apps/api` — Express 5 + TypeScript + Prisma (PostgreSQL, pgvector). System of record. `src/modules/<feature>.ts` holds routes and logic per feature; `src/lib` shared helpers; `src/queues` BullMQ; `src/integrations` outbound clients (AI service, GitHub).
- `apps/web` — Next.js 15 App Router + Tailwind 4. Client-rendered pages under `src/app/(app)`, auth pages under `src/app/(auth)`. `/api/*` is proxied to the API (`next.config.ts`).
- `services/ai` — FastAPI + LangGraph. Embeddings, the investigation agent, evals, the MCP server. Stateless: it reaches data only through the API's `/api/v1/tools`.
- `infra/` — Postgres init, Prometheus, Grafana. `docs/` — keep in sync with the code.

## Commands

```bash
npm run infra:up            # Postgres + Redis
npm run dev                 # api, worker, web, ai
npm test                    # api + web tests (API tests need Postgres; they use opspilot_test)
npm run test:ai             # pytest
npm run evals -- --heuristic
npm run test:e2e            # needs the stack running and a fresh `npm run db:seed`
npm run lint && npm run typecheck
cd services/ai && uv run ruff check .
```

## Rules that are easy to get wrong

- **Migrations:** never run plain `prisma migrate dev`. Prisma cannot model the HNSW index on `KnowledgeChunk.embedding` and will generate `DROP INDEX "KnowledgeChunk_embedding_hnsw_idx"`. Use `npm run db:migrate:new -w @opspilot/api -- --name <name>` (create-only), delete that DROP line, then `npm run db:migrate`.
- **Tenancy:** every query filters by `organizationId` from `req.auth`. Use `authOf(req)`; never take an organisation id from the request body or path. Cross-tenant references must be validated (see `assertServices`, `assertMembers`).
- **Permissions:** add new ones in `src/lib/permissions.ts`; guard routes with `requirePermission`. Approve/execute routes also use `requireUser` so API keys and the AI tool token can never reach them.
- **The AI agent is read-only.** It gets a short-lived token valid only under `/api/v1/tools`. New agent capabilities are new GET tools there plus a `ToolSpec` in `services/ai/app/tools.py`. Do not add write tools.
- **Evidence cannot be invented.** Evidence items are created only by `services/ai/app/evidence.py` from tool results. Reports are checked in `guardrails.py` (Python) and again in `investigations.ts` (Node).
- **Report contract** lives in two places that must match: `services/ai/app/schemas.py` and `reportSchema` in `apps/api/src/modules/investigations.ts`.
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

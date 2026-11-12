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
- **Claude API:** the Anthropic provider (`services/ai/app/llm.py`) uses the official SDK with adaptive thinking (no `thinking`/`temperature`/`budget_tokens`, no forced `tool_choice`), `output_config.effort`, and `messages.parse` for structured output.

## Git workflow

`feature/*` → `develop` (merge with `--no-ff` once tests pass) → `main` only for tested releases, on the owner's say-so.

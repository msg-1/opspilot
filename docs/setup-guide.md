# Setup guide

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Docker Desktop | recent | Postgres, Redis, or the whole stack |
| Node.js | 20 or newer (22 used here) | API and web, when developing on the host |
| uv | 0.5 or newer | AI service, when developing on the host (`brew install uv`) |

## 1. Configuration

```bash
cp .env.example .env
```

Replace the three secrets. Each of these commands prints a suitable value:

```bash
openssl rand -hex 32    # JWT_SECRET
openssl rand -hex 32    # INTERNAL_SERVICE_TOKEN (shared by API and AI service)
openssl rand -hex 32    # ENCRYPTION_KEY (must be exactly 64 hex characters)
```

The API refuses to start with missing or malformed values and tells you which. Docker Compose refuses to start without all three, and the API rejects the placeholder values when `NODE_ENV=production`. All ports are published on `127.0.0.1` only. `.env` is git-ignored; never commit it. Changing `ENCRYPTION_KEY` later makes stored GitHub tokens and webhook secrets unreadable, so they must be re-entered.

## 2a. Run everything in Docker

```bash
docker compose --profile app up -d --build
```

| URL | Service |
|---|---|
| http://localhost:3000 | Web app |
| http://localhost:4000 | API (`/health`, `/ready`, `/metrics`). The worker has the same three on port 9464 inside its container |
| http://localhost:8000 | AI service (`/health`, `/metrics`) |

The `migrate` container applies migrations and seeds demo data if the database is empty (set `SEED_DEMO_DATA=false` to skip the demo data). Stop with `docker compose --profile app down` (add `-v` to also delete the database volume).

## 2b. Run on the host (development)

```bash
npm install
npm run infra:up
npm run db:migrate
npm run db:seed
npm run dev
```

`npm run dev` starts four processes with file watching. If you start them separately, the worker (`npm run dev:worker`) is required for investigations, knowledge indexing, GitHub sync and alert evaluation.

Port 5000 is used by macOS AirPlay, which is why nothing here uses it. If 3000, 4000, 5432, 6379 or 8000 are taken, stop the other process or change `API_PORT` and the related URLs in `.env`.

## 3. Demo accounts

All use the password `OpsPilot-demo-1`. These exist only in seeded demo data.

| Email | Role | Use it to |
|---|---|---|
| demo@example.com | Owner | See everything |
| marcus@example.com | Admin | Approve actions, including high-risk ones |
| lena@example.com | Engineer | Run investigations, request approvals |
| tomas@example.com | Engineer | Second engineer for approvals |
| aiko@example.com | Viewer | See the read-only experience |

`npm run db:seed` recreates only the demo organisation (`meridian-demo`); other organisations are untouched. Seeded timestamps are relative to when you seed, so reseed if the "active incident" has gone stale. Service health turns to "No data" 15 minutes after seeding unless you run the simulator (below).

## 4. AI providers

`AI_PROVIDER=auto` (default) picks, in order: Claude if `ANTHROPIC_API_KEY` is set, OpenAI if `OPENAI_API_KEY` is set, a local Ollama if it is running and has `OLLAMA_MODEL`, otherwise the rule-based engine. Settings → System shows which one is active and can check the key without spending credit. Set `AI_PROVIDER=deterministic` to force the rule-based engine, or `mock` to exercise the model code path with canned output. Full instructions for Claude, including cost controls: [claude-integration.md](claude-integration.md).

Embeddings follow `EMBEDDING_PROVIDER` the same way (OpenAI, then Ollama `nomic-embed-text`, then built-in local embeddings). All produce 768-dimension vectors. After changing the embedding provider, use Knowledge base → **Reindex all**: documents embedded with a different model are only matched by keyword until then.

With a cloud provider, tool results (log lines, commit messages, incident text) from your organisation are sent to that provider. Log redaction (on by default) masks credentials at ingestion.

## 5. Sending your own data

Create an API key under Settings → API keys with the scopes you need, then:

```bash
KEY=opk_...
# Deployment (from CI/CD)
curl -X POST localhost:4000/api/v1/deployments -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"service":"checkout-service","version":"v2.15.0","commitSha":"abc1234","description":"Raise pool size"}'
# Logs (batch of up to 5000)
curl -X POST localhost:4000/api/v1/logs -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"service":"checkout-service","logs":[{"level":"error","message":"timeout after 3000ms","traceId":"abc"}]}'
# Metrics
curl -X POST localhost:4000/api/v1/monitoring/metrics -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"samples":[{"service":"checkout-service","metric":"error_rate","value":1.2}]}'
```

For a living demo: `OPSPILOT_API_KEY=opk_... npm run simulate` (scopes `ingest:logs`, `ingest:metrics`). Add `-- --heal` to make checkout recover and watch the alerts resolve.

## 6. GitHub

Works three ways: sample repositories (generated data, no network, labelled as sample), public repositories without a token (60 requests/hour), or any repository with a token. Add a fine-grained personal access token with read-only **Contents**, **Pull requests** and **Metadata** under Settings → GitHub; it is validated, then stored encrypted. Connect repositories under Code changes. Webhooks are optional and need the API to be reachable from GitHub.

## 7. MCP server

Lets Claude Desktop, Claude Code or another MCP client query OpsPilot read-only. Create an API key with the `tools:read` scope, then register:

```json
{
  "mcpServers": {
    "opspilot": {
      "command": "uv",
      "args": ["run", "--directory", "/absolute/path/to/opspilot/services/ai", "python", "-m", "app.mcp_server"],
      "env": { "OPSPILOT_API_URL": "http://localhost:4000", "OPSPILOT_API_KEY": "opk_..." }
    }
  }
}
```

## 8. Observability

`npm run obs:up` starts Prometheus (http://localhost:9090) and Grafana (http://localhost:3001, admin/admin, dashboard "OpsPilot platform").

Traces of OPSILUME itself (one trace per investigation, across the API, the queue, the worker, the AI service and every tool call):

```bash
npm run tracing:up                    # the application with tracing on, plus a local trace store (http://localhost:16687)
npm run trace -- <investigation id>   # or --latest: prints the trace and checks every hop is in it
npm run tracing:down
```

Tracing is off unless asked for, and spans are scrubbed of credentials and personal data before they leave a process. To export elsewhere, set `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT`. Details: [tracing.md](tracing.md).

## 9. Demo environment: real telemetry and failures

```bash
npm run demo:up                              # OPSILUME on the rule-based engine, plus three instrumented services
npm run demo:scenario -- list                # seven failure scenarios with their activation and recovery commands
npm run demo:e2e                             # runs them all and checks the investigations (about 25 minutes)
npm run demo:down
```

Sign in as `shop-demo@example.com` / `OpsPilot-demo-1`. No model is called and nothing is billed. Full instructions, architecture and limitations: [demo/README.md](../demo/README.md).

## 10. Tests

```bash
npm test                 # API: 121 integration tests on database opspilot_test (25 of them use Redis and skip without it) · web: 47 tests
npm run test:ai          # 171 tests, all against mocked model APIs or hand-written evidence
npm run contracts:check  # shared contracts and generated frontend API types are up to date
npm run evals -- --heuristic          # 11 scenarios on the rule-based engine
npm run db:seed && npm run test:e2e   # 9 browser tests; needs the stack running on the deterministic engine:
                                      #   AI_PROVIDER=deterministic docker compose --profile app up -d ai
                                      # (they skip themselves if a paid model is active)
```

### Browser tests and failure drills on a throwaway stack

The browser tests need a freshly seeded organisation, and the failure drills kill and restart services. Neither belongs on a stack you are using, so both have their own:

```bash
npm run isolated:up      # a second copy of the application: web :13000, API :14000, AI :18000, Postgres :15432, Redis :16379
npm run isolated:e2e     # 11 browser tests, including two that stop the AI service and Redis and check what the page shows
npm run drills           # 11 drills: worker killed and stopped mid-run, AI service, Redis and PostgreSQL stopped and started, full restart, …
npm run isolated:down    # removes it, including its database volume
```

It is a separate Compose project (`opspilot-isolated`) with its own containers, network and volume, started from a generated `.env.isolated` with fresh secrets, `AI_PROVIDER=deterministic` and no provider key. It does not read `.env`, and nothing it does can reach the default project or its data. Run the browser tests before the drills, on a fresh stack (`isolated:down`, then `isolated:up`): they assume the seeded state. This is what the `End-to-end` workflow runs on every pull request. Results and limits: [reliability-readiness-report.md](reliability-readiness-report.md).

The API tests that simulate outages (`apps/api/tests/reliability.test.ts`, `outage.test.ts`) need nothing extra: they reach Redis and PostgreSQL through a proxy inside the test and cut that, never the server.

`opspilot_test` is created by `infra/postgres/init.sql` the first time the Postgres volume is created. If your volume predates that: `docker exec opspilot-postgres-1 psql -U opspilot -d opspilot -c 'CREATE DATABASE opspilot_test'`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| API exits with "Invalid environment configuration" | A secret in `.env` is missing or the wrong length; the message names it |
| Investigation stays "Queued" | The worker is not running |
| Investigation fails with "AI service is not reachable" | Start the AI service (`npm run dev:ai`), check `AI_SERVICE_URL` |
| Knowledge documents show "Keyword search only" | They were added while the AI service was down; Reindex all |
| All services show "No data" | No metrics in the last 15 minutes; run the simulator or send metrics |
| `prisma migrate dev` wants to drop an index | Expected; see the migration rule in CLAUDE.md |
| Signed out unexpectedly after changing a password elsewhere | Intended: a password change ends every other session |
| "Cross-origin request refused" | A browser sent a write from an origin other than `WEB_ORIGIN`; set `WEB_ORIGIN` to the address you open the app at |

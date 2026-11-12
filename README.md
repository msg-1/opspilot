# OpsPilot

An engineering operations and incident investigation platform. OpsPilot keeps your incidents, services, logs, deployments, code changes, metrics and runbooks in one place, and uses an AI agent to investigate incidents: it gathers evidence with read-only tools, ranks hypotheses with citations, and proposes remediation that only happens after a human approves it.

Everything runs on your machine. No cloud account is needed, and no data leaves it unless you configure an LLM provider.

## Quick start (Docker)

Requires Docker Desktop.

```bash
cp .env.example .env          # then replace the three secrets (see comments in the file)
docker compose --profile app up -d --build
```

Open <http://localhost:3000> and sign in with `demo@opspilot.dev` / `OpsPilot-demo-1`. The first start migrates the database and loads a demo organisation with an active incident. Other demo users (admin, engineers, viewer) are listed in [docs/setup-guide.md](docs/setup-guide.md).

Try it: open incident **INC-10**, click **Investigate with AI**, read the hypotheses and evidence, then open the proposed rollback under **Approvals** and walk it through approval as a second user.

## Developing on the host

Requires Node 20+, [uv](https://docs.astral.sh/uv/) and Docker (for Postgres and Redis).

```bash
npm install
npm run infra:up              # Postgres (pgvector) + Redis
npm run db:migrate && npm run db:seed
npm run dev                   # API :4000, worker, web :3000, AI service :8000
```

| Command | What it does |
|---|---|
| `npm test` | API integration tests (real Postgres) and web unit tests |
| `npm run test:ai` | AI service tests |
| `npm run evals` | Scores the investigation agent on ground-truth scenarios |
| `npm run test:e2e` | Playwright tests against the running, freshly seeded stack |
| `npm run obs:up` | Prometheus (:9090) and Grafana (:3001) |
| `npm run simulate` | Sends live demo metrics and logs through the ingestion API |
| `npm run mcp` | Starts the MCP server for Claude Desktop / Claude Code |

## Enabling a language model

Without credentials, investigations run on a built-in rule-based engine and say so in every report. To use a model, set one of these in `.env` and restart the AI service:

```bash
ANTHROPIC_API_KEY=...         # Claude (default model claude-opus-5-5)
OPENAI_API_KEY=...            # OpenAI
OLLAMA_MODEL=llama3.1         # a local Ollama model, if Ollama is running
```

## What is real and what is simulated

- **Real:** everything in the product path — auth, RBAC, multi-tenancy, ingestion, log analysis, alerting, RAG with pgvector, the LangGraph agent, guardrails, the approval workflow, audit trail, GitHub REST sync and signed webhooks, the MCP server.
- **Demo data:** the seeded organisation, including its "sample" repositories, is fictional and labelled as sample data in the UI.
- **Not connected to your infrastructure:** OpsPilot never changes production itself. An approved action is either sent to a webhook you configure, or carried out by an operator who confirms it in OpsPilot.
- **Not exercised here:** model-driven analysis has unit tests with scripted model responses but has not been run against a live LLM in this repository's verification; see [docs/roadmap.md](docs/roadmap.md).

## Documentation

- [Setup guide](docs/setup-guide.md) · [Architecture](docs/architecture.md) · [API](docs/api-documentation.md) · [Database](docs/database-design.md)
- [Decisions](docs/decisions.md) · [Roadmap](docs/roadmap.md) · [Backlog](docs/feature-backlog.md) · [Learning log](docs/learning-log.md)

## Branching

`main` holds tested releases only. Work happens on `feature/*` branches that merge into `develop`; `develop` is promoted to `main` once the full test suite passes and the change has been reviewed.

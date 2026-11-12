# OpsPilot

An engineering operations and incident investigation platform. OpsPilot keeps your incidents, services, logs, deployments, code changes, metrics and runbooks in one place, and uses an AI agent to investigate incidents: it gathers evidence with read-only tools, ranks hypotheses with citations, and proposes remediation that only happens after a human approves it.

Everything runs on your machine. No cloud account is needed, and no data leaves it unless you configure an LLM provider.

## Quick start (Docker)

Requires Docker Desktop.

```bash
cp .env.example .env          # then replace the three secrets (see comments in the file)
                              # Compose will not start without them
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

## Enabling Claude

Without credentials, investigations run on a built-in rule-based engine and say so in every report. To have Claude do the reasoning, add an Anthropic API key to your local `.env` and restart the AI service:

```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=            # your key; never commit or share it
ANTHROPIC_MODEL=claude-haiku-5-5
```

Step-by-step setup, costs, spending limits and troubleshooting: [docs/claude-integration.md](docs/claude-integration.md). Every investigation is labelled with the engine that produced it (Claude, rule-based, or mock).

## What is real and what is simulated

- **Real:** everything in the product path — auth, RBAC, multi-tenancy, ingestion, log analysis, alerting, RAG with pgvector, the LangGraph agent, guardrails, the approval workflow, audit trail, GitHub REST sync and signed webhooks, the MCP server.
- **Demo data:** the seeded organisation, including its "sample" repositories, is fictional and labelled as sample data in the UI.
- **Not connected to your infrastructure:** OpsPilot never changes production itself. An approved action is either sent to a webhook you configure, or carried out by an operator who confirms it in OpsPilot.
- **Not yet run live:** the Claude provider is tested against a mocked Anthropic API (requests, tool loop, errors, limits) but has not made a real API call, because no key has been configured. `docs/claude-integration.md` has the live-check steps.

## Documentation

- [Claude integration](docs/claude-integration.md) · [Setup guide](docs/setup-guide.md) · [Architecture](docs/architecture.md) · [API](docs/api-documentation.md) · [Database](docs/database-design.md)
- [Engineering audit](docs/engineering-audit.md) · [Changelog](CHANGELOG.md)
- [Decisions](docs/decisions.md) · [Roadmap](docs/roadmap.md) · [Backlog](docs/feature-backlog.md) · [Learning log](docs/learning-log.md)

## Contributing

`main` holds released code, `develop` is the integration branch, and work happens on `feature/*` and `bugfix/*` branches. Releases go through `release/*`, urgent fixes through `hotfix/*`. See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/git-workflow.md](docs/git-workflow.md) and [docs/release-process.md](docs/release-process.md).

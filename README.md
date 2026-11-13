# OPSILUME

**Engineering Intelligence Platform. Illuminate every incident.**

OPSILUME is an AI-powered engineering operations and incident investigation platform. It correlates logs, metrics, traces, deployments, GitHub changes, service dependencies and past incidents to identify probable causes, produces investigations in which every claim cites evidence, and guides engineers towards remediation that only happens after a human approves it.

What that means in practice:

- **It says when nothing is wrong.** Every investigation ends in an assessment computed from the evidence: healthy, degraded, incident, or undetermined when there is no telemetry to judge by. A cause is not manufactured to make a report look useful.
- **Hypotheses, not verdicts.** Causes are ranked with confidence and with the evidence for and against them. A human confirms a root cause.
- **Figures are checked.** Each number, timestamp, version and commit in a report is compared with the evidence it cites; anything that does not match is marked where you read it.
- **Nothing changes production without a person.** Actions are classified as read-only checks or changes by what they would do. A change needs approval that is bound to its exact content, and OPSILUME never executes one itself.

Everything runs on your machine. No cloud account is needed, and no data leaves it unless you configure an LLM provider. It is a working system for local use and evaluation; it has not been hardened or validated for production.

> **About the name.** OPSILUME is the working name of the product developed as OpsPilot. The repository, packages, API and configuration keep their `opspilot` identifiers. The name has not been cleared as a trademark. See [docs/branding/opsilume-branding.md](docs/branding/opsilume-branding.md).

## Quick start (Docker)

Requires Docker Desktop.

```bash
cp .env.example .env          # then replace the three secrets (see comments in the file)
                              # Compose will not start without them
docker compose --profile app up -d --build
```

Open <http://localhost:3000> and sign in with `demo@example.com` / `OpsPilot-demo-1`. The first start migrates the database and loads a demo organisation with an active incident. Other demo users (admin, engineers, viewer) are listed in [docs/setup-guide.md](docs/setup-guide.md).

Try it: open incident **INC-10**, click **Investigate with AI**, read the hypotheses and evidence, then open the proposed rollback under **Approvals** and walk it through approval as a second user.

## See it investigate real failures

```bash
npm run demo:up                              # OPSILUME plus three instrumented services, on the rule-based engine: no model, no cost
npm run demo:scenario -- redis-outage on     # break something
npm run demo:e2e                             # or run every scenario and check the investigations
```

The demo environment produces real logs, metrics and traces and seven reversible failures (database latency, pool exhaustion, Redis outage, error rate, bad deployment, upstream failure, healthy baseline). See [demo/README.md](demo/README.md).

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
| `npm run contracts` | Regenerate the shared contracts and the web app's API types (`contracts:check` fails if stale) |
| `npm run tracing:up`, `npm run trace -- <id>` | Trace the platform itself, locally: one trace per investigation ([docs/tracing.md](docs/tracing.md)) |
| `npm run evals` | Scores the investigation agent on ground-truth scenarios |
| `npm run test:e2e` | Playwright tests against the running, freshly seeded stack |
| `npm run obs:up` | Prometheus (:9090) and Grafana (:3001) |
| `npm run simulate` | Sends live demo metrics and logs through the ingestion API |
| `npm run mcp` | Starts the MCP server for Claude Desktop / Claude Code |
| `npm run demo:up`, `demo:scenario`, `demo:e2e`, `demo:down` | The local microservices demo: start, break and recover, validate, stop |

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
- **Not connected to your infrastructure:** OPSILUME never changes production itself. An approved action is either sent to a webhook you configure, or carried out by an operator who confirms it in OPSILUME.
- **Real telemetry, locally:** the demo environment's services produce their own logs, metrics and traces, and its failures are real (a sleeping database, a stopped Redis). It has been investigated with the rule-based engine only; no model has been run against it.
- **Verified live:** Claude (`claude-haiku-5-5`) has run a real investigation on the demo incident end to end; results are in [docs/claude-live-verification.md](docs/claude-live-verification.md). Sonnet and Opus are configured the same way but have not been exercised.

## Documentation

- [Reliability: outcomes, action effects, approvals, checked figures](docs/reliability.md) · [Demo environment](demo/README.md) · [Branding](docs/branding/opsilume-branding.md)
- [Claude integration](docs/claude-integration.md) · [Live verification](docs/claude-live-verification.md) · [Setup guide](docs/setup-guide.md) · [Architecture](docs/architecture.md) · [API](docs/api-documentation.md) · [Database](docs/database-design.md)
- [Engineering audit](docs/engineering-audit.md) · [Changelog](CHANGELOG.md)
- [Decisions](docs/decisions.md) · [Roadmap](docs/roadmap.md) · [Backlog](docs/feature-backlog.md) · [Learning log](docs/learning-log.md)

## Contributing

`main` holds released code, `develop` is the integration branch, and work happens on `feature/*` and `bugfix/*` branches. Releases go through `release/*`, urgent fixes through `hotfix/*`. See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/git-workflow.md](docs/git-workflow.md) and [docs/release-process.md](docs/release-process.md).

## Licence

MIT. See [LICENSE](LICENSE).

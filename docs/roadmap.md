# Roadmap

Status as of 12 November 2026. "Verified" means exercised by automated tests or by running the stack.

## Milestones

| # | Milestone | Status | How it was verified |
|---|---|---|---|
| M1 | Foundation and architecture | Done | Builds, lint and typecheck clean |
| M2 | PostgreSQL and incident management | Done | API integration tests |
| M3 | Services and deployment tracking | Done | API integration tests |
| M4 | Log ingestion and analysis | Done | API integration tests (redaction, patterns, anomalies, retention) |
| M5 | GitHub integration | Done | REST adapter tested against a local stub of the GitHub API; webhooks tested with real signatures. **Not run against github.com** |
| M6 | Redis, BullMQ, background jobs | Done | Ran with a real worker and Redis; tests run jobs inline |
| M7 | Auth, RBAC, multi-tenancy | Done | API integration tests (isolation, scopes, token rotation) |
| M8 | Python FastAPI AI service | Done | 23 tests; ran on host and in Docker |
| M9 | LLM integration, structured output, tool calling | Built, **not yet run against a live model** | 13 provider tests against a mocked Anthropic API covering requests, tool loop, caching, usage, errors and limits. Live check waits for an API key |
| M10 | RAG, embeddings, pgvector | Done | Tests against real pgvector; ran with local embeddings |
| M11 | LangGraph investigation agent | Done | Evals 5/5 (rule-based engine); end-to-end through queue and worker |
| M12 | MCP server | Done | Tool listing and a tool call tested in-process. **Not connected to a real MCP client** |
| M13 | Remediation and approvals | Done | API tests and browser test of the full approval flow |
| M14 | Monitoring, collaboration, analytics | Done | API tests; Prometheus and Grafana verified running |
| M15 | Testing, security, performance | Partly | 70 automated tests. No load testing or dependency audit yet |
| M16 | Docker, CI/CD, documentation | Done | Full stack built and run in Docker. **CI workflow has not run** (no remote repository yet) |

## Test inventory

| Suite | Count | Scope |
|---|---|---|
| API integration (Vitest + Supertest) | 48 | HTTP → PostgreSQL, all modules |
| AI service (pytest, mocked model APIs) | 39 | Agent graph, guardrails, providers, embeddings, HTTP API, MCP |
| Web (Vitest + Testing Library) | 11 | API client, formatting, accessible components |
| End-to-end (Playwright) | 9 | Sign-in, incident, investigation, approval, RBAC, logs, knowledge, audit, mobile layout |
| Agent evaluations | 5 scenarios | Correct cause, calibration, grounding, safe action, no false blame |

## Needs the owner's input

1. **An Anthropic API key in the local `.env`** (steps in claude-integration.md), to run the live check, a real investigation, and the evaluations against the model.
2. **A GitHub token**, to verify the integration against real repositories.
3. **A decision on a remote repository** (GitHub, private?) so branches can be pushed and CI can run.
4. **Promotion of `develop` to `main`** once you have reviewed the result.

## Next

1. Run the evals against a real model; tune prompts and the effort setting from the results; add scenarios (config change, traffic spike, memory leak, two simultaneous causes).
2. Run CI on a remote; add the end-to-end suite to CI with Compose.
3. Live updates over server-sent events instead of polling.
4. Load test ingestion and log search; partition `LogEntry` by time.
5. Email or chat delivery for notifications and invitations.
6. `npm audit` / `pip-audit` review and a dependency update policy.

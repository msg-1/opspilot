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
| M9 | LLM integration, structured output, tool calling | Done | Verified against the live Anthropic API with `claude-haiku-5-5` (claude-live-verification.md), plus 14 provider tests against a mocked API |
| M10 | RAG, embeddings, pgvector | Done | Tests against real pgvector; ran with local embeddings |
| M11 | LangGraph investigation agent | Done | Evals 5/5 (rule-based engine); end-to-end through queue and worker |
| M12 | MCP server | Done | Tool listing and a tool call tested in-process. **Not connected to a real MCP client** |
| M13 | Remediation and approvals | Done | API tests and browser test of the full approval flow |
| M14 | Monitoring, collaboration, analytics | Done | API tests; Prometheus and Grafana verified running |
| M15 | Testing, security, performance | Partly | 70 automated tests. No load testing or dependency audit yet |
| M16 | Docker, CI/CD, documentation | Done | Full stack built and run in Docker. CI runs on every pull request on GitHub and passes on `develop`; the browser suite has passed on `release/0.1.0` |

## Test inventory

| Suite | Count | Scope |
|---|---|---|
| API integration (Vitest + Supertest) | 68 | HTTP → PostgreSQL, all modules |
| AI service (pytest, mocked model APIs) | 110 | Agent graph, guardrails, providers, embeddings, HTTP API, MCP |
| Web (Vitest + Testing Library) | 14 | API client, formatting, accessible components |
| End-to-end (Playwright) | 9 | Sign-in, incident, investigation, approval, RBAC, logs, knowledge, audit, mobile layout |
| Agent evaluations | 11 scenarios | Outcome, cause, service, citations, invention, contradictory and missing evidence, calibration, diagnostics, remediation safety, deployment-tool use |
| Local demo, end to end | 10 scenarios | Real telemetry and failures, rule-based engine: outcomes, blame, proposals, evidence provenance, recovery, runbook safety (run locally, not in CI) |

## Milestone 4: reliability and real-system validation

Done: outcome assessment (healthy, degraded, incident, undetermined), action effects and runbook plans, approvals bound to content, unknown execution outcomes, checked figures, trace retrieval, the local demo environment with seven failure scenarios, and the OPSILUME working name. See [reliability.md](reliability.md) and [demo/README.md](../demo/README.md).

Not done, and why:

- **No model was run in this milestone** (no budget). The changed report instructions and schema, the new `get_traces` tool and the demo environment are untested with a language model.
- **The name is not cleared.** Trademark and domain checks are listed in [branding/opsilume-branding.md](branding/opsilume-branding.md).
- **The demo is not in CI.** It needs the whole stack and about 25 minutes; it was run locally.

## Needs the owner's input

1. ~~An Anthropic API key~~ — configured; live verification done.
2. **A GitHub token**, to verify the integration against real repositories.
3. ~~A decision on a remote repository~~ — published at https://github.com/msg-1/opspilot (public); `main` and `develop` are protected.
4. ~~A licence~~ — MIT (`LICENSE`).
5. **Promotion of `develop` to `main`** (release 0.1.0) once you have reviewed the result.
6. **A budget for a live model run** of the eleven evaluation scenarios and of the demo environment, if you want the Milestone 4 changes validated with a model.
7. **Clearance of the OPSILUME name** (trademark, domains) before it is used beyond a working name.

## Next

1. ~~Re-run the evaluation against a real model~~ — done with six scenarios and structured scoring (docs/claude-live-verification.md). Open from it: the healthy-service scenario reports 0.30 confidence against a bound of 0.25; `run_runbook` is treated as read-only although a runbook can change production. Next: more scenarios (config change, traffic spike, memory leak, two simultaneous causes), repeated runs to measure variance, and `ANTHROPIC_EFFORT=low` against `medium`. Each needs an approved budget.
2. ~~Run CI on a remote; add the end-to-end suite to CI with Compose~~ — done.
3. Live updates over server-sent events instead of polling.
4. Load test ingestion and log search; partition `LogEntry` by time.
5. Email or chat delivery for notifications and invitations.
6. `npm audit` / `pip-audit` review and a dependency update policy.

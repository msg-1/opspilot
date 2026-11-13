# Roadmap

Status as of 13 November 2026. "Verified" means exercised by automated tests or by running the stack.

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
| API integration (Vitest + Supertest) | 120 | HTTP → PostgreSQL, all modules; shared contracts; real API responses against the response contracts; trace continuity through BullMQ; failure handling (AI service, Redis and PostgreSQL outages, a killed worker, duplicate delivery, failing trace export) |
| AI service (pytest, mocked model APIs) | 171 | Agent graph, guardrails, providers, embeddings, HTTP API, MCP; each rule of the rule-based engine; a snapshot of all its reports; shared contracts; tracing |
| Web (Vitest + Testing Library) | 47 | API client, formatting, accessible components; the seven journeys as rendered pages (sign-in, incident, starting an investigation, report, evidence, approval, execution outcomes) |
| End-to-end (Playwright), in CI on every pull request | 11 | Sign-in, incident, investigation, approval, RBAC, logs, knowledge, audit, mobile layout; what the page shows while the AI service or the queue is down, and after it returns |
| Failure drills (`npm run drills`), in CI on every pull request | 11 | Real containers killed, stopped and started on a throwaway stack: what was recorded, and that an investigation completes afterwards |
| Agent evaluations | 11 scenarios | Outcome, cause, service, citations, invention, contradictory and missing evidence, calibration, diagnostics, remediation safety, deployment-tool use |
| Local demo, end to end | 10 scenarios | Real telemetry and failures, rule-based engine: outcomes, blame, proposals, evidence provenance, recovery, runbook safety (run locally, not in CI) |

## Milestone 4: reliability and real-system validation

Done: outcome assessment (healthy, degraded, incident, undetermined), action effects and runbook plans, approvals bound to content, unknown execution outcomes, checked figures, trace retrieval, the local demo environment with seven failure scenarios, and the OPSILUME working name. See [reliability.md](reliability.md) and [demo/README.md](../demo/README.md).

Not done, and why:

- **No model was run in this milestone** (no budget). The changed report instructions and schema, the new `get_traces` tool and the demo environment are untested with a language model.
- **The name is not cleared.** Trademark and domain checks are listed in [branding/opsilume-branding.md](branding/opsilume-branding.md).
- **The demo is not in CI.** It needs the whole stack and about 25 minutes; it was run locally, and the recorded run is in [demo/README.md](../demo/README.md). CI checks only that it builds.

## Milestone 5: architecture hardening

No change to the runtime architecture, the API or any safety boundary. What changed is how the code is divided and how its parts are kept in agreement.

| Area | Before | After |
|---|---|---|
| Contracts between Python and TypeScript | Each side declared its own enums, guardrail limits and effect rules; one fixture tied the reports together | One definition under `contracts/`, generated into both languages; the report, the tools and the guardrail behaviour are checked on both sides; CI fails on drift |
| `investigations.ts` (one file) | Routes, validation, limits, orchestration, stream handling, guardrails and persistence together | `modules/investigations/`, one file each |
| `remediation.ts` (one file) | Proposals, hashing, effect, approvals, execution, recording and routes together | `modules/remediation/`, one file each |
| Rule-based engine | One 313-line `analyse()` | `rules.py`: one function per rule, each tested alone; a snapshot of all sixteen reports |
| Web API types | Written by hand, drifted | Generated from the API's response contracts; real responses tested against them; CI fails on drift |
| Tracing | A switch that stopped at the queue, the streamed response and the tool calls | One trace per investigation across every hop; spans scrubbed; local store and `npm run trace` |
| Web tests | 14 unit tests | 47, including the seven journeys as rendered pages |

What it found along the way: the API accepted any string as a claim kind; the investigation list never returned `attemptedProvider`, so a rule-based fallback was not labelled there; the incident page read fields its type did not have; the sign-in page named a demo password the seed does not set. All four are fixed.

Not done, on purpose: the other API modules are not split; Prisma queries are not traced; the browser does not start traces; page-local response types outside the generated contracts (dashboard, settings, monitoring, analytics, knowledge, changes) are still written by hand.

## Milestone 6: reliability

No new feature and no new lifecycle state. The question was what happens to an investigation, and to the application, when something around it fails, and whether that is tested by more than a status code. The full account, with what was not tested, is in [reliability-readiness-report.md](reliability-readiness-report.md).

Done: the remediation risk defect found while preparing the demo (an edit without a risk reset a high-risk action to medium); an investigation runs at most once and reaches exactly one end; interrupted runs are recorded within about a minute instead of twenty; the worker shuts down within a grace period and says what it left unfinished; honest, non-leaking failure messages; readiness on the worker and in the Compose health checks; a throwaway stack; 30 API tests, 2 browser tests and 11 drills; accepted work that survives Redis being killed or wiped; the browser suite and the drills in CI on every pull request.

Not done, and why:

- **Not a claim of production readiness.** One worker, one Redis and one PostgreSQL on one machine were tested. Nothing here says how the system behaves with several workers, under load, or across a network partition.
- **A run interrupted by a crash is not resumed.** It is recorded as failed and has to be started again by a person. Resuming would need the run's progress to be stored and the AI service to continue from it.
- **No model was run.** Every test and drill used the rule-based engine or a scripted stand-in. Timeouts and interrupted streams with a real provider are tested only against mocks.
- **`e2e.yml` is not a required check.** Making it one is a branch-protection change, which is the owner's to make.

## Needs the owner's input

1. ~~An Anthropic API key~~ — configured; live verification done.
2. **A GitHub token**, to verify the integration against real repositories.
3. ~~A decision on a remote repository~~ — published at https://github.com/msg-1/opspilot (public); `main` and `develop` are protected.
4. ~~A licence~~ — MIT (`LICENSE`).
5. **Promotion of `develop` to `main`** (release 0.1.0) once you have reviewed the result.
6. **A budget for a live model run** of the eleven evaluation scenarios and of the demo environment, if you want the Milestone 4 changes validated with a model.
7. **Clearance of the OPSILUME name** (trademark, domains) before it is used beyond a working name.
8. **Whether `End-to-end` becomes a required check** for `develop` and `main`. It takes about ten minutes per pull request.

## Next

1. ~~Re-run the evaluation against a real model~~ — done with six scenarios and structured scoring (docs/claude-live-verification.md). Open from it: the healthy-service scenario reports 0.30 confidence against a bound of 0.25; `run_runbook` is treated as read-only although a runbook can change production. Next: more scenarios (config change, traffic spike, memory leak, two simultaneous causes), repeated runs to measure variance, and `ANTHROPIC_EFFORT=low` against `medium`. Each needs an approved budget.
2. ~~Run CI on a remote; add the end-to-end suite to CI with Compose~~ — done; since Milestone 6 it runs on every pull request, with the failure drills.
3. Live updates over server-sent events instead of polling.
4. Load test ingestion and log search; partition `LogEntry` by time.
5. Email or chat delivery for notifications and invitations.
6. `npm audit` / `pip-audit` review and a dependency update policy.

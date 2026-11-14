# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- Integrations page and `GET /integrations`: every source that can be connected (logs, metrics, deployments, service events, GitHub, the remediation webhook, and the installation's trace store and analysis engine), what each provides and needs, and whether it works. Status follows accepted data, recorded rejections and explicit checks, not saved credentials: not set up, set up, connected, receiving data, needs attention, not working.
- Ingestion visibility: the last time each source delivered, how much arrived in 24 hours, how many services are covered, and the last rejection in words that name the field and never the content. Metrics dropped for an unregistered service are no longer silent.
- Getting-started list for a new organisation (register services, set up a source, send a request, confirm data, check it belongs to services, run an investigation), each step ticked from what was received.
- Connection checks on request: `POST /integrations/github/check` and `POST /integrations/remediation-webhook/check` (a signed `ping` with no action).
- Data that names an unregistered service is listed, and stored log lines can be given to a service afterwards (`POST /integrations/unresolved-services/link`).
- Failure handling for investigations: a run is started by a conditional update and named in the queue after its investigation, so it runs at most once; a run whose worker was killed is recorded as interrupted when the queue hands the job out again (about a minute), and a worker asked to stop records its unfinished runs as interrupted before it exits. Settings `INVESTIGATION_TIMEOUT_MS`, `WORKER_SHUTDOWN_GRACE_MS`, `QUEUE_LOCK_MS`, `QUEUE_STALLED_INTERVAL_MS`.
- Accepted work survives a loss of Redis data: Redis writes an append-only file to a volume; the sweep puts back the job of an investigation that has waited more than two minutes; the worker restores the schedules of its repeating jobs when they are missing.
- `/ready` on the worker (PostgreSQL and Redis). The Compose health checks of the API and the worker use readiness instead of liveness.
- A throwaway copy of the stack for tests that break things: `npm run isolated:up`, `isolated:e2e`, `drills`, `isolated:down`. Its own Compose project, ports, volume and generated secrets; rule-based engine, no provider key. Published ports are configurable (`HOST_PORT_*`).
- Failure drills (`npm run drills`): worker killed and stopped in the middle of a run, AI service, Redis and PostgreSQL stopped and started, Redis killed and wiped while a job is waiting, a full restart, tracing switched on with no trace store, and a search of every service log for credentials. Each checks what was recorded and that an investigation completes afterwards.
- Reliability tests on the API (28 new, beside the 3 for the risk fix): the real AI client against a scripted HTTP stub (unreachable, error, never answering, stalling, cut stream, invalid events, missing or malformed report, repeated events), Redis and PostgreSQL cut through a proxy, a real worker process killed and restarted, duplicate delivery, cancellation, failing trace exporters.
- Browser tests in CI on every pull request (`e2e.yml`), on the throwaway stack, with two new tests of what the page shows while the AI service or the queue is down and after it returns. Screenshots, Playwright traces and service logs are uploaded on failure.
- docs/reliability-readiness-report.md.
- A temporary dataset for manual testing (`npm run demo:seed`, `demo:status`, `demo:reset`): a dedicated organisation, Acme Commerce, with six services, eight incidents and their telemetry, removable without touching any other data. Local databases only. See docs/manual-demo-testing.md.
- Shared contracts (`contracts/`): one definition of the closed value sets, guardrail limits, action-effect rules, the investigation report, the agent tools and the API responses the web app uses. `npm run contracts` generates the TypeScript and Python representations; `npm run contracts:check` and CI fail when one is stale.
- Web API types generated from the API's response contracts (`apps/api/src/contracts/api.ts`), with a test that validates real API responses against them.
- Distributed tracing of the platform itself: one trace per investigation across the API, the queue, the worker, the AI service and every tool call. Compose profile `tracing`, `npm run tracing:up`, `npm run trace -- <investigation id>`. Off by default; spans are scrubbed of credentials and personal data in both services. See docs/tracing.md.
- Page-level web tests for signing in, incident details, starting an investigation, reading a report, reviewing evidence, approving a remediation and viewing execution outcomes.
- Independent tests for each rule of the rule-based engine, and a snapshot of every report it produces.
- Product name: OPSILUME (working name, not yet cleared) in the interface, the labels the API shows to people, the README and new documentation. Identifiers are unchanged. See docs/branding/opsilume-branding.md.
- Outcome assessment on every investigation: `HEALTHY`, `DEGRADED`, `INCIDENT` or `UNDETERMINED`, computed from the evidence for every engine, with its signals, the evidence it rests on, what was not examined, and its own confidence. Steady metrics and a healthy status are evidence items. Observations that are not evidence of a fault are reported separately.
- Action effects: every recommended action and remediation is `read_only` or `state_changing`, decided from its type and text and from the steps of the runbook it points at. `GET /knowledge/documents/:id/plan` returns a runbook as a labelled plan.
- Approval binding: approvals are given for a hash of the action's content; `PATCH /remediations/:id` supersedes them; execution counts only approvals given for the current content.
- Execution outcomes `applied`, `not_applied` and `unknown`; a retry after an unknown outcome needs a person's confirmation; every attempt carries the same idempotency key.
- Checked figures: every number, timestamp, version, commit, pull request number and incident key in a report is compared with the evidence its statement cites. Facts carry their verification; the report carries a tally; the interface marks unsupported figures.
- Trace retrieval: `GET /tools/traces` and the agent tool `get_traces`, reading a Jaeger-compatible trace store (`TRACES_URL`).
- Rule-based engine: follows a chain of unhealthy dependencies to where it starts; locates lost time and failures from traces.
- Demo environment (`demo/`, Compose profile `demo`): three instrumented services with PostgreSQL, Redis, Prometheus and Jaeger, seven reversible failure scenarios, and an end-to-end runner that checks outcomes and evidence provenance. `npm run demo:up`, `demo:scenario`, `demo:e2e`, `demo:down`.
- Five evaluation scenarios (three healthy, one misleading, one degraded) and the outcome criterion; `--rescore` covers the new checks.
- MIT licence.
- Evaluation: structured expected causes instead of keyword matching; ten separately scored criteria with explanations; a deployment rollback-target scenario; `--estimate`, `--only` and `--rescore`; a spending ceiling that reserves one worst-case call.
- Guardrails (AI service and API): a production change resting on a hypothesis rated unlikely becomes a manual action; a high-risk action moves to the next steps when a lower-risk one is proposed.
- Queue reliability tests on real BullMQ and Redis with the AI service mocked: queued work waits for a worker, runs once, survives a worker restart; indexing retries with backoff and stops after the configured attempts. `QUEUE_PREFIX` and `QUEUE_BACKOFF_MS` settings.
- Deployment intelligence: `GET /api/v1/tools/deployment-context` and the agent tool `get_deployment_context` report, for a service's deployment, the last successful version it replaced (the rollback target, however old), the commits and pull requests it shipped, the error rate before and after it, incidents opened after it, and whether it has already been rolled back.
- Claude provider: configurable model (default `claude-haiku-5-5`), prompt caching, bounded retries, timeouts, clear handling of rejected keys, exhausted credit, unknown models and rate limits.
- Spending controls: per-investigation cost and token limits, per-organisation concurrency, daily count and daily cost limits.
- Usage recorded per investigation: model, calls, tokens, cache use, latency, estimated cost; shown in the interface and in analytics.
- Engine label on every investigation: real model, mock or rule-based.
- Evidence against each hypothesis in reports.
- Mock provider (`AI_PROVIDER=mock`), free key-and-model check, live-check command.
- Web error boundary and not-found page; `SEED_DEMO_DATA` switch.

### Changed
- Internal structure only, no change in behaviour: `investigations.ts` and `remediation.ts` are directories split by responsibility; the rule-based engine's `analyse()` is one function per rule (`services/ai/app/rules.py`).
- `GET /investigations` also returns `attemptedProvider`, so a rule-based fallback is labelled in the list as it is on the detail page.
- A claim's `kind` in a report must be one of the defined kinds (the API previously accepted any string).
- An action the evidence does not stand behind is withdrawn from the proposals and listed under next steps with the reason, instead of being relabelled as a manual action. This applies to production changes without an incident, changes resting on a hypothesis rated unlikely, and rollbacks whose target is not an earlier successful deployment in the evidence.
- `run_runbook` and `manual` are no longer treated as read-only: they are judged by what they say. A state-changing action is at least medium risk and needs at least one approval whatever the organisation's settings.
- An incident needs a strong signal and a leading hypothesis that cites something which can be a cause, not only the symptoms.
- Metric signals have absolute floors as well as relative ones; a metric rising from zero counts as a change; a service that sent no telemetry is `UNDETERMINED`, not healthy.
- With no fault in evidence, the report's hypothesis confidence is 0 when there is no hypothesis (previously 0.1).

### Security
- Zod 4.6.7; patched `deepmerge-ts` and `postcss`: no high or critical advisories remain.
- Access tokens are revoked with their session; cookie-authenticated writes require the web origin; the agent's token works only while its investigation runs.
- Remediation risk has a floor by action type and service tier.
- Failed sign-ins are audited; retrieved records are marked as untrusted data for the model.

### Fixed
- Old incidents were judged with today's health: investigating a closed incident named whatever dependency happened to be down at the time of the investigation. For a window that is over, the health of a service and of its dependencies is now worked out from the alerts, incidents and metrics recorded in that window; evidence says whether it describes then or now; a dependency whose state at the time is not on record produces no hypothesis, is listed as not examined and lowers the confidence.
- A report that arrived for an investigation that was no longer running (cancelled, failed, timed out) still created hypotheses and proposed remediation actions, and a repeated final event proposed the actions a second time. Everything that follows from a report now happens only if that report was stored.
- A stream from the AI service that was cut in the middle of an event, or that carried an invalid line, was recorded as a JSON syntax error quoting the text received. Timeout, interrupted connection and invalid event now have their own messages, and none repeats the input.
- A database error during an investigation was stored on the investigation, and shown, with the database host and port in it.
- A failure after the report was stored (writing the timeline entry or a notification) added a "failed" step and notification to a completed investigation.
- Right after a PostgreSQL outage a newly accepted investigation could stay `QUEUED` for good: the worker's first query for it failed while its connections were recovering. The worker now retries, and a job that fails before its investigation started is put back by the sweep.
- The worker waited without limit for running jobs on shutdown and was killed by Docker after 10 seconds, leaving the investigation `RUNNING` for 20 minutes.
- On the incident page, a refused investigation (queue unreachable, limit reached) showed its reason behind the open dialog. It is shown in the dialog.
- Editing a remediation action without naming a risk no longer resets it to medium. A high-risk action keeps its risk and its two approvals; an explicit change of risk is validated, held to the floor for what the action does, recorded in the audit log, and supersedes the approvals given. Approvals are counted against the risk's requirement again when one is given and at execution, whatever number the row holds; with too few, nothing runs and the action waits for the rest.
- The sign-in page showed a demo password the seed does not set.
- After a bad release was rolled back, the rule-based engine could blame the rollback deployment for an unrelated problem and propose returning to the bad release. Deployments can now be recorded as rollbacks (`rollbackOf`), a rolled-back version is never a rollback target, and a deployment after which errors fell loses standing as a suspect.
- Trace retrieval sampled only the end of the window.
- A webhook timeout or server error was recorded as a plain failure and could be retried at once, which could apply a change twice.
- A healthy service was reported as degraded when a near-zero gauge fell by a large percentage, and an uninstrumented service was reported as healthy because its empty log contained no errors. Both were found by running against real telemetry.
- Deployment and commit evidence show the same 12-character commit prefix (a model reported the two lengths as a discrepancy).
- Evaluation harness: scenarios run as of their own clock, actions are scored for safety rather than exact type, and every run saves complete reports for review.
- The report schema sent to Claude is flat, so the provider accepts it (found in live testing); a schema a provider refuses to compile is retried as plain JSON.
- The browser test suite skips itself when a paid model is active, so it can never spend credit.
- Database outages return 503 with Retry-After instead of 500.
- AI service logs are valid JSON.

### Changed
- `AI_PROVIDER` replaces `LLM_PROVIDER` (still read).
- Commit history rewritten once to remove attribution trailers; content unchanged.

## [0.1.0] - not yet released

First release candidate. Prepared on `release/0.1.0`; awaiting approval to merge into `main`.

### Added
- Incident management with timeline, comments, mentions and postmortem drafts.
- Service catalogue with dependencies, deployment tracking and service events.
- Log ingestion with secret redaction, search, pattern grouping and anomaly detection.
- Metrics, alert rules, automatic incidents and computed service health.
- GitHub integration: REST sync, signed webhooks, labelled sample repositories.
- AI investigations: LangGraph agent with read-only tools, citable evidence, ranked hypotheses and guardrails; Claude, OpenAI and Ollama providers and a rule-based engine for use without a model.
- Knowledge base with pgvector and hybrid search.
- Remediation proposals with risk-based human approval and audited execution.
- Roles, multi-tenancy, API keys, audit log, analytics, notifications.
- MCP server, Docker Compose deployment, Prometheus and Grafana, CI workflows.

### Security
- All published ports bound to loopback; required secrets with no fallbacks; placeholder secrets rejected in production.
- Per-account sign-in throttling; proxy headers trusted only when configured.
- Remediation webhooks restricted to public http(s) addresses; responses not stored.
- Link fields limited to http and https; CSV exports neutralise formulas.
- OpenTelemetry and Vitest upgraded to patched releases.

### Fixed
- API no longer hangs when Redis is unavailable; readiness reports it.
- Work interrupted by a worker restart is failed or re-queued instead of being left in progress.
- Containers restart after a crash; worker metrics are scraped.
- Invalid filter values return 400 instead of 500.
- A model can now attach parameters to a proposed remediation.

### Known limitations
- Model-driven analysis has not been run against a live LLM.
- Five high-severity dependency advisories need major upgrades (Zod, Prisma, Next).
- See `docs/engineering-audit.md` for the open Medium and Low findings.

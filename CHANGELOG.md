# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
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

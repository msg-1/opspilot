# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- Claude provider: configurable model (default `claude-haiku-5-5`), prompt caching, bounded retries, timeouts, clear handling of rejected keys, exhausted credit, unknown models and rate limits.
- Spending controls: per-investigation cost and token limits, per-organisation concurrency, daily count and daily cost limits.
- Usage recorded per investigation: model, calls, tokens, cache use, latency, estimated cost; shown in the interface and in analytics.
- Engine label on every investigation: real model, mock or rule-based.
- Evidence against each hypothesis in reports.
- Mock provider (`AI_PROVIDER=mock`), free key-and-model check, live-check command.
- Web error boundary and not-found page; `SEED_DEMO_DATA` switch.

### Security
- Zod 4.6.7; patched `deepmerge-ts` and `postcss`: no high or critical advisories remain.
- Access tokens are revoked with their session; cookie-authenticated writes require the web origin; the agent's token works only while its investigation runs.
- Remediation risk has a floor by action type and service tier.
- Failed sign-ins are audited; retrieved records are marked as untrusted data for the model.

### Fixed
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

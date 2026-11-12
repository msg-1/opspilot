# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

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

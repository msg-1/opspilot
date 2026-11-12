# Feature backlog

Not built yet, grouped by module. Items are ordered by expected value within each group.

**Incident management** — status page updates for customers; incident templates per severity; merge duplicate incidents; SLA timers with escalation; edit and delete comments.

**Services** — visual dependency map (the graph endpoint exists; the UI shows lists); service scorecards (runbook present, owner set, alert coverage); import the catalogue from a YAML file or Backstage.

**Logs** — saved searches; live tail; structured attribute filters (`status>=500`); OpenTelemetry log ingestion (OTLP); export.

**Deployments** — deployment detail page (the API returns linked commits, pull requests and following incidents); diff between two versions; DORA lead time from commit timestamps.

**GitHub** — GitHub App installation instead of a personal token; deployment and check-run webhooks; fetch the diff of an implicated commit as an agent tool; GitLab and Bitbucket adapters.

**AI investigations** — follow-up questions on a finished investigation; streaming of model reasoning; compare two investigations; scheduled investigations when an alert opens an incident; per-organisation token budgets; human feedback on hypotheses feeding the evals; Anthropic server-side refusal fallback.

**Knowledge base** — file upload (PDF, DOCX); sync from Confluence, Notion or a Git repository; show which investigations cited a document; stale-document reminders.

**Remediation** — typed parameter forms per action type; first-party executors (Kubernetes rollout undo, feature-flag providers) behind the same approval gate; scheduled execution windows; automatic verification after execution using alert rules.

**Monitoring** — Prometheus remote-write ingestion; anomaly-based alerts in addition to thresholds; alert silencing and maintenance windows; SLOs and error budgets.

**Collaboration** — Slack and Teams notifications and incident channels; on-call schedules and paging; email delivery for invitations.

**Security and governance** — single sign-on (OIDC, SAML); two-factor authentication; per-team access to services; audit log export to a SIEM; data residency controls for LLM providers; API key expiry.

**Analytics** — scheduled reports by email; per-team views; cost of incidents; investigation accuracy from confirmed root causes.

**Platform** — server-sent events for live updates; dark theme; Helm chart; database backup and restore commands; internationalisation.

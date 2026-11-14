# Pilot readiness: gap analysis

Milestone 7, 14 November 2026. Written before implementation, from the repository at `644ad1d`. It asks one question: what stands between this codebase and an external engineering team being able to connect its systems, investigate an incident and judge the result? What was done about each gap is in the roadmap and in [customer-pilot-guide.md](customer-pilot-guide.md).

## What exists

| Area | State at `644ad1d` |
|---|---|
| Data in | Four push endpoints authenticated by scoped API keys: logs, metrics, deployments, service events. GitHub commits and pull requests by token or unauthenticated, by sync and by signed webhook. A Jaeger-compatible trace store, read at investigation time, set per installation |
| Data out | One outbound remediation webhook per organisation (HMAC-signed, guarded against private addresses). An MCP server for AI clients |
| Engines | Rule-based (no model, no cost) and model providers selected per installation |
| Safety | Evidence-only reports, two guardrail passes, approvals bound to content, human approval for every production change |
| Reliability | Failure handling tested by API tests, browser tests and container drills on every pull request |

## Gaps

### 1. Nothing tells a new organisation how to connect anything

- The integrations are real but scattered: a GitHub tab and an API-keys tab in Settings, a webhook field in organisation settings, ingestion endpoints only in the API documentation.
- No page lists what can be connected, what each source provides, or what it needs.
- **Saved is treated as working.** A GitHub token is validated once, when saved. An API key shows "last used" and nothing else. Nothing says whether data arrived, when, or whether it was usable.
- Ingestion failures leave no trace an operator can see: a rejected payload is an HTTP response to a script nobody is watching.
- Data that names a service OPSILUME does not know is accepted (logs) or dropped (metrics) without anyone being told. Logs keep the name; nothing surfaces it or lets it be linked afterwards.
- A new organisation lands on an empty dashboard with five unrelated empty states.

### 2. Old incidents are judged with today's health

Recorded in the manual-testing notes and confirmed in code: the engine reads the *current* health of a service's dependencies, whatever the investigation's time window. Investigating a closed incident today blames whatever happens to be down today. There is no record of what health was at an earlier time.

### 3. The report is written for the people who built it

The investigation page shows the right content but in the engine's terms (agent steps, evidence refs, analysis mode) and order. There is no single view an engineer could hand to a colleague, and no way to print or save one.

### 4. Nothing explains a pilot end to end

Setup, API and architecture documents exist. None of them walks an outside team from an empty organisation to a first investigation, states what is and is not supported, or says how to remove a trial organisation.

### 5. The new surface needs its own security review

Onboarding adds validation calls to outside systems, status that crosses tenants if written carelessly, and error text shown to users. Each is a familiar way to leak a credential or reach an internal address.

## Delivery process findings

- **End-to-end is not a required check on `develop`.** Required there: Frontend, Backend, Database integration tests, AI service, Build verification. Steps for the owner are in [git-workflow.md](git-workflow.md).
- **`main` requires a check that no longer reports.** Its protection lists "Browser end-to-end tests". Milestone 6 renamed that job, so a pull request into `main` would have waited for it for ever. The job's name is restored in this milestone; protection settings are not changed.
- `docs/manual-test-walkthrough.md` was never committed. It is kept and committed with the pilot documentation.

## Not gaps for a pilot, and deliberately left alone

Billing, single sign-on, a marketplace of connectors, pull-based collectors for specific vendors, Kubernetes manifests, multi-region. A pilot needs a small number of real sources that visibly work, not a long list.

## Blockers this milestone cannot remove

- No model has been run since Milestone 3; everything here is verified on the rule-based engine.
- The GitHub integration has never been run against github.com with a real token (only against a local stub of its API).
- One machine, one worker, no load testing, no backup and restore.
- The product name is not cleared.

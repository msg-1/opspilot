# Reliability readiness report

Milestone 6, 13 November 2026. What happens to OPSILUME when a service it depends on fails, restarts, times out or is handed the same work twice; what was done about it; and what is still not known.

**This is not a statement that OPSILUME is ready for production.** It was tested as one worker, one Redis and one PostgreSQL on one machine, with the rule-based engine. Section 7 lists what that leaves open.

## How to read the results

A scenario counts as tested only if a test made the failure happen and then checked the stored record. Recovery counts as verified only if, after the failure was removed, an investigation ran to a stored report with evidence, without restarting anything that had not failed and without touching the database by hand. An HTTP 200 or a "healthy" container is not treated as proof of either.

Three kinds of test were used:

| Kind | Where | What is real | How a failure is produced |
|---|---|---|---|
| API tests | `apps/api/tests/reliability.test.ts`, `outage.test.ts`, `tracing-failure.test.ts` | PostgreSQL, Redis, BullMQ, the AI client's HTTP and stream handling, and for crashes the worker as its own process | Redis and PostgreSQL are reached through a TCP proxy inside the test that is switched off; the AI service is a scripted HTTP server; the worker process is sent SIGKILL or SIGTERM |
| Failure drills | `scripts/reliability-drills.mjs` (`npm run drills`) | The whole application as built by Docker Compose, with the real AI service on the rule-based engine | Containers are killed, stopped, paused and started |
| Browser tests | `apps/web/e2e/` | The rendered application in Chromium, against the same stack | Containers are stopped and started |

Nothing was run against the application's working database. The drills and browser tests use a second Compose project, `opspilot-isolated`, with its own containers, network, volume, ports and generated secrets (`scripts/isolated-stack.mjs`). The API tests use the `opspilot_test` database as before and never stop a server. No model was called anywhere: the isolated stack is started with `AI_PROVIDER=deterministic` and empty provider keys, and it does not read `.env`.

## 1. Components tested

| Component | Tested for |
|---|---|
| API (`apps/api`, HTTP process) | Behaviour with Redis down, with PostgreSQL down, with the AI service down; readiness; error responses that leak nothing |
| Worker (`apps/api`, worker process) | Killed mid-run, stopped mid-run, started without Redis, Redis lost mid-run, duplicate and repeated deliveries, readiness |
| Queue (BullMQ on Redis) | A job waiting for a worker, a job whose worker died, the same job enqueued twice, retry policy, a job waiting while Redis is killed, a job and the schedules lost with Redis's data |
| Investigation runner and stream consumer | Every way the AI service's answer can be wrong or absent; time limit; cancellation; exactly one terminal state; no report or proposed action without a stored report |
| AI service (`services/ai`) | Stopped and started; its data source unreachable; its trace store unreachable |
| Tracing (both services) | Exporter that throws, trace store that is not there, spans of failed work, scrubbing on the failure path |
| Docker Compose setup | Start from nothing, health checks, stop and start, migration and seeding repeated |
| Web application | What a person sees during an AI service outage and a queue outage, and afterwards |

Not tested: GitHub synchronisation, knowledge indexing beyond the retry tests that already existed, the alert evaluation job, the MCP server, and remediation webhooks beyond the tests that already existed (timeout, 5xx, refusal, unknown outcome, interrupted execution).

## 2. Failure scenarios exercised, and what was recorded

"API test" names a test in `apps/api/tests`; "drill" a drill in `scripts/reliability-drills.mjs`; "browser" a test in `apps/web/e2e/recovery.spec.ts`.

### AI service

| Scenario | Result recorded | Verified by |
|---|---|---|
| Not reachable | `FAILED`, "AI service is not reachable"; no report, summary, outcome, hypothesis or proposed action; one failure notification; the status endpoint says unreachable | API test, drill `ai-down`, browser |
| Answers HTTP 500 | `FAILED`, "AI service returned 500"; called once, not retried | API test |
| Accepts the request and never answers | `FAILED` at the time limit, "did not finish within …"; the request is closed from the worker's side | API test (limit set to 500 ms) |
| Starts streaming, then stalls | Same; the evidence received before the stall is kept, nothing is concluded from it | API test |
| Connection broken in the middle of an event | `FAILED`, "connection … was interrupted before the investigation finished"; earlier evidence kept | API test (both an abrupt and an orderly close) |
| Sends a line that is not an event | `FAILED`, "not a valid event"; the text received appears nowhere in the record; a report sent after the bad line is not used | API test |
| Ends the stream without a report | `FAILED`, "without producing a report" | API test |
| Sends a report of the wrong shape | `FAILED`, "malformed report" | API test |
| Reports its own failure | `FAILED` with its message | API test |
| Sends evidence and the report twice | One row per evidence item, one report, one proposed action, one audit entry, one notification | API test |
| Cannot reach its own data source (the API) | The run still ends in a report, and the report is `UNDETERMINED` with no hypothesis and nothing recommended. It is not `HEALTHY` | AI service test |

### Worker and queue

| Scenario | Result recorded | Verified by |
|---|---|---|
| Worker killed (SIGKILL) during a run | Still `RUNNING` immediately after, since nothing can know. Once another worker is up, the queue hands the job out again and that worker records `FAILED`, "the worker stopped before this investigation finished", with a final step, an audit entry and a notification. No report. The AI service is not called again for it | API test (real process; under 15 s with short claim times), drill `worker-killed` (60 s with the default claim times) |
| Worker asked to stop (SIGTERM) during a run that can finish in the grace period | `COMPLETED`; exit code 0 | API test |
| Worker asked to stop during a run that cannot | `FAILED` as interrupted, already recorded when the process has exited; exit code 0; the request to the AI service is closed | API test, drill `worker-stopped` (exited in 10 s) |
| The same job enqueued three times, once under a different job id, and processed again by hand | One run, one report, one proposed action | API test |
| Investigation cancelled while running, and its report arrives afterwards | Stays `CANCELLED`; no report, hypothesis or proposed action; the request to the AI service is closed; cancelling again is refused with 409 | API test |
| A failure that the runner handles | The job is not marked failed and is not retried: the failure is the investigation's, recorded on it | API test |
| Job waiting in the queue when Redis is killed (SIGKILL) and started again | The job is still there; the worker runs it to a stored report. Before the fix (defect 11) this drill failed: the job was gone and the investigation read `QUEUED` | Drill `queued-job-survives-redis-kill` |
| Redis loses all its data (`FLUSHALL`) while a job is waiting | The worker restores the schedules of its repeating jobs within a minute; the sweep puts back the job of an investigation that has waited more than two minutes; it runs to a stored report, once. Nothing is restarted | Drill `queue-wiped`, API test |

### Redis

| Scenario | Result recorded | Verified by |
|---|---|---|
| Down when an investigation is requested | The request is answered with 503 in under 8 s (it does not hang); the row is `FAILED` naming Redis, not left `QUEUED`; `/ready` is 503 with `redis: false`; reading incidents still works | API test, drill `redis-down`, browser |
| Down when the workers start | The process stays up; `/health` 200, `/ready` 503 with `redis: false`; it takes work as soon as Redis is there | API test (real process, and in-process) |
| Lost for longer than a job's claim while an investigation is running | The investigation finishes once. The queue hands the job out again, the worker sees it is already running it and does nothing. One report, one proposed action, AI service called once | API test |

### PostgreSQL

| Scenario | Result recorded | Verified by |
|---|---|---|
| Down while requests arrive | 503 `service_unavailable` on reads and writes, with no host, port, driver or query text; `/ready` 503 with `database: false`; `/health` 200; the AI service is not called. A write refused during the outage was not partly applied | API test, drill `postgres-down` |
| Lost when the report of a running investigation arrives, back within about a second | `FAILED`, "The database could not be reached while the investigation was running"; no report, hypothesis or proposed action; no "completed" audit entry or notification; earlier evidence kept | API test |
| Lost for longer than the attempts to record the failure | The row stays `RUNNING` with no report. That is out of date, but it is not a false success. The periodic sweep leaves it alone while it could still be running and records `FAILED` as interrupted once it is older than any run can be; running the sweep again changes nothing | API test |

### Tracing

| Scenario | Result | Verified by |
|---|---|---|
| Exporter throws on every span | Traced work returns and fails exactly as it does untraced; an investigation runs to a stored report | API test |
| Tracing on, trace endpoint not listening | Same; no unhandled rejection follows. In containers: an investigation completes with tracing switched on in the API, the worker and the AI service and no trace store running | API test, AI service test, drill `tracing-without-store` |
| The run fails (AI service error, unreachable, time limit) | The run's span is marked failed with the error's class and nothing else. The job's span is not marked failed, because the job did its work: it recorded the failure. No "persist" span exists. Run and job are in one trace | API test |
| Scrubbing on the failure path | The question, the upstream's error text and the failure message are in no exported span or event | API test |
| Trace context through the queue | Unchanged, tested since Milestone 5 (`tracing.test.ts`) | Existing API test |

Tracing remains off by default (`OTEL_ENABLED=false` in `.env.example`, in the Compose file and in the isolated stack).

### Credentials in logs

After all drills, the logs of every service of the isolated stack were searched for the three generated secrets (JWT secret, internal service token, encryption key), the demo password, the session cookie in use, anything shaped like an Anthropic key and any database URL containing a password. None was found (drill `logs-clean`). The worker process started in the API tests is checked the same way for its two secrets.

This is a search for known values and shapes. It does not prove that no log line ever contains something sensitive.

## 3. Recovery results

Each line was verified by starting an investigation after the failure was removed and checking that it ended `COMPLETED` with a stored report, evidence, steps and an outcome, written by the rule-based engine.

| After | What had to be restarted | Result |
|---|---|---|
| AI service stopped and started | The AI service only | Investigation completed (drill, browser) |
| Redis stopped and started | Nothing else. The drill compares container id, start time and restart count of the API and the worker before and after | Investigation completed (drill, browser, API test) |
| PostgreSQL stopped and started | Nothing else, checked the same way. The same signed-in session kept working, and the counts of investigations, incidents and remediation actions were unchanged | Investigation completed (drill, API test) |
| Worker killed | The worker | The interrupted run was recorded as such; the next investigation completed (drill, API test) |
| Worker stopped and started | The worker | Same (drill, API test) |
| Whole stack stopped and started | Everything | All services ready; one organisation, the same incidents and investigations as before, so the migration and seeding step that runs on every start did not seed twice; investigation completed (drill) |
| Tracing switched on without a trace store, then off again | API, worker, AI service (to change the setting) | Investigation completed in both states (drill) |

No scenario needed a manual change to the database. The one state that does not correct itself at once is a run that was `RUNNING` when the database stayed away for longer than about eight seconds: it is ended by the sweep, up to twenty minutes later.

## 4. Defects found and fixed

Found by reading the code, then confirmed by a test that failed before the fix, unless noted.

| # | Defect | Fix |
|---|---|---|
| 1 | Editing a high-risk remediation action without sending a risk reset it to medium, lowering the approvals needed from two to one (found during the Acme Commerce demo; fixed first, in its own pull request) | The edit keeps the risk unless a new one is given; the threshold is recomputed when approving and executing |
| 2 | A report arriving for an investigation that was no longer running still created hypotheses and proposed remediation actions; a repeated final event proposed the actions a second time | Everything that follows from a report happens only if that call stored it, in the transaction that sets `COMPLETED` |
| 3 | Starting a run was a read followed by a write, so two deliveries could both run it | One conditional update; the queue job is named after the investigation |
| 4 | A run whose worker was killed stayed `RUNNING` for twenty minutes | Recorded as interrupted when the queue hands the job out again (about a minute) |
| 5 | On SIGTERM the worker waited for running jobs without limit and was killed by Docker after ten seconds | A grace period, then unfinished runs are stopped and recorded; `stop_grace_period` raised to 30 s |
| 6 | A cut stream or an invalid line was recorded as a JSON syntax error quoting the text received, which can be model output | Separate messages for time limit, interrupted connection and invalid event; none repeats the input |
| 7 | A database error during a run was stored on the investigation and shown, with host and port | The record says the database could not be reached; the detail goes to the log |
| 8 | A failure after the report was stored added a "failed" step and notification to a completed investigation | Recognised and logged; the investigation stays completed |
| 9 | The worker's connection errors were unhandled `error` events; its health endpoint said "ok" whatever it could reach | Errors handled and logged; `/ready` added; Compose health checks use readiness |
| 10 | On the incident page, the reason an investigation was refused appeared behind the open dialog (found by the browser test) | Shown in the dialog |
| 11 | Redis kept queued jobs in memory between snapshots, so killing it lost a job that had been accepted (reproduced by a drill); the investigation read `QUEUED` and the sweep would have failed it an hour later | Three layers: an append-only file on a volume for Redis; the sweep puts back the job of any investigation that has waited more than two minutes (same job id, so nothing is added if the job is still there, and nothing can run twice); the worker restores the schedules of its repeating jobs if they are missing |
| 12 | The schedules of the repeating jobs (alert evaluation, retention, the sweep itself) exist only in Redis and were written only when the worker started, so after a loss of Redis data all three stopped until the next restart (found by reading; reproduced by the `queue-wiped` drill, which cannot pass without the fix) | The worker checks once a minute and puts back what is missing |
| 13 | Right after a PostgreSQL outage, a newly accepted investigation could stay `QUEUED`: the worker's first query for the job failed while its connections were still recovering, the job failed, and nothing picked the investigation up again (found by the `postgres-down` drill on CI, where it had passed locally three times) | The worker retries its first queries for about eight seconds. A job that still fails before the investigation started is removed from the queue, so the sweep puts it back after two minutes |

Looked for and not found: a throwing trace exporter breaking the work it traces (the SDK contains it; the test passes without any change to the tracing code); a hang with Redis down (fixed in an earlier milestone, and still fixed).

## 5. New automated tests

| File | Tests | What they cover |
|---|---|---|
| `apps/api/tests/safety.test.ts` | +3 | Risk kept on edit, explicit risk changes, approvals counted again at execution (Phase 1) |
| `apps/api/tests/reliability.test.ts` | 19 | AI service failures (10), duplicate delivery and cancellation (2), Redis (4), the worker process (3) |
| `apps/api/tests/outage.test.ts` | 4 | PostgreSQL away and back: for requests, when a worker picks a job up, during a run, and for longer than the retries |
| `apps/api/tests/tracing-failure.test.ts` | 5 | Failing exporters, a missing trace store, spans of failed runs |
| `apps/api/tests/faults.ts` | (helpers) | The TCP proxy, the scripted AI stub, the worker child process |
| `services/ai/tests/test_tracing.py` | +1 | Trace store unreachable and data source unreachable: still a report, and it is `UNDETERMINED` |
| `apps/web/e2e/recovery.spec.ts` | 2 | What the page shows with the AI service down and with the queue down, and after each returns |
| `scripts/reliability-drills.mjs` | 11 drills | Section 2 and 3, on real containers |

Totals after this milestone: API 121 (was 90), AI service 171 (was 170), web unit 47 (unchanged), browser 11 (was 9), drills 11 (new).

All were run locally on 13 November 2026 and pass. The reliability and outage tests were run three times in a row without a failure. The browser tests and drills were run from a stack built from nothing (`isolated:down`, `isolated:up`, `isolated:e2e`, `drills`).

## 6. CI changes

- `e2e.yml` (workflow "End-to-end") now runs on every pull request into `develop` and `main`. Before, it ran only for release branches and pull requests into `main`, so the browser tests were not part of day-to-day review.
- It no longer copies `.env.example` and starts the default project. It starts the isolated stack: generated secrets, rule-based engine, no provider key, and a step that fails the job if the AI container has any other engine or a key. No repository secret is used, so it also runs safely for pull requests from forks.
- It runs the 11 browser tests, then the 11 drills.
- On failure it uploads the Playwright report, the screenshot and trace of each failed test (the trace holds the browser console and the network log) and the last 400 log lines of every service.
- `ci.yml` is unchanged. The new API tests run in the existing "Database integration tests" job, which already has PostgreSQL and Redis; the new AI service test runs in the existing AI job.
- "End-to-end" is not a required check. Making it one is a change to branch protection and was left to the owner.

## 7. Known limitations

- **One of everything.** One worker process, one Redis, one PostgreSQL, one AI service process, on one machine. No test ran two workers at once.
- **Rule-based engine only.** A run on the rule-based engine takes one to two seconds. Failures in the middle of a run were produced by a scripted stand-in or by freezing the AI container, not by a model that is slow in its own ways.
- **An interrupted run is not resumed.** It is recorded as failed and a person starts it again. The evidence it had gathered stays on the failed investigation; the new one starts from nothing.
- **Killing the worker is noticed after about a minute, not at once.** That is the queue's claim time plus its check interval (`QUEUE_LOCK_MS`, `QUEUE_STALLED_INTERVAL_MS`). Until then the investigation reads `RUNNING`.
- **A long database outage leaves `RUNNING` rows for up to twenty minutes.** The sweep that ends them runs in the worker. If no worker is running, nothing sweeps.
- **Chromium only**, desktop and one phone viewport.
- **Local runs were on Docker Desktop for macOS**; CI runs on Linux. Timings in this report are from the local runs. One defect (13) showed only on CI, which is a reminder that a drill passing a few times is not proof of the absence of a timing fault.
- **A job that fails before its investigation started and is removed leaves no entry in the queue's failed set.** The failure is in the worker's log; the investigation is put back by the sweep. That removal-and-return path is covered by reasoning and by the tests of its two halves, not by one test of the whole.
- **The log search looks for known secrets and shapes.** It is not a proof of absence.
- **The browser tests need a freshly seeded stack.** Run twice on the same data, the investigation test fails, because the first run rolls a deployment back and the second finds it rolled back. That is the test's assumption, not a fault in the application; the isolated stack exists so that the assumption holds.

## 8. Remaining reliability risks

Ordered by how much they could hurt.

1. **A worker that is alive but cut off from Redis, with a second worker running.** The queue hands its job to the second worker, which records the investigation as interrupted. The first worker's report, when it arrives, is discarded: the record stays consistent, but the run's cost is lost and the person is told it failed. With one worker this cannot happen (the worker recognises its own run; tested). With several it can, and it is untested.
2. **Side effects after the report is stored are not atomic with it.** The report, the outcome and the hypotheses are one transaction. The proposed actions, the timeline entry, the audit entry and the notification follow one by one. A crash between them leaves a completed investigation whose report recommends an action that has no row to approve. Nothing can be executed because of this (a missing proposal cannot be approved), so it is a completeness gap, not a safety gap. The crash case is untested. The gap itself is observable in normal operation: an investigation reads `COMPLETED` a few milliseconds before its proposed actions exist, which tests of this milestone ran into on CI twice and now wait for. For an interrupted investigation the state and the step that explains it are now one transaction; its audit entry and notification still follow.
3. **The API process dying during a remediation webhook call.** The action stays `EXECUTING` and the sweep records its outcome as unknown after five minutes (tested since Milestone 4 at the level of the sweep). It was not drilled with real containers.
4. **Redis durability is one second.** With the append-only file, a killed Redis loses at most about a second of accepted jobs. An investigation lost that way is put back on the queue by the sweep after two minutes. Jobs of the other queues (knowledge indexing, GitHub synchronisation) are not put back: a document being indexed is retried by the sweep after ten minutes, a synchronisation waits for the next request.
5. **No backup or restore of PostgreSQL was tested**, and there is no replica.
6. **Behaviour under load is unknown.** No test queued more than a handful of investigations at once, and ingestion was not loaded at all.
7. **Timeouts with a real provider** are tested against a mocked API only. The time limit of an investigation (15 minutes) was chosen, not measured.
8. **Background jobs other than investigations** (knowledge indexing, GitHub synchronisation, alert evaluation, retention) were not examined for what a retry or a duplicate does.

## 9. Recommended next priorities

1. **Decide whether "End-to-end" is a required check.** It takes about ten minutes. Until it is required, a pull request can be merged with it red.
2. **Run two workers in the drills** and settle risk 1: either accept it and say so in the interface, or have a worker prove it still holds its job before the job is declared interrupted.
3. **Make the proposals part of storing the report** (risk 2), or reconcile on read: a completed investigation whose report recommends actions that have no rows.
4. **A "start again" action on a failed or interrupted investigation**, so that recovery from an interruption is one click and the new run is linked to the old one.
5. **Drill the remediation path with real containers**: the API killed during a webhook call, and the webhook receiver slow, with the "unknown outcome" shown in the browser.
6. **One paid run of the failure paths**, if a budget is given: time limit and interrupted stream against a real provider.
7. **Load**: a queue of fifty investigations, and ingestion at a realistic rate, to find the first limit.
8. **Backup and restore** of PostgreSQL, tested by restoring.

## Reproducing this

```bash
npm test -w @opspilot/api          # the API tests; needs PostgreSQL and Redis (npm run infra:up)
npm run test:ai                    # the AI service tests

npm run isolated:down              # start from nothing
npm run isolated:up                # build and start the throwaway stack (web :13000, API :14000)
npm run isolated:e2e               # 11 browser tests
npm run drills                     # 11 failure drills; or: npm run drills -- worker-killed redis-down
npm run isolated:down              # remove it, including its volume
```

# Engineering audit

**Date:** 12 November 2026 · **Scope:** `develop` at `eb8c840` · **Standard:** readiness for a first serious beta

This audit was done by probing the running system and reading the code for faults, not by re-running the test suite. Each finding lists the evidence that was actually observed. Secrets are not reproduced here.

## Summary

| Severity | Count | Meaning |
|---|---|---|
| Critical | 1 | Data of every tenant exposed or lost with no special access |
| High | 8 | Security control defeated, core function unavailable or unverified, or work lost |
| Medium | 20 | Should be fixed before a wider beta |
| Low | 11 | Hardening and hygiene |

The product logic held up well: tenant isolation, SQL handling, webhook verification, secret storage and the human-approval gate all survived direct attempts to break them. The weaknesses are concentrated in three places: **deployment defaults** (network exposure, fallback secrets, no restart policy), **behaviour when a dependency is down or a process dies**, and **the model-driven path, which has never met a real model**.

## What was verified to work

| Check | Method | Result |
|---|---|---|
| Clean-environment reproducibility | Fresh `git clone` of `develop`, `npm ci`, typecheck, build, all tests | 28 + 10 + 23 tests pass, web builds |
| Migrations from an empty database | New database, `prisma migrate deploy` | 35 tables, `vector` and `pg_trgm` present |
| Tenant isolation | Code review of every route for an `organizationId` filter and for validation of ids supplied in bodies; existing cross-tenant tests | No gap found |
| SQL injection | Every raw query uses Prisma tagged templates; `ILIKE` input is escaped; the only `$executeRawUnsafe` is in test setup with names read from `pg_tables` | No gap found |
| Webhook signatures | HMAC-SHA256 over the raw body, constant-time compare, tests with wrong and missing signatures | Correct |
| Stored credentials | GitHub token and webhook secrets AES-256-GCM encrypted; API keys and refresh tokens stored as SHA-256; never returned by the API | Correct |
| Approval gate | Approve and execute routes reject API keys and the agent's token; self-approval blocked; state changes are compare-and-swap | Correct (one design weakness: M7) |
| Circular imports | `madge --circular` on API and web | None |
| Python dependencies | `pip-audit` on the locked set | No known vulnerabilities |
| Graceful shutdown | `docker compose stop api worker` | 0.5 s, signal handled |
| Recovery | Restarted Redis and PostgreSQL under a running API | Both reconnect without a restart (see H4, M12 for behaviour during the outage) |
| Observability | Prometheus targets, Grafana provisioning | Targets up, dashboard loads (but see M5) |

## Critical

### C1. PostgreSQL and Redis are reachable from the network with default or no credentials
- **Problem:** `docker-compose.yml` publishes every port on all interfaces. PostgreSQL uses the password committed in the compose file; Redis has no authentication.
- **Evidence:** `docker ps` shows `0.0.0.0:5432->5432` and `0.0.0.0:6379->6379` (also 3000, 3001, 4000, 8000, 9090).
- **Impact:** Anyone on the same Wi-Fi or LAN can read and modify every tenant's data, password hashes and encrypted tokens, and can inject or delete background jobs. No OpsPilot account is needed.
- **Recommendation:** Bind published ports to `127.0.0.1`. Take the database password from `.env`. Document that a real deployment must not publish the data stores at all.

## High

### H1. The stack starts with publicly known secrets if `.env` is incomplete
- **Problem:** Compose falls back to literal defaults for `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN` and `ENCRYPTION_KEY`, with `NODE_ENV=production`. The placeholders in `.env.example` also pass the API's validation.
- **Evidence:** `docker-compose.yml` `${JWT_SECRET:-dev-only-…}`; `env.ts` checks only length and format.
- **Impact:** With a known signing secret, anyone who learns a user id and organisation id can mint a valid session; with the known internal token, anyone can call the AI service; stored tokens are encrypted with a published key.
- **Recommendation:** Make the three secrets mandatory in Compose (`${VAR:?message}`), and make the API refuse the known placeholder values outside development and test.

### H2. Login rate limiting can be bypassed with a forged `X-Forwarded-For` header
- **Problem:** The API sets `trust proxy` to 1 but its port is reachable directly, so the client controls the address used as the rate-limit key. There is no per-account limit.
- **Evidence:** 30 wrong-password logins sent straight to `:4000`: with a different `X-Forwarded-For` each time, 0 were rejected; without the header, 17 were rejected with 429.
- **Impact:** Unlimited password guessing against any account. Audit-log IP addresses can be forged the same way.
- **Recommendation:** Make proxy trust a configuration value that defaults to off, and add a limiter keyed by the account being attempted, which no header can evade.

### H3. The remediation webhook allows server-side request forgery, and returns the response
- **Problem:** An admin can set any URL as the remediation webhook. Executing an action makes the API POST to it and stores up to 2,000 characters of the response, which the UI then shows.
- **Evidence:** `remediation.ts` `execute()`; `settingsBody` validates only `z.string().url()`.
- **Impact:** In a shared deployment, a tenant admin can make the server call internal addresses (cloud metadata, the AI service, other containers) and read what comes back.
- **Recommendation:** Resolve the host and refuse loopback, private and link-local addresses unless an operator explicitly allows them for local use; allow only `http`/`https`; do not follow redirects; stop storing the response body.

### H4. The API hangs when Redis is unavailable
- **Problem:** Queue connections are created with unlimited retries, so `enqueue` and the readiness check wait forever instead of failing.
- **Evidence:** With the Redis container stopped, `POST /investigations` returned nothing in 40 s and `/ready` timed out after 10 s. (After Redis returned, the queued job did run.)
- **Impact:** During a Redis outage, requests pile up until clients give up; the readiness probe, which exists to report exactly this, never answers.
- **Recommendation:** Give API-side queue operations a short timeout and return 503. Record a failed enqueue on the row so nothing is left looking "queued".

### H5. Work is stranded permanently if the worker stops mid-job
- **Problem:** A job that dies with its process leaves its row in an in-progress state that nothing ever revisits: investigations in `RUNNING`, remediation in `EXECUTING`, documents in `indexing`. Investigation jobs are not retried, and the processor ignores rows that are not `QUEUED`.
- **Evidence:** `investigations.ts` `runInvestigation` returns early unless status is `QUEUED`; no reaper exists; BullMQ `attempts: 1` for investigations.
- **Impact:** After any worker restart or crash, the UI polls a "running" investigation forever, and an action stuck in `EXECUTING` can be neither retried nor cancelled.
- **Recommendation:** A periodic reaper that fails in-progress rows older than a safe threshold with a clear message (for remediation: "outcome unknown, verify manually"), and re-queues stale documents.

### H6. Containers do not restart after a crash
- **Problem:** No service has a restart policy; only the API has a health check.
- **Evidence:** `docker kill opspilot-api-1` → still `Exited (137)` 8 s later; `RestartPolicy.Name` is `no`; health checks: api yes, worker/web/ai none.
- **Impact:** One crash, or a Docker or machine restart, takes the product down until someone starts it by hand.
- **Recommendation:** `restart: unless-stopped` on long-running services and health checks for web, AI and worker.

### H7. Model-driven analysis has never run against a real model, and has a known defect
- **Problem:** No LLM credential was available, so the agent/tools loop and model-written reports are covered only by scripted doubles. Capturing the exact request the Claude adapter builds exposed a defect: the report schema's free-form `parameters` field is sent as an empty, closed object.
- **Evidence:** Captured request body: `RecommendedAction.parameters` → `{"type":"object","properties":{},"additionalProperties":false}`. Evaluations were run only with `--heuristic`.
- **Impact:** A model can never attach `deploymentId` and `toVersion` to a rollback proposal, so executing that action would not record the rollback. More broadly, prompt quality, tool-use behaviour, cost and latency with a real model are unknown.
- **Recommendation:** Replace the free-form field with a typed parameters object. Then, with a credential, run the evaluations against a model before calling this path ready.

### H8. Ten high-severity advisories in production dependencies
- **Problem:** The OpenTelemetry packages are pinned to old releases.
- **Evidence:** `npm audit --omit=dev`: 10 high, 47 moderate, all under `@opentelemetry/*`.
- **Impact:** Known vulnerabilities ship in the API and worker images. Exposure is limited because tracing is off by default.
- **Recommendation:** Upgrade the three OpenTelemetry packages and re-run the audit; add `npm audit` to CI.

## Medium

| # | Problem | Evidence | Recommendation |
|---|---|---|---|
| M1 | Access tokens stay valid for up to 15 minutes after logout or password change | A bearer token taken before `POST /auth/logout` still returned 200 on `/auth/me` | Put the session id in the token and check it is not revoked |
| M2 | Invalid filter values cause 500 instead of 400 | `?status=BOGUS`, `?tier=X` → 500 (enum filters are cast with `as never`) | Validate list filters with enums |
| M3 | URL fields accept any scheme | A service was stored with `repoUrl: "javascript:alert(1)"`; same for a document's `sourceUrl`. The UI is protected because React 19 refuses such links, but other API consumers are not | Accept only `http` and `https` |
| M4 | CSV exports allow formula injection | `esc()` in `analytics.ts` and `organization.ts` quotes but does not neutralise cells beginning with `=`, `+`, `-`, `@` | Prefix such cells with `'` |
| M5 | Worker metrics are never scraped | `count(opspilot_jobs_processed_total)` and `count(opspilot_investigations_total)` are 0 in Prometheus; the worker has no HTTP endpoint. Three Grafana panels are permanently empty | Expose `/metrics` from the worker |
| M6 | AI service logs are not valid JSON | 0 of 22 log lines parse; the hand-built format breaks on quotes. `httpx` logs every tool URL at INFO | Use a JSON formatter; lower `httpx` to WARNING |
| M7 | The proposer chooses the risk level, which sets the number of approvals | `remediationInput.risk` is free input, for people and for the model | Derive a minimum risk from action type and service tier; let approvers raise it |
| M8 | Text returned by tools reaches the model unmarked and unscreened | `graph.py` wraps the question and incident as untrusted data but passes tool JSON as-is; `screen_text` runs only on the question | Wrap tool output as data, flag instruction-like content in it, and show approvers when a proposal's text came from a model |
| M9 | No limit on investigations or tokens per organisation; tokens are counted but not costed | No quota code exists | Concurrency and daily limits per organisation; cost estimate from token counts |
| M10 | The report contract and the guardrails exist twice (Python and TypeScript) with no test tying them together; web types are hand-copied | `schemas.py` vs `reportSchema`; `lib/types.ts` | A contract test that feeds real AI-service output through the API schema; generate web types |
| M11 | Test gaps | The worker/BullMQ path is never exercised (tests run jobs inline); team and settings routes have no tests; no page-level web tests; evaluations cover only the rule-based engine with five scenarios written alongside the rules; the browser suite is not in CI and needs a fresh seed | See remediation plan |
| M12 | Database outages surface as 500 | ~8 s of 500 responses during a PostgreSQL restart | Map connection errors to 503 with `Retry-After` |
| M13 | Queries that will not scale | Analytics loads all rows in the period into memory; alert evaluation runs several queries per rule per minute across all organisations; every log search runs `count(*)`; knowledge full-text search has no index; the dashboard issues about twelve queries every 30 s per open tab | Aggregate in SQL; batch; estimate counts; add a tsvector index; cache the dashboard |
| M14 | Module structure | Routes, validation and logic share one file per area (up to ~400 lines); `services.ts` also holds deployments and events, `analytics.ts` also holds the dashboard and postmortems. Duplicated helpers: `userNames`, CSV escaping, time-bucket selection | Split by responsibility when each area is next touched; extract the shared helpers |
| M15 | The web app has no error boundary | No `error.tsx` or `not-found.tsx`; a render error shows a blank page | Add both |
| M16 | Operational endpoints are open | `/metrics` on API and AI service need no credential; Grafana runs with default admin password and anonymous access | Acceptable on localhost once C1 is fixed; restrict for any shared deployment |
| M17 | Demo data is seeded automatically | The `migrate` container seeds users with a documented password whenever the database is empty | Make seeding opt-in for non-demo use |
| M18 | Failed sign-ins are not audited; audit writes are best-effort | `auth.ts` audits only success; `writeAudit` swallows errors | Record failures; write audit entries in the same transaction for approval and execution |
| M19 | CSRF protection rests on `SameSite=Lax` alone | No `Origin` check; other sites on the same registrable domain are not excluded | Reject cookie-authenticated writes whose `Origin` is not the web origin |
| M20 | Rate limits are per process | In-memory store | Use the Redis store when running more than one API instance |

## Low

| # | Problem | Recommendation |
|---|---|---|
| L1 | Login time differs between unknown emails (~215 ms) and accounts hashed at a lower cost (~55 ms for seeded users) | Use a dummy hash generated at the configured cost |
| L2 | JWT verification does not pin the algorithm | Pass `algorithms: ['HS256']` |
| L3 | Card-number redaction can mask other long digit runs | Add a Luhn check |
| L4 | Registration and invitation preview reveal whether an email has an account | Accept for now; revisit with email verification |
| L5 | The agent's tool token is valid for 30 minutes regardless of whether its investigation is still running | Check investigation status when the token is used |
| L6 | No rotation path for `ENCRYPTION_KEY` | Key id prefix and re-encryption command |
| L7 | LLM and embedding clients are created per call and not closed | Reuse per process |
| L8 | No request id shared between API, worker and AI service | Propagate one header |
| L9 | Vector search filters by organisation after the nearest-neighbour scan, which lowers recall as tenants grow | Partition or use iterative scans |
| L10 | Any engineer can cancel another person's approved action | Limit to requester and admins |
| L11 | `COOKIE_SECURE` is false in Compose | Correct for http://localhost; must be true behind TLS |

## AI engineering assessment

| Capability | Rule-based engine (verified) | Needs a real model |
|---|---|---|
| Planning | Fixed playbook, shown as the plan | Model-written plan: built, untested live |
| Tool calling | Playbook calls through the same tool API; argument validation, budgets, error reporting tested | Model-chosen, parallel tool calls: built, tested with scripted turns only |
| Structured output | Report built in code | `messages.parse` / `with_structured_output`: request shape verified offline, response handling untested live (H7) |
| Evidence attribution | Evidence created only from tool results; citations checked in both services | Same mechanism; whether a model cites well is unknown |
| Hallucination handling | Not applicable (no generation) | Guardrails remove invented citations and cap unsupported confidence; tested with a deliberately wrong scripted report |
| State management | Steps, evidence and report persisted as they stream; cancel works; **stuck states after a crash (H5)** | Same |
| Retry behaviour | None for investigations; a failed model call falls back to rules and says so | Provider retries are the SDK defaults; no backoff policy of our own |
| Token and cost tracking | Not applicable | Tokens recorded per investigation and in Prometheus; no cost, no budget (M9) |
| Prompt injection | Question screened; agent is read-only and tenant-scoped, so the worst case is a misleading report or proposal | Tool output is not marked as untrusted (M8) |
| Human approval | Enforced in the API regardless of engine | Same |

**Evaluation quality.** The five scenarios check meaningful outcomes (the right cause is ranked first, confidence falls in an allowed band, no rollback is proposed without cause, an innocent service is not blamed, missing data lowers confidence). Their limits: they were written by the author of the rules, they are few, and the "grounded" score is trivially satisfied by the rule-based engine. They become a real measure only when run against a model.

## Testing assessment

- **Genuine:** API tests go through HTTP to a real PostgreSQL with pgvector; they assert on stored state, on cross-tenant denial, on signatures and on audit entries, not just status codes. Browser tests run the whole incident → investigation → approval → execution flow across four user roles.
- **Substituted:** the Python service is replaced by a scripted double in API tests, and the model by a scripted provider in AI tests. Nothing tests the two services against each other except the browser suite.
- **Missing:** see M11. Failure scenarios covered: AI service down, malformed report, model failure, tool failure, webhook failure, cancelled run. Not covered: Redis down (H4), worker death (H5), database down (M12).

## Prioritised remediation plan

**Now (this pass): Critical and High**

| Order | Finding | Change | Verification |
|---|---|---|---|
| 1 | C1, H1, H6 | Loopback-only ports, mandatory secrets, placeholder rejection, restart policies, health checks | `docker ps` bindings; start without secrets fails; kill a container and watch it return |
| 2 | H2 | Configurable proxy trust, per-account login limiter | Repeat the 30-request probe; new test |
| 3 | H3 | Webhook address validation, no redirects, no stored response body | New tests for blocked and allowed targets |
| 4 | H4 | Queue timeouts, 503 on enqueue failure, readiness that answers | Repeat the Redis-down probe |
| 5 | H5 | Reaper for stranded investigations, executions and indexing | New tests with rows left in progress |
| 6 | H7 (defect only) | Typed remediation parameters in the model schema | Re-capture the request; unit test |
| 7 | H8 | Upgrade OpenTelemetry | `npm audit` |

Small, low-risk Medium items fixed alongside because they share the same code: M2, M3, M4.

**Next: before widening the beta** — M1, M5, M6, M8, M12, M15, M18, M19, and the test gaps in M11 (worker path, contract test, browser tests in CI).

**Then** — M7, M9, M10, M13, M14, M16, M17, M20 and the Low items.

**Blocked on the owner** — the rest of H7 needs an LLM credential.

## Remediation results

Fixes were made on `bugfix/*` branches, each tested and merged into `develop`. "Live" means the original probe was repeated against the rebuilt Docker stack.

| Finding | Status | What changed | Verification |
|---|---|---|---|
| C1 Data stores exposed | **Fixed** | All published ports bound to `127.0.0.1`; database password configurable | Live: 0 ports on `0.0.0.0`, 7 on loopback |
| H1 Fallback secrets | **Fixed** | Compose requires the three secrets; API rejects the published placeholders in production | Live: Compose refuses to start without them. 3 new tests |
| H2 Rate-limit bypass | **Fixed** | Proxy headers ignored unless `TRUST_PROXY` is set; sign-in throttled per account (10 failures in 15 minutes) | Live: with a forged address on every request, 20 of 30 attempts rejected (previously 0). 3 new tests |
| H3 Webhook request forgery | **Fixed** | Only http(s) to publicly routable addresses, checked on save and before each call; redirects not followed; response body no longer stored | 2 new tests, including a URL that was valid when saved and is refused at execution |
| H4 Hang when Redis is down | **Fixed** | Fail-fast producer connection with a 3 s limit; failed enqueue marks the investigation failed | Live: `POST /investigations` → 503 in 3.0 s (previously no answer in 40 s); `/ready` → 503 in 3.0 s; normal service after Redis returned |
| H5 Stranded work | **Fixed** | Once-a-minute sweep fails interrupted investigations and executions with an honest message and re-queues stuck indexing | 1 new test covering stale and fresh rows |
| H6 No restart after crash | **Fixed** | `restart: unless-stopped`; health checks for web, AI and worker | Live: API and worker processes ended from inside their containers came back on their own (restart count 1). Note: `docker kill` is treated by Docker as a deliberate stop and is not restarted |
| H7 Model path | **Defect fixed; verification still blocked** | Typed remediation parameters in the model schema | Regression test captures the real request to the provider. Running against a live model still needs a credential |
| H8 Vulnerable dependencies | **Partly fixed** | OpenTelemetry and Vitest upgraded | Advisories: 2 critical → 0, 10 high → 5. See below |
| M2 500 on bad filters | **Fixed** | Enum-validated list filters | Live: 400. 1 new test over 8 routes |
| M3 Unsafe link schemes | **Fixed** | http/https only | Live: 400. 1 new test |
| M4 CSV formula injection | **Fixed** | Formula cells prefixed with `'` | 1 new test |
| M5 Worker metrics | **Fixed** | Worker serves `/metrics` and `/health`; Prometheus scrapes it | Live: job and investigation series now present |

A defect introduced and caught during remediation: after the OpenTelemetry upgrade npm placed some packages inside the API workspace, and the image copied only the root `node_modules`, so the rebuilt API crash-looped with `MODULE_NOT_FOUND`. The image now ships workspace-local modules. The new restart policy and health checks are what made the failure visible immediately.

### H8: what remains and why

Five high advisories remain. Each needs a major-version upgrade, which is too large a change to make inside an audit pass:

| Package | Advisory | Exposure here | Fix |
|---|---|---|---|
| `zod` 3.x | Memory exhaustion validating oversized constrained collections | Request bodies are capped at 5 MB and arrays have explicit maximums, which bounds the input | Zod 4 |
| `prisma` CLI, `@prisma/config`, `deepmerge-ts` | Stack exhaustion merging recursive objects | Build and migration time only; the input is our own configuration | Prisma 7 |
| `postcss` (via Next) | XSS and file read through crafted CSS | Build time only; the CSS is our own | Next 16 |

These should be scheduled as their own `feature/` branches, one major at a time, each with the full test suite.

### Test totals after remediation

| Suite | Before | After |
|---|---|---|
| API integration | 28 | 39 |
| AI service | 23 | 25 |
| Web unit | 10 | 10 |
| Browser end-to-end | 9 | 9 |
| Agent evaluations | 5/5 | 5/5 |

### Still open

All remaining Medium and Low findings, in the order given in the remediation plan. The most valuable next items are M1 (token revocation), M8 (marking tool output as untrusted for the model), M12 (503 during database outages), M15 (error boundary) and the test gaps in M11.

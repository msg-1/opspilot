# OPSILUME demo environment

Three small instrumented services, their data stores, and seven failure scenarios. They exist so that OPSILUME can be pointed at real logs, real metrics, real traces and real failures on one laptop, at no cost.

Everything here is local. Nothing is published beyond `127.0.0.1`, nothing calls a paid API, and the failure scenarios can only reach the demo containers.

## What runs

```
                    demo-load (6 requests/second, fixed rate)
                         │
                   shop-gateway ──────────────┐
                         │                    │ logs (HTTP, batched)      ┌──────────────┐
                   shop-orders ───────────────┼──────────────────────────▶│              │
                    │    │   │                │                           │   OPSILUME   │
        shop-postgres    │   shop-payments ───┘                           │     API      │
                    shop-redis ◀──────┘                                   │              │
                                                                          └──────▲───▲───┘
   /metrics ──▶ Prometheus ──▶ demo-bridge ── metrics, up/down ─────────────────┘   │
   OTLP traces ──▶ Jaeger ◀── queried at investigation time (TRACES_URL) ───────────┘
```

| Container | What it is | Published on the host |
|---|---|---|
| `demo-gateway` (`shop-gateway`) | Public edge; forwards to orders | `127.0.0.1:8088` |
| `demo-orders` (`shop-orders`) | Orders in PostgreSQL, cache in Redis, pays through payments | `127.0.0.1:8089` |
| `demo-payments` (`shop-payments`) | Charges once per order; idempotency keys in Redis | `127.0.0.1:8090` |
| `demo-postgres`, `demo-redis` | Their data stores. The database lives in memory | not published |
| `demo-jaeger` | Trace store (OTLP in, Jaeger query API out) | `127.0.0.1:16686` |
| `demo-load` | Steady traffic, 70% reads and 30% checkouts | – |
| `demo-bridge` | Reads the services' metrics from Prometheus, probes the data stores, writes both into OPSILUME | – |
| `prometheus` | Scrapes the three services every 5 seconds | `127.0.0.1:9090` |

Memory is capped per container (64 to 384 MB; about 1.6 GB in total for the demo). The services are one Node.js image, `demo/services`.

### How telemetry reaches OPSILUME

| Signal | Path | Used by the investigation through |
|---|---|---|
| Logs | Each service writes JSON lines to stdout and sends the same lines, with trace ids, to `POST /api/v1/logs` every two seconds | `find_log_anomalies`, `get_log_patterns`, `search_logs`, `get_log_histogram` |
| Metrics | `prom-client` → Prometheus → `demo-bridge` → `POST /api/v1/monitoring/metrics` every ten seconds: request rate, error rate, p50/p95 latency, memory, pool connections in use, requests waiting for a connection | `get_metrics` |
| Reachability | `demo-bridge` reports `up` for each service (from Prometheus) and for PostgreSQL and Redis (TCP probe). Alert rules turn `up < 1` into a DOWN service | `get_service`, `list_services` |
| Traces | OpenTelemetry auto-instrumentation (HTTP, Express, pg, ioredis) → OTLP → Jaeger. OPSILUME does not store traces; the API queries Jaeger when asked | `get_traces` |
| Deployments | The `bad-deploy` scenario records the deployment through `POST /api/v1/deployments` at the moment it switches the version | `list_deployments`, `get_deployment_context` |

Nothing is synthesised: every number OPSILUME sees was measured by Prometheus or written by a service.

## Prerequisites

- Docker with Compose v2.24 or newer, about 4 GB of memory free for Docker
- Node.js 22 (for the scripts; they have no dependencies)
- A `.env` in the repository root: copy `.env.example` and set `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN` and `ENCRYPTION_KEY` (see `docs/setup-guide.md`). No model API key is needed.

## Start

```bash
npm run demo:up
```

This starts OPSILUME (API, worker, AI service, web), creates the demo organisation, then starts the demo services. It takes a few minutes the first time because images are built.

`demo:up` always starts the AI service with `AI_PROVIDER=deterministic`, the rule-based engine, and stops if it finds anything else. **Investigations in the demo call no model and cost nothing**, even if a model API key is present in `.env`.

Then:

- OPSILUME: http://localhost:3000 — sign in as `shop-demo@example.com` / `OpsPilot-demo-1`
- Traces: http://localhost:16686
- Prometheus: http://localhost:9090

Wait about three minutes before the first investigation. A failure is judged against the window just before it, so there has to be a "before".

`npm run demo:setup` on its own (re)creates the demo organisation: six services with their dependencies, alert rules, deployment history, a runbook, and an ingestion key written to `demo/.env.demo` (git-ignored, readable only by you, never printed).

## Failure scenarios

```bash
npm run demo:scenario -- list              # every scenario with its commands
npm run demo:scenario -- <name> on         # activate
npm run demo:scenario -- <name> off        # recover, and verify recovery
npm run demo:scenario -- status            # what is switched on, and a live probe
npm run demo:scenario -- baseline          # everything off
```

| Scenario | Mechanism | What you can observe | Recover |
|---|---|---|---|
| `db-latency` | Every statement from shop-orders is preceded by a 400 ms `pg_sleep` in PostgreSQL | p95 latency of shop-orders and shop-gateway rises from tens of milliseconds to most of a second; traces spend their time in the `pg.query` span; no errors | `db-latency off` |
| `pool-exhaustion` | All 6 connections of the shop-orders pool are held by long statements | ERROR `timeout acquiring connection from pool after 1500ms (pool size 6, n waiting)`; 503s; `queue_depth` rises; `db_connections` sits at 6 | `pool-exhaustion off` (cancels the statements, releases the connections) |
| `redis-outage` | `demo-redis` is stopped | shop-redis DOWN; shop-payments 503 `idempotency store unavailable`; checkouts 502; WARN `cache read failed` in shop-orders, which keeps serving reads from the database | `redis-outage off` (starts the container) |
| `error-rate` | shop-payments fails 40% of charges with a 500 | shop-payments error rate; ERROR `payment provider returned an error`; about 12% of gateway requests fail | `error-rate off` |
| `bad-deploy` | shop-orders switches to v1.5.0, which reads a discount field that four orders in five do not have; the deployment is recorded in OPSILUME | Deployment of shop-orders v1.5.0, then ERROR `failed to compute order total: Cannot read properties of null`; error rate jumps | `bad-deploy off` (switches back to v1.4.0 and records that) |
| `upstream-down` | `demo-payments` is stopped | shop-payments DOWN; ERROR `upstream shop-payments request failed: ECONNREFUSED` in shop-orders; every checkout fails, reads still work | `upstream-down off` |
| `baseline` | Everything off | No errors, p95 of a few tens of milliseconds | – |

Every `off` ends with a recovery check: 24 real requests through the gateway must all succeed with p95 under 400 ms. The command exits non-zero if the shop has not recovered within a minute.

The faults are switched through an admin endpoint on the demo services (`/admin`, token `DEMO_ADMIN_TOKEN`, default `local-demo`) or by stopping a demo container. They cannot reach anything else.

`bad-deploy` changes the code path of the running process; it does not build and roll out a new image. What OPSILUME sees is the same as for a real deployment: a deployment record, then different behaviour. Recovery is recorded as a rollback of v1.5.0 (`rollbackOf`), which marks that deployment as rolled back so that it is never proposed as a version to return to.

## Investigate a failure by hand

1. `npm run demo:scenario -- redis-outage on`
2. Wait about two minutes.
3. In OPSILUME, open **Investigations** and ask: *Why are checkouts failing on shop-gateway?*
4. Read the result:
   - **Assessment**: incident, degraded, healthy or undetermined, with the signals found, the evidence it rests on and what was not examined.
   - **Hypotheses**, most likely first. Each cites evidence (E1, E2, …). Click a reference to open the item; "Open source" goes to the record it came from.
   - **Evidence check**: how many of the report's figures match the evidence they cite. A fact with a figure that could not be matched is marked where you read it.
   - **Proposed remediation**: each action is labelled *Read-only check* or *Changes production*. Nothing runs from here.
5. `npm run demo:scenario -- redis-outage off`

To see a remediation proposal, use `bad-deploy`: the investigation proposes a rollback to v1.4.0. Open it under **Approvals**. It needs approval from someone other than whoever submits it; an approval is bound to the exact content shown; editing the action afterwards cancels the approvals. OPSILUME is not connected to the demo services, so "executing" an approved action here means carrying it out yourself (`bad-deploy off`) and confirming.

## Run every scenario automatically

```bash
npm run demo:e2e
npm run demo:e2e -- --only redis-outage,runbook-safety
```

This takes about 25 minutes: each failure runs for 100 seconds before it is investigated, and 150 seconds of clean traffic separate the scenarios so that each has a baseline (`HOLD_S`, `SETTLE_S`). It refuses to start if a paid model is active.

| Scenario | What must hold |
|---|---|
| `healthy-baseline` | Outcome HEALTHY; no hypothesis above "unlikely"; nothing proposed that changes production; the conclusion cites steady metrics |
| `db-latency` | Outcome INCIDENT; a latency metric is a strong signal; the leading hypothesis locates the delay in shop-orders' PostgreSQL calls and cites traces whose slowest span is a PostgreSQL span; Redis and payments are not blamed |
| `redis-outage` | Outcome INCIDENT; the leading hypothesis names Redis; the dependency chain gateway → orders → payments → redis was followed; traces place the failure in shop-payments, which calls Redis directly, and are cited for the Redis hypothesis; PostgreSQL is not blamed; no rollback is proposed |
| `bad-deploy` | Outcome INCIDENT; the leading hypothesis is the v1.5.0 deployment, ahead of every other deployment, and cites the deployment record created by the scenario; traces place the failure in shop-orders; a rollback to v1.4.0 is proposed, awaiting approval; executing it without approval is refused |
| `insufficient-evidence` | Asked about `shop-inventory`, which sends no telemetry: outcome UNDETERMINED, with the missing telemetry named; no hypothesis and no proposal |
| `pool-exhaustion`, `error-rate`, `upstream-down` | The failure shows in real requests; OPSILUME does not report HEALTHY and locates the problem where it is (shop-orders' calls to PostgreSQL; shop-payments; shop-orders' calls to shop-payments); no rollback is proposed; recovery is verified |
| `recovery` | After the failures are removed, shop-orders is HEALTHY again |
| `runbook-safety` | The runbook's steps are split into read-only and state-changing; an action that points at the runbook cannot run without approval, cannot be approved by its proposer, and loses its approvals when edited; a read-only diagnostic can be recorded without approval |

In every investigated scenario two further things are checked:

- **Provenance.** Each evidence item is looked up again where it came from: log lines and patterns in the log store, metric samples in the metric store, the deployment record, the trace in Jaeger (same number of spans), the service in the catalogue. An item that cannot be found fails the scenario.
- **Figures.** No figure in the report may be unsupported by the evidence it cites.

After each failure, recovery is checked twice: real requests succeed again, and the metrics held by OPSILUME are back to normal.

Results are written to `demo/results/<timestamp>.json` (git-ignored).

## Stop and clean up

```bash
npm run demo:scenario -- baseline     # switch every fault off
npm run demo:down                     # stop and remove the demo containers
docker compose --profile app down     # stop OPSILUME itself (add -v to delete its database)
```

The demo database lives in memory and disappears with its container. The demo organisation stays in OPSILUME until its database volume is removed.

If a scenario is interrupted half-way, `npm run demo:scenario -- baseline` restores everything: it restarts stopped containers, clears faults and returns shop-orders to v1.4.0.

## Limitations

- **Earlier failures stay in the history.** Deployments, alerts and incidents recorded by one scenario are evidence in the next, as they would be in a real system. The runner waits for five minutes of clean telemetry before it starts and 150 seconds between scenarios.
- **Rule-based engine only.** The demo has not been run with a language model: that would cost money and was not authorised. What a model would make of this telemetry is untested.
- **One trace store, one tenant.** Jaeger is not tenant-aware. The API only asks it about services of the caller's organisation, and expects the OpenTelemetry `service.name` to equal the service's slug.
- **Traces are kept in memory for about ten minutes** (4,000 traces). An investigation of an older window finds none and says so.
- **Traces are sampled by the query, not by the tracer.** The API reads up to 60 traces per request from Jaeger, failed and slowest first. Rare failures can be missed.
- **Metrics are averages over the window.** A short spike inside a long window is diluted. The scenarios hold a failure for 100 seconds and investigate that window.
- **`bad-deploy` is a behaviour switch**, not a container rollout, and no source repository is linked, so the investigation has the deployment record but no commit or pull request to read.
- **The remediation webhook is not connected** to the demo services. Approved actions are carried out by hand.
- **Synthetic traffic.** A fixed request mix at a fixed rate, with 200 seeded orders. Real traffic has seasonality and noise that this does not.
- **Local only, single node.** No network partitions, no disk pressure, no multi-region behaviour.

# Manual testing with the Acme Commerce dataset

A temporary dataset for trying OPSILUME by hand: a fictional company, six services, eight
incidents and the logs, metrics, deployments and code changes behind them. It is for a local
installation only and can be removed completely.

It is not the live demo in `demo/` (three running services that really fail, `npm run demo:up`).
This one is static records, takes a few seconds to create, and needs nothing running except the
application itself.

## Commands

```bash
npm run demo:seed              # create the dataset; does nothing if it already exists
npm run demo:status            # what exists, by category, and which engine is active
npm run demo:reset             # show what would be removed (deletes nothing)
npm run demo:reset -- --yes    # remove it
```

The application must be running (`docker compose --profile app up -d`, or `npm run dev`) and
the standard demo accounts must exist (`npm run db:seed`, once).

**Use the rule-based engine.** Investigations on this dataset are meant to run without a model.
`npm run demo:status` says which engine is active and warns if a paid model would be used. To
be certain:

```bash
AI_PROVIDER=deterministic docker compose --profile app up -d ai
```

The Investigations page shows the active engine at the top.

## Signing in

Sign in at <http://localhost:3000> with the existing demo owner account, `demo@example.com`
(its password is listed with the other demo accounts in [setup-guide.md](setup-guide.md); this
dataset does not change it). Then choose **Acme Commerce** in the organisation menu at the
bottom of the sidebar.

The other demo accounts are members too, with these roles. You need a second account to see
approval from both sides, because nobody can approve an action they proposed or requested.

| Account | Role in Acme Commerce | Useful for |
|---|---|---|
| `demo@example.com` | Owner | Everything; can approve high-risk actions |
| `marcus@example.com` | Admin | A second approver for high-risk actions |
| `lena@example.com` | Engineer | Requested the Redis restart, so cannot approve it |
| `tomas@example.com` | Engineer | Requested the high-risk change |
| `aiko@example.com` | Viewer | Read-only: no approve, execute or investigate buttons |

## What the dataset contains

Everything is anchored to the moment of seeding ("now").

**Services:** `api-gateway`, `shop-orders`, `shop-payments`, `shop-inventory`,
`shop-notifications`, `shop-redis`, owned by three teams. The gateway calls orders, payments
and inventory; orders publishes to notifications; inventory reads through Redis.

**Incidents:**

| # | Incident | Severity, status | When | Service |
|---|---|---|---|---|
| INC-1 | Inventory service timeouts on stock lookups | SEV3, closed | 13 days ago | shop-inventory |
| INC-2 | Payment service elevated error rate | SEV2, closed | 9 days ago | shop-payments, api-gateway |
| INC-3 | Notification delivery delays | SEV3, resolved | 5 days ago | shop-notifications |
| INC-4 | Database latency affecting order processing | SEV2, resolved | 40 hours ago | shop-orders |
| INC-5 | Reports of slow order confirmation, not reproduced | SEV4, resolved | 9 hours ago | shop-orders |
| INC-6 | Order confirmation e-mails reported missing | SEV3, mitigated | 3 hours ago | shop-notifications |
| INC-7 | Checkout failing at payment after shop-payments v3.8.0 | SEV2, investigating | 52 minutes ago | shop-payments |
| INC-8 | Redis dependency outage: stock lookups failing | SEV1, investigating | 24 minutes ago | shop-inventory |

**Telemetry:** three days of metrics (throughput, error rate, p95 latency, CPU, memory,
database connections and pool usage, Redis availability) and two days of logs with trace ids:
ordinary traffic, pool exhaustion and slow queries, Redis connection failures, HTTP 500 and
503 responses, timeouts, payment gateway errors, and recovery messages.

**Deployments:** 35, including the problematic `shop-payments v3.8.0`, the healthy `v3.7.2`
before it, a failed `shop-inventory v2.5.0` whose canary never passed, and the recovery
deployment `shop-orders v5.2.4`. Six commits and pull requests are linked to them (marked as
sample data on the Changes page).

**Also:** alert rules with four alerts firing, five knowledge-base documents (runbooks, an
architecture note, a postmortem), service events, and three remediation proposals.

**Not included, on purpose:** investigations, reports and evidence. Those are produced only by
running an investigation. Nothing in the dataset is written to look like the engine's output.

## Investigations to run

Open an incident and press **Investigate with AI**, or use the Investigations page and link the
incident. Each takes a few seconds on the rule-based engine.

| Incident | Expected outcome | What the report should show |
|---|---|---|
| INC-4 Database latency | **Incident** | Leading hypothesis: the config change that lowered `DB_POOL_MAX` from 40 to 12, minutes before the first pool timeout. Strong signals from error logs, error rate and latency. |
| INC-8 Redis dependency outage | **Incident** | Leading hypothesis: failure of the upstream dependency `shop-redis`, which is recorded as down. A past incident on the same service appears as a weaker alternative. |
| INC-7 Bad deployment | **Incident** | Leading hypothesis: the deployment of `shop-payments v3.8.0`, with the pull request it shipped. Proposes a rollback to `v3.7.2`, as a proposal only. |
| INC-5 Not reproduced | **Healthy** | No hypothesis. Metrics held steady, the logs hold no error pattern. No production change is recommended. |
| INC-6 E-mails missing | **Undetermined** | No hypothesis and no verdict: the service sent no logs and no metrics in the window, and the report says that absence of telemetry is not health. |

These outcomes were produced by the engine from the records, not written into the dataset. If
one differs, that is a finding about the engine or about the age of the data (see Limitations).

Things worth checking in each report:

- **Facts and hypotheses are separate.** Established facts cite evidence; each hypothesis lists
  what is observed, what is assumed and what is missing.
- **Citations resolve.** Click a reference such as `E5`: it opens the evidence item, and
  "Open source" on a deployment, log pattern or incident goes to the record itself.
- **Figures are checked.** The "Evidence check" line says how many figures in the report match
  the evidence they cite.
- **Uncertainty is stated.** "What is uncertain or could not be checked" and "Not examined"
  (for example: no trace store is connected in this setup).
- **The engine is labelled.** Every report says it was produced by rule-based correlation, not
  a language model.

## Remediation to inspect

On the Approvals page, or from INC-8 and INC-7:

| Action | Effect, risk | State | What to try |
|---|---|---|---|
| Check memory and replication status of shop-redis | Read-only, low | Proposed, no approval needed | "Record as done" after doing it. It cannot be submitted for approval, because it changes nothing. |
| Restart the shop-redis primary | Changes production, medium | Awaiting 1 approval, requested by Lena | Approve as the owner. As Lena, see why the Approve button is missing. |
| Raise shop-redis maxmemory and switch eviction policy | Changes production, high | Awaiting 2 approvals, requested by Tomás | Needs two approvers, and only an owner or admin may approve. As Lena, see the refusal. |
| Roll back shop-payments to v3.7.2 | Changes production, medium | Appears after investigating INC-7; proposed by OPSILUME AI | Submit it for approval yourself, then approve it from a second account. |

Each action page shows why it was classified as read-only or as a change, how many approvals
it needs, and who decided what.

**Nothing is approved or executed by the seed, and nothing can execute by itself.** This
installation has no remediation webhook, so "executing" an approved action means doing it
yourself and pressing **Mark as executed**: OPSILUME records your confirmation and changes no
system. There is nothing real behind the service names, so use it only to see the flow. The
outcomes "not applied" and "unknown" come from a webhook and cannot be produced here.

Safeguards you can try: approve your own request (refused), approve as the viewer (no button),
execute before approval (no button; the API refuses), edit an action after someone approved it
(the approval is marked as no longer counting and the action returns to "Proposed").

## Pages that have data

Dashboard, Incidents and incident details (timeline, related changes), Services and service
details (dependencies, metrics), Logs (stream, patterns, anomalies), Deployments, Changes,
Monitoring (charts, alert rules, firing alerts), Analytics, Knowledge, Approvals, Team, and
Settings → Audit log. Investigations, reports and evidence fill as you run investigations.

## Removing the dataset

```bash
npm run demo:reset             # lists what would go
npm run demo:reset -- --yes    # removes it
```

How it stays contained:

- Everything is in one dedicated organisation, `acme-commerce-demo`, found by its slug and by a
  marker written when it was created. An organisation with that slug but without the marker is
  never touched.
- Every delete is scoped to that organisation's id, children before parents, in one
  transaction. Before committing, the script checks that nothing of the demo organisation is
  left and that no row of any other organisation and no user account changed; otherwise it
  rolls everything back.
- It refuses to run unless the database is on this machine, and refuses under
  `NODE_ENV=production`.
- No table is truncated, no database, volume or migration is touched, and no user is created,
  changed or deleted. The demo accounts keep their passwords and their other organisations;
  only their membership of Acme Commerce goes. Anyone signed in to Acme Commerce at that moment
  is signed out of it.

Seeding twice creates nothing the second time. Resetting twice is harmless.

Investigations you ran, approvals you gave and comments you wrote in Acme Commerce are part of
that organisation and are removed with it.

## Limitations

- **The data ages.** It is anchored to the time of seeding and nothing keeps arriving. After an
  hour, "last hour" views are empty; widen the range, or re-anchor with
  `npm run demo:reset -- --yes && npm run demo:seed`. `npm run demo:status` says how old it is.
- **Service health is computed, not seeded.** The worker derives it every minute from firing
  alerts, active incidents and whether telemetry arrived in the last 15 minutes. About 15
  minutes after seeding, `shop-orders` changes from Healthy to Unknown. The services with a
  firing alert or an active incident keep their state.
- **Open incidents drift.** An investigation of an open incident looks from two hours before
  it started until now. INC-7 and INC-8 were verified within an hour of seeding; much later the
  window is mostly empty and the numbers in the report change. Re-anchor before a session.
- **An active incident counts as a signal.** A service with an open incident is recorded as
  degraded, and the engine counts that. For this reason the Healthy and Undetermined scenarios
  are a resolved and a mitigated incident. Reopen INC-5 and its outcome becomes Degraded.
- **Old incidents are judged by what was recorded at the time.** For an incident that is over,
  the health of a service and of what it depends on is worked out from the alerts, incidents
  and metrics recorded in its window, not from their state today (this was a defect until
  Milestone 7: INC-1 and INC-2 used to name the Redis outage that is happening now). INC-1 and
  INC-2 predate the stored telemetry, so they come out Undetermined and the report says that
  the state of their dependencies at the time is not on record. Their recorded root causes are
  the correct ones.
- **INC-3 has no telemetry in range** (it predates the stored history) and comes out
  Undetermined.
- **No traces.** No trace store is connected, so every report lists traces as not examined.
- **No real integrations.** GitHub data is sample data, and there is no remediation webhook.
- **Only the rule-based engine was verified.** A model would write different reports; running
  one costs money and is not part of this exercise.

# Investigation reliability

How OPSILUME decides whether there is a fault at all, what an action would do, when an action may run, and whether the figures in a report are true to the evidence. Each rule here is enforced in code and covered by tests; the file names say where.

Nothing in this document is a claim of production readiness. It describes safeguards and their limits.

## 1. Outcome: is there a fault at all?

Every report carries an **assessment**, computed from the evidence by `services/ai/app/assessment.py` for every engine (rule-based, mock, or a model). The report's author does not decide it. A model asked "why is X failing?" tends to find a reason; a report that always names a cause is useless on the day nothing is wrong.

| Outcome | Meaning |
|---|---|
| `HEALTHY` | No material evidence of a fault in the window examined |
| `DEGRADED` | Anomalies or warnings are measurable, but no cause is established. Also: a failure is evident but nothing in the evidence explains it |
| `INCIDENT` | A failure is evident, and the leading hypothesis is supported by something that can be a cause |
| `UNDETERMINED` | The service sent no telemetry in the window, or nothing could be queried. Neither a fault nor good health can be concluded |

`UNDETERMINED` is a fourth state on purpose. A service that sends nothing looks exactly like a service with a clean log; calling it healthy would be a guess.

### Signals

| Strength | What counts |
|---|---|
| Strong | 10 or more ERROR/FATAL lines in one pattern · error rate up by half or more **and** at least 1% · latency up by half or more **and** by at least 50 ms · a firing alert · a dependency or the service itself recorded as DOWN · three or more sampled traces with failed spans |
| Moderate | 3 to 9 ERROR/FATAL lines in one pattern · 50 or more new or spiking WARN lines · error rate up by a quarter and at least 0.5% · latency up by a quarter and by at least 20 ms · another metric moved by a quarter or more and by at least one whole unit · a dependency or the service recorded as DEGRADED |
| Weak | Anything else that was noticed: a few warnings, a couple of errors, a percentage change on a value close to zero |

Every metric rule has an absolute floor as well as a relative one. A pool gauge that averages 0.1 connections and drops to 0 has fallen by 100% and means nothing. A metric that was zero and is no longer has no percentage change at all, and is treated as a rise whose size is judged by the level reached.

### From signals to outcome

- A strong signal **and** a leading hypothesis at 0.25 confidence or more that cites something which can be a cause (a deployment, a service event, a commit or pull request, a dependency, a past incident, an alert, a trace): `INCIDENT`. A hypothesis that cites only log patterns and metrics describes the failure without explaining it.
- A strong signal without such a hypothesis, or moderate signals only: `DEGRADED`.
- Neither, and there is telemetry to judge by (metric samples, or log lines of any level): `HEALTHY`.
- Neither, and no telemetry: `UNDETERMINED`.

### Confidence in the outcome

The assessment has its own confidence, separate from the confidence in any hypothesis. For `HEALTHY` it is built from coverage: 0.35 to begin with, more when metrics held steady for every service in question, when the services logged and the logs contain no error pattern, and when the catalogue records them as healthy with no alert firing; less for every data source that failed and for each weak signal. A healthy verdict that rests on metrics alone says so in its rationale and in its number. It is never set to a constant.

### What a healthy report contains

- The outcome and its rationale, with references to the evidence it rests on. Metrics that did **not** move are evidence items (`metric_baseline`), and so is a healthy status in the catalogue (`service_health`), so there is something to cite.
- **Observations**: things worth knowing that are not evidence of a fault (routine warnings, the last deployment), each with references.
- **Not examined**: telemetry that was missing or could not be queried.
- No fault hypothesis above "unlikely". When the evidence shows no fault, any hypothesis is limited to 0.2 and marked unlikely, and the report's hypothesis confidence follows. A report with no hypothesis shows none.
- Nothing that would change production.

A report that concludes differently from the evidence is corrected in both directions, and the correction is recorded as a guardrail step: a report that blames a healthy service, and a report that calls a failing service healthy.

## 2. Action effects

Each recommended action is `read_only` or `state_changing`. The effect is decided from the action's type and its text by `services/ai/app/effects.py` and `apps/api/src/lib/actionEffect.ts`, never taken from whoever proposed it. The two implementations are checked against the same fixture (`services/ai/tests/fixtures/action-effects.json`) by both test suites.

- `rollback_deployment`, `restart_service`, `scale_service`, `toggle_feature_flag`, `config_change`: state-changing by definition.
- `run_runbook` and `manual`: by what the text says. It is state-changing if it mentions restarting or stopping a process, deploying or rolling back, changing configuration, switching something on or off, clearing a queue, cache or data, running a migration or writing data, changing capacity or infrastructure, changing access, or upgrading software.
- It is read-only only if it mentions none of those **and** says what it inspects (check, verify, compare, read, review, query, …).
- **Anything unclear is state-changing.** "Housekeeping, as discussed" needs approval.

The rule errs towards approval. "Read the eviction log" is classified as state-changing because of the word "eviction". That costs an approval; the opposite mistake could cost an outage.

### Runbooks

| Capability | How | Approval |
|---|---|---|
| Read a runbook | `GET /knowledge/documents/:id` | None |
| Explain a runbook | The investigation cites it as evidence | None |
| Generate an execution plan | `GET /knowledge/documents/:id/plan`: its steps, each labelled by what it would do | None |
| Carry out read-only steps | A `read_only` action, recorded by a person | None |
| Carry out state-changing steps | A `state_changing` action | Required |

An action that points at a runbook (`parameters.runbookDocumentId`) takes its effect from the runbook's steps, not from its own title. A runbook with no recognisable steps cannot be shown to be harmless and is state-changing. Commands in code blocks are judged as commands, and a command that is not recognised is state-changing.

OPSILUME executes nothing itself. "Carry out" means: a person does it, or the organisation's remediation webhook does.

## 3. Which actions are offered

The guardrails (`services/ai/app/guardrails.py`, applied again in `apps/api/src/modules/investigations/guardrails.ts`) remove an action from the proposals, and list it under next steps with the reason, when:

- it would change production and the outcome is not `INCIDENT`;
- it would change production and rests only on a hypothesis rated unlikely;
- it is a rollback whose target is not borne out: the deployment is not among those retrieved or has already been rolled back, the version to return to is not an earlier deployment of the same service, that deployment did not succeed and so never ran, or it was itself rolled back;
- it is high risk and a lower-risk action is proposed.

Such an action is withdrawn, not relabelled. Turning a rollback into a "manual" action would leave the same change waiting for approval.

### Deployments as suspects (rule-based engine)

Timing makes a deployment a candidate, not a culprit. A deployment shortly before a problem loses standing when the evidence speaks against it:

- it has already been rolled back, so its code is not running;
- it is itself a rollback, returning the service to a version that ran before;
- error logs fell after it (from the deployment context).

Each is stated as a contradiction on the hypothesis. This was added after a run on real telemetry in which a database slowed down minutes after a bad release had been rolled back: timing alone made the rollback deployment the leading suspect, and the proposed remedy was to return to the release that had just been removed. For that to be preventable, a rollback has to be recorded as one: `POST /deployments` accepts `rollbackOf`.

## 4. Approval and execution

`apps/api/src/modules/remediation/`. Only signed-in people can approve, execute, edit or retry; API keys and the AI's tool token are refused on those routes.

- **Read-only diagnostics** need no approval. A person records that it was done and what was found. They are never sent to the webhook, so a misjudged text cannot change anything. The effect is recomputed at that moment; if the text now reads as a change, the action is reclassified and refused.
- **State-changing actions** need at least one approval, whatever the organisation's settings say, from someone other than the proposer and the requester (unless self-approval is switched on), and are at least medium risk.
- **Binding.** An approval is given for a hash of the action's type, title, description, risk, service and parameters. The interface sends the hash it displayed, so an approver who has an old version open is stopped.
- **Edits.** Changing anything an approver was shown supersedes every approval and returns the action to `PROPOSED`. Superseded approvals stay on record and no longer count. Changing the rationale alone does not.
- **At execution** the hash is recomputed and only approvals given for it are counted. If the content is not what was approved, however it came to differ, execution is refused, the approvals are superseded and the action starts again. Approval of one action authorises no other, even one with identical content.
- **Once.** The action is claimed atomically; a second request at the same moment is refused.
- **Outcome.** A 2xx from the webhook is `applied`. A 4xx, or an address refused before sending, is `not_applied`. A timeout, a dropped connection or a 5xx is `unknown`: the request was sent and nobody knows whether the change happened. That is recorded as unknown, never as executed and never as a clean failure, and no effect is written to the service history.
- **Retry.** After `not_applied`, a retry needs nothing further. After `unknown`, a person must first confirm that the change was not applied. Every attempt carries the same idempotency key (`Idempotency-Key` header and `idempotencyKey` in the body), so a receiver that did apply the first attempt can refuse the second. The approvals are checked again when it is executed.
- **Record.** The execution result and the audit trail carry the content hash, the approvers with the time of each approval, the attempt number, the mode and the outcome.

What OPSILUME cannot guarantee: that a webhook receiver honours the idempotency key, or that a person who confirms "not applied" checked.

## 5. Figures and identifiers

`services/ai/app/claims.py`. A citation that resolves is not enough: "error rate rose to 14% (E3)" has to be compared with what E3 says.

1. Each evidence item is turned into typed values (number, unit, source), from its structured data first and from its own title and summary second. A metric recorded without a unit takes it from its name (`latency_p95_ms`).
2. Each statement is split into claims: numbers with units, timestamps, versions, commit hashes, pull request numbers, incident keys.
3. Each claim is compared with the evidence the statement cites.

| Status | Meaning |
|---|---|
| `exact` | The cited evidence holds this value, in a compatible unit (210 ms = 0.21 s) |
| `rounded` | The cited evidence holds a value that rounds to it at the precision written |
| `calculated` | It is the ratio, difference, sum, share or percentage change of two cited values, or the time between two cited timestamps |
| `estimate` | The text marks it as approximate ("about", "roughly") and it is within 15% of a cited value |
| `uncited` | It matches evidence that exists but that the statement does not cite |
| `unsupported` | None of these: a wrong value, a wrong unit, or nothing to compare with |

- Units are compared by dimension. 210 s against evidence of 210 ms is unsupported, and the detail says the unit differs. A bare number does not support a claim in a physical unit.
- Timestamps are compared in UTC to the minute. An offset is converted. A timestamp without a zone is read as UTC and the detail says so.
- Not treated as measurements: the report's own confidence, HTTP status codes ("502s"), small bare integers ("2 hypotheses"), evidence references, the boundaries of the investigation window. The numbers inside a recommended action are instructions ("watch for 15 minutes") and only its identifiers are checked.
- Nothing is corrected and nothing is filled in. Each fact and observation carries its verification; the report carries a tally and the list of flagged claims; an uncertainty is added when any is unsupported. In the interface a fact with an unsupported figure is marked where it is read.
- A rollback's deployment id and target version are validated against the deployment evidence separately (section 3).

### How it fares on real model output

Run over the nine reports saved from the live evaluation in Milestone 3, without calling a model: 453 claims, 447 supported, 4 correctly flagged as uncited (a version named in a timeline entry that cites a different item), and 2 false positives (a bare HTTP "500" and a confidence written as "(0.35)"). No wrong measurement was found in those reports. The validator's first pass over the same reports flagged 25 claims; reading them showed most to be its own mistakes (status codes, dates, hyphenated units, the report's own confidence), and those became tests. Six remain flagged.

### Limits

- It is tokenisation plus typed comparison, not understanding. A figure can be correct and cited and still be used to support a conclusion it does not support.
- Derived values are found only as one operation on two values. A percentage of a percentage, or an average of three values, is flagged.
- Words are not checked: "doubled", "most", "a few".
- The model-facing instructions that ask for exact figures and UTC timestamps have not been run against a model in this milestone.

## 6. What has and has not been validated

| | Deterministic tests | Local demo, rule-based engine | Live model |
|---|---|---|---|
| Outcome assessment | Yes | Yes | The guardrails were applied to saved model output from Milestone 3; the changed prompt and schema were not run |
| Action effects, withdrawal rules | Yes | Yes | Same |
| Approval binding, execution outcomes | Yes (API tests) | Yes (runbook-safety scenario) | Not applicable |
| Claim validation | Yes | Yes | Applied to saved model output only |
| Trace retrieval | Yes (stub trace store) | Yes (Jaeger) | No |
| Dependency-chain and trace reasoning | Yes | Yes | These are rule-based-engine rules; a model reasons its own way |

The local demo was run once in full on 12 November 2026: nine of ten scenarios passed, and the tenth passed after the fix it prompted. The table and the caveats are in `demo/README.md`.

See `docs/claude-live-verification.md` for the live runs and `demo/README.md` for the local demonstration.

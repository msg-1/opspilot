# Manual test walkthrough: Acme Commerce

A step-by-step script for testing OPSILUME by hand with the Acme Commerce dataset. Each step
says what to do and what you should see. Allow about 45 minutes for the whole thing; the parts
are independent, so you can stop after any of them.

Background on the dataset itself is in [manual-demo-testing.md](manual-demo-testing.md).

---

## Part 0. Prepare (5 minutes)

Run these from the repository root.

**0.1 Start the application on the rule-based engine.**

```bash
docker compose --profile app up -d
AI_PROVIDER=deterministic docker compose --profile app up -d ai
```

The second line matters. Your `.env` selects a paid model by default, and the first line
alone would start the AI service with it.

**0.2 Rebuild the dataset so it is anchored to now.**

```bash
npm run demo:reset -- --yes
npm run demo:seed
```

Do this at the start of every session. The data does not move forward in time: after an hour
the "last hour" charts are empty and the two open incidents no longer look live. The reset
also removes investigations and approvals left over from an earlier session.

**0.3 Confirm it is ready.**

```bash
npm run demo:status
```

Expect:

- eight incidents, INC-1 to INC-8, each with `investigations: 0`;
- the last line: `Investigation engine: rule-based (no model is called, nothing is billed).`

If the last line is a WARNING instead, repeat the second command of step 0.1 before going on.

**0.4 Sign in.**

1. Open <http://localhost:3000>.
2. Sign in as `demo@example.com`. The password is listed with the demo accounts in
   [setup-guide.md](setup-guide.md).
3. Open the account menu (your name) and, under **Switch organisation**, choose
   **Acme Commerce**.

Expect: the sidebar shows Acme Commerce, and **Overview** shows 3 active incidents and
2 pending approvals.

> Start Part 2 within about 30 minutes of seeding. INC-7 and INC-8 are open incidents and
> their investigations look at "from two hours before it started until now".

---

## Part 1. Look around (10 minutes)

A quick pass to see that the pages are connected. You change nothing here.

| # | Do this | Expect |
|---|---|---|
| 1.1 | **Overview** | Active incidents, pending approvals, service health. Numbers are links. |
| 1.2 | **Incidents** | Eight incidents. Two Investigating (INC-7, INC-8), one Mitigated (INC-6), three Resolved, two Closed. The status filter counts match. |
| 1.3 | Open **INC-7** | Title, SEV2, a timeline starting with the alert, the affected service `Shop Payments`. |
| 1.4 | On INC-7, tab **Related changes** | The deployment of `shop-payments v3.8.0` a few minutes before the incident, error patterns, and INC-2 as a similar past incident. |
| 1.5 | **Services** | Six services. `shop-redis` and `shop-inventory` Down, `shop-payments` and `api-gateway` Degraded, `shop-notifications` Unknown, `shop-orders` Healthy (it becomes Unknown about 15 minutes after seeding; that is expected). |
| 1.6 | Open **Shop Inventory** | It depends on Shop Redis, and API Gateway depends on it. Error rate and latency charts jump about 27 minutes before "now". |
| 1.7 | **Monitoring** | Four alerts firing. Pick `shop-payments`: the error rate steps up about 54 minutes ago. |
| 1.8 | **Logs**, range 1 hour | Errors from `shop-payments` ("unsupported_api_version") and `shop-inventory` ("redis connection refused"). Tab **Patterns** groups them. Click a line with a trace id to see related lines. |
| 1.9 | **Deployments** | `shop-payments v3.8.0` at the top; a Failed `shop-inventory v2.5.0`; `shop-orders v5.2.4`. |
| 1.10 | **Code changes** | Six commits and pull requests, marked as sample data. #214 is the PayGate API v2 change. |
| 1.11 | **Knowledge base** | Five documents, all indexed. Open "Runbook: shop-redis unavailable". |
| 1.12 | **Analytics**, 30 days | Incident and deployment trends are not empty. |
| 1.13 | **Investigations** | Empty history. The notice at the top says the rule-based engine is in use. |

If the notice in 1.13 names a model, stop and go back to step 0.1.

---

## Part 2. Investigations (15 minutes)

For each incident below: open it from **Incidents**, press **Investigate with AI**, leave the
suggested question as it is, and start it. You land on the report; it completes in a few
seconds.

### 2.1 Bad deployment: INC-7

Expected outcome: **Incident**.

Check, in order:

1. **Engine label.** The header says "Rule-based engine · no AI model", and the summary says it
   was produced by rule-based correlation, not a language model.
2. **Assessment box.** "Incident", a confidence, strong signals from the error logs, the error
   rate and the firing alert. Under "Not examined": traces.
3. **Leading hypothesis.** "Regression introduced by Deployment of shop-payments v3.8.0". Open
   it: observed facts, assumptions and missing evidence are three separate lists. It is
   labelled as a hypothesis to verify, not a confirmed root cause.
4. **Citations.** Click one of the `E…` references in the hypothesis. The **Evidence
   timeline** tab opens with that item highlighted and marked "cited in report". Press
   **Open source** on the deployment item: it goes to the Deployments page.
5. **Evidence check line.** "N of N figures and identifiers in this report match the evidence
   they cite."
6. **Agent steps tab.** Every tool call is listed. Expand one to see what was asked and what
   came back.
7. **Proposed remediation** (right-hand side). "Roll back shop-payments to v3.7.2", labelled
   "Changes production", status Proposed. There is no approve or execute button on this page.

You use this rollback in Part 3.

### 2.2 Redis dependency outage: INC-8

Expected outcome: **Incident**.

- Leading hypothesis: "Failure of upstream dependency shop-redis". The incident is on
  `shop-inventory`; the engine found Redis through the dependency.
- A second, weaker hypothesis points at the past incident INC-1. Check that it is ranked
  below and that its confidence is lower.
- No rollback is proposed: there was no deployment to blame.

### 2.3 Database latency: INC-4

Expected outcome: **Incident**. This incident is resolved, so the report covers a fixed
period about 40 hours ago.

- Leading hypothesis: the config change "DB_POOL_MAX lowered from 40 to 12", minutes before
  the first pool timeout.
- Evidence timeline: filter by **Log pattern** to see the pool timeouts, then sort by time
  and read the order: config change, first errors, restore, recovery.

### 2.4 Nothing wrong: INC-5

Expected outcome: **Healthy**.

- No hypothesis. The Findings tab says none is put forward because there is nothing to explain.
- The assessment says what the verdict rests on: metrics held steady, no error pattern in the
  logs.
- "Proposed remediation" says the investigation did not recommend a production change.

This is the case that matters most: asked "what is the cause?", the engine answers that there
is nothing to cause.

### 2.5 No telemetry: INC-6

Expected outcome: **Undetermined**.

- No hypothesis and no verdict of health either. The rationale says the service sent no
  metric samples and no log lines, so neither a fault nor good health can be concluded.
- "Not examined" lists exactly what was missing.
- Confidence is 0. Check that it is not shown as "healthy".

### 2.6 Check the list

Go to **Investigations**. Five rows, with outcomes Incident, Incident, Incident, Healthy,
Undetermined, each with its evidence count and the rule-based engine label.

### If an outcome differs

| You see | Likely reason |
|---|---|
| INC-7 or INC-8 is Degraded, or the numbers look thin | The dataset is old. Redo step 0.2. |
| INC-5 is Degraded | It was reopened, or something else raised an alert on `shop-orders`. Redo step 0.2. |
| A report names a model | The AI service is not on the rule-based engine. Redo step 0.1. |
| Anything else | A real finding. Note the incident, the outcome and the rationale text. |

---

## Part 3. Remediation and approvals (10 minutes)

You need two browser sessions, because nobody may approve an action they proposed or
requested. Keep your normal window signed in as `demo@example.com` (owner) and open a
private window for the second account. All demo accounts share the password from step 0.4;
each must switch to Acme Commerce after signing in.

### 3.1 A read-only diagnostic

1. As the owner, open **Approvals** → "Check memory and replication status of shop-redis".
2. Expect: "Read-only check", low risk, "None required" under Approvals, and a sentence
   explaining why it was classified as read-only.
3. There is no "Submit for approval" button, only **Record as done**. Press it, add a note,
   confirm.
4. Expect: status Executed, an execution result saying a person recorded it.

### 3.2 A change you can approve

1. As the owner, open "Restart the shop-redis primary".
2. Expect: "Changes production", medium risk, "0 of 1 required", requested by Lena Fischer,
   progress at "Awaiting approval".
3. Press **Approve**. The dialog names exactly what you are approving. Add a comment, confirm.
4. Expect: "1 of 1 required", progress at "Approved", your decision listed.
5. Note that approving did not execute anything. A separate **Mark as executed** button
   appears. Leave it for step 3.6.

### 3.3 The requester cannot approve their own request

1. In the private window, sign in as `lena@example.com` and switch to Acme Commerce.
2. Open "Raise shop-redis maxmemory to 4 GB…". Expect the notice "High-risk actions must be
   approved by an admin or owner" and no Approve button.
3. Sign out. Sign in as `tomas@example.com`, open the same action. Expect "You proposed or
   requested this action, so someone else must approve it".

### 3.4 A high-risk change needs two approvers

1. As the owner, open "Raise shop-redis maxmemory to 4 GB…". Expect "0 of 2 required".
2. Approve it. Expect "1 of 2 required" and status still Awaiting approval.
3. Expect the notice "You have already recorded your decision" and no second Approve button.
4. In the private window, sign in as `marcus@example.com` (admin), open it and approve.
5. Expect "2 of 2 required" and status Approved.

### 3.5 The AI's proposal goes through the same gate

1. As the owner, open "Roll back shop-payments to v3.7.2" (from Approvals, or from INC-7).
2. Expect: proposed by OPSILUME AI, status Proposed, a notice asking you to review the
   rationale and evidence, and a link to the source investigation.
3. Press **Submit for approval**. You are now the requester.
4. Expect: you cannot approve it ("You proposed or requested this action…").
5. In the private window, as `marcus@example.com`, approve it.
6. Expect: Approved, with "1 of 1 required".

### 3.6 Execution

There is no remediation webhook in this installation, so nothing can be executed for you.

1. As the owner, open the approved rollback and press **Mark as executed**.
2. The dialog says OPSILUME is not connected to your infrastructure and asks you to confirm
   that you carried the action out. Add a note, press **I have carried this out**.
3. Expect: status Executed; an execution result with outcome "Applied", attempt 1, mode
   "carried out manually".
4. Open **INC-7**: the timeline shows the proposal, the approval request, the approval and
   the execution, each with a link.

Nothing real is behind these service names, so this records a confirmation and changes no
system.

### 3.7 The viewer sees everything and can do nothing

1. In the private window, sign in as `aiko@example.com` and switch to Acme Commerce.
2. Open any action under **Approvals**: no Approve, Reject, Execute or Cancel buttons, and the
   notice "Your role cannot approve remediation actions" on a pending one.
3. Open **INC-8**: no "Investigate with AI", no status selector, no comment box.
4. Open **Investigations**: the history is readable, the question box is absent.

### 3.8 The audit trail

As the owner: **Settings** → Audit log. Expect an entry for every step above: investigation
started, approval requested, approved, executed, each with who did it.

---

## Part 4. Clean up (2 minutes)

```bash
npm run demo:reset             # lists what would be removed
npm run demo:reset -- --yes    # removes it
npm run demo:status            # "No demo dataset"
```

Then check that nothing else was affected: sign in again as `demo@example.com`. You are in
Meridian Commerce with its incidents as before, and Acme Commerce is gone from the
organisation menu.

To return the AI service to whatever `.env` selects:

```bash
docker compose --profile app up -d ai
```

---

## What this walkthrough cannot show

- **Execution outcomes "Not applied" and "Unknown".** They come from a webhook that refuses or
  does not answer. No webhook is configured here.
- **A model-written report.** Only the rule-based engine is used. Running a model costs money.
- **Traces as evidence.** No trace store is connected; every report lists traces as not
  examined.
- **INC-1, INC-2, INC-3.** They are history for the lists and for analytics. Their telemetry
  is older than what is stored, so investigating them gives Undetermined, and the report says
  that the state of their dependencies at the time is not on record. (Containers built before
  Milestone 7 instead point INC-1 and INC-2 at the Redis outage happening now; that was a
  defect and is fixed.)

## A defect that was fixed after this dataset was built

Editing a high-risk action without sending its risk again used to lower the risk to medium,
so that it needed one approval instead of two. That is fixed in the code (the edit now keeps
the risk, and the approvals are counted again when the action is executed).

Containers built before the fix still have the old behaviour. To test with the fix, rebuild
the application, keeping the rule-based engine:

```bash
AI_PROVIDER=deterministic docker compose --profile app up -d --build
```

Then, in Part 3, edit the description of the high-risk action: it should stay high risk and
still say "0 of 2 required".

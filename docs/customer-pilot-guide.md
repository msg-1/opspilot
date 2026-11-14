# Pilot guide

For an engineering team that wants to try OPSILUME on its own systems and decide whether it is useful. It takes you from an empty organisation to a first investigation, says what is supported and what is not, and ends with how to remove everything again.

OPSILUME is a working name. This is pre-release software: it has no compliance certification, no service-level agreement and has not been validated at production scale. Read [Known limitations](#known-limitations) before you rely on anything it tells you.

## What it does

When something is wrong with a service, OPSILUME gathers what your systems recorded around that time (logs, metrics, deployments, configuration changes, code changes, alerts, past incidents, runbooks), works out whether there is a fault at all, and writes a report: what is established, what most probably caused it, how sure that is, what speaks against it, what is missing, and what to do next.

Three things it is built not to do:

- **It does not invent evidence.** Every statement in a report cites records in your own data, and the figures in the report are checked against the records they cite.
- **It does not call a guess a cause.** A report names a hypothesis with a confidence, never a confirmed root cause. When the data is too thin it says "undetermined".
- **It does not change your systems.** It can propose an action. A person approves it, and a person or your own automation carries it out.

## What you need

| | |
|---|---|
| A machine to run it on | Docker with Compose. The whole application is six containers (web, API, worker, analysis service, PostgreSQL with pgvector, Redis). Tested on one machine; see limitations |
| Network | Your systems must be able to reach the API over HTTPS to send data. If you use the remediation webhook or GitHub, the installation must be able to reach those |
| Someone to operate it | Whoever runs the containers sets the secrets, the analysis engine and, optionally, a trace store. These are installation settings, not organisation settings |
| A model provider, or none | By default the analysis is done by a rule-based engine: no model, no cost, nothing leaves the installation. A language model can be configured by the operator; then evidence from your data is sent to that provider. Decide which before you send real data |

Installation is in [setup-guide.md](setup-guide.md). In short: copy `.env.example` to `.env`, generate the three secrets, set `SEED_DEMO_DATA=false` for anything that will hold real data, and `docker compose --profile app up -d --build`. Put TLS in front of the web container before using it from anywhere but the same machine.

## Supported integrations

These are all of them. The Integrations page in the application shows the same list with the live status of each.

| Source | Direction | What it gives an investigation | What it needs | Limits |
|---|---|---|---|---|
| **Logs** | You send (`POST /api/v1/logs`) | Error patterns, new and spiking messages, example lines | API key with `ingest:logs` | Batches of up to 5,000 lines, 5 MB per request. No agent or collector is provided: you send JSON over HTTP |
| **Metrics** | You send (`POST /api/v1/monitoring/metrics`) | What moved and what held steady; alert rules; service health | API key with `ingest:metrics` | Named samples per service. No scraping: something of yours must push |
| **Deployments** | You send, from CI/CD (`POST /api/v1/deployments`) | What was released before a failure; the version to roll back to | API key with `ingest:deployments` | One request per deployment |
| **Service events** | You send (`POST /api/v1/service-events`) | Configuration changes, feature flags, scaling, restarts | API key with `ingest:events` | |
| **GitHub** | OPSILUME reads; optional webhook | Commits and pull requests behind a deployment, and the files they touched | A token with read access (fine-grained: Contents and Pull requests, read-only), or none for public repositories | github.com only. Tested against a local stand-in for the GitHub API, **not yet against github.com with a real token** |
| **Remediation webhook** | OPSILUME calls you | A way to carry out approved actions through your own pipeline | An HTTPS endpoint at a public address; a shared secret | One endpoint per organisation. Optional: without it, people carry out actions and confirm them |
| **Distributed traces** | OPSILUME reads, at investigation time | Where time was lost and which call failed | A Jaeger-compatible query API, set by the operator for the whole installation | Not per organisation. Service names in the trace store must match service slugs |
| **MCP server** | AI clients read | The same read-only tools the analysis uses, for an assistant such as Claude Code | An API key with `tools:read` | Read-only. Tested in-process, not with a real client |

Not supported: pulling from a log or metrics vendor (Datadog, CloudWatch, Prometheus scraping, Loki, Splunk and so on), PagerDuty or Opsgenie, Slack or e-mail delivery, GitLab or Bitbucket, single sign-on. If your data lives in one of those, you need a small forwarder that posts to the endpoints above.

## Setting up, step by step

The Integrations page has a getting-started list that ticks each of these as it actually happens.

### 1. Create the organisation and invite people

Register at `/register`. The person who registers is the owner. Invite colleagues under Team; an invitation is a link you pass on yourself (no e-mail is sent).

| Role | Can |
|---|---|
| Viewer | Read everything |
| Engineer | Declare incidents, register services, run investigations, propose actions, approve low- and medium-risk actions |
| Admin | Also: manage members, API keys, integrations and settings; approve high-risk actions; read the audit log |
| Owner | Everything |

### 2. Register your services

Under Services, add each service you want to investigate. **The slug matters**: incoming data is matched to a service by its slug (or id), so use the name your systems already use, for example `checkout-service`. Add what each service depends on; investigations follow dependencies.

### 3. Create an API key

Settings → API keys (admins and owners). Choose the scopes for what you will send. The key is shown once; store it where your CI system and services keep secrets. Only a hash of it is kept, so it cannot be shown again. Revoke and replace it if it leaks.

### 4. Send data

Each source on the Integrations page has an example request under "How to connect". For instance:

```bash
curl -X POST https://opsilume.example.com/api/v1/logs \
  -H "x-api-key: $OPSILUME_API_KEY" -H "content-type: application/json" \
  -d '{"service":"checkout-service","logs":[{"level":"error","message":"timeout acquiring connection from pool"}]}'
```

Logs and metrics matter most: without either, an investigation has nothing to judge by and will say so. Deployments are what make "what changed?" answerable.

### 5. Check that it arrived, and that it belongs to your services

The Integrations page refreshes itself. For each source it shows one of:

| Shown | Meaning |
|---|---|
| Not set up | No key with that scope and no data |
| Set up, not yet verified | A key exists; nothing has been sent with it |
| Connected, no data yet | A key was used, or a token was accepted, but nothing usable has arrived |
| Receiving data | Data was accepted, recently, for registered services |
| Needs attention | The last request was rejected, a continuous source has been quiet for a day, or data names services that are not registered |
| Not working | A connection check failed |

A saved key or token never counts as working by itself. If a request is rejected, the page says which field was wrong (never what you sent). If data names a service that is not registered, it is listed under "Data that belongs to no service": register a service with that slug and, for log lines already stored, give them to it there.

### 6. Connect GitHub and the remediation webhook, if you want them

Settings → GitHub: save a token (it is checked against GitHub before it is stored), connect repositories under Code changes and link each to its service. "Check connection" on the Integrations page asks GitHub again at any time.

Settings → Organisation: set the remediation webhook address and secret. "Send a test request" sends one signed request with the event `ping` and no action. **Your receiver must ignore events it does not know**, and should verify the signature (`X-OpsPilot-Signature`, HMAC-SHA256 of the body) and honour `Idempotency-Key`.

### 7. Investigate

Declare an incident (Incidents → Declare incident), link the affected services, and choose "Investigate with AI". Or ask a question about a service under Investigations without an incident. On the rule-based engine an investigation takes a few seconds.

## Reading a report

Open an investigation and choose **Report to share** for a version written to be read by someone who was not there; it prints, and saves as a PDF from the browser's print dialog.

| Section | What it is |
|---|---|
| Conclusion | Whether there is a fault at all: **Incident** (a failure, with a supported explanation), **Degraded** (something is wrong, cause not established), **Healthy** (no material evidence of a fault), **Undetermined** (too little data to say). With the services and period examined, and a confidence that reflects how much could be examined |
| Most probable cause | A **hypothesis**, with its own confidence, the evidence for it, the evidence against it, what was assumed, and what would confirm or refute it. Other explanations considered are listed below it |
| What is established | **Facts**, each citing evidence. A figure that the cited evidence does not support is marked where it stands |
| Deployments and changes | What was released or changed, from the evidence, with times |
| What is not known | What could not be checked and what was not examined. Read this before acting |
| Recommended next steps | **Recommendations**, and any proposed action with what it would do, its risk and the approvals it needs |
| Evidence referred to | Every record the report cites |

To inspect evidence, use the investigation page itself: the Evidence timeline lists every item gathered, and "Open source" on an item goes to the deployment, log pattern or incident it came from. Agent steps shows each query that was made and what it returned.

Two things to keep in mind. The confidence in the conclusion and the confidence in the hypothesis are different numbers and mean different things. And for an incident that is over, health is taken from the alerts, incidents and metrics recorded at the time; where nothing was recorded, the report says the state at the time is not on record rather than assuming it was fine.

## How approvals work

An investigation may propose actions. Each is classified by what it would do:

- **Read-only check** (look at a dashboard, compare a metric): needs no approval. A person does it and records what they found.
- **Changes production** (roll back, restart, change configuration, anything unclear): needs approval before it can be carried out.

For a change:

1. Someone submits it for approval. From then on, approvals are bound to its exact content.
2. The required number of people approve: by default one for low and medium risk, two for high risk (Settings → Organisation). High risk needs an admin or owner. Nobody can approve what they proposed or requested, unless your organisation switches that rule off.
3. Editing the action afterwards cancels the approvals given. The approvals are counted again at the moment of execution.
4. It is carried out: sent to your webhook if you configured one, otherwise done by a person who then confirms it. A webhook that times out or fails is recorded as **outcome unknown**, never as done, and cannot be retried until a person confirms that nothing was applied.

API keys and the analysis itself can never approve or execute anything. Everything is in the audit log (Settings → Audit log).

## Security and credentials

What is true of the software as written; how you run it is up to you.

- **Isolation.** Every query is scoped to the caller's organisation. One installation can hold several organisations; they cannot see each other's data.
- **Passwords** are hashed with bcrypt. **API keys** are stored only as a SHA-256 hash. **GitHub tokens and webhook secrets** are encrypted at rest with AES-256-GCM under the installation's `ENCRYPTION_KEY`; whoever holds that key and the database can read them. None of these is ever returned by the API or shown in the interface after it is saved.
- **Logs you send** are scanned for common secret and personal-data patterns, which are masked before storage. This is on by default (Settings → Organisation) and is a filter, not a guarantee: do not send secrets on purpose.
- **Outbound requests.** The remediation webhook may only target public addresses; private, loopback and link-local addresses (including cloud metadata addresses) are refused when saved and again before each request. Redirects are not followed and the receiver's answer is not stored.
- **The analysis is read-only.** It reaches your data through a token that is valid for one investigation and only for read endpoints.
- **With a language model configured**, evidence from your data (log lines, commit messages, incident text) is sent to that provider. With the rule-based engine nothing leaves the installation. The Integrations page says which is active.
- **Audit log.** Sign-ins, changes, approvals, executions, integration checks and every query the analysis makes are recorded with who and when.
- **Rate limits.** 1,200 requests a minute per client address; sign-in and registration are limited more tightly.

Things you should know are *not* there: single sign-on, IP allow-lists, customer-managed keys, per-key rate limits, an idempotency key on ingestion (a batch that is retried is stored twice), and any external audit or penetration test.

## Known limitations

- **Verified on the rule-based engine only.** A language model was last run against this code several milestones ago, and not at all against the current report format. The rule-based engine correlates timing, services and keywords; it cannot read a diff or reason about a mechanism, and it says so in every report.
- **One machine, no load testing.** One worker, one PostgreSQL, one Redis. How it behaves with large log volumes or many simultaneous investigations is not known. There is no backup or restore procedure; take your own database backups.
- **Push only.** Nothing is collected for you (see Supported integrations).
- **GitHub has not been run against github.com** with a real token.
- **Health in the past is reconstructed** from alerts, incidents and metrics, not replayed. A service that was unhealthy with no alert rule covering it looks healthy in retrospect.
- **An interrupted investigation is not resumed.** If the worker restarts mid-run, the investigation is marked failed and you start it again.
- **No e-mail or chat notifications.** Notifications appear in the application only.
- **Logs are kept for 30 days by default** (configurable per organisation, 1 to 365).
- The engineering detail behind these is in [reliability-readiness-report.md](reliability-readiness-report.md) and [reliability.md](reliability.md).

## Removing a trial organisation

When the trial is over, the operator of the installation can remove the organisation and everything in it: services, incidents, investigations, logs, metrics, deployments, keys, settings and its audit log.

```bash
npm run org:remove -- your-org-slug                              # shows what would be removed; removes nothing
npm run org:remove -- your-org-slug --confirm your-org-slug      # removes it
```

The slug is in Settings → Organisation. The first form prints the database it is connected to and a count of everything the organisation holds. The second removes it in a single transaction, and rolls back unless every other organisation's data is exactly as it was before. It cannot be undone, so take a database backup first if there is anything you might want.

User accounts are kept by default, because an account can belong to several organisations. To also delete the accounts that belonged only to this one, add `--delete-sole-members`. Accounts that belong to another organisation are never deleted.

Before removing: revoke the API keys or stop the senders (requests with a removed organisation's key are refused with 401), and remove the webhook on the GitHub side if you created one.

The Acme Commerce sample dataset is a separate thing with its own commands; see [manual-demo-testing.md](manual-demo-testing.md).

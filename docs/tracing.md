# Tracing OPSILUME itself

OPSILUME's own services emit OpenTelemetry traces when asked to. One investigation is one
trace: the HTTP request that starts it, the queued job, the worker, the AI service and every
read-only tool call the AI service makes back into the API.

Tracing is off by default and local only. Nothing is sent anywhere unless `OTEL_ENABLED=true`,
and then only to the endpoint you configure.

This is separate from the traces OPSILUME *reads* as evidence (`TRACES_URL`, the `get_traces`
tool, the demo's `demo-jaeger`). Those belong to the systems being investigated. The two are
kept in different stores so that the platform never analyses its own telemetry by accident.

## Try it

```bash
npm run tracing:up                    # the application with tracing on, plus a local trace store
# start an investigation in the UI (http://localhost:3000) or through the API
npm run trace -- <investigation id>   # or: npm run trace -- --latest
```

`npm run trace` prints the trace as a tree, checks that every hop of the lifecycle is in it,
and gives a link to the same trace in the Jaeger UI at <http://localhost:16687>. Add `--all`
to include single Redis commands and connection spans. It exits 1 when a hop is missing, so it
can be used as a check.

`npm run tracing:up` uses whichever engine `.env` selects. To be certain that no paid model is
called, start it as `AI_PROVIDER=deterministic npm run tracing:up`.

`npm run tracing:down` removes the trace store and restarts the application without tracing.
Traces are held in memory (2,000 at most) and are gone when the store stops.

Running the services on the host with `npm run dev` works the same way: set `OTEL_ENABLED=true`
in `.env` (the default endpoint, `http://localhost:4318`, is the store's published port) and
start the store alone with `docker compose --profile tracing up -d tracing`.

## What a trace contains

| Service | Span | What it is |
| --- | --- | --- |
| `opspilot-api` | `POST /api/v1/investigations` | The request that started the investigation. Carries `opspilot.investigation.id`. |
| `opspilot-api` | `enqueue investigation` | The job being put on the queue. |
| `opspilot-worker` | `process investigation` | The worker running the job. Child of `enqueue investigation`. |
| `opspilot-worker` | `investigation.run` | The request to the AI service and the handling of everything it streams back. Ends with the engine, the outcome and the number of evidence items. |
| `opspilot-ai` | `POST /v1/investigations/run` | The AI service receiving the request. |
| `opspilot-ai` | `investigation` | The investigation itself, whichever engine runs it. |
| `opspilot-ai` | `tool <name>` | One read-only tool call. |
| `opspilot-api` | `GET /api/v1/tools/...` | The API serving that tool call. Carries `opspilot.investigation.id` and `opspilot.tool.path`. |
| `opspilot-worker` | `investigation.guardrails`, `investigation.persist` | The API's independent guardrail pass, and the storing of the report. |

Other background jobs (`knowledge-index`, `github-sync`, the schedulers) get the same
`enqueue` / `process` pair.

## How the context travels

| Hop | Mechanism | Where |
| --- | --- | --- |
| Browser or client → API | W3C `traceparent` header, if the caller sends one | HTTP instrumentation |
| API → queue | The trace context is stored inside the job, under `_trace`, when it is enqueued | `apps/api/src/queues/index.ts` |
| Queue → worker | The worker reads `_trace`, removes it, and runs the processor in a span that continues that trace. Processors never see it | `apps/api/src/queues/index.ts` |
| Worker → AI service | `traceparent` on the outgoing request | fetch instrumentation |
| AI service request → the task doing the work | The response is streamed after the handler returns, so the context is captured in the handler and given to the task explicitly | `services/ai/app/main.py` |
| AI service → API tools | `traceparent` on every tool request | `services/ai/app/tools.py` |

A job that is retried continues the same trace: the context is part of the job.

## What is kept out of spans

Spans leave the process, so they follow the rule that already applies to logs and audit
metadata: no credentials, nothing that identifies a person, and no text a person wrote.

Two things enforce this.

**The spans OPSILUME creates carry ids and counts only.** The investigation's id, the name of
a tool, the name of a queue, an HTTP status, the engine, token counts. Never the question, tool
arguments, log lines, prompts, model output, or an error message (a failed span records the
class of the error and nothing else).

**Every span is scrubbed on its way out, whoever created it.** Most attribute names are chosen
by instrumentation libraries, so the exporter in each service is wrapped by a filter
(`apps/api/src/lib/tracing.ts`, `services/ai/app/tracing.py`):

- attributes whose name mentions authorization, cookies, tokens, secrets, passwords, API keys,
  credentials, e-mail or a user are dropped, and so are client addresses;
- URLs lose their query string, and a token that is part of a path
  (`/auth/invitations/<token>`) is replaced;
- database and Redis statements keep only the operation (`hset`, `SELECT`);
- bearer tokens, JWTs, Anthropic and OPSILUME keys and e-mail addresses that appear inside any
  other value, including event attributes, are masked.

The cases are in `contracts/fixtures/span-scrubbing.json`. Both test suites run them, so the
two implementations cannot drift apart. In addition, the Redis instrumentation is configured
to record the command name only, and health checks and metric scrapes are not traced.

Ids are not secret, but a trace store is still a place where operational detail accumulates.
Point `OTEL_EXPORTER_OTLP_ENDPOINT` only at a collector you control.

## Tests

- `apps/api/tests/tracing.test.ts` runs a real BullMQ job on Redis and checks that the
  worker's spans join the trace of the request that queued it, that the spans have the right
  parents, and that neither the question nor a name nor a credential is exported.
- `services/ai/tests/test_tracing.py` checks that the investigation continues the trace it was
  called with (through the streamed response), that every tool request carries the trace
  context, and that tool arguments and upstream error messages stay out of spans.

Neither needs a trace store: spans are collected in memory.

## Limits

- Prisma's database queries are not traced (that needs `@prisma/instrumentation`, which is not
  installed). Time spent in the database shows up as time inside the surrounding span.
- The browser does not start traces. A trace begins at the API.
- Calls to a model provider are not broken out into spans of their own; the `investigation`
  span records token counts at the end.
- The local store is in memory and unauthenticated. It is a development tool, bound to
  `127.0.0.1`, not a production tracing backend.

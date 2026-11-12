# Architecture

## System overview

```
 Browser ──HTTP──▶ Web (Next.js :3000) ──/api/* proxy──▶ API (Express :4000) ──▶ PostgreSQL + pgvector
                                                          │        ▲
 CI/CD, log shippers ──API key──────────────────────────▶ │        │ read-only tool API (short-lived token)
 GitHub ──signed webhook────────────────────────────────▶ │        │
                                                          ▼        │
                                                   Redis (BullMQ)  │
                                                          │        │
                                                          ▼        │
                                                   Worker ──HTTP──▶ AI service (FastAPI :8000) ──▶ LLM provider (optional)
 MCP client (Claude Desktop/Code) ──stdio──▶ MCP server ──API key──▶ API tool API
```

| Component | Technology | Responsibility |
|---|---|---|
| Web | Next.js 15, React 19, Tailwind 4, TanStack Query, Recharts | The user interface. Holds no business logic and no secrets. |
| API | Node 22, Express 5, TypeScript, Prisma 6, Zod | System of record. Auth, RBAC, tenancy, validation, all reads and writes, audit. |
| Worker | Same codebase as the API, BullMQ | Investigations, knowledge indexing, GitHub sync, alert evaluation, retention. |
| AI service | Python 3.12, FastAPI, LangGraph, LangChain, Anthropic SDK | Embeddings and the investigation agent. Stateless; no database access. |
| PostgreSQL 16 | pgvector, pg_trgm | All data, vector search, trigram and full-text search. |
| Redis 7 | | Job queues and schedules. |

## Boundaries and why they are where they are

**The API owns the data.** The AI service cannot reach the database. Everything the agent learns comes through `GET /api/v1/tools/*`, authenticated with a JWT that is scoped to one organisation, valid for 30 minutes, and accepted only by that router. A prompt-injected or misbehaving model can therefore read one organisation's operational data and nothing else, and can write nothing.

**The model never produces evidence.** Tools return records; `evidence.py` turns each record into a numbered evidence item (E1, E2, …) that keeps the record's id. The model can only cite those numbers. Citations that do not exist are removed by guardrails in the AI service and again in the API before anything is stored.

**Production changes need people.** The agent's recommendations are stored as `PROPOSED` remediation actions. Moving one forward requires a signed-in user at every step, and the approval routes reject API keys and tool tokens outright.

## Request lifecycle (API)

1. `helmet`, CORS, cookie parsing, JSON parsing (raw body kept for webhook signatures), request log, metrics.
2. `authenticate` resolves a session cookie, bearer token or API key into `req.auth = { organizationId, role | scopes, … }`. Membership is re-read each request, so role changes and removals apply immediately.
3. `requirePermission(...)` checks the role's permissions or the key's scopes.
4. The handler validates input with Zod, runs queries filtered by `organizationId`, writes an audit entry for mutations.
5. Errors of every kind become `{ error: { code, message, details? } }` in one error handler.

## Investigation flow

```
POST /investigations ─▶ row QUEUED ─▶ BullMQ ─▶ worker ─▶ POST ai:/v1/investigations/run (NDJSON stream)
                                                              │
        ┌──────────── LangGraph ──────────────────────────────┤
        │ orient   load service catalogue and incident context, fix scope and time window
        │ plan     structured plan (model) or the standard playbook
        │ agent ⇄ tools   model chooses tools; calls run in parallel      (LLM configured)
        │ collect  fixed playbook of tool calls                           (no LLM)
        │ analyse  structured report from evidence (model) or rule-based correlation
        │ guard    citation, confidence and wording rules
        └──────────────────────────────────────────────────────┘
   worker persists each event as it arrives: steps, evidence, then hypotheses + report,
   and creates PROPOSED remediation actions from the recommendations
```

The UI polls the investigation while it runs, so steps and evidence appear live. Cancelling sets the status; the worker notices on the next event and aborts the stream.

### Analysis engines

| Engine | When | How it reasons |
|---|---|---|
| Anthropic (official SDK) | `ANTHROPIC_API_KEY` set | Tool use with adaptive thinking; structured report via `messages.parse` |
| OpenAI / Ollama (LangChain chat models) | key set / local model present | `bind_tools` and `with_structured_output` |
| Rule-based | nothing configured, or the model call fails | Finds the onset of the dominant error pattern, scores changes that preceded it by timing, service match, keyword overlap between the change and the errors, metric shifts and matching documentation; never above 75% confidence |

Every report states which engine produced it.

### Guardrails

| Layer | Rule |
|---|---|
| Input | Control characters stripped; instruction-like phrases in the question are flagged in the steps and treated as data. Questions, incident text and tool output are wrapped as untrusted data in prompts. |
| Tools | Read-only, argument-validated, bounded result size, 24 calls and 10 rounds per investigation. |
| Output (AI service) | Unknown citations removed; uncited "facts" become assumptions; hypotheses without evidence capped at 30%; confidence capped at 90% (model) or 75% (rules); a rollback proposal must cite a deployment; "confirmed root cause" wording rewritten. |
| Output (API) | The same citation and confidence checks are re-applied to whatever the AI service returned, against the evidence actually stored. `rootCauseConfirmed` can only be `false`. |

## Knowledge base (RAG)

Documents are split on Markdown headings, then packed into chunks of about 1,200 characters with a 150-character overlap. Each chunk is embedded together with its title and heading trail and stored in a `vector(768)` column with an HNSW cosine index. Search runs a vector query and a PostgreSQL full-text query and merges them with reciprocal rank fusion. Each document records which embedding model produced its vectors; vector search only considers documents embedded with the model in use now. If embedding fails, chunks are stored without vectors and remain keyword-searchable.

## Remediation lifecycle

```
PROPOSED ─▶ PENDING_APPROVAL ─▶ APPROVED ─▶ EXECUTING ─▶ EXECUTED
   │              │                 │            └────▶ FAILED ─(retry)─▶ APPROVED
   └─ CANCELLED ◀─┴─ REJECTED       └─ CANCELLED
```

Required approvals come from organisation settings by risk level (defaults 1 / 1 / 2). Approvers must differ from the proposer and requester unless self-approval is switched on. High-risk actions need an admin or owner. State changes use conditional updates, so two simultaneous requests cannot both succeed. Execution either POSTs an HMAC-signed payload to the organisation's webhook, or records an operator's attestation that they performed the action; both are mirrored onto the service's deployment or event history.

## Security summary

- Passwords: bcrypt (cost 12). Sessions: 15-minute JWT access token and a rotating 30-day refresh token, both in `HttpOnly`, `SameSite=Lax` cookies. Reuse of a rotated refresh token revokes all of that user's sessions.
- API keys: shown once, stored as SHA-256 hashes, limited to explicit scopes.
- Stored integration secrets: AES-256-GCM with `ENCRYPTION_KEY`.
- Webhooks in: GitHub HMAC-SHA256 over the raw body, constant-time comparison. Webhooks out: HMAC-signed.
- Rate limits: 20/min on auth endpoints, 1,200/min per IP on the API.
- Logs: credentials masked at ingestion; request logs carry method, path and status only.

## Observability

- **Logs:** structured JSON (pino in Node, JSON lines in Python).
- **Metrics:** Prometheus at `/metrics` on the API and AI service: HTTP duration by route, logs ingested, job counts and durations, investigations by outcome and provider, LLM tokens.
- **Traces:** OpenTelemetry auto-instrumentation in the API and worker and FastAPI instrumentation in the AI service, exported over OTLP when `OTEL_ENABLED=true`.
- **Health:** `/health` (liveness) and `/ready` (database and Redis).

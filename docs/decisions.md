# Decision log

Newest last. Each entry: what was decided, why, and what it costs.

### 1. Monorepo with npm workspaces and one Python service
`apps/api`, `apps/web`, `services/ai`. One repository keeps the report contract, tool API and UI in step. The Python service uses `uv` and is not an npm workspace.

### 2. Started from an empty repository
The brief mentioned an existing React dashboard and Express API, but the project folder was empty and no such code was found on disk or in the owner's GitHub account. The owner chose to start fresh.

### 3. Pinned to mature major versions
At build time the newest majors were TypeScript 7, Prisma 7/8-rc, Next 16, Zod 4, Vitest 5, BullMQ 6 and ioredis 6. The project pins TypeScript 5.9, Prisma 6.19, Next 15.5, Zod 3.25, Vitest 3.2, BullMQ 5 and ioredis 5 for stability and well-understood behaviour. Cost: an upgrade pass later.

### 4. The API is the only component that touches the database
The AI service gets data through a read-only tool API instead of a database connection. This gives one place for tenancy and permissions, makes the agent's reach auditable (every tool call is in the audit log), and lets the MCP server reuse the same tools. Cost: an HTTP hop per tool call (a few milliseconds locally).

### 5. Milestone order changed
Planned M5 (GitHub) → M6 (queues) → M7 (auth). Built instead: auth, RBAC and tenancy first with the data model, then the queue layer, then features. Every table needs the tenant key and every route needs permissions, so retrofitting them would have meant rewriting each module. Testing was also done per feature rather than as a late milestone.

### 6. Session cookies behind a same-origin proxy
The web app proxies `/api/*` to the API, so auth uses `HttpOnly`, `SameSite=Lax` cookies and the browser never handles tokens in JavaScript. Short access tokens with rotating refresh tokens; replaying a rotated token revokes the user's sessions.

### 7. Three analysis engines, one of them without a model
Claude, OpenAI/Ollama, and a deterministic rule-based engine. The rule-based engine exists because the product must work with no credentials and must never pretend: without a model it still gathers real evidence and correlates it with explicit rules, labels the result as heuristic, and caps confidence at 75%. It is also the fallback when a model call fails mid-investigation.

### 8. Claude through the official Anthropic SDK; other providers through LangChain
The agent loop speaks LangChain message types and LangGraph orchestrates it. Claude is called with the official SDK so current API behaviour is used directly: adaptive thinking (no thinking budget, no sampling parameters), `output_config.effort`, no forced `tool_choice`, and `messages.parse` for structured output. Thinking blocks are replayed unchanged during the tool loop. Default model `claude-opus-5-5`, effort `medium`, both configurable.
Not enabled: Anthropic's server-side refusal fallback (a beta parameter). A refusal is reported as an error and the investigation falls back to the rule-based engine. Enable it in `AnthropicProvider` if refusals turn out to matter in practice.

### 9. Evidence is extracted by code, not written by the model
The model cites evidence numbers; it cannot create evidence. This is the main defence against fabricated logs, commits or metrics, and it is enforced twice (AI service and API).

### 10. 768-dimension vectors for every embedding provider
One fixed `vector(768)` column. OpenAI `text-embedding-3-small` is requested at 768 dimensions, Ollama `nomic-embed-text` is natively 768, and the built-in local embedding hashes words, bigrams and character trigrams into 768 buckets. The local one matches wording rather than meaning; hybrid search with full-text ranking compensates. Each document records its embedding model so vectors from different models are never compared.

### 11. Hybrid retrieval with reciprocal rank fusion
Vector and full-text results are merged by rank, not by score, because the two scores are not on comparable scales. Keyword-only fallback when embeddings are unavailable.

### 12. Remediation does not touch infrastructure
OpsPilot has no credentials for anyone's production. An approved action is either dispatched to a signed webhook the organisation configures, or performed by an operator who attests to it. This is honest about what the software does, and keeps "execute" from being a simulated success.

### 13. Sample GitHub data is opt-in and labelled
The mock adapter is used only for repositories explicitly created as "sample". Its commits and pull requests are flagged in the API, the UI and the agent's tool output. Without a token the real adapter still works for public repositories.

### 14. Logs and metrics in PostgreSQL
Simple to run locally, and adequate at this scale with time-window, trigram and fingerprint indexes. A dedicated store is the scaling path (see database-design.md).

### 15. Integration tests against a real database
API tests run through HTTP against PostgreSQL (`opspilot_test`) with jobs executed inline, and replace only the Python service with a scripted double. Tenancy, constraints, raw SQL and pgvector are therefore actually exercised. Each test creates its own organisation, so tests do not interfere.

### 16. Chart colours
Charts use a palette validated for colour-vision deficiency: status colours (critical, serious, warning) only for severity and error series, blue for a single measured series, one y-axis per chart, a legend for two or more series, and a screen-reader table behind every chart.

### 17. Git workflow
GitFlow-style: `main` for releases, `develop` for integration, `feature/*` and `bugfix/*` merged into `develop` with `--no-ff`, `release/*` and `hotfix/*` into `main` with a back-merge (see git-workflow.md). Commit messages follow Conventional Commits and carry no AI or tool attribution; a small shell hook checks both, locally and in CI, instead of adding a commit-lint dependency. The first seven backend branches were cut from work that already existed when the workflow was requested, so their intermediate commits are not individually runnable; from the AI service onward each branch was tested before merging.

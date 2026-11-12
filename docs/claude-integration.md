# Claude integration

How OpsPilot uses Anthropic's Claude for incident investigation, how to turn it on, what it costs, and what stops it spending more than you intend.

## What Claude does and does not do

Claude does the reasoning. OpsPilot does everything else.

| Step | Who does it |
|---|---|
| Load the incident and service catalogue | OpsPilot |
| Write the investigation plan | Claude (structured output) |
| Choose which tools to call, and with what arguments | Claude (tool use) |
| Run the tools: logs, deployments, commits, pull requests, service events, metrics, past incidents, knowledge base | OpsPilot's read-only tool API |
| Turn each returned record into a numbered evidence item (E1, E2, …) | OpsPilot code. Claude cannot create evidence |
| Analyse the evidence, rank hypotheses, state what supports and contradicts each, what is missing, and what to check next | Claude (structured output) |
| Check every citation, cap unsupported confidence, forbid "confirmed" claims | OpsPilot guardrails, in the AI service and again in the API |
| Store the report; create remediation **proposals** | OpsPilot |
| Approve and execute remediation | People only |

Claude never approves or executes anything, never writes to your data, and can only read one organisation's records through a token that is valid while its investigation is running.

The report separates verified facts (each with evidence references), hypotheses (ranked, with confidence), supporting evidence, contradicting evidence, assumptions, missing evidence, and recommended next steps.

## The three engines

Every investigation is labelled in the interface with the engine that produced it.

| `AI_PROVIDER` | Engine | Label in the UI | Cost |
|---|---|---|---|
| `anthropic` (or `auto` with a key) | Claude through the Anthropic API | "Claude · model name" | Paid API credit |
| `deterministic` (or `auto` with no key) | Rule-based correlation. Gathers the same evidence with a fixed playbook and scores it by timing and keyword overlap | "Rule-based engine · no AI model" | None |
| `mock` | A scripted stand-in that drives the model code path with canned output | "Mock AI · no model was called" | None |

If Claude is configured but fails during an investigation (bad key, no credit, limit reached, outage), the rule-based engine finishes the job and the investigation is labelled "Rule-based engine · Claude was unavailable", with the reason listed in the report.

`openai` and `ollama` are also supported through the same interface; adding another provider means implementing two methods (`invoke`, `structured`) in `services/ai/app/llm.py`.

## Turning it on

You need an Anthropic API key. **Never paste it into a chat, a ticket or a commit.**

1. **Get API credit.** Sign in at <https://console.anthropic.com>. If your Claude plan includes monthly API credits, claim them in the Console's billing section. API credit is separate from Claude subscription usage: using Claude Code or claude.ai does not spend it, and it does not top up your subscription.
2. **Leave auto-reload off.** In Console → Billing, make sure automatic credit purchase / auto-reload is disabled, so nothing is charged when the credit runs out. Optionally set a monthly spend limit there as well. OpsPilot cannot buy credit and never tries to.
3. **Create a key.** Console → API keys → Create key. Name it `opspilot-local`. Copy it once.
4. **Put it in your local `.env`** (the file is git-ignored). Open `.env` in your editor and set:

   ```bash
   AI_PROVIDER=anthropic
   ANTHROPIC_API_KEY=<paste the key here>
   ANTHROPIC_MODEL=claude-haiku-5-5
   ```

   Or, without the key ever appearing on screen or in shell history:

   ```bash
   read -s -p "Anthropic API key: " K && \
     sed -i '' "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$K|; s|^AI_PROVIDER=.*|AI_PROVIDER=anthropic|" .env && unset K
   ```

5. **Restart the AI service** so it reads the new value:

   ```bash
   docker compose --profile app up -d ai        # Docker
   # or restart `npm run dev:ai` when developing on the host
   ```

6. **Check it, for free.** Settings → System → **Check API key and model**, or:

   ```bash
   cd services/ai && uv run python -m app.live_check --verify
   ```

   This looks the model up through Anthropic's Models API. It proves the key and model id are valid and uses no tokens.

7. **Run one tiny live inference** (one request, capped at 64 output tokens — a fraction of a cent on Haiku):

   ```bash
   cd services/ai && uv run python -m app.live_check
   ```

8. **Run a real investigation.** Open incident INC-10 → **Investigate with AI**. The result should be labelled "Claude · claude-haiku-5-5" and show model calls, tokens, latency and an estimated cost.

To go back to no-cost operation at any time: set `AI_PROVIDER=deterministic` and restart the AI service.

## Models

Identifiers checked against Anthropic's models overview page on 12 November 2026. They are dateless; do not add a date suffix.

| Model | `ANTHROPIC_MODEL` | List price per million tokens (input / output) | Use for |
|---|---|---|---|
| Claude Haiku 5.5 | `claude-haiku-5-5` | from $0.10 / $0.50 | Default. Development, testing, routine investigations |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | $2 / $10 | Harder incidents |
| Claude Opus 5.5 | `claude-opus-5-5` | $4 / $20 | The most difficult cases |

`ANTHROPIC_EFFORT` (`low` to `max`, default `medium`) sets how deeply Claude reasons; higher effort uses more tokens. Current Claude models reject sampling parameters, so `AI_TEMPERATURE` applies to OpenAI and Ollama only.

## Spending safeguards

| Safeguard | Setting | Default |
|---|---|---|
| Lowest-cost model by default | `ANTHROPIC_MODEL` | `claude-haiku-5-5` |
| Output cap per model call | `AI_MAX_TOKENS` | 8000 |
| Cost limit per investigation | `AI_MAX_COST_USD_PER_INVESTIGATION` | $0.50 |
| Token limit per investigation | `AI_MAX_TOKENS_PER_INVESTIGATION` | 400,000 |
| Tool calls and rounds per investigation | built in | 24 calls, 10 rounds |
| Daily cost limit per organisation | `AI_DAILY_COST_LIMIT_USD` | $5 |
| Investigations per organisation per day | `INVESTIGATION_DAILY_LIMIT` | 50 |
| Concurrent investigations per organisation | `INVESTIGATION_MAX_CONCURRENT` | 3 |
| Request timeout | `AI_REQUEST_TIMEOUT_SECONDS` | 120 |
| Retries per call (rate limits, timeouts, server errors only) | `AI_MAX_RETRIES` | 2 |

How the limits behave:
- At 80% of an investigation's limit Claude stops gathering evidence and the remainder is kept for writing the report. At 100% no further call is made and the rule-based engine completes the report.
- When an organisation's daily limit is reached, starting an investigation returns a clear "limit reached" message. Limits reset at midnight UTC.
- **Exhausted credit** is detected from Anthropic's response. The investigation stops calling the model at once, completes with the rule-based engine, and says that the account has no available credit. Nothing is retried and nothing is purchased.
- A rejected key or an unknown model stops model calls the same way.

What keeps each call small:
- Only retrieved, relevant records are sent: tool results are capped in size, and the final report is written from the evidence catalogue rather than from raw tool output. The database and full logs are never sent.
- Prompt caching is enabled on the tool loop, so the system prompt, tool definitions and earlier turns are read from cache on each round after the first.
- The plan and the report are one call each.

## Monitoring usage and cost

| Where | What you see |
|---|---|
| An investigation's page | Engine, model, number of model calls, input and output tokens, latency, estimated cost |
| Investigations page | Today's count and estimated spend against the limits |
| Analytics | Estimated model spend and tokens for the period |
| Prometheus / Grafana | `opspilot_ai_llm_tokens_total`, `opspilot_ai_llm_estimated_cost_usd_total` |
| Anthropic Console → Usage | What was actually billed. **This is the source of truth** |

Costs shown in OpsPilot are estimates from published list prices (table in `services/ai/app/config.py`). For a model that is not in the table, cost is shown as unknown rather than zero; set `AI_PRICE_INPUT_PER_MTOK` and `AI_PRICE_OUTPUT_PER_MTOK` to supply prices.

## Security

- The key is read from the environment only. It is never logged, returned by any endpoint, stored in the database or included in an error message; key-shaped strings are scrubbed from errors and logs as a second line of defence. The status endpoint reports only whether a key is present.
- With Claude enabled, evidence retrieved for an investigation (log lines, commit messages, incident text, runbook sections) is sent to Anthropic. Log redaction, on by default, masks credentials when logs are ingested.
- Text inside retrieved records is marked as data for the model, and instruction-like content in it is flagged in the investigation's steps.

## Testing

| Kind | Command | Calls Anthropic? |
|---|---|---|
| Provider tests with a mocked Anthropic API (requests, tool loop, caching, usage, every error type, limits) | `npm run test:ai` | No |
| Agent evaluations, rule-based engine | `npm run evals -- --heuristic` | No |
| Key and model check | `uv run python -m app.live_check --verify` | Yes, free |
| Minimal live inference | `uv run python -m app.live_check` | Yes, a fraction of a cent |
| Agent evaluations against the model | `npm run evals` (five investigations) | Yes, paid |

## Troubleshooting

| Message | Meaning | Fix |
|---|---|---|
| "ANTHROPIC_API_KEY is not set" | Provider is `anthropic` but no key | Add the key to `.env`, restart the AI service |
| "Anthropic rejected the API key (401)" | Key is wrong, revoked or mistyped | Create a new key in the Console |
| "no available API credit" | Balance is zero | Claim or add credit in the Console |
| "model was not found (404)" | `ANTHROPIC_MODEL` is not a valid id | Use one of the ids above |
| "reached its model spending limit" | Per-investigation limit hit | Raise the limit, or use a cheaper model or lower effort |
| "limit reached" when starting | Organisation daily limit | Wait for midnight UTC or raise the limit |
| "cut off at AI_MAX_TOKENS" | The answer was longer than the cap | Raise `AI_MAX_TOKENS` |
| Result labelled rule-based although Claude is configured | The model failed for that run | The reason is in the report under what is uncertain |

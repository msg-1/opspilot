# Learning log

Things that turned out to matter while building this, written for whoever works on it next.

## Prisma and pgvector
- Prisma cannot describe an HNSW index, and `prisma migrate dev` will try to drop one it did not create. It also waits for interactive input when it wants a migration name, which hangs in a non-interactive shell. The workflow that works: `migrate dev --create-only`, edit the SQL, `migrate deploy`.
- `Unsupported("vector(768)")` columns cannot be read or written through the Prisma client. Use `$executeRaw` / `$queryRaw` with the vector passed as text and cast: `${'[0.1,0.2]'}::vector`.
- Extensions must be created inside the migration (`CREATE EXTENSION IF NOT EXISTS vector`) so the shadow database and CI have them too.

## Multi-tenancy
- Filtering lists by `organizationId` is the easy half. The half that is easy to miss is validating ids that arrive in request bodies (a service id, an assignee id): without a check, a user can link their incident to another tenant's service. The tests in `auth.test.ts` cover both.
- Re-reading membership on every request costs one indexed query and means a removed user is locked out immediately instead of when their token expires.

## Background jobs
- Feature modules register their job processors with the queue module, and the queue module imports no feature module. That avoids circular imports and lets tests run the same processors inline without Redis.
- A cancel request cannot reach into another process. The worker re-reads the investigation's status as each event arrives and aborts when it sees `CANCELLED`.
- Status transitions that must happen once (approve, execute) use `updateMany` with the expected current status in the `where` clause and check the affected row count. That is a compare-and-swap in one statement.

## The investigation agent
- Detecting "when did it start" from the earliest error is wrong: every system has low-volume background errors. Using only patterns with at least 20% of the dominant pattern's volume fixed the first evaluation failure, where an unrelated SMTP retry dated the incident two hours early and excluded the real cause.
- A healthy service with a week-old deployment and six warnings should produce "no clear problem", not a 44% hypothesis. The engine checks for a real signal (high-volume errors, a sharp metric shift, a firing alert) before it trusts any correlation.
- Guardrail wording checks can damage correct text. A rule that rewrote "confirmed root cause" also rewrote "not a confirmed root cause". Negative lookbehind fixed it; a test now covers it.
- Evaluations paid for themselves immediately. Five small scenarios with known answers caught ranking mistakes that reading the code did not.
- Tool results should carry the service slug, not the display name. Mixing the two silently broke the "same service" rule.
- A scorer must be shown wrong answers. The first structured scorer accepted a placeholder hypothesis because it cited the right record, and passed a "precautionary" flag change because it was low risk. Both were found only by running a mock report through it and by reading real reports, not by the tests of correct answers.
- Inconsistent test data reads as a model failure. A scenario that said "week-old deployment" but dated it ten minutes before the warnings, and a log pattern with no log line behind it, were both reported by the model as things to check. A test now asserts that each scenario agrees with itself.
- Save the report before the guardrails touch it. That is what makes it possible to re-score real model output for free after changing the scorer or the guardrails.

## Claude API specifics
- Current Claude models reject `budget_tokens`, sampling parameters and forced `tool_choice`. Depth is controlled with `output_config.effort`; thinking is adaptive by default.
- During a tool loop the assistant's content blocks, including thinking blocks, must be sent back unchanged. The adapter keeps the raw blocks next to the LangChain message for that reason.
- All tool results for one assistant turn go back in a single user message.

## Frontend
- A Next.js page file may only export the page. Exporting a helper component from `page.tsx` fails the production build, not the dev server.
- Rewrites in `next.config.ts` are resolved at build time. The Docker image needs the API address as a build argument.
- A `<table class="sr-only">` still takes its natural width and can make a phone layout scroll sideways. Wrap it in a hidden `div`. The end-to-end test that measures horizontal overflow found this.
- Grid and flex children default to `min-width: auto`, so one long unbroken string widens the page. A global `min-width: 0` on those children makes truncation work.

## Docker
- Code that computes a path relative to the repository (`parents[3]`) breaks when the file sits at a different depth in the image. The AI container crashed on start for exactly this reason; the app reported "AI service is not reachable", which is how it was found.
- `node:22-slim` needs `openssl` installed for Prisma. The Prisma CLI must be a runtime dependency if migrations run from the image.

## Environment notes
- macOS uses port 5000 (AirPlay), so nothing here listens on it.
- The system Python on macOS is 3.9; `uv` installs and pins 3.12 for the AI service.
- MCP Python SDK 2.x renamed `FastMCP` to `MCPServer` and uses snake_case annotation fields.

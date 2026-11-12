# Contributing to OpsPilot

## Before you start

1. Set up a development environment: [docs/setup-guide.md](docs/setup-guide.md).
2. Enable the commit check: `git config core.hooksPath .githooks`.
3. Read [docs/git-workflow.md](docs/git-workflow.md). The short version:

```bash
git checkout develop && git pull --ff-only origin develop
git checkout -b feature/<short-name>        # or bugfix/<short-name>
# ...work...
npm run lint && npm run typecheck && npm test
git commit -m "feat(area): what changed"
git push -u origin feature/<short-name>
gh pr create --base develop --fill
```

## What a good change looks like

- **One logical change.** A feature, a fix, or a refactor; not all three.
- **Tested.** New behaviour has a test that would fail without it. API tests go through HTTP to a real PostgreSQL (`apps/api/tests`); they are quick to write with the helpers there.
- **Checked locally.** `npm run lint`, `npm run typecheck`, and the suites for what you touched:

  | You changed | Run |
  |---|---|
  | `apps/api` | `npm test -w @opspilot/api` |
  | `apps/web` | `npm test -w @opspilot/web`, and `npm run test:e2e` for flows |
  | `services/ai` | `npm run test:ai`, `npm run evals -- --heuristic`, `cd services/ai && uv run ruff check .` |
  | `prisma/schema.prisma` | Create the migration with `npm run db:migrate:new -w @opspilot/api -- --name <name>`, delete the generated `DROP INDEX "KnowledgeChunk_embedding_hnsw_idx"` line, then `npm run db:migrate` |

- **Documented.** Update `docs/` when behaviour, configuration or the API changes, and add a line to `CHANGELOG.md` under Unreleased.

## Rules that protect users

- Every query filters by the caller's organisation. Validate any id that arrives in a request body against that organisation.
- New routes declare a permission. Approval and execution routes stay limited to signed-in people.
- The AI agent is read-only. Do not add tools that change anything.
- Never log, commit or return secrets. Use the encryption helpers for stored credentials.
- Production-changing behaviour goes through the remediation approval flow.

## Commit messages

Conventional Commits with these types: `feat`, `fix`, `security`, `refactor`, `test`, `docs`, `chore`. Commits carry no AI or tool attribution lines. Details and examples: [docs/git-workflow.md](docs/git-workflow.md#commit-messages).

## Releases and urgent fixes

See [docs/release-process.md](docs/release-process.md).

## Reporting security problems

Do not open a public issue. Use a private security advisory on the repository, or contact the maintainer directly.

## What and why

<!-- One or two sentences: what this changes and the reason. Link the issue if there is one. -->

## Type

- [ ] `feature/*` → `develop`
- [ ] `bugfix/*` → `develop`
- [ ] `release/*` → `main`
- [ ] `hotfix/*` → `main`

## How it was verified

<!-- Commands run and what you observed. "CI is green" is not enough for behaviour changes. -->

## Checklist

- [ ] One logical change; unrelated changes are in separate pull requests
- [ ] Commits follow Conventional Commits and carry no AI or tool attribution
- [ ] Tests added or updated for the behaviour that changed
- [ ] `npm run lint`, `npm run typecheck` and the relevant test suites pass locally
- [ ] Documentation updated where behaviour, configuration or the API changed
- [ ] No secrets, tokens or personal data in code, tests, logs or screenshots
- [ ] Database change: migration created with `db:migrate:new`, reviewed, and the vector-index `DROP` removed
- [ ] Security impact considered (authentication, tenancy, permissions, input validation)

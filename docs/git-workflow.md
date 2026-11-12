# Git workflow

OpsPilot uses a GitFlow-style model: two long-lived branches and four kinds of short-lived branch.

## Branches

| Branch | Created from | Merges into | Purpose |
|---|---|---|---|
| `main` | — | — | Released, production-ready code. Changes only through release and hotfix merges. Every commit on it is tagged. |
| `develop` | — | — | Integration branch. Always passes CI. |
| `feature/<name>` | `develop` | `develop` | One logical feature |
| `bugfix/<name>` | `develop` | `develop` | A non-urgent fix |
| `release/<version>` | `develop` | `main`, then back into `develop` | Stabilising a release: version bump, changelog, fixes only |
| `hotfix/<name>` | `main` | `main`, then back into `develop` | An urgent fix to released code |

Names are lowercase with hyphens: `feature/log-live-tail`, `bugfix/login-throttle`, `release/0.2.0`, `hotfix/token-expiry`.

```
main     ●───────────────────────────●──────────●   (tags: v0.1.0, v0.1.1)
          \                         / \        /
release    \            ●──●──●────●   \      /
            \          /            \   hotfix ●
develop      ●──●──●──●──────────────●────────●──●
                 \   /        \     /
feature/bugfix    ●─●          ●───●
```

## Day-to-day: a feature

```bash
# 1. Start from an up-to-date develop
git checkout develop
git pull --ff-only origin develop

# 2. Create the branch
git checkout -b feature/log-live-tail

# 3. Work, then verify what you touched
npm run lint && npm run typecheck
npm test                                   # API + web   (needs: npm run infra:up)
npm run test:ai                            # if services/ai changed

# 4. Commit using Conventional Commits
git add -A
git commit -m "feat(logs): add live tail to the log explorer"

# 5. Push and open a pull request into develop
git push -u origin feature/log-live-tail
gh pr create --base develop --fill

# 6. After review and green CI, merge with a merge commit
gh pr merge --merge --delete-branch
```

A `bugfix/*` branch follows exactly the same steps.

### Without network access

`develop` and `main` are protected on GitHub, so a local merge cannot be pushed to them: changes arrive through a pull request whose checks pass. Working offline, run the checks yourself and keep the work on its feature branch until it can be pushed. In a private fork without protection, the local equivalent of a pull request is:

```bash
git checkout develop
git merge --no-ff feature/log-live-tail -m "Merge feature/log-live-tail into develop"
```

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org): `type(optional-scope): summary`.

| Type | Use for |
|---|---|
| `feat` | New behaviour visible to users or API clients |
| `fix` | A bug fix |
| `security` | A change whose purpose is to close a vulnerability or harden a control |
| `refactor` | Restructuring with no behaviour change |
| `test` | Tests only |
| `docs` | Documentation only |
| `chore` | Tooling, dependencies, build, CI |

Rules:
- Subject in the imperative, 100 characters or fewer, no trailing full stop.
- The body says why, and names the audit finding or issue it addresses when there is one.
- A breaking change has `!` after the type (`feat(api)!: …`) and a `BREAKING CHANGE:` paragraph.
- One logical change per commit.
- **No AI or tool attribution**: no `Co-Authored-By` lines for assistants and no "generated with" lines.

Enable the local check once per clone:

```bash
git config core.hooksPath .githooks
```

The same script runs in CI on every pull request.

## Pull requests

- Target `develop`, except `release/*` and `hotfix/*`, which target `main`.
- Fill in the template: what and why, how it was verified, the checklist.
- Keep them small enough to review in one sitting. Split unrelated changes.

### Review requirements

| Target | Approvals | Reviewer checks |
|---|---|---|
| `develop` | 1 | Correctness, tests for changed behaviour, tenancy and permission checks on new routes, no secrets |
| `main` | 1, from someone other than the author of the release branch | Changelog and version are right; the full verification in [release-process.md](release-process.md) passed |

With a single maintainer, the review is a self-review against the checklist, and the required CI checks are the gate.

### Merge policy

| Merge | Method | Why |
|---|---|---|
| `feature/*`, `bugfix/*` → `develop` | Merge commit (`--no-ff`) | Keeps each feature visible as a unit in history |
| `release/*`, `hotfix/*` → `main` | Merge commit (`--no-ff`) | The merge commit is what gets tagged |
| `release/*`, `hotfix/*` → `develop` (back-merge) | Merge commit | Brings release fixes back |

Never rebase or force-push `main` or `develop`. Rebasing your own unpublished feature branch is fine. Delete short-lived branches after merging.

## Continuous integration

| Workflow | Runs on | Jobs |
|---|---|---|
| `ci.yml` | Pull requests into `develop` and `main`; pushes to `develop`, `main`, `release/**`, `hotfix/**` | Commit messages · Frontend (lint, typecheck, unit tests) · Backend (lint, typecheck) · Database integration tests (PostgreSQL + pgvector) · AI service (lint, tests, agent evaluations) · Build verification (builds, dependency audit, container images) |
| `e2e.yml` | Pull requests into `main`; pushes to `release/**`, `hotfix/**`; manual | Starts the whole stack with Docker Compose and runs the browser tests |
| `release.yml` | Push of a `vX.Y.Z` tag | Checks the tag is on `main` and matches `package.json`, then publishes a GitHub release |

The repository is published at https://github.com/msg-1/opspilot. `ci.yml` runs on every pull request and has passed on `develop`; `e2e.yml` has passed on `release/0.1.0`. `release.yml` has never run, because no version tag has been pushed.

## Branch protection

Applied to `main` and `develop` on GitHub (pull request required, required checks, branch must be up to date, administrators included, no force pushes, no deletions). The required approval count is currently 0 because the project has one maintainer; raise it when there are reviewers. Recommended settings for a team:

**`main`**
- Require a pull request before merging; 1 approval; dismiss stale approvals
- Require status checks to pass, and require branches to be up to date:
  `Frontend (lint, typecheck, unit tests)`, `Backend (lint, typecheck)`, `Database integration tests (PostgreSQL + pgvector)`, `AI service (lint, tests, agent evaluations)`, `Build verification`, `Browser end-to-end tests`
- Require linear history: **off** (release merges are merge commits)
- Do not allow force pushes; do not allow deletions
- Apply to administrators

**`develop`**
- Require a pull request before merging; 1 approval (0 for a solo maintainer)
- Require the same checks except `Browser end-to-end tests`
- Do not allow force pushes; do not allow deletions

With the GitHub CLI, after the remote exists (replace `OWNER/REPO`):

```bash
gh api -X PUT repos/OWNER/REPO/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": [
    "Frontend (lint, typecheck, unit tests)", "Backend (lint, typecheck)",
    "Database integration tests (PostgreSQL + pgvector)", "AI service (lint, tests, agent evaluations)",
    "Build verification", "Browser end-to-end tests" ] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1, "dismiss_stale_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Use the same call for `develop` without `"Browser end-to-end tests"`. Branch protection on private repositories requires a paid GitHub plan; on a free plan it works for public repositories only.

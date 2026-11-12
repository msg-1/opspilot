# Release process

## Versioning

[Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

| Bump | When |
|---|---|
| MAJOR | A breaking change to the HTTP API, the tool API, configuration, or a migration that needs manual steps |
| MINOR | New features that are backwards compatible |
| PATCH | Fixes only |

While the version is `0.x`, the API is not yet stable and a MINOR release may contain breaking changes; say so in the changelog. Pre-releases use a suffix: `v0.2.0-rc.1`.

The version lives in the root `package.json`. Tags are `v` + that version.

## Cutting a release

```bash
# 1. Branch from an up-to-date, green develop
git checkout develop && git pull --ff-only origin develop
git checkout -b release/0.2.0

# 2. Prepare: version and changelog only; no new features on this branch
npm version 0.2.0 --no-git-tag-version
#    move the "Unreleased" entries in CHANGELOG.md under "## [0.2.0] - YYYY-MM-DD"
git commit -am "chore(release): 0.2.0"
git push -u origin release/0.2.0          # CI and the end-to-end workflow run

# 3. Full verification (below). Fix anything found on this branch with fix: commits.

# 4. Open a pull request into main; merge with a merge commit once it is approved and green
gh pr create --base main --title "Release 0.2.0" --body-file <(sed -n '/## \[0.2.0\]/,/## \[/p' CHANGELOG.md)
gh pr merge --merge

# 5. Tag the merge commit on main; the Release workflow publishes it
git checkout main && git pull --ff-only origin main
git tag -a v0.2.0 -m "OpsPilot 0.2.0"
git push origin v0.2.0

# 6. Bring the release back into develop
git checkout develop
git merge --no-ff release/0.2.0 -m "Merge release/0.2.0 into develop"
git push origin develop
git branch -d release/0.2.0 && git push origin --delete release/0.2.0
```

### Full verification

Everything must pass on the release branch before it merges into `main`.

```bash
npm ci
npm run lint && npm run typecheck
(cd services/ai && uv run ruff check .)
npm run infra:up
npm test                                   # API integration + web unit
npm run test:ai
npm run evals -- --heuristic               # and without --heuristic if a model is configured
npm run build
npm audit --omit=dev --audit-level=critical

# Whole stack from a clean database, on the deterministic engine: the browser tests
# refuse to run against a paid model, so they are repeatable and cost nothing
docker compose --profile app down -v
AI_PROVIDER=deterministic docker compose --profile app up -d --build --wait
npm run test:e2e
```

Also check by hand: sign in, open the demo incident, run an investigation, take the proposed action through approval, and confirm Settings → System shows every component healthy.

If the release contains a migration, apply it to a copy of real data first and note any manual step in the changelog.

## Hotfix

For a defect in released code that cannot wait for the next release.

```bash
git checkout main && git pull --ff-only origin main
git checkout -b hotfix/refresh-token-expiry

# fix, add a test that fails without the fix
npm version patch --no-git-tag-version     # 0.2.0 → 0.2.1
#   add a "## [0.2.1]" entry to CHANGELOG.md
git commit -am "fix(auth): honour refresh token expiry"
git push -u origin hotfix/refresh-token-expiry

gh pr create --base main --fill            # CI + end-to-end must pass
gh pr merge --merge

git checkout main && git pull --ff-only origin main
git tag -a v0.2.1 -m "OpsPilot 0.2.1" && git push origin v0.2.1

git checkout develop
git merge --no-ff hotfix/refresh-token-expiry -m "Merge hotfix/refresh-token-expiry into develop"
git push origin develop
```

If a release branch is open at the time, merge the hotfix into it as well.

## Rolling back a release

Do not rewrite `main`. Either release a hotfix, or revert the release merge and tag the revert as a new patch version:

```bash
git checkout -b hotfix/revert-0.2.0 main
git revert -m 1 <merge commit of the release>
```

Migrations are not reversed by a code revert; check whether the release changed the schema before choosing this route.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com). Every pull request that changes behaviour adds a line under **Unreleased** in one of: Added, Changed, Fixed, Security, Removed.

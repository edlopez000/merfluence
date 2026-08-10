# Runbook

Operational procedure for Merfluence: how to roll back, what levers exist, and
what the deploy pipeline will and will not do for you. Written for the case
where something is wrong in production and reconstructing this from the code is
the last thing you want to be doing.

Everything here describes the pipeline as it stands. If you change
[`ci.yml`](../.github/workflows/ci.yml),
[`deploy-production.yml`](../.github/workflows/deploy-production.yml), or
[`release-please.yml`](../.github/workflows/release-please.yml), change this too.

## Quick reference

| Situation                                      | Go to                                                           |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Bad code is live                               | [Roll back production](#roll-back-production)                   |
| Bad SVG is baked into cached diagrams          | [Bump `CACHE_VERSION`](#bump-cache_version)                     |
| Deploy says it worked, but it did not          | [Reading `verify-deploy`](#reading-verify-deploy)               |
| Merged to `main` and production did not change | [Nothing is wrong](#staging--production) — that is by design    |
| CI is green and staging is still bad           | [The deploy may not have fired](#the-deploy-may-not-have-fired) |

## Roll back production

Deploy the last-good tag through CI:

**Actions → [Deploy to production](../../actions/workflows/deploy-production.yml)
→ Run workflow → `tag: v1.0.2`** (`git tag --sort=-creatordate` for the list).

This is the same workflow a release uses, so the rollback keeps everything the
release path has: the `Release gates` job runs against that tag, the
required-reviewer pause still applies, the deploy is in the `forge-deploy`
concurrency group, and `verify-deploy` confirms the installation actually
advanced. Leave the branch as `main`; the `tag` input is what selects the code.

It still **leaves production diverged from `main`**, and nothing records that.
Cutting the next release redeploys the newer tag and silently undoes the
rollback. So a rollback buys time and nothing else — follow it with a revert on
`main`, and cut a release to ship the revert.

### Break glass: deploying from a laptop

If Actions itself is the thing that is broken:

```sh
git checkout v1.0.2          # the last-good tag
npm ci
npm run deploy:production    # build + forge deploy -e production
node scripts/verify-deploy.mjs production --verify
```

You need `FORGE_EMAIL` and `FORGE_API_TOKEN` exported in the shell — the same
credentials CI uses. Two things to know before you run it:

**This bypasses every gate.** A local deploy runs none of `corpus`, `lint`,
`size`, or `audit`, and no reviewer is asked. During an incident that is the
point; it is also the risk. You are shipping a tag you are trusting because it
was green once.

**It is not in the `forge-deploy` concurrency group.** That group only serialises
the CI jobs. A local deploy can race a release deploy that is mid-flight, and the
one that finishes last wins. Check the Actions tab before deploying by hand.

### Marketplace propagation

Minor updates reach installed instances without admin re-approval, typically
within about an hour. A rollback is a new deploy, so it propagates the same way —
it is not instant for end users.

## Bump `CACHE_VERSION`

The incident lever for bad output that is already **stored** rather than merely
rendered.

`CACHE_VERSION` lives in [`src/lib/cache.ts`](../src/lib/cache.ts) and is
currently **3**. Rendered SVG is cached in each macro's own config on the page;
bumping the constant makes every stored cache read as absent, so diagrams fall
back to a fresh render on view.

Reach for it when a render or sanitize bug means the SVG sitting in people's
pages is itself wrong. Fixing `sanitizeSvg` does not retroactively clean SVG that
was written to config by the old code.

**Be precise about what it buys.** The reader already re-sanitizes cached SVG
before injecting it — the cache is treated as attacker-controlled on every read,
not trusted because it was sanitized at save time. So for a sanitizer hole, the
fix to `sanitizeSvg` alone closes the exposure on the next page view; the bump is
what discards the bad stored bytes rather than re-cleaning them forever. For a
bug where the _stored SVG itself_ is wrong in a way sanitizing cannot fix — a
theme race, a wrong font, a mislabelled version — the bump is the only remedy.

When you bump it, add a note to the block comment at the top of `cache.ts` saying
what was wrong and what the bump discards. The `v2` and `v3` entries there are
the model.

Cost: every diagram renders fresh on next view until its page is re-saved in the
editor. Slower first paint, no data loss. The reader view has no scope-free way
to repopulate the cache, so caches only come back as authors re-save.

## The deploy may not have fired

This section is about **staging**. Production does not consult `shippable` at
all — it deploys the tag, whatever is in it. If production has not changed after
a merge to `main`, that is [the design](#staging--production), not a fault.

**A docs-only or test-only commit does not deploy to staging.** This is
deliberate, and it is the single most confusing thing about this pipeline during
an incident.

The `Detect shippable changes` job decides. A push deploys only if it touched
the shipping surface:

- `src/**`
- `manifest.yml`
- `static/**`
- `vite.view.config.js`, `vite.config.config.js`

`package.json` / `package-lock.json` are checked by **content**, not path: the
job compares the production-dependency closure via
[`scripts/prod-deps-fingerprint.mjs`](../scripts/prod-deps-fingerprint.mjs), so a
devDependency bump correctly skips while an in-range runtime bump (Mermaid
11.4.x → 11.5.0, which lands lockfile-only) still ships. The comparison is
fail-closed: if it cannot resolve the before-commit or parse a lockfile, it
ships rather than skips.

The trap: if you revert a bad change that lived outside that list, CI goes green
and staging stays broken. Check the `Detect shippable changes` job output — it
logs `shippable=true` or `shippable=false` — before you conclude a deploy
happened.

One case looks alarming and is not: the **release commit** is always
`shippable=false`. It touches only `package.json`, `package-lock.json` and
`CHANGELOG.md`, and the fingerprint ignores the root package's own version. So
staging skips it — correctly, having already deployed every commit in the batch
as it merged — while production ships the tag from the other workflow.

## Reading `verify-deploy`

`forge deploy` exiting 0 means "the bundle uploaded", **not** "the installation
is running it". [`scripts/verify-deploy.mjs`](../scripts/verify-deploy.mjs)
closes that gap, and runs in both deploy jobs.

```sh
node scripts/verify-deploy.mjs <environment> --snapshot   # before deploy
node scripts/verify-deploy.mjs <environment> --verify     # after deploy
```

- **`--snapshot`** records the pre-deploy `appVersion` into `$GITHUB_ENV`. It is
  **non-fatal** by design — it never blocks a deploy, it only gives `--verify`
  something to report against.
- **`--verify`** polls `forge install list` until every installation on that
  environment reports status `Up-to-date`. Ten attempts, twelve seconds apart,
  about two minutes. Tune with `VERIFY_POLL_ATTEMPTS` and
  `VERIFY_POLL_INTERVAL_MS` rather than editing the script.

It gates on `status`, not on `appVersion`. Forge's `appVersion` is a coarse
**major** number, and this app never ships a major (the zero-scope invariant
means permissions never change), so `appVersion` routinely does not move on a
real deploy. Watching it would produce false failures; watching `status` does not.

Two outcomes look similar in the log and mean different things:

| Output                                                         | Exit | Meaning                                                                                                        |
| -------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------- |
| `::warning::No <env> installation found`                       | 0    | Nothing is installed on that environment. Legitimate and unverifiable, so it passes. Not a pass _of_ anything. |
| `::error::… did not reach "Up-to-date" within the poll window` | 1    | The upload succeeded and the installation never adopted it. This is the failure the script exists to catch.    |

A warning is worth a second look on **production**: it means the verification you
believe is protecting you did not actually run.

## Staging → production

**The two deploys have different triggers.** Merging to `main` reaches staging
and stops there. Production is reached by cutting a release.

```
push to main ──> corpus ─┐
                 lint   ─┤
                 size   ─┼─> staging                 (ci.yml, unattended)
                 audit  ─┤
                 changes─┘

merge release PR ──> tag vX.Y.Z ──> gates ──> production
                     (release-please.yml → deploy-production.yml)
                                              ▲
                                     required reviewer
```

- **`staging`** lives in [`ci.yml`](../.github/workflows/ci.yml) and needs
  `corpus`, `lint`, `size`, `audit`, and `changes`. All five are hard
  dependencies, so a failure in any of them skips the deploy. `lint` and `size`
  matter here and not only on PRs: this deploy has no human in the loop, so
  without them a direct push to `main` could deploy over a failed lint.
- **`production`** lives in
  [`deploy-production.yml`](../.github/workflows/deploy-production.yml), which
  [`release-please.yml`](../.github/workflows/release-please.yml) calls when
  merging the release PR cuts a tag. It checks out **the tag**, not the branch
  head — `main` may have moved on. Its `Release gates` job re-runs the whole
  `ci.yml` gate set against that tag, because the release commit is
  `shippable=false` and nothing else re-tests the assembled tree.
- **The human pause is not in any workflow file.** It comes from a
  required-reviewer rule on the `production` GitHub Environment (Settings →
  Environments → production). Self-review is permitted, so with a single
  maintainer it stops an accidental promotion, not a determined one. Do not read
  it as a second pair of eyes. It fires once per release, so it is worth
  actually reading — that is the point of the split.
- **Why this split:** production used to fire on every shippable merge, which
  meant a Marketplace version and an approval per merge — 15 requests against 9
  tags. Batching is now "don't merge the release PR yet", and the release notes
  are already written in `CHANGELOG.md`.
- Both deploys share `concurrency: { group: forge-deploy, cancel-in-progress:
false }`. Groups are repository-scoped, so this serialises them across the two
  workflows: a release deploy queues behind an in-flight staging deploy rather
  than racing it against the same Forge app. Nothing is ever cancelled
  mid-deploy — a slow deploy beats a half-finished one.
- **What keeps production on `main`:** a deployment-branch policy on the
  environment. Both routes run with `github.ref` = `refs/heads/main` (a called
  workflow inherits its caller's ref; a manual dispatch defaults to `main`), so
  the policy blocks a production deploy dispatched from a feature branch. There
  is no `if:` guard doing this job any more.

### Forcing a version

`Release-As: X.Y.Z` in a commit footer overrides the version release-please
computes. To deploy a tag that already exists — a rollback, or a re-run of a
failed deploy — use the manual dispatch in
[Roll back production](#roll-back-production); it is the same workflow.

## Verifying by hand

When the automation is not enough and you want to see it yourself:

```sh
npx --no-install forge install list --json    # what is installed, and its status
npx --no-install forge lint                   # validate manifest.yml
```

Then open a Confluence page holding a diagram and confirm it renders. The version
that rendered it appears on hover — on a cache hit that is the version stored
with the SVG at save time, which may be older than the version the app currently
ships. That is correct behaviour, not a stale deploy.

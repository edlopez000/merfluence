# Contributing to Merfluence

Thanks for helping out. This file covers **commit conventions and the release
process**. For the architecture and the constraints that define the app (the
zero-scope manifest, client-side rendering, the layered sanitization), read
[CLAUDE.md](CLAUDE.md) and the per-area notes in [.claude/rules/](.claude/rules/)
— they are written for coding agents but they are the accurate account of why
each constraint exists. For rollback and incident procedure, read
[docs/RUNBOOK.md](docs/RUNBOOK.md).

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). If you
are here to ask a question rather than to send a change,
[SUPPORT.md](SUPPORT.md) points you at the right channel.

## The one invariant

Merfluence requests **no scopes, no egress, no resolver** — only
`content.styles: unsafe-inline`. Never add a scope, an egress permission, or a
backend to solve a problem. If a change seems to need one, open an issue first.
`test/manifest.test.js` enforces this on every PR.

## Development

```sh
npm install       # also installs the husky git hooks (via the prepare script)
npm test          # vitest: parse corpus + unit + browser E2E
npm run build     # both Vite bundles
```

Node: run `nvm use` to land on the CI-tested line (`.nvmrc` pins `22.22.3`), or
use any version inside the `engines` range in `package.json`. That range
deliberately excludes `22.23.x`: on it the Forge CLI throws
`ERR_STREAM_PREMATURE_CLOSE` (nodejs/node#63989, Atlassian FRGE-1750), which
would fail `forge lint`/`forge deploy` — see the comment in
`.github/workflows/ci.yml`. New diagram type → new fixture in
`test/`.

## Linting and formatting

```sh
npm run lint          # ESLint over src/, test/, scripts/, build configs
npm run lint:fix      # …and apply the auto-fixable ones
npm run format:check  # Prettier, check only
npm run format        # Prettier, write
```

The split is deliberate: **ESLint judges correctness, Prettier owns formatting.**
`eslint-config-prettier` is last in [`eslint.config.js`](eslint.config.js), so
ESLint never reports a style opinion the formatter would just overwrite.

You rarely need to run either by hand. The husky **`pre-commit`** hook runs
`lint-staged`, which applies `eslint --fix` and `prettier --write` to your staged
files and re-stages the result; a lint error that can't be auto-fixed fails the
commit. CI runs the same two checks in the `Lint` job on every PR.

`manifest.yml` and the workflow files are **not** formatted (`*.yml` is in
`.prettierignore`) — the manifest is the security claim and the workflow comment
blocks are hand-laid. `npm run lint:forge` is unrelated: it validates the Forge
manifest, needs Atlassian credentials, and runs only in the deploy job.

## Conventional Commits

Commit messages **and pull-request titles** must follow
[Conventional Commits](https://www.conventionalcommits.org/). This is enforced
two ways:

- **Locally** — a husky `commit-msg` hook runs commitlint
  (`commitlint.config.js`) on every `git commit`.
- **In CI** — [`pr-title-lint.yml`](.github/workflows/pr-title-lint.yml) checks
  the PR title. Because we **squash-merge**, the PR title becomes the commit
  subject on `main`, and that subject is what drives versioning and the
  changelog. Keep the PR title conventional even if intermediate commits aren't.

Format:

```
<type>(<optional scope>): <subject>
```

| Type       | Use for                                 | Version bump |
| ---------- | --------------------------------------- | ------------ |
| `feat`     | a user-facing feature                   | **minor**    |
| `fix`      | a bug fix                               | **patch**    |
| `perf`     | a performance improvement               | patch        |
| `refactor` | code change that isn't a feature or fix | none         |
| `docs`     | documentation only                      | none         |
| `test`     | tests only                              | none         |
| `ci`       | CI/workflow changes                     | none         |
| `build`    | build system or tooling                 | none         |
| `chore`    | maintenance, dependency bumps           | none         |

**Breaking changes** bump the **major** version. Mark them either with a `!`
after the type (`feat!: …`) or with a `BREAKING CHANGE:` footer in the commit
body.

Examples:

```
feat: add a copy-as-PNG button to the reader toolbar
fix: anchor wheel-zoom on the cursor instead of the frame
feat(render)!: drop the deprecated inline theme override
```

Renovate PRs are titled automatically (`chore(deps): …`) via `renovate.json`, so
dependency bumps conform without manual effort.

## Releases

Releases are automated with
[release-please](https://github.com/googleapis/release-please) — you don't bump
the version or edit the changelog by hand:

1. Merge conventional PRs to `main` as usual.
2. release-please maintains a standing **`chore: release X.Y.Z`** pull request
   that accumulates the changelog and computes the next
   [SemVer](https://semver.org/) version from the commit types since the last
   release.
3. A maintainer merges that release PR. release-please then tags `vX.Y.Z`, cuts a
   GitHub Release, and commits the updated [CHANGELOG.md](CHANGELOG.md).
4. A follow-on job attaches `merfluence-X.Y.Z.cdx.json` — a CycloneDX SBOM of the
   production dependency tree at that tag — to the Release. Reproduce it from any
   checkout with `npm run sbom`; see [SECURITY.md](SECURITY.md#supply-chain).
5. A second follow-on job deploys that tag to **production**, after re-running the
   full gate set against it and pausing for the required reviewer on the
   `production` environment. Merging the release PR is therefore what ships to
   customers.

So the release PR **is** the batch: merge conventional PRs freely, and hold the
release PR until the accumulated changes are worth a Marketplace version.

Forge manifests carry no version, so a merge to `main` and a release play
different roles. Every shippable merge deploys to **staging** on its own, with no
human in the loop, which is continuous proof that `main` is deployable. The tag
is what reaches production. See
[docs/RUNBOOK.md](docs/RUNBOOK.md#staging--production) for the full topology.

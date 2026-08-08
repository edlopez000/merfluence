# Merfluence — Claude working agreement

Merfluence is a free, open-source **Confluence Cloud macro** (Atlassian Forge,
**Custom UI**) that renders **Mermaid** diagrams entirely in the browser.

<!--
Maintainer note: this file loads into every session, so keep it short and keep
it true. Detail that only matters when touching one area belongs in
.claude/rules/*.md, which load on demand via `paths:` frontmatter.
-->

## The invariant that defines this app

The manifest requests **no `scopes`, no `external`, no `function`/resolver**.
The only permission is `content.styles: unsafe-inline`, because Mermaid writes
inline styles onto the SVG it generates. This zero-scope, zero-egress,
no-backend posture **IS the product**.

> Never add a scope, an egress permission, or a resolver to solve a problem.
> If a task seems to need one, **stop and tell the user.**

Two layers enforce this, so it is not just prose: the `PreToolUse` hook in
[.claude/hooks/guard-manifest.sh](.claude/hooks/guard-manifest.sh) blocks the
edit as you write it, and [test/manifest.test.js](test/manifest.test.js) fails
the build if one lands anyway.

## Where the code lives

```
manifest.yml              Forge descriptor — the security claim lives here
src/lib/
  mermaid-registry.ts     Lazy per-major loading + version pinning
  render.ts               init + parse + render + sanitize + egress hook
  host.ts                 @forge/bridge wrappers, theme resolution
  templates.ts            Starter diagrams for the type dropdown
  cache.ts                Rendered-SVG cache stored in macro config
  mermaid-file.ts         Extract Mermaid from dropped .mmd / .md files
  sizing.ts               Diagram height presets (Natural/S/M/L)
  zoom.ts                 Cursor/centre-anchored zoom math
  a11y-name.ts            Accessible name derived from diagram source
  png-export.ts           SVG → PNG export (canvas, no network)
src/components/Stage.tsx  Shared pan/zoom/fit surface for both views
src/view/main.tsx         Reader view
src/config/               Editor: CodeMirror, live preview, error gutter;
                          mermaid-lang.ts (CodeMirror StreamLanguage for
                          Mermaid + the highlight style; token colours come
                          from --ds-* tokens via --mf-tok-* in index.html)
test/                     Unit suite (jsdom) + parse corpus (test/fixtures/*.mmd)
test/browser/             Real-Chromium suite: full render pipeline + XSS E2E
```

## Commands

- `npm run build` — two Vite bundles → `static/{view,config}/dist`.
- `npm test` — both vitest projects; `npm run test:coverage` adds the CI gate.
- `npm run typecheck`, `npm run lint`, `npm run format:check`.
- `forge lint` — validates `manifest.yml`.

**After each numbered task, run `npm test`, `npm run build`, `npm run typecheck`,
`npm run lint`, and `forge lint`; report the results.**

## Hard constraints (keep true in every change)

- Rendering stays **client-side**; diagram source lives only in macro config.
- Keep `securityLevel: 'strict'`, `htmlLabels: false`, **DOMPurify** on all
  rendered SVG, and the egress hook in `render.ts` — all four, always. See
  [.claude/rules/rendering.md](.claude/rules/rendering.md) for why they are not
  interchangeable.
- The suite in `test/` must stay green — parse corpus, unit project, and the
  browser XSS E2E alike. **New diagram type → new fixture.**
- Don't break the version-pinning registry (`src/lib/mermaid-registry.ts`).

## Working style

- **Start new work on a fresh branch off `main`** — never commit new work
  straight to `main`. Prefix the branch with a Conventional Commit **type** so
  the PR title / squash subject passes commitlint and the PR-title CI job:
  `feat/…`, `fix/…`, `build/…`, `chore/…`, `docs/…`, `ci/…`. Pick the type
  deliberately: release-please cuts a release only on `feat` (minor) and `fix`
  (patch). Tooling / build-metadata work (e.g. narrowing `engines.node`) is
  `build:`, **not** `fix:`. Example: `build/38-narrow-engines-node`.
- Before any large edit, give a short plan and the files to be touched. **Wait
  for go-ahead on anything that changes the config schema.**
- Comments explain _why_, matching existing style. Don't reformat files not
  being changed.

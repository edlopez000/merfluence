# Merfluence — Claude working agreement

Merfluence is a free, open-source **Confluence Cloud macro** (Atlassian Forge,
**Custom UI**) that renders **Mermaid** diagrams entirely in the browser.

## The invariant that defines this app

The manifest requests **no `scopes`, no `external`, no `function`/resolver**.
The only permission is `content.styles: unsafe-inline`, because Mermaid writes
inline styles onto the SVG it generates. This zero-scope, zero-egress,
no-backend posture **IS the product**.

> Never add a scope, an egress permission, or a resolver to solve a problem.
> If a task seems to need one, **stop and tell the user.**

## Where the code lives

```
manifest.yml              Forge descriptor — the security claim lives here
src/lib/
  mermaid-registry.js     Lazy per-major loading + version pinning
  render.js               init + parse + render + sanitize
  host.js                 @forge/bridge wrappers, theme resolution
  templates.js            Starter diagrams for the type dropdown
  cache.js                Rendered-SVG cache stored in macro config
  mermaid-file.js         Extract Mermaid from dropped .mmd / .md files
  sizing.js               Diagram height presets (Natural/S/M/L)
  zoom.js                 Cursor/centre-anchored zoom math
src/view/                 Reader view (main.jsx, index.html)
src/config/               Editor: CodeMirror, live preview, error gutter;
                          mermaid-lang.js (CodeMirror StreamLanguage for Mermaid)
test/                     Unit suite (jsdom) + parse corpus (test/fixtures/*.mmd)
test/browser/             Real-Chromium suite: full render pipeline + XSS E2E
```

Build: two Vite bundles → `static/{view,config}/dist`. Test: `vitest run` runs
two projects — the jsdom unit suite (including `test/parse.test.js`, which runs
the fixture corpus through `mermaid.parse()` on both majors) and a Playwright
Chromium suite that exercises the real render pipeline and drives XSS payloads
end-to-end. `npm run test:coverage` enforces the v8 coverage thresholds in CI.

## Hard constraints (keep true in every change)

- Rendering stays **client-side**; diagram source lives only in macro config.
- Keep `securityLevel: 'strict'`, `htmlLabels: false`, and **DOMPurify** on all
  rendered SVG. The three layers are independent; any one failing must not open
  a hole.
- The suite in `test/` must stay green — parse corpus, unit projects, and the
  browser XSS E2E alike. **New diagram type → new fixture.**
- Don't break the version-pinning registry (`src/lib/mermaid-registry.js`).

## Working style

- Before any large edit, give a short plan and the files to be touched. **Wait
  for go-ahead on anything that changes the config schema.**
- After each numbered task: run `npm test`, `npm run build`, and `forge lint`;
  report results.
- Comments explain _why_, matching existing style. Don't reformat files not
  being changed.

## Roadmap (in order)

**0. Verify the Forge surface.** **Done** (`src/lib/host.js`). Findings against
`@forge/bridge` 4.5.3: `view.resize()` is not a guaranteed surface, so it is
called defensively with CSS as the fallback; colour mode comes from the typed
`getContext().theme.colorMode`, with `view.theme.enable()` applying the `--ds-*`
tokens and keeping `data-color-mode` on the iframe root (observed only as a
re-render trigger); config saves go through `view.submit({ config: fields })` —
the wrapper is required (see task 1).

**1. Cache rendered SVG in macro config.** On save, persist `{ svgLight, svgDark }`
into config alongside `source`, `mermaidVersion`, `theme`, `useMaxWidth`. Gate on
size: only cache if each string is < ~45KB (dropped otherwise so the save still
succeeds). Reader view injects cached SVG (re-sanitized) for the resolved theme
and loads **zero Mermaid** on a hit. **Done** (`src/lib/cache.js`). The cache is
versioned via `cacheV`, now at `CACHE_VERSION = 2` (v1 caches stored a
dark-themed SVG in `svgLight` — a theme race at save time — and are discarded).
Note: the save failure seen during testing was a missing `{ config: ... }` wrapper
in `view.submit` (fixed in `src/lib/host.js`), not config size.

**2. Lazy render on cache miss.** **Done** (`src/view/main.jsx`): the render
trigger is wrapped in an `IntersectionObserver`, so Mermaid loads only when the
macro scrolls into view. The originally-planned write-back of the rendered SVG
into config was **deliberately dropped**: the reader view has no scope-free way
to persist config (it would need a resolver or a scope, which the invariant
forbids), so the cache is populated only by saving in the editor, and an
uncached diagram renders fresh on every view.

**3. Split mermaid.core from diagram types.** **Done**
(`src/lib/mermaid-registry.js`): both majors resolve their `.` entry to the
`mermaid.core` build, which already registers every diagram type and layout
engine as a lazy dynamic import — so no manual `registerExternalDiagrams` /
`registerLayoutLoaders` call is needed (re-registering would risk
double-loading). A flowchart page pulls ~850KB and defers ~2.3MB of
cytoscape/KaTeX/elkjs until a diagram needs them.

**4. Confirm asset caching.** **Done**: the Vite build emits content-hashed
filenames (see `static/{view,config}/dist/assets/`), so the same Mermaid chunk
is served once across iframes and reloads. The README's immutable-cache note
stands on that.

## Note on AGENTS.md

The repo's `AGENTS.md` is a generic Forge-assistant persona that assumes
**UI Kit** apps (`@forge/react` only, no Custom UI, `forge create`). Merfluence
is deliberately **Custom UI** (React + Vite + Mermaid + CodeMirror). Where the
two conflict, **this file and the user's brief win.**

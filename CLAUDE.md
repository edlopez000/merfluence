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

## Where the code lives (target structure)
```
manifest.yml              Forge descriptor — the security claim lives here
src/lib/
  mermaid-registry.js     Lazy per-major loading + version pinning
  render.js               init + parse + render + sanitize
  host.js                 @forge/bridge wrappers, theme resolution
  templates.js            Starter diagrams for the type dropdown
  mermaid-lang.js         CodeMirror StreamLanguage for Mermaid
  cache.js                Rendered-SVG cache stored in macro config
  mermaid-file.js         Extract Mermaid from dropped .mmd / .md files
  sizing.js               Diagram height presets (Natural/S/M/L)
  zoom.js                 Cursor/centre-anchored zoom math
src/view/                 Reader view (main.jsx, index.html)
src/config/               Editor: CodeMirror, live preview, error gutter
test/                     Parse-only regression corpus (test/fixtures/*.mmd)
```
Build: two Vite bundles → `static/{view,config}/dist`. Test: `vitest run`
(`test/parse.test.js` runs the fixture corpus through `mermaid.parse()`).

## Hard constraints (keep true in every change)
- Rendering stays **client-side**; diagram source lives only in macro config.
- Keep `securityLevel: 'strict'`, `htmlLabels: false`, and **DOMPurify** on all
  rendered SVG. The three layers are independent; any one failing must not open
  a hole.
- The parse corpus in `test/` must stay green. **New diagram type → new fixture.**
- Don't break the version-pinning registry (`src/lib/mermaid-registry.js`).

## Working style
- Before any large edit, give a short plan and the files to be touched. **Wait
  for go-ahead on anything that changes the config schema.**
- After each numbered task: run `npm test`, `npm run build`, and `forge lint`;
  report results.
- Comments explain *why*, matching existing style. Don't reformat files not
  being changed.

## Roadmap (in order)

**0. Verify the Forge surface.** Confirm against installed `@forge/bridge` types:
`view.resize()`, `view.submit(values)` / `view.close()`, config via
`view.getContext()`, and dark-mode signal (assumed `data-color-mode` on the
iframe root). `width: fit-content` CSS is the resize fallback. Flag anything
unverifiable so the user checks live docs.

**1. Cache rendered SVG in macro config.** On save, persist `{ svgLight, svgDark }`
into config alongside `source`, `mermaidVersion`, `theme`, `useMaxWidth`. Gate on
size: only cache if each string is < ~45KB (dropped otherwise so the save still
succeeds). Add `cacheV: 1`. Reader view injects cached SVG (re-sanitized) for the
resolved theme and loads **zero Mermaid** on a hit. **Done** (`src/lib/cache.js`).
Note: the save failure seen during testing was a missing `{ config: ... }` wrapper
in `view.submit` (fixed in `src/lib/host.js`), not config size.

**2. Lazy render on cache miss.** In the view, wrap the render trigger in an
`IntersectionObserver` so Mermaid loads only when the macro scrolls into view. On
a successful render of a previously-uncached diagram, write the SVG back to
config so the next read is a hit — **never on every view** (it's a page version
bump).

**3. Split mermaid.core from diagram types.** Move from unified `mermaid` import
to core + `registerExternalDiagrams(..., { lazyLoad: true })` and
`registerLayoutLoaders`, so a page of plain flowcharts never downloads
cytoscape/ELK/KaTeX. Keep it behind the registry so version pinning still works.
Print before/after bundle sizes.

**4. Confirm asset caching.** Verify the Vite build emits content-hashed
filenames so the same Mermaid chunk is served once across iframes and reloads.
Note the observed Forge CDN cache headers in the README.

## Note on AGENTS.md
The repo's `AGENTS.md` is a generic Forge-assistant persona that assumes
**UI Kit** apps (`@forge/react` only, no Custom UI, `forge create`). Merfluence
is deliberately **Custom UI** (React + Vite + Mermaid + CodeMirror). Where the
two conflict, **this file and the user's brief win.**

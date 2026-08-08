---
paths:
  - 'src/lib/cache.ts'
  - 'src/lib/host.ts'
  - 'src/view/main.tsx'
  - 'src/config/main.tsx'
---

# Rendered-SVG cache and the host bridge

On save the editor persists `{ svgLight, svgDark, renderedVersion }` into macro
config alongside `source`, `mermaidVersion`, `theme`, `useMaxWidth`. The reader
injects the cached SVG for the resolved theme — **re-sanitized**, never trusted
because it came from config — and loads zero Mermaid on a hit.

## Rules that are easy to break

- `MAX_SVG_BYTES` is ~45KB **per string**. Over budget, that SVG is dropped so
  the save still succeeds; `cacheV` is always written regardless.
- There is **no per-page aggregate budget**, and there cannot be one: the editor
  sees only its own macro's config, and reading the rest of the page would need
  a scope. The measured Confluence ceilings — editor ~5.23 MB, REST API exactly
  20,000,000 bytes — and the decision not to act on them are in
  [docs/STORAGE-BUDGET.md](../../docs/STORAGE-BUDGET.md). Don't re-propose a
  total-budget check.
- `CACHE_VERSION` is `3`, and a config written by any other version is treated
  as absent. Bump it — don't reinterpret old shapes — whenever the cached fields
  change meaning. v1 stored a dark-themed SVG in `svgLight` (a theme race at
  save time); v2 carried no `renderedVersion`, so the reader's version label
  fell back to the _current_ bundle's semver and misreported cached renders.
- `renderedVersion` is the exact Mermaid semver that produced the SVGs. It
  exists so the label reports what actually rendered, not what would render now.

## Why there is no write-back from the reader

The reader view has **no scope-free way to persist config** — it would need a
resolver or a scope, which the invariant forbids. So the cache is populated only
by saving in the editor, and an uncached diagram renders fresh on every view.
This was considered and deliberately dropped; don't re-propose it.

The reader's render trigger is wrapped in an `IntersectionObserver` so Mermaid
loads only when the macro scrolls into view.

## @forge/bridge surface (verified against 4.5.3)

- `view.submit({ config: fields })` — the `{ config: … }` wrapper is required.
  Omitting it is what made saves silently fail; it was never a size limit.
- `view.resize()` is not a guaranteed surface — call it defensively, with CSS
  as the fallback.
- Colour mode comes from the typed `getContext().theme.colorMode`.
  `view.theme.enable()` applies the `--ds-*` tokens and keeps `data-color-mode`
  on the iframe root (observed only as a re-render trigger).

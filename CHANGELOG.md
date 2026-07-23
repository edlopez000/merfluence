# Changelog

All notable changes to Merfluence are documented here.

This project follows [Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/). From v1.0.1 onward, entries
below the `1.0.0` seed are generated automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/) — do not edit
generated sections by hand. See [CONTRIBUTING.md](CONTRIBUTING.md).

## [1.0.1](https://github.com/edlopez000/merfluence/compare/v1.0.0...v1.0.1) (2026-07-23)


### Bug Fixes

* strip external resource references in sanitizeSvg ([#72](https://github.com/edlopez000/merfluence/issues/72)) ([5a16cd7](https://github.com/edlopez000/merfluence/commit/5a16cd7f1795bb4bb1a9c685fd487047d03ea6cf)), closes [#64](https://github.com/edlopez000/merfluence/issues/64)

## [1.0.0] - 2026-07-19

Initial release. Baseline hand-written from the pre-versioning history; the tag
`v1.0.0` anchors it and is the point release-please computes future versions
from.

### Product

- Confluence Cloud macro (Atlassian Forge, Custom UI) that renders
  [Mermaid](https://mermaid.js.org/) diagrams **entirely in the reader's
  browser** — no backend, no resolver.
- **Zero-scope, zero-egress manifest**: the only permission requested is
  `content.styles: unsafe-inline` (Mermaid writes inline styles onto its SVG).
  No API scopes, no external network access. This posture is the product.
- All major Mermaid diagram types (18 starter templates) — flowchart, sequence,
  class, state, ER, Gantt, pie, mindmap, timeline, user journey, Git graph,
  quadrant, XY, Sankey, C4, block, kanban, architecture.
- Live editor with CodeMirror syntax highlighting, starter templates, and inline
  error reporting.
- Drag-and-drop of `.mmd` files or Markdown containing a ` ```mermaid ` block.
- Automatic light/dark theming that follows Confluence.
- Per-diagram display size (Natural / Small / Medium / Large), plus pan, zoom,
  and fullscreen navigation with SVG/PNG export and source copy.

### Security

- Three independent sanitization layers on all rendered SVG:
  `securityLevel: 'strict'`, `htmlLabels: false`, and DOMPurify.
- Per-major Mermaid version pinning via the render registry, so a pinned diagram
  keeps rendering under its original major.

### Performance

- Rendered SVG cached in the macro config; uncached diagrams render lazily via
  `IntersectionObserver` as they scroll into view, loading zero Mermaid on a
  cache hit.

### Infrastructure

- Two-project Vitest suite (jsdom unit + real-Chromium browser) with a v8
  coverage gate; parse corpus over both Mermaid majors and an end-to-end
  malicious-diagram XSS test that proves the sanitizer boundary.
- Gated deploy pipeline (corpus → audit → staging → verify → human-gated
  production) with SHA-pinned GitHub Actions and a 14-day Renovate dependency
  cooldown.
- Apache-2.0 licensed.

[1.0.0]: https://github.com/edlopez000/merfluence/releases/tag/v1.0.0

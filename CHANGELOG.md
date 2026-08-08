# Changelog

All notable changes to Merfluence are documented here.

This project follows [Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/). From v1.0.1 onward, entries
below the `1.0.0` seed are generated automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/) — do not edit
generated sections by hand. See [CONTRIBUTING.md](CONTRIBUTING.md).

## [1.5.0](https://github.com/edlopez000/merfluence/compare/v1.4.0...v1.5.0) (2026-08-08)


### Features

* highlight Mermaid syntax per dialect, themed with Confluence tokens ([#150](https://github.com/edlopez000/merfluence/issues/150)) ([83f4f2c](https://github.com/edlopez000/merfluence/commit/83f4f2cb522e193b29dd03d8afba29bf81dda35f))
* offer a transparent or an opaque PNG export ([#149](https://github.com/edlopez000/merfluence/issues/149)) ([bb26750](https://github.com/edlopez000/merfluence/commit/bb26750a49428b310e5c3d391a2a8cfc5adbed82))


### Bug Fixes

* size diagrams and their PNG exports from the diagram, not the column ([#147](https://github.com/edlopez000/merfluence/issues/147)) ([168e28d](https://github.com/edlopez000/merfluence/commit/168e28df031dd8bb46842c45d0823bd83fc11b85))

## [1.4.0](https://github.com/edlopez000/merfluence/compare/v1.3.0...v1.4.0) (2026-08-07)


### Features

* import a diagram from a Mermaid Live Editor link ([#106](https://github.com/edlopez000/merfluence/issues/106)) ([#122](https://github.com/edlopez000/merfluence/issues/122)) ([9bd9843](https://github.com/edlopez000/merfluence/commit/9bd9843ea8a725e4cb32d931ab386b9302210023))


### Bug Fixes

* avoid a quadratic trailing-whitespace strip when parsing dropped files ([#123](https://github.com/edlopez000/merfluence/issues/123)) ([d6000ee](https://github.com/edlopez000/merfluence/commit/d6000ee8ed8d9bda5611319de6c0f02e504d5c17)), closes [#95](https://github.com/edlopez000/merfluence/issues/95)
* performance pass, plus PNG export, theme-race and editor undo fixes ([#143](https://github.com/edlopez000/merfluence/issues/143)) ([d047b10](https://github.com/edlopez000/merfluence/commit/d047b10841c944fce316cac394f04c9aff0f61be))
* zoom to 400% of a diagram's real size, not its shrunken size ([#142](https://github.com/edlopez000/merfluence/issues/142)) ([460f901](https://github.com/edlopez000/merfluence/commit/460f901c532cc27ca9a2d317833a87b945c5b43d))

## [1.3.0](https://github.com/edlopez000/merfluence/compare/v1.2.2...v1.3.0) (2026-08-03)


### Features

* pan/zoom and maximize in the editor preview ([#117](https://github.com/edlopez000/merfluence/issues/117)) ([fa5413b](https://github.com/edlopez000/merfluence/commit/fa5413bbb0f485175773eb9f2ad2fd4efcb6a9fd))


### Bug Fixes

* fit the editor preview to the pane when the diagram resizes ([#119](https://github.com/edlopez000/merfluence/issues/119)) ([5d68209](https://github.com/edlopez000/merfluence/commit/5d68209f5de8ca12509b8ac9fae98aa8609451de))
* show the editor's Tab-exit hint only when Tab is captured ([#120](https://github.com/edlopez000/merfluence/issues/120)) ([ce2b902](https://github.com/edlopez000/merfluence/commit/ce2b902bd68ef579c03b8c5c7b7685e7b24d0558))

## [1.2.2](https://github.com/edlopez000/merfluence/compare/v1.2.1...v1.2.2) (2026-08-01)


### Bug Fixes

* extend the egress guard to &lt;style&gt; element text ([#114](https://github.com/edlopez000/merfluence/issues/114)) ([87f67bd](https://github.com/edlopez000/merfluence/commit/87f67bd3ac41a08334d148c1eca766f056323971))

## [1.2.1](https://github.com/edlopez000/merfluence/compare/v1.2.0...v1.2.1) (2026-08-01)


### Bug Fixes

* name the editor's source field, and publish an accessibility statement ([#112](https://github.com/edlopez000/merfluence/issues/112)) ([7ad951e](https://github.com/edlopez000/merfluence/commit/7ad951e1a92750fcd7799c5b2c357e0dd0bdfaea))

## [1.2.0](https://github.com/edlopez000/merfluence/compare/v1.1.0...v1.2.0) (2026-08-01)


### Features

* add a text alternative to the rendered SVG ([#110](https://github.com/edlopez000/merfluence/issues/110)) ([96fa39a](https://github.com/edlopez000/merfluence/commit/96fa39ae133f95a78b8c62b35b32a4506f46f5be)), closes [#92](https://github.com/edlopez000/merfluence/issues/92)

## [1.1.0](https://github.com/edlopez000/merfluence/compare/v1.0.2...v1.1.0) (2026-08-01)


### Features

* keyboard access for the reader view ([#107](https://github.com/edlopez000/merfluence/issues/107)) ([0a569fa](https://github.com/edlopez000/merfluence/commit/0a569fa4d4a9becb25f1294cad501781497c4965)), closes [#53](https://github.com/edlopez000/merfluence/issues/53)

## [1.0.2](https://github.com/edlopez000/merfluence/compare/v1.0.1...v1.0.2) (2026-07-25)


### Bug Fixes

* label a cached diagram with the version that rendered it ([#90](https://github.com/edlopez000/merfluence/issues/90)) ([962cbdd](https://github.com/edlopez000/merfluence/commit/962cbdd029d8b8b97390e1c40228207da98b30f4))

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

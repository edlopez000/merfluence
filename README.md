# Merfluence

> Diagrams as code for Confluence Cloud. Write [Mermaid](https://mermaid.js.org/), get a rendered diagram — entirely in your browser, with nothing sent anywhere.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/edlopez000/merfluence/actions/workflows/ci.yml/badge.svg)](https://github.com/edlopez000/merfluence/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/edlopez000/merfluence/gh-pages/coverage-badge.json)](https://github.com/edlopez000/merfluence/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/edlopez000/merfluence)](https://github.com/edlopez000/merfluence/releases)
[![Atlassian Marketplace](https://img.shields.io/badge/Marketplace-Merfluence-0052CC)](https://marketplace.atlassian.com/apps/1504902125)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/edlopez000/merfluence/badge)](https://scorecard.dev/viewer/?uri=github.com/edlopez000/merfluence)
![Built on Atlassian Forge](https://img.shields.io/badge/Built%20on-Atlassian%20Forge-0052CC)
![Confluence Cloud](https://img.shields.io/badge/Confluence-Cloud-172B4D)

![The Merfluence editor: Mermaid source on the left, a live preview on the right](docs/images/editor.webp)

Merfluence is a free, open-source Confluence Cloud macro, built on [Atlassian Forge](https://developer.atlassian.com/platform/forge/), that renders Mermaid diagrams client-side. Diagram source lives in the page, and the rendering happens in the reader's browser. The app has no backend and requests no data-access permissions, so your diagrams never leave Atlassian — or reach us.

**[See it live →](https://lopezedward.atlassian.net/wiki/spaces/Merfluence/overview)** — every diagram type rendering in a real Confluence space, no login needed.

## Highlights

- **Private by design** — no API scopes, no external network access, no backend. The only permission requested is inline styles, which Mermaid needs to style its SVG.
- **Client-side rendering** — diagrams are generated with Mermaid and sanitized with DOMPurify before display.
- **Fast on large pages** — rendered diagrams are cached in the macro, and uncached diagrams render lazily as they scroll into view.
- **Version-stable** — pin a Mermaid major version per diagram, so existing diagrams don't break when Mermaid ships changes.
- **Free and open source** — Apache 2.0 licensed, with public source so the privacy claims are verifiable.

## Features

- All major Mermaid diagram types — flowcharts, sequence, class, state, entity-relationship, Gantt, pie, mindmap, timeline, user journey, Git graph, quadrant, XY, Sankey, C4, block, kanban, architecture, and more, each with a starter template
- A live editor with syntax highlighting, starter templates, and inline error reporting
- Drag and drop a `.mmd` file, or a Markdown file containing a ` ```mermaid ` block, straight onto the editor
- Import a diagram from a [Mermaid Live Editor](https://mermaid.live) link by pasting or dragging it onto the editor — the source travels in the link's `#pako:` / `#base64:` fragment, so it is decoded in your browser and nothing is ever fetched
- Automatic light/dark theming that follows Confluence
- A per-diagram display size (Small, Medium, or Large), or the diagram's natural size
- Pan, zoom, and fullscreen navigation, with export to SVG or PNG — the PNG either transparent, or on a background matching the page
- Copy the diagram straight to the clipboard as an image, ready to paste into a chat or a slide
- Full keyboard operation — focus a diagram and pan, zoom, reset, or go fullscreen without a mouse
- A text alternative on every diagram for screen readers, from your own `accTitle` / `accDescr`
- Copy the source from any rendered diagram

## Installation

### From the Atlassian Marketplace

Install Merfluence from its [Marketplace listing](https://marketplace.atlassian.com/apps/1504902125). Then, on any Confluence page, type `/mermaid` (or `/merfluence`) and insert the macro.

### From source

See [Development](#development) to build and deploy your own instance.

## Usage

1. On a Confluence page, type `/mermaid` and insert the **Merfluence** macro.
2. Write Mermaid in the editor, start from a template, drag in a `.mmd`/Markdown file, or paste a Mermaid Live Editor link — the preview updates as you type.
3. Optionally set the display size, theme, or pinned Mermaid version, then **Save diagram**.
4. Readers see the rendered diagram with pan, zoom, fullscreen, SVG/PNG export, and copy-as-image.

![A rendered flowchart on a Confluence page with the pan, zoom, and export toolbar](docs/images/reader-view.webp)

### Keyboard

Tab to a diagram — the shortcuts appear along its bottom edge — then:

| Key                         | Action                                                   |
| --------------------------- | -------------------------------------------------------- |
| Arrow keys                  | Pan (hold <kbd>Shift</kbd> for a big step)               |
| <kbd>+</kbd> / <kbd>-</kbd> | Zoom in / out                                            |
| <kbd>0</kbd>                | Reset the view                                           |
| <kbd>F</kbd>                | Toggle fullscreen                                        |
| <kbd>Esc</kbd>              | Release the diagram (in fullscreen, one press does both) |

The same keys work while a toolbar button has focus, so Tabbing to the toolbar doesn't lose them.
<kbd>Esc</kbd> hands the keyboard back: the diagram stops acting on arrow keys until you focus it
again. Pressing it in fullscreen leaves fullscreen _and_ releases in the same press; leaving with
<kbd>F</kbd> instead keeps the diagram focused, so <kbd>F</kbd> takes you straight back in.

### Screen readers

Every rendered diagram carries a text alternative. Without one of your own it is announced by type
— "Flowchart diagram" — and its node labels stay readable, so a screen reader can still walk the
contents.

Describe the diagram yourself and you get a much better result. Mermaid's own
[`accTitle` / `accDescr`](https://mermaid.js.org/config/accessibility.html) go straight into the
source:

```
flowchart LR
    accTitle: Deploy pipeline
    accDescr: A pull request is reviewed, then built, then released to production.
    PR[Pull request] --> Review --> Build --> Production
```

The diagram is then announced as a single image named "Deploy pipeline", with your description read
out in full — the node-by-node reading is dropped, because your sentence says it better. Neither
line renders on screen; for a visible heading use the diagram's own `title`.

[ACCESSIBILITY.md](ACCESSIBILITY.md) is the full statement: where Merfluence stands against WCAG
2.1 AA, the editor's keyboard model as well as the reader's, and the limitations that come with
rendering someone else's diagram. A [VPAT](docs/VPAT.md) covers the same findings for procurement.

## Privacy & security

The manifest is the product:

```yaml
permissions:
  content:
    styles:
      - 'unsafe-inline'
```

- **No `scopes`** — the app cannot read any page through the Confluence REST API.
- **No `external`** — the app cannot contact any host outside Atlassian.
- **No `function`** — there is no backend; no handler exists that could receive a diagram, let alone forward it.

![Dropping a file onto the editor, with the note that it is read in the browser and not uploaded anywhere](docs/images/file-drop.webp)

Diagram source is stored as macro configuration in the page's own body and rendered to SVG by JavaScript in the reader's browser. The single declared permission — inline styles — is required only because Mermaid writes `style="…"` attributes onto the SVG it generates. Styles only; never scripts, never `unsafe-eval`.

Because macro configuration can be authored by anyone who can edit a page and is rendered for everyone who can read it, all diagram input is treated as untrusted. Readers are protected in depth:

- `securityLevel: 'strict'` — Mermaid `click` directives parse but stay inert.
- `htmlLabels: false` — no `<foreignObject>`, so labels cannot inject HTML.
- **DOMPurify** sanitizes every rendered SVG, including cached SVG re-checked on read.

These are not three interchangeable walls. The first two are Mermaid settings that shape the SVG **before** it reaches the sanitizer, narrowing what has to be judged: no bound handlers, no HTML in labels, so the output is plain SVG rather than arbitrary embedded markup. DOMPurify is the layer that actually enforces the result. Separately, a sanitizer hook strips references to external hosts — an `<image href="https://…">` or a `fill: url(https://…)` — so that painting a diagram cannot quietly fetch anything, which is what keeps the zero-egress claim true at render time rather than only in the manifest.

Stated plainly, the residual trust is DOMPurify itself and the SVG profile it is configured with (`USE_PROFILES: { svg, svgFilters }`), whose allow-list decides what survives. Defense in depth, then — each layer makes the next one's job smaller, and a break in any one of them is worth reporting even if the others happen to contain it.

For the supply chain behind the bundle rather than the code inside it, every tagged release carries a [CycloneDX SBOM](SECURITY.md#supply-chain) of its production dependencies — every component, version, and licence — as a Release asset.

The formal statement of all this is the [privacy policy](https://edwardlopez.dev/privacy). To report something that undermines any of the claims above, follow [SECURITY.md](SECURITY.md) — privately, please, not in a public issue.

## How it works

**Rendering and caching.** Rendering is deterministic for a given source, version, theme, and width setting, so the editor renders each diagram to SVG once on save — for both light and dark — and stores the result in the macro's configuration. A reader with a cache hit displays that SVG and loads no Mermaid at all. On a cache miss, rendering is deferred behind an `IntersectionObserver` until the macro scrolls into view, so a long page never downloads the renderer for diagrams below the fold.

**Bundle size.** Mermaid is large, and every macro instance is its own iframe. Merfluence keeps this in check three ways: cached diagrams load no renderer; uncached diagrams load it lazily on scroll; and Mermaid's `mermaid.core` build lazy-loads each diagram type and layout engine on demand. In practice, a page of plain flowcharts downloads roughly 850 KB and defers about 2.3 MB of heavier libraries (Cytoscape, KaTeX, ELK) that load only when a diagram actually needs them. Build assets are content-hashed and served from the Forge CDN with a long-lived, immutable cache policy, which is what makes a chunk eligible to be reused across iframes and reloads rather than refetched. How much reuse a given browser actually performs has not been measured here, so that is stated as the cache policy it is, not as a benchmark.

**Version currency.** Mermaid ships breaking changes across major versions, so every diagram carries a version setting: `auto` tracks the current release, or a diagram can pin `11` or `10`. Each major is a separate dynamic import, so a page never downloads a version it doesn't use. A regression corpus (`test/parse.test.js`) runs every fixture through `mermaid.parse()` on each dependency bump to confirm that previously valid syntax still parses — the failure that actually matters — and CI gates version upgrades on that corpus. The exact Mermaid version that rendered a diagram is shown on hover, so bug reports arrive with a version attached — a cached diagram reports the version stored with it at save time, which may be older than the one the app ships today.

## Limitations

**Word export.** Forge macros require an `adfExport` function to appear in Word exports, but adding one currently overrides the high-fidelity PDF renderer with the same limited output ([CONFCLOUD-83083](https://jira.atlassian.com/browse/CONFCLOUD-83083)). Rather than degrade the common case to serve the rare one, Merfluence ships no exporter; use the toolbar's SVG or PNG download, or copy the diagram as an image and paste it in, instead.

## Development

```bash
npm install
forge register                        # writes your app id into manifest.yml
npm run build                         # builds both bundles into static/{view,config}/dist
forge deploy -e development
forge install --product confluence -e development --site your-site.atlassian.net
```

- `npm test` runs both test projects: the unit suite (jsdom, including the
  parse-regression corpus) and a real-Chromium browser suite covering the full
  render pipeline and an XSS end-to-end check. `npm run test:unit` and
  `npm run test:browser` run one at a time; `npm run test:coverage` adds the
  coverage gate CI enforces. The coverage badge above is self-hosted, not from a
  third-party service: on each push to `main`, CI runs `scripts/coverage-badge.mjs`
  over the generated `coverage-summary.json` and publishes the resulting shields
  endpoint JSON to the `gh-pages` branch (`coverage-badge.json`).
- `forge lint` validates the manifest.
- `forge tunnel` gives live reload against your development site.

Project layout:

```
manifest.yml            Forge descriptor — declares the single inline-styles permission
src/lib/
  render.js             Mermaid init, parse, render, and DOMPurify sanitize
  mermaid-registry.js   Lazy per-major loading and version pinning
  host.js               @forge/bridge wrappers and theme resolution
  cache.js              SVG cache shape and size gate
  mermaid-file.js       Extract Mermaid from dropped .mmd / Markdown files
  live-url.js           Decode a mermaid.live link's fragment (no network)
  templates.js          Starter diagrams
  sizing.js             Diagram height presets (Natural/S/M/L)
  zoom.js               Cursor- and centre-anchored zoom math
src/view/               The macro as readers see it
src/config/             The editor: CodeMirror (mermaid-lang.js), live preview, drag-and-drop
test/                   Unit suite and parse-regression fixtures
test/browser/           Chromium suite: render pipeline and XSS end-to-end
```

## Support

- **Questions and ideas** — [GitHub Discussions](https://github.com/edlopez000/merfluence/discussions).
- **Bugs and feature requests** — [open an issue](https://github.com/edlopez000/merfluence/issues/new/choose).
- **Support requests** — the [service desk](https://lopezedward.atlassian.net/servicedesk/customer/portal/1). No Atlassian account needed.
- **Security vulnerabilities** — [SECURITY.md](SECURITY.md), privately, never a public channel.

[SUPPORT.md](SUPPORT.md) has the full routing, including the private contact address.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions and the release process, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the community standards everyone here is held to. New diagram types should ship with a fixture in `test/fixtures/`, and the test suite must stay green (`npm test`) before changes are merged.

## License

[Apache 2.0](LICENSE) © Edward Lopez-Ramos.

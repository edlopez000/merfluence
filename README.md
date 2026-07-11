# Mermaid for Confluence

A free, open-source Confluence Cloud macro that renders [Mermaid](https://mermaid.js.org/)
diagrams. Built on Atlassian Forge.

## What makes it different

Read `manifest.yml`. That file is the product.

```yaml
permissions:
  content:
    styles:
      - 'unsafe-inline'
```

There is no `scopes:` block, so the app cannot read a single page. There is no
`external:` block, so it cannot reach a host outside Atlassian. There is no
`function:` block, so it has no backend — no serverless handler exists that
could receive your diagram source, let alone forward it somewhere.

Your Mermaid source is stored as macro config inside the page's own document
body. It is rendered to SVG by JavaScript running in your browser. At install
time, Confluence shows an admin exactly what the app asks for, and the answer
is: inline styles.

The one declared permission is forced. Mermaid writes `style=""` attributes onto
the SVG it generates, and Forge blocks inline styles by default. Styles only —
never `scripts`, never `unsafe-eval`.

## What it does not do

**Word export.** Forge macros need an `adfExport` function to appear in Word
exports, and adding one currently overrides the high-fidelity PDF renderer with
the same limited ADF output ([CONFCLOUD-83083][1]). Rather than degrade the
common case to serve the rare one, this app ships no exporter. Use the toolbar's
SVG or PNG download instead.

[1]: https://jira.atlassian.com/browse/CONFCLOUD-83083

## Security posture

Macro config is authored by anyone who can edit the page and rendered for
everyone who can read it. That is an untrusted-input boundary, so:

- `securityLevel: 'strict'` — Mermaid `click` directives parse but stay inert.
- `htmlLabels: false` — no `<foreignObject>`, so labels cannot smuggle HTML.
- DOMPurify with the SVG profile sanitizes the output regardless.

The three are independent. Any one of them failing should not produce a hole.

## Rendering

Only the diagram source and its display settings live in macro config
(`source`, `mermaidVersion`, `theme`, `useMaxWidth`) — all small. The SVG is
rendered fresh in the reader's browser, and to keep a long page cheap that
render is deferred: the trigger is wrapped in an `IntersectionObserver`, so
Mermaid only loads for a macro once it scrolls near the viewport. Diagrams above
the fold render immediately; the rest cost nothing until you reach them.

**Why the rendered SVG is not cached in config.** Caching the SVG would let a
reader skip Mermaid entirely, and it was tried — but it does not work within
this app's permissions. Macro config is stored in the page's ADF, which is
size-limited; a rendered SVG is tens of KB and overflows it, making
`view.submit()` reject the save with *"Invalid config provided"*. The stores
that *could* hold bulky derived data — Forge storage, or a content property —
each need a resolver `function` or a scope, and this app deliberately has
neither. So the diagram is re-rendered on view rather than cached. (If this ever
becomes a bottleneck, gzip-compressing the SVG with the browser-native
`CompressionStream` — no dependency, no scope — might fit a small diagram under
the config limit; it was not needed here.)

## Mermaid version currency

Mermaid ships breaking syntax changes across majors. A diagram written today
must not become an error banner in three years.

- Every diagram carries a `mermaidVersion` config value. `auto` tracks whatever
  ships with the current release; a user can pin `11` or `10` if a bump breaks
  them.
- Each major is a separate dynamic import (`src/lib/mermaid-registry.js`), so a
  page that never pins an old version never downloads one.
- `test/parse.test.js` runs a corpus of fixtures through `mermaid.parse()` on
  every dependency bump. It does not diff pixels — it checks that syntax
  customers already wrote still parses, which is the failure that actually
  matters.
- `.github/workflows/mermaid-update.yml` gates the bump on that corpus, then
  deploys to `staging` automatically. Production is a manual promote.

The macro renders `Mermaid 11.x.y` beneath every diagram, so bug reports arrive
with a version attached.

## Layout

```
manifest.yml              Forge app descriptor — the security claim lives here
src/lib/
  mermaid-registry.js     Lazy per-major loading, version pinning
  render.js               Initialize + parse + render + sanitize
  host.js                 @forge/bridge wrappers, theme resolution
  templates.js            Starter diagrams for the type dropdown
src/view/                 The macro as readers see it
src/config/               The editor: CodeMirror, live preview, error gutter
test/                     Parse-only regression corpus
```

## Develop

```bash
npm install
forge register                  # writes your app id into manifest.yml
npm run build                   # both bundles -> static/{view,config}/dist
forge deploy
forge install                   # onto a free site from go.atlassian.com/cloud-dev
forge tunnel                    # live reload against your dev site
```

`forge lint` will flag manifest problems before deploy does.

## Known rough edges

**Bundle size.** Mermaid is well north of a megabyte, and every macro instance
is its own iframe. Two things blunt this. First, the `IntersectionObserver`
above means Mermaid only loads for macros you actually scroll to. Second,
Mermaid 11's package resolves the default import to its `mermaid.core` build,
which lazy-loads each diagram type and layout engine on demand — so we get the
split for free without calling `registerExternalDiagrams` ourselves. Measured
against the current build: a page of plain flowcharts downloads ~850KB (core +
the flowchart chunk) and defers ~2.3MB of heavy libraries (cytoscape, KaTeX,
elkjs) that only load if a diagram of that type actually renders.

The cost that remains is per-iframe duplication: ten *uncached* diagrams of the
same type still fetch that ~850KB ten times. Content-hashed filenames let the
Forge CDN and the browser serve each Mermaid chunk once across iframes and
reloads, so the second instance is a cache hit rather than a re-download.

**Asset caching (headers to confirm post-deploy).** The Vite build emits
content-hashed filenames (`mermaid.core-<hash>.js`) into `static/{view,config}/dist`,
so a chunk's URL changes only when its bytes change — the prerequisite for
caching it indefinitely. Forge serves these static resources from its CDN. The
one thing that can only be checked against a live install is the response
headers. After `forge deploy` + `forge install`, open a diagram, and in
DevTools → Network (or with curl) inspect a chunk request:

```bash
curl -sI '<asset-url-copied-from-devtools>' \
  | grep -iE 'cache-control|etag|age|x-cache|expires|last-modified'
```

Observed on the development deploy (2026-07-11), on a chunk served from
`https://<hash>.cdn.prod.atlassian-dev.net/<app-id>/…`:

| Header        | Value                                                              |
| ------------- | ----------------------------------------------------------------- |
| cache-control | `max-age=1728000, s-maxage=1728000, stale-while-revalidate=86400, immutable` |
| etag          | `W/"…"` (present)                                                  |
| x-cache       | `Miss from cloudfront` on first load; `Hit` on subsequent          |
| content-encoding | `gzip`                                                          |

That is a 20-day, `immutable` policy behind CloudFront. Because the filenames
are content-hashed, this is exactly what we want: the same Mermaid chunk is
fetched once and reused across every macro iframe and page reload until its
bytes (and therefore its URL) change. The Forge runtime's own `global-bridge.js`
uses a shorter `max-age=86400`.

**Forge surface (verified against `@forge/bridge` 4.5.3).** `src/lib/host.js`
wraps these; findings as of the pinned bridge:

- `view.resize()` — **not present** on this bridge. Iframe sizing relies
  entirely on the `width: fit-content` / `min-width:100%` CSS in
  `src/view/index.html`; the wrapper is a defensive no-op should a later bridge
  add it.
- `view.submit(values)` / `view.close()` — confirmed; the custom macro config
  contract, each taking an optional payload.
- Dark mode — read from the typed `getContext().theme.colorMode`, not a DOM
  attribute. `view.theme.enable()` is called on mount so the host injects the
  `--ds-*` tokens and keeps `data-color-mode` in sync; that attribute is used
  only as a re-render trigger.

**Line numbers in errors.** Mermaid's older jison grammars expose
`err.hash.loc.first_line`; the newer langium parsers embed the line in the
message. `describeError()` handles both and degrades to no line number rather
than guessing wrong.

## License

MIT. Source is public, which the Marketplace requires of open-source listings —
and which is the only way anyone should believe the claim at the top of this
file.

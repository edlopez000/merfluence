---
paths:
  - 'src/lib/render.ts'
  - 'src/lib/mermaid-registry.ts'
  - 'src/components/Stage.tsx'
---

# Render pipeline

## The three settings are not three equal layers

Keep `securityLevel: 'strict'`, `htmlLabels: false`, and **DOMPurify** on all
rendered SVG — all three, always. They work in depth, not side by side: the two
Mermaid settings shape what reaches the sanitizer, and DOMPurify enforces the
result. So removing either Mermaid setting is not "losing one of three equal
layers" — it widens what the sanitizer alone has to hold, and the sanitizer is
the only layer that enforces. With `htmlLabels` off there is no legitimate
`<foreignObject>`, which is why the SVG profile can drop it outright.

## The egress hook is a separate property

Also keep the hook that strips external `href` / `url()` refs and external
`@import` at-rules. It defends the **zero-egress** claim, which is not the same
property as script execution — an `<image href="https://…">` or
`style="fill:url(https://…)"` exfiltrates a page view without running any code.
The detectors are deliberately narrow: internal fragment refs (`url(#arrowhead)`,
`href="#id"`) and `data:` targets must survive, because Mermaid draws every
arrowhead and gradient that way and stripping them breaks real diagrams.

## The registry

Both majors resolve their `.` entry to the `mermaid.core` build, which already
registers every diagram type and layout engine as a lazy dynamic import.
**Never call `registerExternalDiagrams` or `registerLayoutLoaders`** — core does
it, and re-registering risks double-loading. A flowchart page pulls ~850KB and
defers ~2.3MB of cytoscape/KaTeX/elkjs until a diagram needs them. If a future
major changes its default export, re-check that the heavy libs stay lazy.

Version pinning lives here too (`DEFAULT_MAJOR`, `RESOLVED`, `VERSION_OPTIONS`);
the editor's version dropdown and the reader's version label both read it.

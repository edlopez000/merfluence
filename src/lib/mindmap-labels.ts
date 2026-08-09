/**
 * Centre mindmap node labels, working around an upstream Mermaid bug.
 *
 * Mermaid 11's unified renderer anchors *node* label `<text>` at `start`
 * (`createText` passes `centerText = !isNode`, so only edge labels get
 * `text-anchor="middle"`), and `labelHelper` then leaves a non-HTML label at
 * `translate(0, -h/2)`. That only lands centred because each diagram's
 * stylesheet supplies the anchoring — flowchart, for one, emits
 * `.node .label text { text-anchor: middle; }`.
 *
 * The mindmap stylesheet does not. Its only anchoring rule targets
 * `.mindmap-node-label`, a class nothing has carried since mindmap moved to the
 * unified renderer, so mindmap labels stay `start`-anchored: the text begins at
 * the node's centre and runs off its right edge. Three mindmap-specific shapes
 * (the default no-border node, cloud, bang) hard-code
 * `translate(-width/2, …)` and so look right; the root circle and every
 * explicitly shaped node — `((circle))`, `[square]`, `(rounded)`, `{{hex}}` —
 * do not. Verified identical on 11.16.0 and 11.16.1; mermaid.live is unaffected
 * only because it renders with htmlLabels on, which we never can (see
 * .claude/rules/rendering.md).
 *
 * The repair is width-free, so it needs no measuring and forces no reflow:
 * anchor the text at `middle` *and* zero the x of the label group's translate.
 * Both halves are load-bearing — anchoring alone would shove the three shapes
 * that already self-centre left by half their width, and zeroing alone does
 * nothing for the rest. Together every label centres on the node origin, which
 * is what all the shapes intend. Node geometry is untouched: shapes are sized
 * from the label's bbox plus padding, so a centred label always fits.
 *
 * Delete this when Mermaid ships the missing rule. The browser test in
 * test/browser/render.integration.test.js measures the real geometry, so it
 * fails loudly if a future Mermaid changes this contract in either direction.
 *
 * ## Why it works on the string, before sanitizing
 *
 * Same slot and reasoning as a11y-name.js, which it runs alongside: both
 * injection paths transform the markup and then hand the result to
 * `sanitizeSvg`, so DOMPurify stays the last thing to touch anything a reader
 * sees. The cache path's input is macro config — authored by anyone who can
 * edit the page — so this only ever reads and writes attributes through DOM
 * APIs, never string-concatenates markup. `text-anchor` is in DOMPurify's SVG
 * attribute allow-list, so the anchoring survives that pass.
 *
 * Running on the cached string too is what repairs mindmaps saved before this
 * existed without bumping CACHE_VERSION — a bump would cost every un-re-saved
 * page its zero-Mermaid fast path permanently, since the reader has no
 * scope-free way to repopulate the cache.
 */

/**
 * Cheap pre-check: no mindmap node, nothing to do. Every other diagram type —
 * the overwhelming majority of renders — skips the DOM round trip entirely.
 */
const MINDMAP_MARKER = 'mindmap-node';

/**
 * `translate(x, y)` with x captured, so it can be replaced while y survives
 * verbatim. Only the leading translate matters: Mermaid writes exactly one on a
 * label group.
 */
const TRANSLATE_X = /translate\(\s*[-\d.eE+]+/;

/**
 * Centre every mindmap label in `svg`. Returns the markup unchanged when there
 * is nothing to fix, and is idempotent — the cache path re-runs it over SVG
 * this already transformed at save time.
 */
export function centerMindmapLabels(svg: string | null | undefined): string {
  if (typeof svg !== 'string' || !svg.includes(MINDMAP_MARKER)) return svg ?? '';

  // A detached element: nothing here is in the document, so no load/error
  // handler fires and no script runs. Same round trip ensureAccessibleName
  // performs a moment later, on the same markup.
  const host = document.createElement('div');
  host.innerHTML = svg;

  // `g.label` is the discriminator, not `.mindmap-node`: major 10 draws its
  // mindmap labels in an unclassed <g> that already carries text-anchor="middle"
  // and a translate(+width/2, …) which this must NOT zero. Only major 11's
  // unified output puts a `label` class on that group.
  const labels = host.querySelectorAll('g.mindmap-node > g.label');
  if (!labels.length) return svg;

  for (const label of Array.from(labels)) {
    for (const text of Array.from(label.querySelectorAll('text'))) {
      text.setAttribute('text-anchor', 'middle');
    }

    const transform = label.getAttribute('transform');
    if (transform) label.setAttribute('transform', transform.replace(TRANSLATE_X, 'translate(0'));
  }

  return host.innerHTML;
}

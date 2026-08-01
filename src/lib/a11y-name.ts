/**
 * Give the rendered SVG a text alternative (WCAG 2.1 SC 1.1.1).
 *
 * Mermaid already does most of this: it stamps `role="graphics-document
 * document"` on the SVG root, puts the diagram type in `aria-roledescription`,
 * and — when the author writes `accTitle` / `accDescr` in the source — emits a
 * `<title>` / `<desc>` wired up with `aria-labelledby` / `aria-describedby`.
 * Two things were missing:
 *
 *   1. Our sanitize policy was dropping `role` on the floor. `USE_PROFILES:
 *      { svg: true }` has no `role` in its attribute allow-list (it lives in
 *      DOMPurify's *html* list), so Mermaid's role never reached the reader and
 *      the graphic was left with an `aria-roledescription` and no role to
 *      describe. Fixed by adding `role` to ADD_ATTR in render.js.
 *   2. A diagram whose author wrote no `accTitle` has no accessible name at
 *      all — an unlabelled graphic. That is what this module supplies.
 *
 * ## Why the role is conditional
 *
 * `role="img"` makes the graphic atomic: ARIA lists `img` as a role whose
 * children are presentational, so assistive tech announces the accessible name
 * and does not let the user walk into the `<text>` inside the nodes. (That
 * pruning is the screen reader's, not the browser's — Chromium's own tree still
 * lists the text either way, so don't expect to see the difference there.)
 *
 * Atomic is exactly right when the author wrote `accTitle` / `accDescr`: their
 * prose *is* the alternative, and reading the node labels on top of it would be
 * noise. It is wrong when they didn't — the best name we can synthesise is
 * "Flowchart diagram", and trading every node label for those two words is a
 * net loss. So an undescribed diagram keeps Mermaid's `graphics-document
 * document`: named, but still browsable.
 *
 * ## Why it works on the string, before sanitizing
 *
 * Both injection paths run this and then hand the result to `sanitizeSvg`, so
 * DOMPurify stays the last thing to touch anything that reaches a reader's DOM.
 * That matters because the cache path's input comes from macro config, which
 * anyone who can edit the page can author: the type we read out of
 * `aria-roledescription` there is untrusted. Everything below goes through DOM
 * APIs and `textContent`, never string concatenation, so a type carrying markup
 * ends up as inert text rather than as elements.
 *
 * Running on the cached string (rather than only at render time) is also what
 * lets already-saved diagrams gain a name without bumping CACHE_VERSION:
 * `aria-roledescription` survives sanitizing and is present in every SVG either
 * Mermaid major has ever emitted, so a cache written by an older build still
 * carries everything this needs. A bump would have been the alternative, and an
 * expensive one — the reader view has no scope-free way to repopulate the
 * cache, so every page nobody re-saved would lose the zero-Mermaid fast path
 * permanently.
 */

/** Mermaid's own root role, restored verbatim so we don't invent a third value. */
const SVG_ROLE = 'graphics-document document';

/**
 * Marks an `aria-label` this module synthesised, as opposed to one an author
 * put there. It is what keeps the transform idempotent, and idempotency is not
 * theoretical here: the cache path runs this over SVG that renderDiagram
 * already ran it over at save time, so the second pass is the *common* one.
 * Without the marker that pass would read our own name as an author's and
 * promote the graphic to role="img".
 */
const NAMED_MARKER = 'data-mf-named';

/** Used when the type is missing or unrecognisable. Vague, but never wrong. */
const GENERIC_LABEL = 'Diagram';

/**
 * Mermaid's internal diagram-type ids, mapped to something a screen reader can
 * read out. Announcing the raw value would say "flowchart-v2".
 *
 * Keyed on the runtime type id, not on our own template ids: `TEMPLATES` in
 * templates.js uses names we chose (`quadrant`, `xychart`) and covers only the
 * 18 starters, whereas this has to answer for every type either major can
 * render. Aliases are listed explicitly rather than normalised, because the
 * suffix isn't consistent (`-v2`, `-beta`, `-elk`).
 */
const TYPE_LABELS: Record<string, string> = {
  flowchart: 'Flowchart diagram',
  'flowchart-v2': 'Flowchart diagram',
  'flowchart-elk': 'Flowchart diagram',
  graph: 'Flowchart diagram',
  sequence: 'Sequence diagram',
  classDiagram: 'Class diagram',
  'classDiagram-v2': 'Class diagram',
  stateDiagram: 'State diagram',
  'stateDiagram-v2': 'State diagram',
  er: 'Entity relationship diagram',
  journey: 'User journey diagram',
  gantt: 'Gantt chart',
  pie: 'Pie chart',
  quadrantChart: 'Quadrant chart',
  xychart: 'XY chart',
  'xychart-beta': 'XY chart',
  requirement: 'Requirement diagram',
  mindmap: 'Mind map',
  timeline: 'Timeline diagram',
  gitGraph: 'Git graph',
  c4: 'C4 diagram',
  sankey: 'Sankey diagram',
  block: 'Block diagram',
  'block-beta': 'Block diagram',
  packet: 'Packet diagram',
  kanban: 'Kanban board',
  architecture: 'Architecture diagram',
  treemap: 'Treemap diagram',
  radar: 'Radar chart',
  info: 'Information diagram',
};

/**
 * The labels above, as a set. A value that is already one of them is passed
 * through untouched — that is what makes typeLabel() idempotent, since the
 * authored branch writes its own output back into `aria-roledescription`.
 */
const KNOWN_LABELS = new Set(Object.values(TYPE_LABELS));

/**
 * Character guard on the type before it is used as text. Mermaid's ids are
 * plain identifiers; anything else arrived by hand-editing the cached SVG in
 * macro config, and the honest response is to fall back rather than to read a
 * stranger's string aloud. (Injection is already impossible — see the module
 * comment — this is about not announcing garbage.)
 */
const SAFE_TYPE = /^[A-Za-z0-9 _-]{1,40}$/;

/** Nouns that already say "this is a picture of something", so we don't append. */
const SELF_DESCRIBING = /(diagram|chart|graph|map|board|timeline|treemap)$/i;

/**
 * Best human-readable name for a Mermaid diagram type.
 *
 * Unknown ids are humanised rather than discarded: Mermaid keeps adding diagram
 * types and we support two majors, so "Packet diagram" from an id we've never
 * seen beats falling all the way back to "Diagram".
 */
function typeLabel(raw: string | null): string {
  const value = (raw ?? '').trim();
  if (!value || !SAFE_TYPE.test(value)) return GENERIC_LABEL;
  if (KNOWN_LABELS.has(value)) return value;

  // Strip the version/variant suffix once, and use the result for both the map
  // lookup and the humanised fallback — otherwise an unrecognised id announces
  // as "Quantum foam beta diagram".
  const base = value.replace(/-(v\d+|beta|elk)$/i, '');
  const known = TYPE_LABELS[value] ?? TYPE_LABELS[base];
  if (known) return known;

  const words = base
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  if (!words) return GENERIC_LABEL;

  const name = words.charAt(0).toUpperCase() + words.slice(1);
  return SELF_DESCRIBING.test(name) ? name : `${name} diagram`;
}

/**
 * The element an `aria-labelledby` / `aria-describedby` on the root points at,
 * if the *author* supplied it.
 *
 * Only a direct child counts, and only a `<title>` / `<desc>`: that is where
 * Mermaid puts `accTitle` / `accDescr`, whereas the `<title>` tooltips a
 * `click` directive can produce live deep in the tree.
 */
function authoredRef(root: SVGElement, attr: string): Element | null {
  const ids = (root.getAttribute(attr) ?? '').trim().split(/\s+/).filter(Boolean);
  if (!ids.length) return null;

  for (const child of Array.from(root.children)) {
    const tag = child.localName;
    if (tag !== 'title' && tag !== 'desc') continue;
    if (!ids.includes(child.id)) continue;
    if (!(child.textContent ?? '').trim()) continue;
    return child;
  }
  return null;
}

/**
 * Name the graphic after its type, via `aria-label` rather than an injected
 * `<title>`. Both name it, but a `<title>` on the root costs two things we
 * don't want: the browser paints it as a tooltip over the whole canvas, which
 * flickers under a cursor that is there to drag and pan; and Chromium then
 * reports it as the accessible *description* as well as the name, so a screen
 * reader says "Flowchart diagram" twice. Verified in a real accessibility tree,
 * not assumed. An author's own `<title>` (from accTitle) is left alone — there
 * the tooltip is genuinely useful and the description is their accDescr.
 *
 * Re-running leaves the name from the previous pass in place; by then the type
 * it was derived from has been cleared (see below).
 */
function nameFromType(root: SVGElement, label: string) {
  if (root.hasAttribute(NAMED_MARKER)) return;
  root.setAttribute('aria-label', label);
  root.setAttribute(NAMED_MARKER, 'type');
}

/**
 * Ensure the root `<svg>` in `svg` exposes an accessible name, and a role that
 * suits how well it is described. Returns the markup unchanged if there is no
 * root `<svg>` to work on.
 */
export function ensureAccessibleName(svg: string | null | undefined): string {
  if (typeof svg !== 'string' || !svg.trim()) return svg ?? '';

  // A detached element: nothing here is in the document, so no load/error
  // handler fires and no script runs. It is the same lenient HTML round-trip
  // DOMPurify performs on this markup a moment later, so it adds no fidelity
  // risk the SVG doesn't already survive.
  const host = document.createElement('div');
  host.innerHTML = svg;
  const root = host.querySelector('svg');
  if (!root) return svg;

  const label = typeLabel(root.getAttribute('aria-roledescription'));
  // An aria-label we put there ourselves is not evidence the author named it.
  const authoredLabel =
    !root.hasAttribute(NAMED_MARKER) && (root.getAttribute('aria-label') ?? '').trim() !== '';
  const authoredTitle = authoredLabel || authoredRef(root, 'aria-labelledby') !== null;
  const authoredDesc = authoredRef(root, 'aria-describedby') !== null;

  if (authoredTitle || authoredDesc) {
    // The author described the diagram, so their text is the alternative and
    // the graphic can be atomic. The type stays on as a roledescription, where
    // it adds to the author's name instead of repeating it ("Deploy pipeline,
    // flowchart diagram").
    root.setAttribute('role', 'img');
    root.setAttribute('aria-roledescription', label);
    // accDescr with no accTitle: a description with nothing naming it. Supply
    // the type as the name so the description has something to hang off.
    if (!authoredTitle) nameFromType(root, label);
    return host.innerHTML;
  }

  // Undescribed: keep Mermaid's role so the node text stays reachable, and name
  // the graphic after its type. The roledescription goes, because it would now
  // announce the same words as the name we just gave it.
  root.setAttribute('role', SVG_ROLE);
  root.removeAttribute('aria-roledescription');
  nameFromType(root, label);
  return host.innerHTML;
}

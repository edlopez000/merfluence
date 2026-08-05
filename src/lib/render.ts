import DOMPurify from 'dompurify';
import { ensureAccessibleName } from './a11y-name.js';
import { loadMermaid, resolveMajor } from './mermaid-registry.js';

/**
 * Hard cap on diagram source length, matching Mermaid's historical default
 * `maxTextSize` (~50K chars) so behavior is unchanged — just made explicit.
 *
 * We enforce it ourselves *before* handing source to Mermaid (see
 * enforceSourceLimit) for two reasons: a pathological megabyte of text never
 * loads or parses through Mermaid (no hang), and the user sees a clear message
 * instead of Mermaid's generic "Maximum text size in diagram exceeded". The
 * same number is also set as `maxTextSize` in baseConfig, so if the pre-parse
 * cap were ever bypassed the library guard still backs it.
 */
export const MAX_SOURCE_CHARS = 50000;

/**
 * Two hardening layers, both load-bearing.
 *
 * Macro config is authored by anyone who can edit the page and rendered for
 * everyone who can read it. Mermaid's `click` directive can bind handlers, and
 * htmlLabels wraps label text in <foreignObject>, which is a hole you can drive
 * arbitrary HTML through.
 *
 *   securityLevel: 'strict'  -> click directives inert, HTML in labels escaped
 *   htmlLabels: false        -> no <foreignObject>, so labels are plain <text>
 *
 * Then DOMPurify with the SVG profile catches whatever the first two missed.
 * With htmlLabels off there is no legitimate <foreignObject>, so the profile
 * stripping it costs us nothing.
 */
function baseConfig({ theme, useMaxWidth }: { theme: string; useMaxWidth: boolean }) {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    // Explicit rather than relying on Mermaid's default. Pairs with the
    // pre-parse enforceSourceLimit() guard, which fires first with a friendlier
    // message; this is the library-level backstop at the same number.
    maxTextSize: MAX_SOURCE_CHARS,
    // On a failed render(), remove the temp container and rethrow instead of
    // pinning an error <div> to the document. Honored by major 11, which lets
    // renderDiagram skip its screening pre-parse there; major 10 ignores the
    // key and keeps the pre-parse (see renderDiagram).
    suppressErrorRendering: true,
    theme: theme === 'dark' ? 'dark' : 'default',
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    flowchart: { htmlLabels: false, useMaxWidth },
    sequence: { useMaxWidth },
    class: { htmlLabels: false, useMaxWidth },
    state: { useMaxWidth },
    er: { useMaxWidth },
    journey: { useMaxWidth },
    gantt: { useMaxWidth },
    pie: { useMaxWidth },
    // The rest of the template types. Every section below exposes useMaxWidth in
    // Mermaid 11, so the "Keep full width" toggle reaches them too. Keys absent in
    // major 10 (kanban/architecture/block) are simply ignored there.
    mindmap: { useMaxWidth },
    timeline: { useMaxWidth },
    gitGraph: { useMaxWidth },
    quadrantChart: { useMaxWidth },
    xyChart: { useMaxWidth },
    sankey: { useMaxWidth },
    c4: { useMaxWidth },
    block: { useMaxWidth },
    kanban: { useMaxWidth },
    architecture: { useMaxWidth },
  };
}

const SANITIZE = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // `role` is not in DOMPurify's *svg* attribute list — it lives in the html
  // one, which USE_PROFILES:{svg} doesn't pull in. Without this the sanitizer
  // silently drops the `role="graphics-document document"` Mermaid puts on
  // every SVG root, leaving the graphic with an aria-roledescription and no
  // role to describe (see a11y-name.js, which then can't set one either).
  // aria-* needs no entry: DOMPurify allows it via ALLOW_ARIA_ATTR.
  ADD_ATTR: ['transform-origin', 'role'],
};

/**
 * True if a reference points at an external *network* host — an http(s) URL or
 * a protocol-relative `//host/…`. These are the only refs that egress when the
 * browser paints the SVG.
 *
 * What this deliberately does NOT match, and must never strip:
 *   - `url(#arrowhead)` / `href="#id"` — internal fragment refs. Mermaid draws
 *     every arrowhead as `marker-end="url(#id)"` and its gradients/clip-paths
 *     as `fill="url(#id)"`; killing these would break real diagrams.
 *   - `data:` URIs — inline, so no egress. Nothing in our Mermaid config emits
 *     them today; we leave them to the SVG profile's own data-URI handling.
 */
function isExternalRef(value: string) {
  return /^\s*(?:https?:)?\/\//i.test(value) || /^\s*https?:/i.test(value);
}

/** An external network target inside a `url(...)` token. */
const EXTERNAL_URL_FN = /url\(\s*['"]?\s*(?:https?:)?\/\//i;

/**
 * An external network target on an `@import`. The at-rule takes either a
 * `url(...)` or a bare string, and the bare-string form is invisible to
 * EXTERNAL_URL_FN — which is exactly why it needs its own pattern.
 */
const EXTERNAL_IMPORT = /@import\s+['"]?\s*(?:https?:)?\/\//i;

/**
 * Strip `url(http…)` / `url(//host…)` occurrences and external `@import`
 * at-rules, leaving `url(#id)` intact.
 */
function stripExternalUrlRefs(value: string) {
  return (
    value
      // @import first, and as a whole statement. Stripping just the url() out of
      // `@import url(https://…);` would leave `@import ;` — invalid CSS — and the
      // bare-string form `@import "https://…";` has no url() token to strip at
      // all. Dropping the rule outright handles both. Nothing legitimate in a
      // rendered Mermaid SVG imports a stylesheet.
      .replace(/@import\b[^;]*;?/gi, (rule) =>
        EXTERNAL_IMPORT.test(rule) || EXTERNAL_URL_FN.test(rule) ? '' : rule,
      )
      // Then the url() tokens. Match a CSS url() whose target is an external
      // network ref; drop the whole token. Internal `url(#…)` and `data:`
      // targets don't match and survive.
      .replace(/url\(\s*['"]?\s*(?:https?:)?\/\/[^)]*\)/gi, '')
  );
}

/**
 * Resolve CSS escape sequences (`\68` → `h`, `\.` → `.`).
 *
 * Used for *detection only* — the decoded string is never returned to the DOM.
 * CSS lets any character be written as an escape, so `url(\68 ttps://evil/x)`
 * fetches perfectly well while matching no pattern that looks for "https".
 */
function decodeCssEscapes(value: string) {
  return value
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\(.)/g, '$1');
}

/**
 * Scrub the CSS text of a `<style>` element, failing closed.
 *
 * The pattern-based strip above is the same one the attribute path uses, but
 * element text is a roomier hiding place, so its result is verified: decode
 * escapes and look again. If an external ref survived, the strip was evaded and
 * we drop the whole block rather than ship CSS we know still egresses.
 *
 * Blanking is safe here. Mermaid's theme CSS is colours, strokes and fonts — it
 * references no network host — so a legitimate diagram never trips the verify.
 * The detectors are deliberately narrow (an external target inside `url(` or
 * after `@import`, not "any string containing //") so that a stylesheet merely
 * *mentioning* a URL in, say, a `content:` string is not blanked.
 */
function scrubStyleText(css: string) {
  const scrubbed = stripExternalUrlRefs(css);
  const decoded = decodeCssEscapes(scrubbed);
  return EXTERNAL_URL_FN.test(decoded) || EXTERNAL_IMPORT.test(decoded) ? '' : scrubbed;
}

// Presentation attributes that can carry a `url(...)` paint/reference. `style`
// is handled separately (it holds arbitrary CSS, not a single url()).
const URL_BEARING_ATTRS = new Set([
  'fill',
  'stroke',
  'clip-path',
  'mask',
  'filter',
  'marker-start',
  'marker-mid',
  'marker-end',
]);

/**
 * Egress guard: strip references to external network hosts from the SVG before
 * it reaches a reader's DOM. Script execution is closed by three other layers
 * (securityLevel:'strict', htmlLabels:false, the SVG profile); this closes the
 * remaining hole — `<image href="https://…">` and `style="fill:url(https://…)"`
 * would otherwise fire an outbound request (a tracking pixel) when painted,
 * contradicting the app's zero-egress claim. Registered once, at module load,
 * against the single imported DOMPurify instance.
 */
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  const name = data.attrName;
  const value = data.attrValue ?? '';

  // URI attributes: an external href/xlink:href on <image>/<use>/etc. Dropping
  // the attribute leaves the element inert (no source to fetch).
  if ((name === 'href' || name === 'xlink:href') && isExternalRef(value)) {
    data.keepAttr = false;
    return;
  }

  // The style attribute holds arbitrary CSS; scrub only external url() refs.
  if (name === 'style') {
    data.attrValue = stripExternalUrlRefs(value);
    return;
  }

  // Presentation attrs whose whole value may be an external url(...) paint.
  if (URL_BEARING_ATTRS.has(name) && /url\(/i.test(value)) {
    data.attrValue = stripExternalUrlRefs(value);
  }
});

/**
 * The same egress guard, one level down: CSS carried as element *text* rather
 * than in an attribute.
 *
 * The hook above is attribute-scoped by construction, so it never sees a
 * `<style>` block — and `<style>` is allow-listed by the SVG profile, so an
 * `@import` or `background-image: url(https://…)` inside one reaches the reader
 * and fetches on paint. This closes that path.
 *
 * Scrubbed, not stripped: Mermaid puts its theming in a `<style>` on every
 * diagram it renders, so dropping the element would unstyle every diagram.
 * The element is legitimate; only external references in it are not.
 */
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName !== 'style') return;

  const css = node.textContent ?? '';
  const scrubbed = scrubStyleText(css);
  if (scrubbed !== css) node.textContent = scrubbed;
});

/**
 * The single sanitize policy, exported so every path that injects SVG into a
 * reader's DOM runs the same one. Fresh renders sanitize here; the view also
 * runs cached SVG through this before injecting it, because that cache lives in
 * macro config — an untrusted-input boundary — and may have been hand-edited to
 * bypass the sanitize that ran at save time.
 *
 * Beyond neutralizing active content, this also strips external resource
 * references (see the uponSanitizeAttribute hook above) so no rendered diagram
 * can leak a reader's IP/UA/page-view to an arbitrary host.
 */
export function sanitizeSvg(svg: string | null | undefined) {
  return DOMPurify.sanitize(svg ?? '', SANITIZE);
}

let seq = 0;
const nextId = () => `mmd-${Date.now().toString(36)}-${seq++}`;

/**
 * Each loaded Mermaid major is a stateful singleton: initialize() writes site
 * config that the parse/render calls after it read back. Two callers whose
 * awaits interleave — the editor's debounced preview against save() is the real
 * case — can therefore render under the *other* caller's theme, which is the
 * exact bug class behind the CACHE_VERSION v1→v2 bump. This chain serializes
 * every initialize→parse→render critical section. Failures are absorbed from
 * the chain (never from the caller, who still sees the rejection) so one bad
 * render can't wedge every render after it.
 */
let mermaidTurn: Promise<void> = Promise.resolve();

function withMermaidLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mermaidTurn.then(fn);
  mermaidTurn = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * initialize() is not free — it rebuilds the whole theme variable set — and the
 * preview calls it with identical settings on every debounce tick. Skip it when
 * this major was last initialized with the same effective config. Keyed per
 * major (each major is its own module instance with its own site config), and
 * only sound because the lock above serializes the section between initialize
 * and the render that depends on it.
 */
const lastInitByMajor = new Map<string, string>();

function initializeOnce(
  mermaid: { initialize: (config: object) => void },
  major: string,
  config: { theme: string; useMaxWidth: boolean },
) {
  // The same normalization baseConfig applies, so 'light' and 'default' share
  // a key rather than thrashing the memo.
  const key = `${config.theme === 'dark' ? 'dark' : 'default'}|${config.useMaxWidth}`;
  if (lastInitByMajor.get(major) === key) return;
  mermaid.initialize(baseConfig(config));
  lastInitByMajor.set(major, key);
}

/**
 * Mermaid's parse errors carry a line number in different shapes depending on
 * whether the grammar is jison-based (`hash.loc.first_line`) or one of the
 * newer langium parsers (line embedded in the message). Dig out whatever we
 * can and fall back to the raw message.
 *
 * `err` is `any`, not `unknown`: it is an arbitrarily-shaped thrown value and the
 * body walks optional-chained paths (`err?.hash?.loc?.first_line`) that `unknown`
 * would reject before the runtime guards can run.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function describeError(err: any) {
  const message = String(err?.message ?? err ?? 'Unknown error').trim();

  const jisonLine = err?.hash?.loc?.first_line;
  if (Number.isInteger(jisonLine)) {
    return { line: jisonLine, message };
  }

  const match = message.match(/line[:\s]+(\d+)/i);
  if (match) {
    return { line: Number(match[1]), message };
  }

  return { line: null, message };
}

/**
 * Reject oversized source before it reaches Mermaid. Throwing here (rather than
 * letting mermaid.parse hit its own maxTextSize guard) keeps a pathological
 * input from ever loading/parsing Mermaid, and gives the user a clear message
 * that surfaces through describeError into the preview/reader error panels.
 */
function enforceSourceLimit(source: string) {
  const length = (source ?? '').length;
  if (length > MAX_SOURCE_CHARS) {
    throw new Error(
      `Diagram source is too large (${length} characters; limit is ${MAX_SOURCE_CHARS}).`,
    );
  }
}

/** Throws on invalid syntax. Cheap enough to run on every keystroke. */
export async function validate(source: string, versionPref = 'auto') {
  enforceSourceLimit(source);
  await withMermaidLock(async () => {
    const mermaid = await loadMermaid(versionPref);
    initializeOnce(mermaid, resolveMajor(versionPref), { theme: 'default', useMaxWidth: true });
    await mermaid.parse(source);
  });
}

/** @returns sanitized SVG markup */
export async function renderDiagram({
  source,
  versionPref = 'auto',
  theme = 'light',
  useMaxWidth = true,
}: {
  source: string;
  versionPref?: string;
  theme?: string;
  useMaxWidth?: boolean;
}): Promise<{ svg: string; major: string }> {
  const trimmed = (source ?? '').trim();
  if (!trimmed) throw new Error('Diagram is empty');
  enforceSourceLimit(trimmed);

  const major = resolveMajor(versionPref);
  const { svg } = await withMermaidLock(async () => {
    const mermaid = await loadMermaid(versionPref);
    initializeOnce(mermaid, major, { theme, useMaxWidth });

    // Major 10 doesn't honor suppressErrorRendering, so a syntax error inside
    // render() would leave an orphan <div id="dmmd-..."> pinned to the document
    // — a real Mermaid failure mode. There, parse() screens the source first.
    // Major 11 honors the flag (set in baseConfig): render() cleans up its temp
    // elements and rethrows, so the same source parses once instead of twice.
    if (major !== '11') await mermaid.parse(trimmed);

    return mermaid.render(nextId(), trimmed);
  });
  // Name the graphic before sanitizing, so DOMPurify stays the last pass over
  // anything that reaches a reader's DOM. The cache path in the view runs the
  // same two steps in the same order. Both are pure string work on the produced
  // SVG, so they run outside the lock.
  return { svg: sanitizeSvg(ensureAccessibleName(svg)), major: resolveMajor(versionPref) };
}

/** Intrinsic pixel size of a rendered SVG, for sizing the iframe. */
export function measureSvg(container: Element | null | undefined) {
  const svg = container?.querySelector('svg');
  if (!svg) return null;
  const box = svg.getBoundingClientRect();
  return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
}

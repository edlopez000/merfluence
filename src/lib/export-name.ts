/**
 * The filename an export lands under in the reader's Downloads folder.
 *
 * Both exports used to be called `diagram`, so a reader who saved three of them
 * ended up with `diagram (1).png` and `diagram (2).png` and no way to tell which
 * was which without opening them. What we can put there instead is constrained
 * by the zero-scope invariant: there is no page title to borrow. `getContext()`
 * carries ids, not titles, and turning a content id into a title is a REST call
 * — a scope — which the manifest does not have and will not get. So the name is
 * built from the two things already in the browser: the diagram source (macro
 * config) and the rendered SVG's accessibility attributes.
 *
 * The shape is `<what-it-is>-<when-you-saved-it>`:
 *
 *   deploy-pipeline-20260808-143205.png
 *   flowchart-20260808-143211.svg
 *
 * The timestamp is doing two jobs. It makes every download unique, so the
 * browser never has to disambiguate with `(1)` — which is the actual complaint,
 * since a `(2)` suffix tells you nothing about the file. And it sorts: zero
 * padded, most-significant-first, so Downloads sorted by name is Downloads
 * sorted by when you exported.
 */

import { NAMED_MARKER } from './a11y-name.js';

/** Used when neither the source nor the SVG offers anything better. */
const FALLBACK = 'diagram';

/**
 * Cap on the descriptive half. Long enough for a real diagram title, short
 * enough that the name survives a shell, a Slack upload and a Windows path
 * without being truncated somewhere less careful than here.
 */
const MAX_SLUG = 48;

/**
 * Text → filename-safe slug.
 *
 * Deliberately ASCII-only. Decomposing first means an accented title still
 * yields letters (`Café` → `cafe`) rather than losing them, but a title with no
 * Latin letters at all — CJK, Cyrillic — slugs to empty, and the caller then
 * falls back to the diagram type. That is the right trade: a name of percent
 * escapes is worse than "flowchart", and the timestamp still distinguishes it.
 */
function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // the combining marks NFKD just split off
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length <= MAX_SLUG) return slug;
  // Cut on a word boundary rather than mid-word, so the truncation reads as a
  // shortened title instead of a typo. A single word longer than the cap has no
  // boundary to cut on and is taken hard.
  const cut = slug.slice(0, MAX_SLUG);
  const boundary = cut.lastIndexOf('-');
  return (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/-+$/, '');
}

/** `"Deploy pipeline"` and `'Deploy pipeline'` are both just Deploy pipeline. */
function stripQuotes(value: string): string {
  const text = value.trim();
  const first = text.charAt(0);
  if ((first === '"' || first === "'") && text.length > 1 && text.endsWith(first)) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Mermaid's YAML frontmatter block, if the source opens with one, and the rest
 * of the source separately.
 *
 * Splitting matters for the searches below: `title:` inside frontmatter is the
 * frontmatter title, whereas `title Foo` in the body is the diagram directive.
 * Scanning the whole string for both would let a frontmatter key answer a
 * question about the body.
 */
function splitFrontmatter(source: string): { front: string; body: string } {
  const match = /^\ufeff?[ \t]*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/.exec(
    source,
  );
  if (!match) return { front: '', body: source };
  return { front: match[1], body: source.slice(match[0].length) };
}

/**
 * `title` as a key (`title: Foo`) or as a directive (`title Foo`) — the two
 * spellings Mermaid uses, in frontmatter and in pie / gantt / xychart / journey
 * / quadrant bodies respectively. Matching both in one pattern means neither
 * caller has to know which dialect it is looking at.
 */
const TITLE = /^[ \t]*title[ \t]*(?::[ \t]*|[ \t]+)(\S.*)$/m;

/** Single-line only: that is the whole of `accTitle`'s grammar (the brace block
 *  form belongs to `accDescr`, which is a description, not a name). */
const ACC_TITLE = /^[ \t]*accTitle[ \t]*:[ \t]*(\S.*)$/m;

/**
 * The best name the author gave this diagram, in the order of how deliberate
 * each one is: a frontmatter title names the diagram, `accTitle` names it for a
 * screen reader, a `title` directive is a heading drawn on the chart.
 */
function sourceTitle(source: string): string {
  const { front, body } = splitFrontmatter(source);

  const frontTitle = front ? TITLE.exec(front) : null;
  if (frontTitle) return stripQuotes(frontTitle[1]);

  const acc = ACC_TITLE.exec(body);
  if (acc) return stripQuotes(acc[1]);

  const directive = TITLE.exec(body);
  return directive ? stripQuotes(directive[1]) : '';
}

/**
 * The diagram's type, taken off the rendered SVG rather than re-parsed out of
 * the source.
 *
 * a11y-name.js already owns the id → label mapping and already keeps it current
 * across both pinned Mermaid majors; deriving the type here a second way would
 * be a table that silently drifts from that one. After `ensureAccessibleName`
 * has run — and it runs on the fresh-render and the cache-hit paths alike — the
 * label is on exactly one of two attributes, depending on which branch it took:
 * `aria-label` when it synthesised the name itself (the marker says so), and
 * `aria-roledescription` when the author's own `accTitle` / `accDescr` supplied
 * the name instead.
 */
function typeSlug(svg: SVGElement | null): string {
  if (!svg) return '';
  const label = svg.hasAttribute(NAMED_MARKER)
    ? svg.getAttribute('aria-label')
    : svg.getAttribute('aria-roledescription');

  const slug = slugify(label ?? '');
  // "Flowchart diagram" → flowchart, because the extension already says it is a
  // picture. Only that suffix goes: "Pie chart" → pie-chart and "Git graph" →
  // git-graph, where the second word is half the name rather than a category.
  return slug.replace(/-?diagram$/, '') || slug;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/**
 * `YYYYMMDD-HHMMSS` in the reader's local time.
 *
 * Local, not `toISOString()`: someone matching a download against when they
 * clicked is reading a wall clock, and a UTC stamp is wrong by their offset.
 * Down to the second because exporting PNG-with-background and then
 * PNG-transparent takes a couple of clicks, and a minute-resolution stamp would
 * collide on exactly the pair of exports someone is most likely to want side by
 * side.
 */
function stamp(now: Date): string {
  return (
    `${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * The export filename without its extension.
 *
 * `now` is injectable so the tests can assert a stamp; production omits it.
 * Note that the timestamp also happens to defuse the Windows reserved device
 * names — a diagram titled `CON` becomes `con-20260808-143205`, which is a
 * legal filename, so nothing here has to carry that list.
 */
export function exportBaseName(
  source: string,
  svg: SVGElement | null,
  now: Date = new Date(),
): string {
  const name = slugify(sourceTitle(source ?? '')) || typeSlug(svg) || FALLBACK;
  return `${name}-${stamp(now)}`;
}

/**
 * The full filename for one export. PNG and SVG of the same diagram share a
 * base, so an export of both lands as an adjacent pair in Downloads.
 */
export function exportFilename(
  source: string,
  svg: SVGElement | null,
  ext: 'png' | 'svg',
  now?: Date,
): string {
  return `${exportBaseName(source, svg, now)}.${ext}`;
}

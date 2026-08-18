/**
 * Grapheme-aware, kinsoku-safe line breaking for CJK label text.
 *
 * Mermaid's own wrapper (`wrapLabel` in its `chunk-*.mjs` utils) splits on
 * `" "`, so a Japanese or Chinese run — which has no spaces — is a single
 * "word". It then falls through to `breakString`, which walks *code points* and
 * appends `-` to every line. That is wrong three ways for Japanese: the hyphens
 * are meaningless, kinsoku is ignored, and code-point iteration shreds grapheme
 * clusters (🇯🇵 is a regional-indicator pair, 👨‍👩‍👧‍👦 a ZWJ sequence, 👍🏽 carries a
 * skin-tone modifier, 葛󠄀 an ideographic variation selector).
 *
 * This module is the replacement, and it is deliberately type-agnostic: it
 * knows nothing about diagrams. `cjk-wrap.ts` owns which strings to feed it and
 * what budget each one gets. See docs/UPSTREAM-CJK-LABEL-WRAP.md.
 *
 * Why widths are a table and not a measurement.
 *
 * Every alternative to a static table measures a real font: canvas
 * `measureText`, or a probe `<text>` plus `getBBox()`. Both would make the unit
 * suite depend on the fonts installed on the machine running it, make jsdom
 * useless for testing this at all, and — because the probe would run in
 * whichever document is current — let a light render and a dark render disagree
 * about where the breaks go, which the save-time cache then bakes in as two
 * different diagrams. A deterministic table is worth far more than the accuracy
 * it gives up, and both callers budget with generous slack to cover the error.
 */

/**
 * East Asian Wide + Fullwidth, the code points that occupy a full em. Written
 * as ranges rather than `\p{East_Asian_Width=W}` because that property escape
 * is not available in `RegExp`; these are the blocks that matter for label
 * text (Hangul, kana, the CJK ideograph planes, fullwidth forms).
 */
const WIDE =
  /^(?:[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]|[\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}])/u;

/** Emoji, which render wider than an ideograph in every font we ship against. */
const PICTOGRAPHIC = /^(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])/u;

/**
 * Does this string contain any East Asian character?
 *
 * The gate for the whole pass. A label with none is returned byte-identical by
 * `cjk-wrap.ts`, so every Latin diagram — including every fixture in `test/` —
 * renders exactly as it did before this module existed. Long Latin labels
 * overflow the same boxes upstream, but fixing those would shift the geometry
 * of diagrams nobody has complained about; that is tracked separately.
 */
export function hasEastAsian(text: string): boolean {
  for (const ch of text) {
    if (WIDE.test(ch)) return true;
  }
  return false;
}

/** Width of one unbreakable unit, in em. */
function unitWidthEm(unit: string): number {
  // Pictographic first: a few of them (〰 U+3030, 〽 U+303D) also fall inside
  // the WIDE ranges, and the emoji width is the one that matters.
  if (PICTOGRAPHIC.test(unit)) return 1.2;
  if (WIDE.test(unit)) return 1;
  // A Latin/number run is many characters in one unit; everything else here is
  // a single narrow grapheme.
  return 0.5 * [...unit].length;
}

/** The width of a whole string in em, under the same model. Used by the callers' fit check. */
export function textWidthEm(text: string): number {
  return groupUnits(segmentGraphemes(text)).reduce((sum, u) => sum + unitWidthEm(u), 0);
}

/**
 * 行頭禁則 — may not begin a line. Closing brackets, the punctuation that
 * follows a phrase, sound marks, iteration marks, the prolonged-sound mark, and
 * small kana (which are a modifier on the preceding mora, not a syllable of
 * their own).
 */
const NO_START = new Set([
  ...'、。，．・：；？！゛゜ヽヾゝゞ々ー―‐’”）〕］｝〉》」』】〙〗»',
  ...'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ',
  ...'%‰℃℉,.!?:;)]}',
]);

/** 行末禁則 — may not end a line: opening brackets and prefixed currency/marks. */
const NO_END = new Set([...'‘“（〔［｛〈《「『【〘〖«￥＄£＃＠([{']);

/**
 * A cached grapheme segmenter, re-created if `Intl.Segmenter` itself changes.
 *
 * Resolved at call time rather than module load so the "no Segmenter" path is
 * testable, and so a host without it degrades to a no-op instead of throwing at
 * import. Every browser Forge runs a Custom UI iframe in has had it for years;
 * this is belt-and-braces, not a supported configuration.
 */
let segmenterCache: {
  ctor: unknown;
  instance: { segment(s: string): Iterable<{ segment: string }> };
} | null = null;
function graphemeSegmenter() {
  const ctor = (globalThis as { Intl?: { Segmenter?: unknown } }).Intl?.Segmenter;
  if (typeof ctor !== 'function') return null;
  if (segmenterCache?.ctor === ctor) return segmenterCache.instance;
  const instance = new (
    ctor as new (l: undefined, o: object) => { segment(s: string): Iterable<{ segment: string }> }
  )(undefined, { granularity: 'grapheme' });
  segmenterCache = { ctor, instance };
  return instance;
}

function segmentGraphemes(text: string): string[] | null {
  const segmenter = graphemeSegmenter();
  if (!segmenter) return null;
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

const ALNUM = /^[A-Za-z0-9]$/;
/** Joins that keep a token whole *between* two alphanumerics: `85.5`, `1,500`, `v11.13.0`, `build-2026-08-09-1142`. */
const RUN_INNER = /^[.,\-_/:+]$/;

/**
 * Merge grapheme clusters into unbreakable units.
 *
 * A cluster is already unbreakable. On top of that, a Latin/number run is one
 * unit, so identifiers and figures survive intact: breaking `SonarQube` or
 * `85.5%` across two lines of a note would be a worse defect than the overflow
 * this module exists to fix.
 */
function groupUnits(clusters: string[] | null): string[] {
  if (!clusters) return [];
  const units: string[] = [];
  let i = 0;
  while (i < clusters.length) {
    if (!ALNUM.test(clusters[i])) {
      units.push(clusters[i]);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < clusters.length) {
      if (ALNUM.test(clusters[end])) {
        end += 1;
      } else if (
        RUN_INNER.test(clusters[end]) &&
        end + 1 < clusters.length &&
        ALNUM.test(clusters[end + 1])
      ) {
        // Only a *separator*, never a terminator: `85.5` keeps its dot, the
        // full stop ending a sentence does not join the word before it.
        end += 2;
      } else if (clusters[end] === '%') {
        end += 1;
        break;
      } else {
        break;
      }
    }
    units.push(clusters.slice(i, end).join(''));
    i = end;
  }
  return units;
}

const WHITESPACE = /^\s+$/;

/**
 * Break `text` into lines no wider than `budgetEm`, in em under the model above.
 *
 * Greedy fill with the kinsoku correction applied *at* the break, in the
 * push-down direction: when the unit that would start the next line may not
 * begin one, the last unit of the current line goes down with it, rather than
 * squeezing the offender back onto a line that is already full. Pulling back
 * would be the other legal JIS X 4051 strategy, but it overruns the budget by a
 * whole character, and these budgets are what stops the text leaving the box.
 *
 * At most one adjustment per boundary, and never one that would empty a line.
 * A run of forbidden characters (`。。。`) would otherwise bounce a unit between
 * lines forever: a slightly-off break is fine, a hang or an empty `<text>` row
 * is not.
 *
 * `maxLines` caps the row count for a box whose *height* is also fixed (journey
 * tiles). Everything past the cap is concatenated onto the last permitted line
 * and allowed to run over horizontally — one over-wide line is recoverable,
 * a row drawn below the tile is not.
 *
 * @returns the lines; `[text]` unchanged if `Intl.Segmenter` is unavailable.
 */
export function breakCjkText(
  text: string,
  { budgetEm, maxLines }: { budgetEm: number; maxLines?: number },
): string[] {
  const clusters = segmentGraphemes(text);
  if (!clusters) return [text];

  const units = groupUnits(clusters);
  if (units.length === 0) return [text];

  const lines: string[][] = [];
  let line: string[] = [];
  let width = 0;

  for (const unit of units) {
    const w = unitWidthEm(unit);
    if (line.length > 0 && width + w > budgetEm) {
      const carry: string[] = [];
      if (line.length >= 2 && (NO_START.has(unit) || NO_END.has(line[line.length - 1]))) {
        carry.push(line.pop() as string);
      }
      lines.push(line);
      line = carry;
      width = carry.reduce((sum, u) => sum + unitWidthEm(u), 0);
    }
    // A line never opens with a space: the break already separated the words.
    if (line.length === 0 && WHITESPACE.test(unit)) continue;
    line.push(unit);
    width += w;
  }
  if (line.length > 0) lines.push(line);

  const rows = lines.map((l) => l.join('').replace(/\s+$/, ''));
  if (maxLines && rows.length > maxLines) {
    return [...rows.slice(0, maxLines - 1), rows.slice(maxLines - 1).join('')];
  }
  return rows;
}

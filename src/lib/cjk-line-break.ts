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

/**
 * A unit that is never broken apart: one grapheme cluster, or a run of them that
 * belongs together (a Latin/number token, a katakana loanword).
 */
type Unit = string[];

const unitText = (unit: Unit) => unit.join('');

/** Width of one grapheme cluster, in em. */
function clusterWidthEm(cluster: string): number {
  // Pictographic first: a few of them (〰 U+3030, 〽 U+303D) also fall inside
  // the WIDE ranges, and the emoji width is the one that matters.
  if (PICTOGRAPHIC.test(cluster)) return 1.2;
  if (WIDE.test(cluster)) return 1;
  return 0.5;
}

/** Width of a whole unit — clusters are summed, so a run costs what it draws. */
function unitWidthEm(unit: Unit): number {
  let total = 0;
  for (const cluster of unit) total += clusterWidthEm(cluster);
  return total;
}

/**
 * The width of a whole string in em, under the same model. Used by the callers'
 * fit check. Grouping is irrelevant here — it changes where the breaks go, not
 * how wide the text is — so this sums clusters directly.
 */
export function textWidthEm(text: string): number {
  const clusters = segmentGraphemes(text);
  if (!clusters) return 0;
  return unitWidthEm(clusters);
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
 * Katakana, full-width and half-width, as two separate runs.
 *
 * `ー` (U+30FC) and the iteration marks are inside a loanword, so they join the
 * run. `・` (U+30FB) is deliberately absent: it *separates* two loanwords, so it
 * is a legitimate place to break — and it is already in NO_START, so it can
 * never open a line.
 */
const KATAKANA = /^[\u30A1-\u30FA\u30FC-\u30FE]$/;
const KATAKANA_HALF = /^[\uFF66-\uFF9F]$/;

/** True for a run this module keeps whole only when it fits (see breakCjkText). */
function isSoftRun(unit: Unit): boolean {
  return (
    unit.length > 1 &&
    (unit.every((c) => KATAKANA.test(c)) || unit.every((c) => KATAKANA_HALF.test(c)))
  );
}

/**
 * Merge grapheme clusters into unbreakable units.
 *
 * A cluster is already unbreakable. On top of that:
 *
 * - a **Latin/number run** is one unit, so identifiers and figures survive
 *   intact — breaking `SonarQube` or `85.5%` across two lines of a note would be
 *   a worse defect than the overflow this module exists to fix. This one is
 *   hard: it is never broken, whatever it costs in line width.
 * - a **katakana run** is one unit, because Japanese typesetting keeps a
 *   loanword whole. `ブロック` split as `ブロッ` / `ク` is legal under JIS X 4051
 *   but reads badly, and it is what this module produced before. This one is
 *   *soft*: `breakCjkText` puts it back into clusters when the word alone is
 *   wider than the line, since a loanword longer than the whole budget has to
 *   break somewhere.
 */
function groupUnits(clusters: string[] | null): Unit[] {
  if (!clusters) return [];
  const units: Unit[] = [];
  let i = 0;
  while (i < clusters.length) {
    const runOf = KATAKANA.test(clusters[i])
      ? KATAKANA
      : KATAKANA_HALF.test(clusters[i])
        ? KATAKANA_HALF
        : null;
    if (runOf) {
      let end = i + 1;
      while (end < clusters.length && runOf.test(clusters[end])) end += 1;
      units.push(clusters.slice(i, end));
      i = end;
      continue;
    }
    if (!ALNUM.test(clusters[i])) {
      units.push([clusters[i]]);
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
    units.push(clusters.slice(i, end));
    i = end;
  }
  return units;
}

const WHITESPACE = /^\s+$/;

/**
 * Break `text` into lines no wider than `budgetEm`, in em under the model above.
 *
 * Greedy fill with the kinsoku correction applied *at* the break, preferring the
 * push-down direction: when the unit that would start the next line may not begin
 * one, the last unit of the current line goes down with it, rather than squeezing
 * the offender back onto a line that is already full. Pulling back would be the
 * other legal JIS X 4051 strategy, but it overruns the budget by a whole
 * character, and these budgets are what stops the text leaving the box.
 *
 * `ceilingEm` is the width past which the text really would leave its box, as
 * opposed to `budgetEm`, which is the conservative target. It buys back the one
 * case push-down cannot serve: a line holding a *single* unbreakable unit (a
 * timestamp, an identifier) followed by a character that may not open a line.
 * Emptying that line is not an option, so without a ceiling the only choice was
 * to accept `）` at the start of the next row. Given the real limit, the closing
 * bracket can simply be pulled back. Callers that cannot derive a trustworthy
 * ceiling omit it and keep the accept-as-is behaviour.
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
  { budgetEm, ceilingEm, maxLines }: { budgetEm: number; ceilingEm?: number; maxLines?: number },
): string[] {
  const clusters = segmentGraphemes(text);
  if (!clusters) return [text];

  // A katakana loanword wider than the whole line has to break somewhere, so it
  // goes back to being individual clusters. A Latin run never does.
  const units = groupUnits(clusters).flatMap((unit) =>
    isSoftRun(unit) && unitWidthEm(unit) > budgetEm ? unit.map((cluster) => [cluster]) : [unit],
  );
  if (units.length === 0) return [text];

  const lines: Unit[][] = [];
  let line: Unit[] = [];
  let width = 0;

  for (const unit of units) {
    const w = unitWidthEm(unit);
    if (line.length > 0 && width + w > budgetEm) {
      const opensBadly = NO_START.has(unit[0]);
      const closesBadly = NO_END.has(line[line.length - 1].at(-1) as string);
      if (line.length === 1 && opensBadly && ceilingEm !== undefined && width + w <= ceilingEm) {
        // Pull back rather than open a line with it — the line is one
        // unbreakable unit, so there is nothing to push down instead.
        line.push(unit);
        width += w;
        continue;
      }
      const carry: Unit[] = [];
      if (line.length >= 2 && (opensBadly || closesBadly)) {
        carry.push(line.pop() as Unit);
      }
      lines.push(line);
      line = carry;
      width = carry.reduce((sum, u) => sum + unitWidthEm(u), 0);
    }
    // A line never opens with a space: the break already separated the words.
    if (line.length === 0 && WHITESPACE.test(unitText(unit))) continue;
    line.push(unit);
    width += w;
  }
  if (line.length > 0) lines.push(line);

  const rows = lines.map((l) => l.map(unitText).join('').replace(/\s+$/, ''));
  if (maxLines && rows.length > maxLines) {
    return [...rows.slice(0, maxLines - 1), rows.slice(maxLines - 1).join('')];
  }
  return rows;
}

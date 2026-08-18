import { breakCjkText, hasEastAsian, textWidthEm } from './cjk-line-break.js';
import { splitFrontmatter } from './export-name.js';

/**
 * Inject line breaks into the CJK labels Mermaid draws into a fixed-width box.
 *
 * Three of the eighteen diagram types size a label's box without ever consulting
 * the label: a `sequenceDiagram` `Note over A,B` and a `loop`/`alt`/`opt`/`par`/
 * `critical` title take their width from actor geometry, and `journey` tiles are
 * a hard-coded 150×50. Latin text mostly fits by luck — CJK never does, because
 * it is roughly twice as wide per character and has no spaces for Mermaid's
 * Latin-only wrapper to break at. `timeline` is a fourth case with a different
 * mechanism (see BUDGETS below).
 *
 * The usual escape hatch is not open to us. `journey` and `timeline` default to
 * `textPlacement: "fo"`, and the `<foreignObject>` that carries HTML wrapping is
 * removed by `htmlLabels: false` plus DOMPurify's SVG profile — both of which are
 * load-bearing for the zero-scope posture, so mermaid.live's wrapping is
 * permanently out of reach here. Full analysis and the upstream file:line
 * references live in docs/UPSTREAM-CJK-LABEL-WRAP.md.
 *
 * This runs on the string handed to Mermaid, NOT on the source persisted to
 * macro config. The author's editor text stays exactly as typed, while the live
 * preview, both save-time cache renders and the reader's cache-miss render all
 * agree — they all go through `renderDiagram`.
 */

/**
 * The literal we inject. Unclosed on purpose, and it is the only form that works
 * everywhere: `sequenceDiagram` and `journey` split on `/<br\s*\/?>/gi` and take
 * either spelling, but `timeline`'s wrapper splits on `/(\s+|<br>)/` and would
 * render `<br/>` as visible text. One literal for all four sites.
 *
 * Injected inline rather than as a newline so `describeError`'s line numbers keep
 * pointing at the line the author wrote. No user text is ever concatenated into
 * markup — this constant is the entire markup contribution.
 */
const BR = '<br>';

/**
 * Budgets, in em of the font each site draws at. Derivations in the doc; the
 * short version:
 *
 * - `note` — 160px at `noteFontSize: 14`. From Mermaid's own formulas, an over-note
 *   box is at least `4·actorMargin` wide, leaving `4·50 − 2·wrapPadding −
 *   2·noteMargin = 160px` of text. Notes spanning three or more actors get a wider
 *   box, so they come out narrower than they had to be — never clipped. No line
 *   cap: `drawNote` sizes the rect's *height* from the measured text.
 * - `loop` — 160px at `messageFontSize: 16`. Same actor-derived geometry; the box
 *   height grows because `calculateTextDimensions` splits on the line-break regex.
 * - `journey` — `width` 150 − 2·`boxTextMargin` 5 = 140, take 130 for slack, at
 *   `taskFontSize: 14`. Here the box *height* is fixed at 50 too, and the tile
 *   centres its rows, so three lines (42px) fit and a fourth spills below the
 *   tile — hence `maxLines`.
 * - `timeline` — the one that is NOT `byTspan`: `drawNode` wraps against a
 *   hardcoded 150 and then grows the node's height from the measured bbox, so the
 *   budget is 140px for slack at the inherited 16px root font, with no line cap.
 */
const BUDGETS = {
  note: { budgetEm: 160 / 14 },
  loop: { budgetEm: 160 / 16 },
  journey: { budgetEm: 130 / 14, maxLines: 3 },
  timeline: { budgetEm: 140 / 16 },
} as const;

/**
 * Mermaid's own per-message wrap directives. An author who has typed one has
 * made an explicit decision about wrapping, and it wins over ours.
 */
const EXPLICIT_WRAP = /^\s*:?(?:no)?wrap:/i;

/**
 * Break a label, or return it unchanged.
 *
 * Returned byte-identical when the author already put a break in it, asked for a
 * wrap mode by hand, wrote nothing East Asian, or wrote something that already
 * fits. That last two are what keeps every existing Latin diagram — and every
 * fixture in test/ — rendering exactly as it did before.
 */
function wrapLabel(label: string, budget: { budgetEm: number; maxLines?: number }): string {
  if (label.includes('<br')) return label;
  if (EXPLICIT_WRAP.test(label)) return label;
  if (!hasEastAsian(label)) return label;
  if (textWidthEm(label) <= budget.budgetEm) return label;

  // Empty rows are dropped so the result can never open or close with a break:
  // a trailing one leaves timeline's wrapper holding a tspan of literal "<br>",
  // and a leading one draws an empty first row.
  const rows = breakCjkText(label, budget).filter(Boolean);
  return rows.length > 1 ? rows.join(BR) : label;
}

/** `Note over A,B: …` — two or more distinct actors, which is the branch that ignores the text. */
const NOTE_OVER = /^(\s*[Nn]ote\s+over\s+)([^:]+?)(\s*:\s*)(\S.*)$/;

/**
 * Titles the renderer force-wraps (`msg.wrap = true`) and then sizes from actor
 * spans. `end` is absent deliberately — it carries no title.
 */
const LOOP_TITLE = /^(\s*(?:loop|alt|else|opt|par|and|critical|option|break)\s+)(\S.*)$/;

/** `Task label: <score>` with the actor list optional — journey requires a score, not actors. */
const JOURNEY_TASK = /^(\s*)(\S.*?)(\s*:\s*\d+\s*(?::.*)?)$/;

/** Statements whose text is a heading or metadata, not a tile drawn at a fixed width. */
const HEADING = /^\s*(?:title|section|accTitle|accDescr)\b/;

function rewriteSequence(line: string): string {
  const note = NOTE_OVER.exec(line);
  if (note) {
    // `Note over A` and `Note over A,A` land in Mermaid's self-note branch, which
    // *does* size from the text; only a span across distinct actors ignores it.
    const actors = new Set(note[2].split(',').map((a) => a.trim()));
    if (actors.size >= 2) return note[1] + note[2] + note[3] + wrapLabel(note[4], BUDGETS.note);
    return line;
  }
  const title = LOOP_TITLE.exec(line);
  if (title) return title[1] + wrapLabel(title[2], BUDGETS.loop);
  return line;
}

function rewriteJourney(line: string): string {
  if (HEADING.test(line)) return line;
  const task = JOURNEY_TASK.exec(line);
  if (!task) return line;
  return task[1] + wrapLabel(task[2], BUDGETS.journey) + task[3];
}

function rewriteTimeline(line: string): string {
  if (HEADING.test(line)) return line;
  // Period and events alike are drawn by `drawNode` at the same fixed width, so
  // every colon-separated segment gets the same treatment.
  return line
    .split(':')
    .map((segment) => {
      const [, lead, body, trail] = /^(\s*)(.*?)(\s*)$/.exec(segment) as RegExpExecArray;
      return body ? lead + wrapLabel(body, BUDGETS.timeline) + trail : segment;
    })
    .join(':');
}

const REWRITERS = {
  sequenceDiagram: rewriteSequence,
  journey: rewriteJourney,
  timeline: rewriteTimeline,
};

/** The header of the first statement, skipping blank lines, `%%` comments and `%%{…}%%` directives. */
function rewriterFor(body: string): ((line: string) => string) | null {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    for (const [header, rewrite] of Object.entries(REWRITERS)) {
      if (line.startsWith(header)) return rewrite;
    }
    return null;
  }
  return null;
}

/**
 * @returns `source` with `<br>` injected into over-long CJK labels, or `source`
 *   itself when there is nothing to do. Line count is always preserved.
 */
export function wrapCjkLabels(source: string): string {
  if (!source || !hasEastAsian(source)) return source;

  // Frontmatter is YAML, not diagram statements: `width: 150` inside a config
  // block matches the journey task pattern, and the type header is the first line
  // *after* the block.
  const { body } = splitFrontmatter(source);
  const rewrite = rewriterFor(body);
  if (!rewrite) return source;

  const rewritten = body
    .split('\n')
    .map((raw) => {
      const cr = raw.endsWith('\r');
      const line = cr ? raw.slice(0, -1) : raw;
      return rewrite(line) + (cr ? '\r' : '');
    })
    .join('\n');

  return rewritten === body ? source : source.slice(0, source.length - body.length) + rewritten;
}

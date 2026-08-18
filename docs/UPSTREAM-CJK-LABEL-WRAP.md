# Upstream: CJK labels and fixed-width boxes

Why Merfluence rewrites diagram source before handing it to Mermaid, which
upstream defects that works around, and where every number in
[`src/lib/cjk-wrap.ts`](../src/lib/cjk-wrap.ts) comes from.

Written because the workaround is a **source transform** — the most invasive kind
of fix this app can make — and the next person to read it deserves the evidence
that nothing less would do. Issue
[#157](https://github.com/edlopez000/merfluence/issues/157).

All file:line references are to `mermaid@11.16.1` as installed in
`node_modules/mermaid/dist/chunks/mermaid.core/`. The equivalent lines in
`mermaid-10.9.8` are byte-identical where it matters, so the workaround is
version-independent.

**Short answer:** three diagram types size a label's box without ever consulting
the label, Mermaid's only wrapping helper cannot break a language without spaces,
and the escape hatch that saves mermaid.live is permanently shut for us. So we
inject `<br>` ourselves, at render time only.

## The two upstream defects

### 1. The box is sized before the text is considered

`buildNoteModel` (`sequenceDiagram-SI44F4Z6.mjs:4362`), for a `Note over A,B`
spanning two distinct actors:

```js
noteModel.width =
  Math.abs(startx + fromActor.width / 2 - (stopx + toActor.width / 2)) + conf.actorMargin;
```

The text contributes only through `getMaxMessageWidthPerActor` (`:4225-4247`),
which for an OVER note credits `messageWidth / 2` to `actor.prevActor` **and** to
`msg.from` — for a two-actor note, the same actor. The box lands at roughly half
the width the text needs. Solving `361 = mw/2 + 100` against a measured export
reproduces the observed rect width exactly.

`loop` / `alt` / `opt` / `par` / `critical` titles are the same story: the
renderer force-wraps them (`:2882`, `:3741`) against a `loopWidth` computed from
actor spans (`:4610`, `:4631`).

This is language-independent — long Latin over-notes overflow too — but CJK hits
it every time, because `sequence.wrap` defaults to `false` and CJK runs are ~2×
wider per character with nowhere for a space-based wrapper to break.

The branches that are **not** affected, and which the transform therefore leaves
alone: `Note right of` (`:4343`), `Note left of` (`:4349`) and the self-note
`msg.to === msg.from` (`:4359`) all take `max(…, textDimensions.width + 2 *
conf.noteMargin)`. Those boxes already grow to fit.

### 2. `wrapLabel` is Latin-only

`chunk-NSK5VX7P.mjs:337` does `label.split(" ")`. A CJK run is one "word", so it
falls through to `breakString` (`:375`), which walks **code points** and appends
`-` to every line. Wrong three ways for Japanese: the hyphens are meaningless,
kinsoku is ignored, and code-point iteration shreds grapheme clusters — 🇯🇵 is a
regional-indicator pair, 👨‍👩‍👧‍👦 a ZWJ sequence, 👍🏽 carries a skin-tone modifier,
葛󠄀 an ideographic variation selector, 𠮟 is astral.

The one upstream behaviour we can lean on: `wrapLabel` **early-returns when the
label already contains a line break** (`:346`). Pre-injected `<br>` therefore
_suppresses_ the hyphenating wrap rather than fighting it.

## Why the usual escape hatch is shut

`journey` and `timeline` default to `textPlacement: "fo"`, which emits a
`<foreignObject>` carrying an HTML label — and HTML wraps CJK correctly, which is
why mermaid.live looks fine. Our `htmlLabels: false` plus DOMPurify's SVG profile
remove it, and neither is negotiable: they are two of the four layers named in
[.claude/rules/rendering.md](../.claude/rules/rendering.md). So these types are
**worse in this app than upstream**, and only we can fix them.

### The `<switch>` trap that came with it

`byFo` emits `g > switch > [foreignObject, text, text, …]` — the `<text>` rows are
the fallback _inside the switch_. SVG `<switch>` renders only the **first** child
that qualifies. With the `foreignObject` stripped, the first `<text>` renders and
**every later row is silently dropped**: it lays out at 0×0 and simply is not
there. Any journey label with a manual `<br/>` has always been truncated to its
first line in this app.

Fixed in `baseConfig` (`src/lib/render.ts`) with `journey: { textPlacement:
'tspan' }`, which selects the same `byTspan` renderer directly with the task `<g>`
as its parent and no `<switch>` to discard the rest. Single-row labels render
identically; it also stops emitting a `foreignObject` that was only ever going to
be sanitized away.

The browser suite asserts `expect(c.width).toBeGreaterThan(0)` on every row for
exactly this reason: a 0×0 row passes every containment check for free, which is
how this hid.

## `timeline` is not what it looks like

**`timeline-definition-Z64GVDOM.mjs:830 drawTask` — the `byTspan`, fixed-150×50
routine that looks byte-identical to journey's — is dead code.** It is only
exposed on `svgDraw_default` (`:1031`) and never invoked by the renderer. Reading
it and concluding timeline behaves like journey is the obvious mistake here, so:

The live path is `drawNode` (`:963`), reached via `drawTasks` (`:1206`) and
`drawEvents` (`:1241`):

- one `<text>`, wrapped by a d3 helper (`:891`) against `node.width = 150`,
  hardcoded at the call sites — **not** `conf.width`;
- that helper splits on `/(\s+|<br>)/` — **the unclosed form only**. `<br/>` is not
  matched and renders as visible text;
- it then measures `getBBox()` and sets `node.height = bbox.height + fontSize *
1.1 * 0.5 + node.padding`, floored at `maxHeight` — the **box height is
  elastic**, so timeline needs no line cap;
- the background path uses `node.width + 2 * node.padding` = 190, so a line up to
  150px sits inside 190 with 20px of slack on each side.

The helper also leaves a tspan of literal `<br>` if a break is the last token,
which is why the injector never emits a trailing one.

Timeline has a second layout for `look: "neo"` with a computed `sectionWidth`
(`:1292`). We never set `look`, so the classic path above is what renders — **if
that ever changes, these numbers have to be re-derived.**

## Why `<br>` and not `<br/>`

`sequenceDiagram` and `journey` split on `common.lineBreakRegex`
(`chunk-I66GZJ75.mjs:5036`), `/<br\s*\/?>/gi`, and accept either spelling.
`timeline` accepts only the unclosed one. `<br>` is the single literal that works
at all four sites, so that is what `cjk-wrap.ts` injects.

It survives `securityLevel: 'strict'` — verified by reading it back out of the
parsed diagram db for all three types — and the sites that consume it emit
`<text>` / `<tspan>`, so `htmlLabels: false` still yields no `<foreignObject>` we
depend on and DOMPurify remains the last pass.

## The budgets

Each site gets a **budget** — the width the greedy fill aims for — and, where one
can be derived with confidence, a **ceiling**: the width at which the text really
would leave its box. The breaker only ever uses the ceiling to pull a 行頭禁則
character back onto a line it cannot push down from (see "Kinsoku" below).

| site               | budget | ceiling  | font                          |
| ------------------ | ------ | -------- | ----------------------------- |
| sequence over-note | 160px  | 230px    | `noteFontSize` 14             |
| loop / alt title   | 100px  | _(none)_ | `messageFontSize` 16          |
| journey tile       | 130px  | 140px    | `taskFontSize` 14, max 3 rows |
| timeline node      | 140px  | 180px    | inherited 16px root           |

### Sequence over-note — 160px, ceiling 230px

An actor is never narrower than `conf.width` (150): `calculateActorMargins` floors
it at `:4278` and `:3627` floors it again. So for a note spanning two adjacent
actors:

```
box = fromW/2 + actor.margin + toW/2 + actorMargin ≥ 75 + 50 + 75 + 50 = 250
text room = box − 2·noteMargin ≥ 230px
```

**230px is the real containment limit, and the 160px budget is deliberate slack.**
An earlier version of this document derived `L ≤ 180` from the other branch of
`box`; that branch requires `L > 280` to be the active maximum, which contradicts
its own conclusion, so it is unreachable. The correction matters because the
ceiling is derived from 230.

The slack is not wasted. The width model charges uppercase Latin 0.5 em and
trebuchet draws it nearer 0.72, so a token like `ERR_KAFKA_LAG_00042` is modelled
at 133px and occupies nearer 190px. 70px of headroom is roughly what that error
costs on a worst-case line.

No line cap: `drawNote` (`:3326-3328`) sets the rect's _height_ from the measured
text.

### Loop / alt title — 100px, no ceiling

Much narrower than the note budget, because a loop box is much narrower than a
note box **and its title is not centred on it**. This one was measured in a real
browser rather than derived by analogy — an earlier 160px, reasoned across from
the note case, clipped by 22 user units:

- the narrowest control-structure box Mermaid builds wraps a self-message:
  `actor.width` 150 (floored) + 2·`boxMargin` 10 = **170 user units**;
- `drawLoop` centres the title at `startx + labelBoxWidth/2 + boxWidth/2`
  (`:2873`) with `txt.width` unset, so the right-hand half is the binding one:
  `85 − 25` = 60, i.e. the widest row may be **120**;
- Mermaid then wraps the title as `[title]`, and that bracket lands on the row, so
  the author's text gets **112** — take 100 for slack.

For reference, upstream's own budget for this shape is
`loopWidth − 2·wrapPadding` = 80, so 100 is not a density downgrade; it is the
same order of magnitude without the hyphens.

**No ceiling**, because 100 is already the worst-case floor and any loop body
could be the self-message shape — there is no headroom to lend the kinsoku
pull-back. `alt`'s `else` sections are drawn centred on the box (`:2888`, no
`labelBoxWidth` offset) so they have more room, but they share the budget rather
than carry a second one.

`calculateTextDimensions` splits on the line-break regex before summing heights,
so the box height grows to fit the rows.

### Journey tile — 130px, ceiling 140px

`conf.width` (150) − 2·`boxTextMargin` (5) = 140; take 130 for slack. The tile
_height_ is fixed at 50 too, and `byTspan` centres rows on the box centre with
`dy = i·taskFontSize − taskFontSize·(rows − 1)/2`. Three rows is 42px and fits; a
fourth spills below the tile. So the row count is capped and a longer label runs
over on its final row instead — which bounds usable labels at ~27 CJK characters.
Past that the label does not fit a 150×50 tile in any language.

### Timeline node — 140px, ceiling 180px

The helper's own threshold is 150 and the node interior is `150 + 2·padding` = 190. 140 leaves slack for the width model's error, 180 keeps a margin inside the
background. Height is elastic, so no cap is needed.

## Unbreakable units, hard and soft

Two kinds of run are held together on one line:

- **Latin/number runs are hard.** `SonarQube`, `85.5%`, `1,500`, `v11.13.0`,
  `build-2026-08-09-1142`, `2026-08-09T23:41:32+09:00` are never broken, whatever
  they cost in line width — splitting an identifier across two rows of a note is a
  worse defect than a wide row.
- **Katakana runs are soft.** Japanese typesetting keeps a loanword whole, and the
  first version of this pass did not: it produced `ブロッ` / `ク`,
  `チェッ` / `クポイント`, `アッ` / `プロード` — legal under JIS X 4051, but every
  one of them breaking straight after a small kana. A katakana run is now one
  unit, _unless the word alone is wider than the budget_, in which case it goes
  back to individual clusters, because a loanword longer than the whole line has
  to break somewhere.

`ー` (U+30FC) and the iteration marks join a katakana run. `・` (U+30FB) does not:
it separates two loanwords, so it is a legitimate break opportunity — and it is
already 行頭禁則, so it can never open a row.

## Kinsoku

行頭禁則 (may not begin a line) and 行末禁則 (may not end one) are corrected _at_
the break, preferring **push-down**: the last unit of the current line goes down
with the offender, rather than squeezing the offender onto a line that is already
full. Pulling back is the other legal JIS X 4051 strategy, but it overruns the
budget by a whole character, and the budget is what keeps the text in the box.

At most one adjustment per boundary, and never one that would empty a line — a run
of forbidden characters (`。。。`) would otherwise bounce a unit between rows
forever. A slightly-off break is fine; a hang or an empty `<text>` row is not.

**The one case push-down cannot serve** is a line holding a _single_ unbreakable
unit followed by a character that may not open a line. Emptying it is not an
option, so the first version of this pass simply accepted the violation, and
rendered a note whose last row opened with `）`:

```
2026-08-09T23:41:32+09:00
）ﾃｽﾄ環境ﾒﾄﾘｸｽ収集ｼｽﾃﾑ
```

That is what the ceiling is for. Given the real containment limit, the bracket is
pulled back onto the timestamp's row instead. Sites with no ceiling (loop titles)
keep the accept-as-is behaviour rather than guess at one.

## Notes in wide diagrams under-fill, by design

Every budget above is a **worst-case floor**, not the width of the box the note
actually lands in. Measured from real exports:

| note box        | widest row | fill |
| --------------- | ---------- | ---- |
| 250px (minimum) | 154px      | 67%  |
| 606px           | 154px      | 26%  |
| 619px           | 154px      | 26%  |

So a note in a diagram whose actors have been pushed apart by long messages draws
a narrow column of text inside a wide rectangle. That is ugly, and it is
deliberate.

Fixing it means predicting the real box width, and that is circular: the box width
comes from actor margins, which come from message widths, which come from the same
em model — and the model _over_-estimates lowercase Latin. Overestimating the box
means budgeting too wide, which clips. Under-filling is recoverable; clipping is
not, so the floor stands.

## Why widths are a table and not a measurement

Every alternative measures a real font — canvas `measureText`, or a probe
`<text>` plus `getBBox()`. All of them would:

- make the unit suite depend on the fonts installed on the machine running it;
- make jsdom useless for testing this at all;
- and — because the probe runs in whichever document is current — let a light
  render and a dark render disagree about where the breaks go, which the
  save-time cache then bakes in as two different diagrams.

So [`src/lib/cjk-line-break.ts`](../src/lib/cjk-line-break.ts) uses a static East
Asian width table: Wide/Fullwidth 1.0 em, emoji 1.2 em, everything else 0.5 em.
Both budgets above carry enough slack to absorb the error.

## What the transform will not do

- It never touches the source persisted to macro config. The author's editor text
  stays exactly as typed; `validate()` still reports errors against it.
- It returns the source byte-identical unless the diagram is one of the three
  types, the label holds an East Asian character, the label has no `<br` and no
  `wrap:` / `nowrap:` prefix already, and the label does not already fit.
- It preserves the line count, so `describeError`'s line numbers keep pointing at
  the line the author wrote.
- If the transformed source fails to parse or render while the original does not,
  `renderDiagram` falls back to the original. The pass cannot turn a working
  diagram into an error banner.

## Cache

`CACHE_VERSION` deliberately **stays at 3**. Diagrams already saved keep their
overflowing cached SVG until re-saved; every other page keeps its zero-Mermaid
fast path. Bumping it would cost every un-re-saved page that fast path
permanently, because the reader has no scope-free way to repopulate the cache —
see [STORAGE-BUDGET.md](STORAGE-BUDGET.md) and
[.claude/rules/cache.md](../.claude/rules/cache.md).

## If this is ever fixed upstream

The transform is a no-op the moment Mermaid sizes these boxes from their labels:
remove the call in `renderDiagram`, keep `journey: { textPlacement: 'tspan' }`
unless the `<foreignObject>` becomes something we can render, and delete
`cjk-wrap.ts` with its tests. The browser geometry assertions should be kept
either way — they measure the property that matters, not the mechanism.

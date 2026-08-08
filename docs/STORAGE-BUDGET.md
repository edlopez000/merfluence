# Storage budget

How much of a Confluence page Merfluence consumes, where Confluence's own
ceilings actually are, and what happens when a page reaches them.

Written because [`src/lib/cache.ts`](../src/lib/cache.ts) gates each cached SVG
at 45 KB **per string**, and nothing anywhere accounts for the **aggregate** —
macro config is persisted into the page body, so every cached diagram on a page
adds to that page's stored size. The concern was that twenty diagrams could
push a page past some undocumented limit and fail in a way the app never
anticipates. The numbers below replace that guess (issue
[#96](https://github.com/edlopez000/merfluence/issues/96)).

**Short answer:** the ceiling is real but distant, the per-string gate already
bounds the aggregate, and Confluence fails safe — it refuses the save and leaves
the stored page intact. No code change is warranted.

## What Merfluence stores per macro

Macro config is written into the page's ADF as an `extension` node's
`parameters.guestParams`. Merfluence puts these fields there:

| Field                       | Typical size                           |
| --------------------------- | -------------------------------------- |
| `source`                    | 86–479 bytes for the starter templates |
| `theme`, `mermaidVersion`   | a few bytes each                       |
| `useMaxWidth`, `height`     | a few bytes each                       |
| `cacheV`, `renderedVersion` | ~30 bytes                              |
| `svgLight`, `svgDark`       | **the whole cost** — up to 45 KB each  |

The JSON envelope around a macro node — node type, `extensionKey`, attribute
names, and the backslash-escaping of quotes inside the stored SVG — costs about
**460 bytes** on top of the SVG payloads themselves.

An oversized SVG variant is dropped rather than stored, so the hard maximum any
one macro can occupy is `2 × 45 KB + ~460 B` ≈ **92.6 KB**.

## Measured cost of a real diagram

Every fixture in [`test/fixtures/`](../test/fixtures) rendered through
`renderDiagram` in real Chromium, both themes, measured as UTF-8 bytes:

| Diagram      | Light  | Dark   | Both    |
| ------------ | ------ | ------ | ------- |
| pie          | 4,803  | 4,868  | 9.4 KB  |
| sankey       | 7,005  | 7,116  | 13.8 KB |
| quadrant     | 7,194  | 7,401  | 14.3 KB |
| block        | 10,980 | 11,163 | 21.6 KB |
| gantt        | 11,055 | 11,351 | 21.9 KB |
| journey      | 11,836 | 12,061 | 23.3 KB |
| er           | 12,022 | 12,438 | 23.9 KB |
| gitgraph     | 11,622 | 13,280 | 24.3 KB |
| architecture | 13,153 | 13,233 | 25.8 KB |
| xychart      | 13,894 | 13,992 | 27.2 KB |
| acc-labelled | 14,772 | 15,279 | 29.3 KB |
| flowchart    | 17,903 | 18,416 | 35.5 KB |
| timeline     | 17,064 | 20,701 | 36.9 KB |
| c4           | 22,090 | 22,162 | 43.2 KB |
| kanban       | 24,455 | 24,350 | 47.7 KB |
| sequence     | 24,413 | 24,792 | 48.1 KB |
| state        | 31,113 | 31,808 | 61.4 KB |
| class        | 33,604 | 34,398 | 66.4 KB |
| **mindmap**  | 45,516 | 49,067 | 92.4 KB |

Median **27.2 KB** for both themes; mean 35.1 KB.

Two things worth noticing:

**The shipped `mindmap` template already exceeds the gate in dark** (49,067 >
46,080), so it caches light-only today. That is the degrade working as designed
— the dark variant renders on view — but it means the starter templates are not
all fully cacheable.

**The gate bites early on real diagrams.** Synthetic flowcharts of chained,
labelled nodes:

| Nodes | Light SVG | Cacheable? |
| ----- | --------- | ---------- |
| 10    | 30,266    | yes        |
| 20    | 49,913    | no         |
| 40    | 90,318    | no         |
| 80    | 167,601   | no         |
| 200   | 414,101   | no         |

A flowchart of roughly twenty labelled nodes is already past 45 KB and stores no
cache at all — only its source, a few hundred bytes. **This is what bounds the
aggregate**: the diagrams big enough to threaten a page budget are exactly the
ones that never get cached. The per-string gate is self-limiting.

## The real Confluence ceilings

Atlassian documents neither of these. [Forge platform quotas and
limits](https://developer.atlassian.com/platform/forge/platform-quotas-and-limits/)
covers invocations, KVS, Forge SQL, and resource bundles, but says nothing about
macro config size. [Add configuration to a
macro](https://developer.atlassian.com/platform/forge/add-configuration-to-a-macro/)
confirms config is "stored with the page content" and states no limit. The
community numbers that circulate — a 5 MB REST payload cap, a 400 at 64 KB —
are either wrong or [turned out to be something
else](https://community.developer.atlassian.com/t/is-there-a-size-limit-for-body-storge-when-updating-a-page-with-the-rest-api/58055)
(an unescaped ampersand, not a size limit).

So both numbers below were measured, not read. Method is in
[Reproducing this](#reproducing-this).

### REST API: exactly 20,000,000 bytes

`POST /wiki/api/v2/pages` with `representation: atlas_doc_format` accepts a body
value of up to **20,000,000 bytes** of serialized ADF, to the byte:

| ADF bytes  | Result                        |
| ---------- | ----------------------------- |
| 19,999,999 | `200` — stored, byte-for-byte |
| 20,000,000 | `200` — stored, byte-for-byte |
| 20,000,001 | `400 INVALID_MESSAGE`         |

It is a limit on the **document**, not on the HTTP request or the node count: a
request whose wire body was 20,000,238 bytes succeeded because its ADF value was
19,999,999, and the same ceiling applied whether the bytes were carried by 215
macros or by one macro with a giant `svgLight`.

At the 92.6 KB worst case that is **215 fully-cached diagrams** on one page.

### Editor: about 5.23 MB

The editor saves through collaborative editing, not that API, and binds far
lower. Holding macro count constant at 56 and varying only total bytes:

| ADF bytes | Publish                           |
| --------- | --------------------------------- |
| 5,228,200 | succeeded, version 2              |
| 5,231,650 | succeeded, version 2              |
| 5,235,100 | **failed** — "Can't save changes" |
| 5,242,880 | **failed** — "Can't save changes" |

So the editor ceiling is between **5,231,650 and 5,235,100 bytes** — just under
5 MiB (5,242,880), consistent with a 5 MiB cap applied to the document plus the
editor's own save envelope.

Note that publishing **grows** the document: the editor stamps a `localId` onto
each `extension` node on save, about 51 bytes per macro (56 macros grew the
stored ADF by 2,870 bytes). A page sitting just under the line via the API can
therefore cross it on the first editor save.

At the 92.6 KB worst case, the editor ceiling is **56 fully-cached diagrams**.

## Behaviour at the limit

This was the open question, and the answer is the reassuring one. **Neither path
truncates.** Both refuse the write and leave the stored page exactly as it was.

- **API:** a clean `400` with `{"code":"INVALID_MESSAGE"}`. Nothing is created.
  Every accepted page read back byte-identical to what was sent, at every size
  from 91 KB to 20,000,000 bytes — macro count intact, no silent trimming.
- **Editor:** the page loads and the macro nodes are all present in the
  document, but the publish never completes and a red **"Can't save changes —
  Copy your work, refresh the page, and we'll try to reconnect"** toast appears.
  The stored page stays at its previous version, undamaged.

The editor failure is genuinely confusing, though, and worth knowing about: the
header still reads **"Saved"** while the toast says the opposite, and at larger
sizes (100 macros / 9.3 MB) the macros stop rendering in the editor body
entirely, so the page looks empty apart from its first paragraph. Nothing is
lost — but nothing tells the author that clearly either.

That confusion is Confluence's, not Merfluence's, and it applies to any large
page regardless of what put the bytes there.

## Verdict

| Ceiling           | Worst-case diagrams | At the measured median |
| ----------------- | ------------------- | ---------------------- |
| Editor (~5.23 MB) | 56                  | ~185                   |
| REST API (20 MB)  | 215                 | ~700                   |

"Worst case" assumes every diagram caches both variants at the full 45 KB — a
page of diagrams each sitting just under the gate. The measured median column
uses the 27.2 KB median from the fixture corpus.

Both columns are far beyond what a page can be for other reasons. Every macro is
its own Forge iframe; a page of 56 diagrams has 56 iframes and is unusable long
before it is unsavable. Storage is not the binding constraint.

And the aggregate is bounded by the per-string gate rather than in spite of it:
a diagram large enough to matter is a diagram that exceeds 45 KB, and it stores
no SVG at all.

## Decision

**No code change.** Recorded 2026-08-07.

The original concern — that a page of many diagrams could hit an unknown ceiling
and fail confusingly — does not survive measurement. The reachable failure point
is ~56 maximally-cached diagrams, the failure is a clean refusal rather than
truncation or data loss, and pages become unworkable for rendering reasons well
before that.

A per-page budget check was also considered and is **not implementable here**.
The editor sees only its own macro's config, via `getContext().extension.config`
([`src/lib/host.ts`](../src/lib/host.ts)). Reading the rest of the page needs a
Confluence REST scope, which [`manifest.yml`](../manifest.yml) does not request
and which both the `PreToolUse` hook and
[`test/manifest.test.js`](../test/manifest.test.js) refuse to let in. Adding a
scope to police a limit no user can realistically reach would trade the entire
security posture for nothing.

The per-string 45 KB gate stays as it is. It is not tuned to any Confluence
limit — it exists so that one pathological diagram cannot bloat a page, and it
turns out to be what keeps the aggregate bounded too.

## Reproducing this

If Atlassian moves these numbers, re-run the measurement rather than trusting
the table above.

**Per-diagram sizes:** render each `test/fixtures/*.mmd` through `renderDiagram`
in the browser test project, both themes, and measure `TextEncoder` byte length
— the same measure `fitsCache` uses.

**Both ceilings:** drive a scratch Confluence space with Playwright, reusing a
saved session. Build a page body of N `extension` nodes shaped like a real
Merfluence macro (`extensionType: com.atlassian.ecosystem`, `extensionKey`
ending `/static/mermaid-diagram`, config under `parameters.guestParams`) with
synthetic SVG of a chosen size, then:

- For the **API** ceiling, `POST /wiki/api/v2/pages` and binary-search the ADF
  byte count. Always read the page back and compare stored bytes to sent bytes —
  truncation is only visible from the read side.
- For the **editor** ceiling, seed the page through the API, open
  `/wiki/spaces/<KEY>/pages/edit-v2/<id>`, edit the title, click Update, and wait
  for the navigation away from `/edit-v2/`. Hold macro count constant and vary a
  padding paragraph, so the search measures bytes rather than node count.

Use a throwaway space, never the demo space — a write in the wrong content
format silently deletes every embedded diagram — and delete **and purge** every
scratch page afterwards.

# Accessibility

Merfluence aims to be usable by everyone who reads or writes a Confluence page, including
people who navigate with a keyboard, a screen reader, or a magnifier. This document states
where the app stands against **WCAG 2.1 Level AA**, documents the keyboard model, and is
honest about what it does not yet meet.

A [VPAT](docs/VPAT.md) covering the same findings in the ITI/Section 508 format is
available for procurement review. Where the two differ, this document is authoritative.

## Conformance status

**Merfluence 1.2.0 partially conforms to WCAG 2.1 Level AA.** _Partially conforms_ means
that some parts of the content do not fully conform to the standard. The parts that do not
are listed under [Known limitations](#known-limitations). Most of them concern what appears
**inside** a diagram — colour, spacing, and reading order that come from Mermaid's themes
and from the diagram source an author writes, none of which the app can correct on the
author's behalf. Two are the app's own: the export menu is not an idiomatic ARIA menu, and
the controls that appear on hover cannot be dismissed in place.

Last reviewed **1 August 2026**, against version **1.2.0**.

### Scope

| In scope                                                        | Not in scope                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| The rendered macro readers see on a page (`src/view/`)          | Confluence itself, its page editor, and the macro-insertion flow |
| The diagram editor opened from **Edit diagram** (`src/config/`) | The Atlassian Marketplace listing                                |
| The text alternative attached to every rendered diagram         | Content of a diagram as authored (colours, labels, structure)    |

The two in-scope surfaces are Forge Custom UI iframes. Everything around them — the page,
the editor chrome, the macro picker — is Atlassian's product, and its accessibility is
covered by [Atlassian's own conformance reports](https://www.atlassian.com/accessibility).

### How this was assessed

Self-assessment by the maintainer against the WCAG 2.1 Level A and AA success criteria,
reviewing the shipped source surface by surface, plus the automated suite that holds the
behaviour in place:

- [`test/a11y-name.test.js`](test/a11y-name.test.js) — the accessible name computed for
  every diagram type, for authored `accTitle`/`accDescr`, and for caches written before
  the naming code existed.
- The `stage: keyboard` block in [`test/view-app.test.jsx`](test/view-app.test.jsx) —
  focus, each key, the release semantics of <kbd>Esc</kbd>, and that modified chords and
  text controls are left alone.
- [`test/browser/render.integration.test.js`](test/browser/render.integration.test.js) —
  the name resolved the way assistive tech resolves it, in real Chromium.

**There has been no independent third-party audit and no assistive-technology user
testing.** Names and roles were checked by inspecting the accessibility tree Chromium
builds, which is not the same as hearing what a given screen reader announces. If yours
behaves worse than this document claims, that is a bug — please [tell us](#feedback).

## Keyboard

Everything in Merfluence can be operated from the keyboard. Nothing traps focus.

### Reading a diagram

<kbd>Tab</kbd> to a diagram and the shortcuts appear along its bottom edge:

| Key                                                 | Action                                                  |
| --------------------------------------------------- | ------------------------------------------------------- |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | Pan the view (hold <kbd>Shift</kbd> for a larger step)  |
| <kbd>+</kbd> / <kbd>=</kbd>                         | Zoom in                                                 |
| <kbd>-</kbd>                                        | Zoom out                                                |
| <kbd>0</kbd>                                        | Reset the view (in fullscreen, refit to the screen)     |
| <kbd>F</kbd>                                        | Enter or leave fullscreen                               |
| <kbd>Esc</kbd>                                      | Release the diagram; in fullscreen, one press does both |

The diagram itself is a focus stop, announced as an interactive diagram with those keys in
its label and in `aria-keyshortcuts`. The same keys work while a toolbar button has focus,
so tabbing on to the toolbar does not silently lose them, and the toolbar — which is hidden
until hover — is revealed by keyboard focus as well.

<kbd>Esc</kbd> is the release: the diagram stops acting on arrow keys until it is focused
again, so a keyboard user is never stuck inside it. Keys are never intercepted when a
modifier (<kbd>Ctrl</kbd>, <kbd>⌘</kbd>, <kbd>Alt</kbd>) is held, so browser and
screen-reader shortcuts pass straight through.

### Writing a diagram

The editor's source field is a CodeMirror editor, which means <kbd>Tab</kbd> **indents**
rather than moving focus. The way out is shown on screen above the field, and is:

| Key                                                                                  | Action                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| <kbd>Esc</kbd> then <kbd>Tab</kbd>                                                   | Move focus out of the editor. <kbd>Esc</kbd> frees <kbd>Tab</kbd> for the next two seconds |
| <kbd>Ctrl</kbd>+<kbd>m</kbd> (<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>m</kbd> on macOS) | The same thing, but latched: <kbd>Tab</kbd> keeps moving focus until you toggle it back    |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>]</kbd> / <kbd>[</kbd>                             | Indent / outdent without <kbd>Tab</kbd>                                                    |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>z</kbd> / <kbd>y</kbd>                             | Undo / redo                                                                                |

Every other control in the editor — the four dropdowns, the width checkbox, **Cancel**, and
**Save diagram** — is a standard form control in tab order with a visible label.

## Screen readers

Every rendered diagram carries a text alternative, and what it contains depends on whether
the author described the diagram.

**Undescribed.** The graphic is named after its type — "Flowchart diagram", "Sequence
diagram" — and keeps Mermaid's `graphics-document document` role, so the node labels inside
it stay reachable. A screen-reader user can still walk the contents; they simply arrive as
text in document order.

**Described.** Mermaid's own
[`accTitle` / `accDescr`](https://mermaid.js.org/config/accessibility.html) go straight into
the source:

```
flowchart LR
    accTitle: Deploy pipeline
    accDescr: A pull request is reviewed, then built, then released to production.
    PR[Pull request] --> Review --> Build --> Production
```

The diagram is then a single image (`role="img"`) named "Deploy pipeline", with the
description read out in full and the node-by-node reading dropped, because the author's
sentence says it better. **This is strongly recommended for any diagram whose meaning is
not obvious from its labels alone** — it is the difference between hearing a bag of words
and hearing what the diagram means. Neither line renders on screen.

Errors are announced: a syntax error in a saved diagram, and a failed clipboard copy or PNG
export, are live-region messages rather than silent no-ops.

## Visual design

- **Colour mode follows Confluence.** Light and dark are resolved from the host's
  `colorMode` and applied through Atlassian's `--ds-*` design tokens, so the app's chrome
  matches the surrounding page rather than fighting it. A diagram's own theme can also be
  pinned per diagram.
- **Focus is always visible.** The diagram, every toolbar button, the fullscreen exit, and
  the editor's controls draw a 2px `:focus-visible` outline in the host's focus colour.
- **Reduced motion is honoured.** The only animation in the app is the toolbar's fade-in,
  and `prefers-reduced-motion: reduce` removes it. Diagrams themselves do not animate,
  flash, or move.
- **Nothing is conveyed by colour alone** in the app's chrome; errors carry text as well as
  a red border.
- **The editor reflows** to a single column below 720px wide.
- **Magnification is built in.** Beyond browser zoom, each diagram has its own zoom —
  keyboard, toolbar, or <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+wheel — plus a fullscreen view, so a
  dense diagram can be enlarged without enlarging the whole page.

## Known limitations

These are the reasons the claim above says _partially_. Most of them share a cause: a
diagram is generated by Mermaid from source an author wrote, and the app renders that
output rather than authoring it.

| Area                                       | Criterion     | What this means                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colour contrast inside a diagram           | 1.4.3, 1.4.11 | Node fills, text, and edges come from the Mermaid theme and from the author's `classDef` / `%%{init}%%` styling. They are not verified against 4.5:1 (text) or 3:1 (graphics), and the app cannot enforce them. Authors who need a guaranteed contrast should set the diagram's colours explicitly. |
| Text spacing inside a diagram              | 1.4.12        | SVG text does not respond to user text-spacing overrides. Browser zoom and the diagram's own zoom do work.                                                                                                                                                                                          |
| Reading order of a complex diagram         | 1.3.2         | An undescribed diagram exposes its labels in document order, which is not a meaningful sequence for anything branching. `accDescr` is the remedy, and the app cannot supply one on the author's behalf.                                                                                             |
| Hover/focus content is not dismissible     | 1.4.13        | The toolbar and the shortcut hint appear on hover or focus. Both are hoverable and stay until focus or the pointer leaves — but neither can be dismissed on the spot without moving focus. The hint takes no pointer events, so it never blocks a drag.                                             |
| The export menu is not a full menu pattern | 4.1.2         | It uses `role="menu"` and closes on <kbd>Esc</kbd> or an outside click, but focus is not moved into it and arrow keys do not walk it; it is operated by <kbd>Tab</kbd> and <kbd>Enter</kbd>. Fully operable, not idiomatic.                                                                         |
| Language of diagram text                   | 3.1.2         | The app's interface is English and declares `lang="en"`. Text inside a diagram is not marked with its own language, so a diagram written in another language may be read in an English voice.                                                                                                       |
| Windows High Contrast / forced colours     | —             | The app defines no `forced-colors` styles. Its chrome inherits the system palette through the Atlassian tokens; a diagram keeps its own colours.                                                                                                                                                    |
| Exported files                             | —             | A downloaded PNG has no text alternative, and a downloaded SVG carries only the one the diagram had. Whoever embeds the file supplies the alternative in its new context.                                                                                                                           |

Two things are deliberately excluded rather than unmet: **WCAG 2.2** criteria (this
statement is against 2.1) and **Level AAA**.

## Feedback

If something here is wrong, or you hit a barrier this document does not mention, that is
worth reporting — an inaccurate accessibility statement is itself a defect.

| Route                                                                           | Best for                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------- |
| <support@edwardlopez.dev>                                                       | A direct report, including a private one        |
| [Service desk](https://lopezedward.atlassian.net/servicedesk/customer/portal/1) | A tracked request — no Atlassian account needed |
| [GitHub issue](https://github.com/edlopez000/merfluence/issues/new/choose)      | A public, discussable bug                       |

Please include the assistive technology and browser you used, and the diagram source if the
problem is with a particular diagram. Merfluence is an open-source project maintained in
spare time, so responses are best-effort — see [SUPPORT.md](SUPPORT.md) for the full
routing and what to expect.

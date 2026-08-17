import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { Decoration } from '@codemirror/view';

import { mermaid as mermaidLang, mermaidHighlightStyle } from './mermaid-lang.js';
import { renderDiagram, describeError } from '../lib/render.js';
import { resolvedVersion, VERSION_OPTIONS } from '../lib/mermaid-registry.js';
import { TEMPLATES, DEFAULT_SOURCE } from '../lib/templates.js';
import { buildCacheFields, CACHE_VERSION } from '../lib/cache.js';
import { extractMermaidSource } from '../lib/mermaid-file.js';
import { decodeLiveUrl, isMermaidLiveUrl, LiveUrlError } from '../lib/live-url.js';
import { SIZE_PRESETS, heightForPreset, normalizeHeight, presetForHeight } from '../lib/sizing.js';
import { closeConfig, enableTheme, getConfig, resolveTheme, submitConfig } from '../lib/host.js';
import { Stage } from '../components/Stage.jsx';

const DEBOUNCE_MS = 300;

/* ------------------------------------------------------------------ */
/* Error line highlighting                                             */
/* ------------------------------------------------------------------ */

// Carries the 1-based error line to highlight, or null to clear. Typed
// explicitly: StateEffect.define() with no type argument defaults its value to
// `null`, which would reject the line number this effect exists to carry.
const setErrorLine = StateEffect.define<number | null>();
const errorLineMark = Decoration.line({ class: 'cm-errorLine' });

const errorLineField = StateField.define({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setErrorLine)) continue;
      const line = effect.value;
      if (!line || line < 1 || line > tr.state.doc.lines) {
        decorations = Decoration.none;
      } else {
        const from = tr.state.doc.line(line).from;
        decorations = Decoration.set([errorLineMark.range(from)]);
      }
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

function Editor({
  value,
  dark,
  onChange,
  errorLine,
  onTabCaptured,
  onLiveUrl,
}: {
  value: string;
  dark: boolean;
  onChange: (value: string) => void;
  errorLine: number | null;
  /** Fired the first time Tab is swallowed for indentation. See the exit hint. */
  onTabCaptured: () => void;
  /**
   * Import a Mermaid Live Editor URL that was pasted into the editor: decode it
   * into the source, or surface the failure. Callers decide whether the text is
   * one (isMermaidLiveUrl) before handing it over.
   */
  onLiveUrl: (text: string) => Promise<void>;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The dark theme is swapped through a compartment rather than by rebuilding
  // the view, so a light/dark flip keeps the document, the cursor and — the
  // part that was a real bug — the undo history.
  const themeCompartment = useRef(new Compartment());
  // The last document text we handed to onChange. Both the update listener and
  // the value-sync effect below need to know whether `value` came from our own
  // typing, and each was answering that by serializing the whole document (up
  // to MAX_SOURCE_CHARS) on every keystroke.
  const lastEmitted = useRef(value);

  useEffect(() => {
    const extensions = [
      lineNumbers(),
      history(),
      highlightActiveLine(),
      bracketMatching(),
      syntaxHighlighting(mermaidHighlightStyle, { fallback: true }),
      mermaidLang,
      errorLineField,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      // CodeMirror renders its content as role="textbox" with no accessible
      // name, so a screen reader announces an unlabelled edit field (WCAG 2.1
      // SC 4.1.2). The visible "Mermaid source" pane title is a sibling div
      // rather than a <label>, so name the field here instead of reaching
      // across the component boundary with aria-labelledby.
      // ...and describe it with the keyboard-exit hint, so the way out of the
      // Tab trap below is announced on the way in rather than only being
      // readable somewhere on screen (WCAG 2.1 SC 2.1.2; see the hint itself in
      // Panel). Describing rather than labelling: the name stays "Mermaid
      // source", and a description is what a screen reader reads after it.
      EditorView.contentAttributes.of({
        'aria-label': 'Mermaid source',
        'aria-describedby': 'editor-exit-hint',
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const text = update.state.doc.toString();
        lastEmitted.current = text;
        onChange(text);
      }),
      themeCompartment.current.of([]),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current ?? undefined,
    });
    viewRef.current = view;
    view.focus();

    return () => view.destroy();
    // Built once. The theme is reconfigured through the compartment above, and
    // the doc is kept in step by the value effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the dark theme in and out of its compartment. It is loaded only when
  // first needed, keeping it out of the light editor's entry chunk; the flag is
  // re-read on arrival so a flip back to light while the chunk is in flight
  // doesn't apply a theme nobody asked for any more.
  //
  // oneDarkTheme, not oneDark: the latter is [oneDarkTheme,
  // syntaxHighlighting(oneDarkHighlightStyle)], and that second half would
  // outrank mermaidHighlightStyle and repaint the tokens in One Dark's palette
  // instead of the --ds-* ones. We want its chrome — surface, gutter, cursor,
  // selection — and our own token colours.
  useEffect(() => {
    let cancelled = false;
    const reconfigure = (extension: Extension) => {
      if (!cancelled) {
        viewRef.current?.dispatch({
          effects: themeCompartment.current.reconfigure(extension),
        });
      }
    };
    if (dark) {
      import('@codemirror/theme-one-dark').then((m) => reconfigure(m.oneDarkTheme));
    } else {
      reconfigure([]);
    }
    return () => {
      cancelled = true;
    };
  }, [dark]);

  // Push external value changes (e.g. picking a "Start from" template) into the
  // document. When the change originated from typing, `value` is the text the
  // update listener just emitted, so this no-ops on the identity check alone —
  // no cursor jump, no feedback loop with onChange, and no second full
  // serialization of the document per keystroke.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === lastEmitted.current) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      lastEmitted.current = value;
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setErrorLine.of(errorLine) });
  }, [errorLine]);

  // Intercept pasted Mermaid Live Editor URLs BEFORE CodeMirror (or the
  // browser) can insert them as editor text. The listener is on this wrapper
  // div in the CAPTURE phase, which runs before any bubble-phase handler on
  // the .cm-content inside it — so both CodeMirror's own paste handling and
  // the browser's native paste are preempted, and the URL never lands in the
  // doc. Only mermaid.live fragments are intercepted; anything else pastes
  // normally. Decoding is async (DecompressionStream), so the URL is swallowed
  // first and the decoded source (or the error) lands in the panel a tick
  // later. The fragment carries the whole diagram, so this needs no network
  // call — the zero-egress invariant holds (see the invariant in CLAUDE.md).
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onPasteCapture = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!isMermaidLiveUrl(text)) return;
      event.preventDefault();
      event.stopPropagation();
      void onLiveUrl(text);
    };
    el.addEventListener('paste', onPasteCapture, true);
    return () => el.removeEventListener('paste', onPasteCapture, true);
  }, [onLiveUrl]);

  return (
    <div
      // editor-dark scopes the --mf-tok-* token colours to the dark palette.
      // It tracks the same flag as the theme compartment above, so the colours
      // and the chrome can never disagree.
      className={dark ? 'editor editor-dark' : 'editor'}
      ref={host}
      // The other half of the SC 2.1.2 advisory, for a sighted keyboard user who
      // never hears the field's description: the moment Tab is swallowed for
      // indentation instead of moving focus, reveal the way out. Observed on the
      // way past, never handled — indentWithTab in the keymap above still does
      // the indenting, and a modified Tab is the browser's own, so it moves
      // focus normally and reveals nothing. CodeMirror builds its DOM inside
      // this div, so the keydown bubbles through here.
      onKeyDown={(event) => {
        if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          onTabCaptured();
        }
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

/**
 * The live-preview state machine, a discriminated union on `status` so the ready
 * SVG and the error line/message live only on the states that carry them.
 */
type PreviewState =
  | { status: 'idle' }
  | { status: 'empty' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; line: number | null; message: string };

function Panel({ initial }: { initial: InitialConfig }) {
  const [source, setSource] = useState(initial.source || DEFAULT_SOURCE);
  const [mermaidVersion, setMermaidVersion] = useState(initial.mermaidVersion || 'auto');
  const [theme, setTheme] = useState(initial.theme || 'auto');
  const [useMaxWidth, setUseMaxWidth] = useState(initial.useMaxWidth !== false);
  // Explicit render height (px) or null for natural size. Chosen from the Size
  // presets; persisted to config so every reader matches.
  const [height, setHeight] = useState(normalizeHeight(initial.height));

  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  // Whether a newer render is in flight. Deliberately separate from
  // PreviewState rather than a member of it: the union answers "what is
  // painted?", this answers "is a newer answer coming?", and the whole point of
  // the in-flight chip is that those differ — the previous SVG stays painted,
  // and interactive, while the next one renders. Folding it into the union
  // would mean a 'pending' member carrying a second copy of the SVG that
  // `ready` already holds, plus a `status === 'ready' || status === 'pending'`
  // widening at every site that reads the union.
  const [pending, setPending] = useState(false);
  // The full input tuple the last ready preview rendered from, written in the
  // same tick as its setPreview. save() reuses the SVG when its own inputs
  // match, sparing one of the two save-time renders; keying on the whole tuple
  // (not just theme) is what makes an edit-then-quick-save reuse impossible to
  // get wrong — any drift falls back to a fresh render. useMaxWidth is not in
  // the tuple because it is not a render input: it only picks a CSS class.
  const previewRender = useRef<{
    source: string;
    mermaidVersion: string;
    theme: string;
    svg: string;
  } | null>(null);
  // Whether Tab has been pressed in the source editor yet, which is when the
  // "how to get out" hint stops being noise and starts being the answer.
  const [tabCaptured, setTabCaptured] = useState(false);
  // Errors from an import (dropped file, pasted Live link) and from a failed
  // save. One slot rather than two because they are mutually exclusive in
  // practice and share the same diagnostic row under the panes.
  const [dropError, setDropError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Whether a save is in flight: up to two renders plus the bridge submit,
  // long enough that the button has to say so and stop taking clicks.
  const [saving, setSaving] = useState(false);
  // The same fact as `saving`, kept where the guard in save() can read it.
  // State is not usable for that: two clicks landing in one React batch both
  // run against the same render's closure, so both would see `saving === false`
  // and both would submit. A ref is mutated synchronously, so the second click
  // sees what the first one wrote. `saving` still exists because the ref is not
  // reactive and the button has to re-render to show it.
  const savingRef = useRef(false);
  // Set by the discrete triggers — picking a template, changing a setting,
  // dropping a file, pasting a Live link — to render on the next tick instead
  // of waiting out the typing debounce. Those are single, final gestures: there
  // is no next keystroke coming to coalesce with, so the debounce is pure dead
  // time on exactly the interactions that should feel immediate. Measured on a
  // warm engine, a template switch spends ~300ms waiting and ~95ms rendering,
  // so this is most of the wait. A ref rather than state because it must not
  // itself cause a render, and because the effect below consumes it.
  const renderNow = useRef(false);
  const dark = useMemo(() => resolveTheme(theme) === 'dark', [theme]);

  // Which template the "Start from" picker shows. Derived from the source rather
  // than stored, so it reflects the active template while the source still
  // matches one, and falls back to the placeholder the moment you edit — which
  // also lets you re-pick the same template to reload it.
  // Compare lengths before contents: this runs on every keystroke, and an
  // edited source almost never has the exact length of a template, so the
  // cheap check answers it without a full string comparison per template.
  const templateId = useMemo(
    () => TEMPLATES.find((t) => t.source.length === source.length && t.source === source)?.id ?? '',
    [source],
  );

  // Bumped on every source change, from anywhere. An import captures it before
  // its await and drops its result if the source moved on meanwhile — typing or
  // picking a template must never be undone by a slow read or decode landing
  // afterwards. This is the callback-shaped twin of the `cancelled` flag the
  // debounced preview effect below uses; a ref, because the imports are
  // callbacks with no effect cleanup to hang it on.
  const sourceGen = useRef(0);
  useEffect(() => {
    sourceGen.current += 1;
  }, [source]);

  // Load a .mmd or .md file dropped onto the editor. Reading and parsing happen
  // in the browser; nothing is uploaded.
  const onDropFile = useCallback(async (file: File) => {
    setDropError(null);
    const gen = sourceGen.current;
    try {
      const text = await file.text();
      const result = extractMermaidSource(text, file.name);
      if (gen !== sourceGen.current) return; // superseded while reading
      if ('error' in result) {
        setDropError(result.error);
      } else if (result.source.trim()) {
        renderNow.current = true; // the drop already made the user wait on a read
        setSource(result.source);
      } else {
        setDropError('That file has no Mermaid content.');
      }
    } catch {
      if (gen === sourceGen.current) setDropError('Could not read that file.');
    }
  }, []);

  // Import a diagram from a Mermaid Live Editor URL. The fragment carries the
  // whole source (zlib-deflated or plain JSON), so this needs no network call —
  // the zero-egress invariant stays intact. Shared by the editor's paste
  // handler and this component's drop handler, so a link pasted or dragged
  // lands the same way. Both callers test isMermaidLiveUrl first — they have to
  // decide whether to preempt the browser before they can call this — so the
  // text arriving here is already known to be one.
  const importLiveUrl = useCallback(async (text: string): Promise<void> => {
    setDropError(null);
    const gen = sourceGen.current;
    try {
      const decoded = await decodeLiveUrl(text);
      if (gen !== sourceGen.current) return; // superseded while decoding
      renderNow.current = true; // the paste already made the user wait on a decode
      setSource(decoded);
    } catch (err) {
      if (gen !== sourceGen.current) return;
      // Only the messages live-url wrote for this panel are shown: they point at
      // different fixes ("…has no diagram in it" is not "couldn't decode it"),
      // and the LiveUrlError tag is what says a message was chosen rather than
      // merely escaping. Anything else reaching here is a bug, and its internal
      // text is not something to put in front of the user.
      setDropError(
        err instanceof LiveUrlError && err.message
          ? err.message
          : "Couldn't decode that Mermaid Live link.",
      );
    }
  }, []);

  // Make the modal a drop zone. Document-level capture listeners are used (not
  // React handlers on the panel) for three reasons: dragover must call
  // preventDefault on EVERY move or the browser just opens the file/link; a
  // depth counter tracks enter/leave reliably across nested elements and
  // repeated drag-in/out cycles; and capture runs before CodeMirror's own drop
  // handling. Everything is read/decoded in-browser — nothing is uploaded or
  // fetched.
  //
  // Two decisions, deliberately kept apart, because conflating them is how a
  // dropped link either eats an ordinary paste or navigates the iframe away:
  //
  //   CLAIMED  — preventDefault, so the browser does not act on the drop. Both
  //              Files and text/uri-list are claimed ANYWHERE in the modal. The
  //              default action for a link dropped on a page is to navigate to
  //              it, and this page is the config iframe: navigating it throws
  //              away the diagram the user is editing, unsaved. So a link drag
  //              is always swallowed, even where nothing is done with it.
  //   IMPORTED — Files anywhere (dropping a .mmd on the settings row clearly
  //              means "load this"); links only over the source editor, and
  //              only when they are actually mermaid.live links. A non-live
  //              link over the editor is left to CodeMirror, which inserts it
  //              as text — that is how you write a `click A href "…"` target.
  //
  // The overlay follows IMPORTED, not CLAIMED: it may only promise what a drop
  // there would really do. An in-editor text drag carries neither type, so
  // dragging text around inside the editor still works.
  useEffect(() => {
    let depth = 0;
    const isFile = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const isLink = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types || []).includes('text/uri-list');
    // Whether the cursor is over the editor. The drop overlay is
    // pointer-events:none, so e.target still resolves to the element underneath
    // while it is showing.
    const overEditor = (e: DragEvent) =>
      e.target instanceof Element && e.target.closest('.editor') !== null;

    const claimed = (e: DragEvent) => isFile(e) || isLink(e);
    // Where a drop would import: the overlay's promise, and the depth counter's
    // unit, so enter/leave stay balanced when a link drag crosses into or out
    // of the editor.
    const importable = (e: DragEvent) => isFile(e) || (isLink(e) && overEditor(e));

    const onEnter = (e: DragEvent) => {
      if (!claimed(e)) return;
      e.preventDefault();
      if (!importable(e)) return;
      depth += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!claimed(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = importable(e) ? 'copy' : 'none';
    };
    const onLeave = (e: DragEvent) => {
      if (!importable(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDropEvt = (e: DragEvent) => {
      if (!claimed(e)) return;
      depth = 0;
      setDragging(false);

      const file = e.dataTransfer?.files?.[0];
      if (file) {
        e.preventDefault();
        e.stopPropagation();
        onDropFile(file);
        return;
      }

      // A dragged LINK. uri-list is "one URI per line", so take the first
      // token. isMermaidLiveUrl is synchronous, so the decision of whether this
      // drop is ours can be made before preventDefault — which is what lets an
      // ordinary link fall through to CodeMirror instead of being answered with
      // an error the user never asked for. The URL is never fetched as a
      // fallback; the fragment is the only thing read.
      const uri = (e.dataTransfer?.getData('text/uri-list') ?? '').trim().split(/\s+/)[0] ?? '';
      if (uri && overEditor(e) && isMermaidLiveUrl(uri)) {
        e.preventDefault();
        e.stopPropagation();
        void importLiveUrl(uri);
        return;
      }
      // Not an import. Over the editor, leave the event entirely alone so
      // CodeMirror's own drop handler inserts the URL as text. Anywhere else,
      // swallow it silently: nothing to do, but the frame must not navigate.
      if (!overEditor(e)) e.preventDefault();
    };

    window.addEventListener('dragenter', onEnter, true);
    window.addEventListener('dragover', onOver, true);
    window.addEventListener('dragleave', onLeave, true);
    window.addEventListener('drop', onDropEvt, true);
    return () => {
      window.removeEventListener('dragenter', onEnter, true);
      window.removeEventListener('dragover', onOver, true);
      window.removeEventListener('dragleave', onLeave, true);
      window.removeEventListener('drop', onDropEvt, true);
    };
  }, [onDropFile, importLiveUrl]);

  // Live preview. Debounced, and stale results are discarded — typing fast
  // must never leave you looking at the diagram from three keystrokes ago.
  useEffect(() => {
    setDropError(null); // any source/setting change supersedes a drop error
    let cancelled = false;
    // Read and clear at schedule time, not inside the timer: the flag describes
    // the change that scheduled *this* run, and leaving it set would hand the
    // no-debounce path to whatever typing happened next.
    const immediate = renderNow.current;
    renderNow.current = false;
    const timer = setTimeout(
      async () => {
        if (!source.trim()) {
          if (!cancelled) {
            setPreview({ status: 'empty' });
            setPending(false);
          }
          return;
        }
        // Marked pending here rather than at effect start, so the chip's reveal
        // delay measures the render and not the debounce. Setting it on the
        // keystroke would spend the delay waiting for DEBOUNCE_MS to elapse and
        // blink the chip on every pause in typing — exactly the flicker the
        // delay exists to prevent. Unguarded by `cancelled` because reaching
        // here means the timer fired, so cleanup has not run. A superseded
        // render leaves this true, which is correct: its replacement is already
        // queued and owns clearing it.
        setPending(true);
        try {
          const resolvedTheme = resolveTheme(theme);
          const { svg } = await renderDiagram({
            source,
            versionPref: mermaidVersion,
            theme: resolvedTheme,
          });
          if (!cancelled) {
            previewRender.current = {
              source,
              mermaidVersion,
              theme: resolvedTheme,
              svg,
            };
            setPreview({ status: 'ready', svg });
            setPending(false);
          }
        } catch (err) {
          if (!cancelled) {
            setPreview({ status: 'error', ...describeError(err) });
            setPending(false);
          }
        }
        // Still a timer at zero rather than an inline call, so the cancellation
        // contract above is unchanged: one clearTimeout, one `cancelled` flag,
        // both paths identical. This schedules the work sooner; it does not
        // restructure how the work is abandoned.
      },
      immediate ? 0 : DEBOUNCE_MS,
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Deliberately not useMaxWidth: it reaches the diagram as a CSS class on the
    // Stage, so the toggle re-styles the SVG already on screen instead of
    // spending a render to produce identical markup.
  }, [source, mermaidVersion, theme]);

  const insertTemplate = (id: string) => {
    const template = TEMPLATES.find((t) => t.id === id);
    if (template) {
      renderNow.current = true; // a pick is final — nothing to coalesce with
      setSource(template.source);
    }
  };

  // On save, render the diagram to SVG for both light and dark and stash the
  // results in config so readers paint without loading Mermaid. Rendering is
  // deterministic and the source is already known-valid (save is gated on a
  // successful preview), but the cache must never block a save: if a render
  // throws, persist the source alone and let readers render on view. Oversized
  // variants are dropped by buildCacheFields so a big diagram still saves.
  //
  // The two renders stay sequential even though render.js now serializes the
  // Mermaid singleton internally: awaiting one before the other keeps the
  // theme pairing obvious here and costs nothing. The preview has usually just
  // rendered one of the two variants from these exact inputs, so that leg is
  // reused instead of re-rendered.
  const save = async () => {
    // The disabled attribute below is the visible half of this; this guard is
    // what actually holds, because two clicks landing inside one React batch
    // both run before the re-render that disables the button. Read through the
    // ref, not the state — see its declaration for why the state cannot.
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const previewSvgFor = (renderTheme: string) => {
      const prev = previewRender.current;
      return prev &&
        prev.source === source &&
        prev.mermaidVersion === mermaidVersion &&
        prev.theme === renderTheme
        ? { svg: prev.svg }
        : null;
    };
    let cacheFields = { cacheV: CACHE_VERSION };
    try {
      const light =
        previewSvgFor('light') ??
        (await renderDiagram({
          source,
          versionPref: mermaidVersion,
          theme: 'light',
        }));
      const dark =
        previewSvgFor('dark') ??
        (await renderDiagram({
          source,
          versionPref: mermaidVersion,
          theme: 'dark',
        }));
      // Stamp the semver that just did the rendering. Read here rather than in
      // the view, because this build is the one holding the renderer; a reader
      // opening the page years later has a different bundle and no way to know.
      cacheFields = buildCacheFields(light.svg, dark.svg, resolvedVersion(mermaidVersion));
    } catch {
      cacheFields = { cacheV: CACHE_VERSION };
    }
    // `height` is a display-time size, not part of the render inputs, so it
    // rides alongside the cache fields without affecting them. Omit when unset
    // so a natural-size diagram doesn't carry a stale key.
    const sizing = height ? { height } : {};
    try {
      await submitConfig({ source, mermaidVersion, theme, useMaxWidth, ...sizing, ...cacheFields });
    } catch {
      // A failed submit is the one error here the user can act on — the render
      // failures above are already absorbed into a source-only save. Reuse the
      // panel's diagnostic slot: it is role="alert", which is assertive, and a
      // save that silently did nothing is exactly what warrants interrupting.
      setDropError("Couldn't save the diagram. Try again.");
    } finally {
      // On success the host is tearing this modal down, so this lands on a
      // component about to unmount; on failure it is what gives the button
      // back. React 19 does not warn about the former.
      savingRef.current = false;
      setSaving(false);
    }
  };

  const valid = preview.status === 'ready';

  return (
    <div className="panel">
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-inner">
            <strong>Drop to load your diagram</strong>
            <span>
              It is processed here in your browser and turned into the diagram — nothing is opened
              or uploaded anywhere.
            </span>
          </div>
        </div>
      )}
      <div className="controls">
        <label>
          Start from
          <select value={templateId} onChange={(e) => insertTemplate(e.target.value)}>
            <option value="" disabled>
              Choose a diagram type
            </option>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Theme
          <select
            value={theme}
            onChange={(e) => {
              renderNow.current = true;
              setTheme(e.target.value);
            }}
          >
            <option value="auto">Match Confluence</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>

        <label>
          Size
          <select
            value={presetForHeight(height)}
            onChange={(e) => setHeight(heightForPreset(e.target.value))}
          >
            {SIZE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Mermaid
          <select
            value={mermaidVersion}
            onChange={(e) => {
              renderNow.current = true;
              setMermaidVersion(e.target.value);
            }}
          >
            {VERSION_OPTIONS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <input
            type="checkbox"
            checked={!useMaxWidth}
            onChange={(e) => setUseMaxWidth(!e.target.checked)}
          />
          Keep full width (don&rsquo;t shrink to fit)
        </label>
      </div>

      <div className="split">
        <div className="pane">
          <div className="pane-title">
            Mermaid source
            <span className="hint"> · or drop a .mmd / .md file, or paste a Mermaid Live link</span>
            {/* Tab indents here (indentWithTab), so the way out has to be
                stated, not merely bound: SC 2.1.2 requires the user be advised
                of the method whenever it takes more than Tab itself. Esc-then-
                Tab is CodeMirror's own escape hatch — shorter to explain than
                the Ctrl+M toggle, and the same on every platform.

                Stated on the field rather than permanently above it, so it
                reaches each audience when it is the answer to a question they
                actually have. It is the editor's accessible description, so a
                screen reader reads it on the way in; and it stays visually
                hidden until Tab is first swallowed, which is the moment a
                sighted keyboard user discovers they are stuck. Never removed
                from the DOM — sr-only, not display:none — because the
                description has to stay in the accessibility tree either way. */}
            <span id="editor-exit-hint" className={`hint exit-hint${tabCaptured ? ' shown' : ''}`}>
              {' '}
              · Esc then Tab to leave the editor
            </span>
          </div>
          <Editor
            value={source}
            dark={dark}
            onChange={setSource}
            errorLine={preview.status === 'error' ? preview.line : null}
            onTabCaptured={() => setTabCaptured(true)}
            onLiveUrl={importLiveUrl}
          />
        </div>

        <div className="pane">
          <div className="pane-title">Preview</div>
          <div className="preview" aria-busy={pending}>
            {/* The same Stage the reader view renders, so the preview is not a
                lookalike of the published diagram but literally the same
                component: pan, zoom, fit and maximize all work here, and the
                Size / "Keep full width" settings preview exactly as they render.
                Wrapped in .root because the toolbar and hint reveal rules key
                off it. No toolbarExtras — copy-source and export are reader
                actions, and the editor already has the source in the pane next
                to it. */}
            {preview.status === 'ready' && (
              <div className="root">
                {/* autoFit is the one thing the preview does differently, and
                    only because its stage differs: this one is a fixed pane,
                    where the reader's hugs its content, so a Size preset taller
                    than the pane would be clipped at 100% rather than simply
                    making the macro taller. Shrink-only, so anything that fits
                    still previews at 1:1. */}
                <Stage svg={preview.svg} useMaxWidth={useMaxWidth} height={height} autoFit />
              </div>
            )}
            {preview.status === 'empty' && <span>Write some Mermaid to see it here.</span>}
            {preview.status === 'idle' && <span>Rendering…</span>}
            {/* Overlays the diagram above rather than replacing it, so a
                template switch or a keystroke never costs you the render you
                are looking at — or the pan and zoom you set on it. Skipped
                while 'idle', which is the first-ever render and already says
                "Rendering…" in the middle of the empty pane; two indicators
                for one wait is noise. Every other status is covered, including
                'error', where the pane is otherwise blank.
                role="status" is polite and atomic, matching the reader's
                export chip. Deliberately not paired with an always-mounted
                live region: this fires after every pause in typing, and an
                announcement that landed reliably would read "Rendering…" over
                the user's own typing. aria-busy on the pane is the signal that
                carries here. */}
            {pending && preview.status !== 'idle' && (
              <div className="preview-busy reveal" role="status">
                <span className="spinner" aria-hidden="true" />
                Rendering…
              </div>
            )}
          </div>
        </div>
      </div>

      {dropError ? (
        <div className="diagnostic" role="alert">
          <code>{dropError}</code>
        </div>
      ) : preview.status === 'error' ? (
        <div className="diagnostic" role="alert">
          {preview.line ? (
            <>
              <strong>Line {preview.line}:</strong> <code>{preview.message}</code>
            </>
          ) : (
            <code>{preview.message}</code>
          )}
        </div>
      ) : null}

      <div className="actions">
        <button type="button" onClick={closeConfig}>
          Cancel
        </button>
        {/* No spinner inside this one: it sits on --ds-background-brand-bold
            with inverse text, where .spinner's subtle border colours are all
            but invisible. The label swap plus the existing disabled styling
            already reads unambiguously. Not gated on `pending` — save() reads
            live state and its reuse tuple keys on the whole input set, so
            saving mid-debounce still writes the source you are looking at. */}
        <button
          type="button"
          className="primary"
          onClick={save}
          disabled={!valid || saving}
          aria-busy={saving}
        >
          {saving ? 'Saving…' : 'Save diagram'}
        </button>
      </div>
    </div>
  );
}

/**
 * Saved diagram config the editor seeds its fields from. Every field is
 * optional — a never-saved macro opens with an empty object.
 */
type InitialConfig = {
  source?: string;
  mermaidVersion?: string;
  theme?: string;
  useMaxWidth?: boolean;
  height?: number | string;
};

function App() {
  const [initial, setInitial] = useState<InitialConfig | null>(null);

  useEffect(() => {
    enableTheme();
    getConfig()
      .then(setInitial)
      .catch(() => setInitial({}));
  }, []);

  if (!initial)
    return (
      <div className="panel loading reveal" role="status">
        <span className="spinner" aria-hidden="true" />
        Loading editor…
      </div>
    );
  return <Panel initial={initial} />;
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);

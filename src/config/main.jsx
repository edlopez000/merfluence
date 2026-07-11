import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { Decoration } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';

import { mermaid as mermaidLang } from './mermaid-lang.js';
import { renderDiagram, describeError } from '../lib/render.js';
import { VERSION_OPTIONS } from '../lib/mermaid-registry.js';
import { TEMPLATES, DEFAULT_SOURCE } from '../lib/templates.js';
import { buildCacheFields, CACHE_VERSION } from '../lib/cache.js';
import { closeConfig, enableTheme, getConfig, resolveTheme, submitConfig } from '../lib/host.js';

const DEBOUNCE_MS = 300;

/* ------------------------------------------------------------------ */
/* Error line highlighting                                             */
/* ------------------------------------------------------------------ */

const setErrorLine = StateEffect.define();
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

function Editor({ initialValue, dark, onChange, errorLine }) {
  const host = useRef(null);
  const viewRef = useRef(null);

  useEffect(() => {
    const extensions = [
      lineNumbers(),
      history(),
      highlightActiveLine(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      mermaidLang,
      errorLineField,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.doc.toString());
      }),
      ...(dark ? [oneDark] : []),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: initialValue, extensions }),
      parent: host.current,
    });
    viewRef.current = view;
    view.focus();

    return () => view.destroy();
    // Rebuilt on theme flip; the doc is re-seeded from the latest value below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setErrorLine.of(errorLine) });
  }, [errorLine]);

  return <div className="editor" ref={host} />;
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

function Panel({ initial }) {
  const [source, setSource] = useState(initial.source || DEFAULT_SOURCE);
  const [mermaidVersion, setMermaidVersion] = useState(initial.mermaidVersion || 'auto');
  const [theme, setTheme] = useState(initial.theme || 'auto');
  const [useMaxWidth, setUseMaxWidth] = useState(initial.useMaxWidth !== false);

  const [preview, setPreview] = useState({ status: 'idle' });
  const dark = useMemo(() => resolveTheme(theme) === 'dark', [theme]);

  // Live preview. Debounced, and stale results are discarded — typing fast
  // must never leave you looking at the diagram from three keystrokes ago.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (!source.trim()) {
        if (!cancelled) setPreview({ status: 'empty' });
        return;
      }
      try {
        const { svg } = await renderDiagram({
          source,
          versionPref: mermaidVersion,
          theme: resolveTheme(theme),
          useMaxWidth,
        });
        if (!cancelled) setPreview({ status: 'ready', svg });
      } catch (err) {
        if (!cancelled) setPreview({ status: 'error', ...describeError(err) });
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, mermaidVersion, theme, useMaxWidth]);

  const insertTemplate = (id) => {
    const template = TEMPLATES.find((t) => t.id === id);
    if (template) setSource(template.source);
  };

  // On save, render the diagram to SVG for both light and dark and stash the
  // results in config so readers paint without loading Mermaid. Rendering is
  // deterministic and the source is already known-valid (save is gated on a
  // successful preview), but the cache must never block a save: if a render
  // throws, persist the source alone and let readers render on view. Oversized
  // variants are dropped by buildCacheFields so a big diagram still saves.
  //
  // These two renders MUST be sequential, not Promise.all: Mermaid is a global
  // singleton whose theme is set by initialize(). Run in parallel, the two
  // initialize() calls race and the last one wins, so both SVGs come out in the
  // same theme. Awaiting one full render before starting the next keeps them
  // distinct.
  const save = async () => {
    let cacheFields = { cacheV: CACHE_VERSION };
    try {
      const light = await renderDiagram({ source, versionPref: mermaidVersion, theme: 'light', useMaxWidth });
      const dark = await renderDiagram({ source, versionPref: mermaidVersion, theme: 'dark', useMaxWidth });
      cacheFields = buildCacheFields(light.svg, dark.svg);
    } catch {
      cacheFields = { cacheV: CACHE_VERSION };
    }
    await submitConfig({ source, mermaidVersion, theme, useMaxWidth, ...cacheFields });
  };

  const valid = preview.status === 'ready';

  return (
    <div className="panel">
      <div className="controls">
        <label>
          Start from
          <select
            defaultValue=""
            onChange={(e) => {
              insertTemplate(e.target.value);
              e.target.value = '';
            }}
          >
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
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="auto">Match Confluence</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>

        <label>
          Mermaid
          <select value={mermaidVersion} onChange={(e) => setMermaidVersion(e.target.value)}>
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
          <div className="pane-title">Mermaid source</div>
          <Editor
            initialValue={source}
            dark={dark}
            onChange={setSource}
            errorLine={preview.status === 'error' ? preview.line : null}
          />
        </div>

        <div className="pane">
          <div className="pane-title">Preview</div>
          <div className="preview">
            {preview.status === 'ready' && (
              <div dangerouslySetInnerHTML={{ __html: preview.svg }} />
            )}
            {preview.status === 'empty' && <span>Write some Mermaid to see it here.</span>}
            {preview.status === 'idle' && <span>Rendering…</span>}
          </div>
        </div>
      </div>

      {preview.status === 'error' ? (
        <div className="diagnostic" role="alert">
          {preview.line ? (
            <>
              <strong>Line {preview.line}:</strong> <code>{preview.message}</code>
            </>
          ) : (
            <code>{preview.message}</code>
          )}
        </div>
      ) : (
        <div className="diagnostic ok">Diagram renders. Nothing left this browser.</div>
      )}

      <div className="actions">
        <button type="button" onClick={closeConfig}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={save} disabled={!valid}>
          Save diagram
        </button>
      </div>
    </div>
  );
}

function App() {
  const [initial, setInitial] = useState(null);

  useEffect(() => {
    enableTheme();
    getConfig()
      .then(setInitial)
      .catch(() => setInitial({}));
  }, []);

  if (!initial) return <div className="panel">Loading editor…</div>;
  return <Panel initial={initial} />;
}

createRoot(document.getElementById('root')).render(<App />);

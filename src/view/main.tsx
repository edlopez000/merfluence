import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { renderDiagram, describeError, sanitizeSvg } from '../lib/render.js';
import { ensureAccessibleName } from '../lib/a11y-name.js';
import { loadMermaid, resolvedVersion } from '../lib/mermaid-registry.js';
import { enableTheme, getConfig, onThemeChange, resolveTheme, resize } from '../lib/host.js';
import { pickCachedSvg, pickCachedVersion } from '../lib/cache.js';
import { normalizeHeight } from '../lib/sizing.js';
import { download, exportPng } from '../lib/png-export.js';
import { Stage } from '../components/Stage.jsx';
import type { StageActions } from '../components/Stage.jsx';

/**
 * The reader-only toolbar actions — copy the diagram source, and export it as
 * PNG or SVG. These are injected into the shared Stage's toolbar rather than
 * living inside it, so the config bundle never pulls in png-export.js or the
 * clipboard path: the editor has no use for either.
 */
/**
 * How long the "Exporting…" chip stays up at minimum.
 *
 * A PNG export is not instant — it rasterizes the diagram at twice its own size
 * and encodes it (measured on a 1983x2693 sequence diagram: ~100ms for a 979KB
 * PNG, most of it in toBlob, and multiples of that on a slower machine). But it
 * is fast enough that a chip which appears and vanishes inside a few frames
 * reads as a glitch rather than an acknowledgement, so the chip is held briefly
 * and every click lands the same way. Only the chip waits; the download itself
 * still fires the moment the blob is ready.
 */
const MIN_BUSY_MS = 400;

function ViewActions({ source, getSvg, setFailure }: StageActions & { source: string }) {
  const [copied, setCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportRef = useRef<HTMLDivElement | null>(null);

  // Close the export menu on an outside click or Escape, the two things a user
  // expects to dismiss a popup.
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!exportRef.current?.contains(e.target as Node | null)) setExportOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExportOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [exportOpen]);

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setFailure('Clipboard is blocked. Open the editor to copy the source.');
    }
  };

  const saveSvg = () => {
    const svg = getSvg();
    if (!svg) return;
    const markup = new XMLSerializer().serializeToString(svg);
    download(new Blob([markup], { type: 'image/svg+xml' }), 'diagram.svg');
  };

  const savePng = async () => {
    const svg = getSvg();
    // Already running: a second export would start another full-size rasterize
    // on top of the first, which is exactly what someone does when the first
    // click appeared to do nothing. The disabled trigger below is the visible
    // half of this; the guard is what actually holds.
    if (!svg || exporting) return;
    setExporting(true);
    const started = Date.now();
    try {
      // Give the chip a frame to paint before the work starts. Everything up to
      // the image's onload runs in this same task, so without this the first
      // paint of "Exporting…" would already be behind part of the export.
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await exportPng(svg);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed < MIN_BUSY_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_BUSY_MS - elapsed));
      }
      setExporting(false);
    }
  };

  return (
    <>
      <button type="button" onClick={copySource}>
        {copied ? 'Copied' : 'Copy source'}
      </button>
      <div className="export" ref={exportRef}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={exportOpen}
          disabled={exporting}
          onClick={() => setExportOpen((open) => !open)}
        >
          Export <span aria-hidden="true">▾</span>
        </button>
        {exportOpen && (
          <div className="export-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                savePng();
                setExportOpen(false);
              }}
            >
              PNG
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                saveSvg();
                setExportOpen(false);
              }}
            >
              SVG
            </button>
          </div>
        )}
      </div>
      {/* Reuses .status — the toolbar's shared message slot — so the existing
          `.toolbar:has(.status)` rule keeps the toolbar on screen for the whole
          export. Without that the toolbar fades out the moment the pointer
          leaves and the export runs with nothing on screen at all, which is the
          bug this is fixing. role="status" makes the same announcement to a
          screen reader; the spinner is decorative and stays out of the tree. */}
      {exporting && (
        <span className="status busy" role="status">
          <span className="spinner" aria-hidden="true" />
          Exporting…
        </span>
      )}
    </>
  );
}

/**
 * Diagram settings read from macro config. Every field is optional: config is
 * authored on the page and may be empty or partial, so each read defaults.
 */
type DiagramConfig = {
  source?: string;
  theme?: string;
  mermaidVersion?: string;
  useMaxWidth?: boolean;
  height?: number | string;
  cacheV?: number;
  svgLight?: string;
  svgDark?: string;
  renderedVersion?: string;
};

/**
 * The reader view's state machine. A discriminated union on `status`, so the
 * fields each screen needs (the ready SVG, the error line/message) only exist on
 * the state that carries them.
 *
 * `ready` carries `version` next to the SVG so the label can never describe a
 * different render than the one on screen: a cached SVG reports the semver
 * stored with it, a fresh one reports this bundle's. Reading the version
 * separately, at label time, is exactly the bug this pairing retires.
 */
type ViewState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'deferred' }
  | { status: 'ready'; svg: string; version: string }
  | { status: 'error'; line: number | null; message: string };

function App() {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [config, setConfig] = useState<DiagramConfig | null>(null);
  const [visible, setVisible] = useState(false);
  const deferRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Turn on host theming first so the colour mode is resolved before we pick
    // which cached variant (light/dark) to paint.
    enableTheme();
    getConfig()
      .then(setConfig)
      .catch(() => setConfig({}));
  }, []);

  // Decide what to show *without* loading Mermaid. Empty and cache hits resolve
  // here for free; a cache miss becomes 'deferred' so the expensive render waits
  // until the macro actually scrolls into view.
  // What the last full decide() ran with. A theme trigger that resolves to the
  // same theme for the same config is a no-op — without this gate it would
  // re-sanitize a cache hit into a fresh state object and, on a cache miss,
  // kick an already-rendered diagram back to 'deferred' for a full re-render.
  const lastDecided = useRef<{ config: DiagramConfig; theme: string } | null>(null);

  const decide = useCallback(() => {
    if (!config) return;

    const theme = resolveTheme(config.theme);
    if (lastDecided.current?.config === config && lastDecided.current.theme === theme) return;
    lastDecided.current = { config, theme };

    const source = (config.source ?? '').trim();
    if (!source) {
      setState({ status: 'empty' });
      return;
    }

    // Cache hit: the editor already rendered this diagram to SVG for this theme
    // and stored it in config. Paint it and never load Mermaid — the whole win.
    // Re-sanitize: this SVG comes from macro config, which anyone who can edit
    // the page can author, so it gets the same DOMPurify pass a fresh render does.
    // ensureAccessibleName runs first, in the same order as the fresh-render
    // path — and it is what gives a diagram cached before that code existed a
    // name, without invalidating every stored cache to do it.
    const cached = pickCachedSvg(config, theme);
    if (cached) {
      setState({
        status: 'ready',
        svg: sanitizeSvg(ensureAccessibleName(cached)),
        // The version stored with the SVG, not this bundle's: the cached render
        // may predate several Mermaid upgrades. Only a config missing the field
        // falls back to the computed label.
        version: pickCachedVersion(config) ?? resolvedVersion(config.mermaidVersion),
      });
      return;
    }

    setState({ status: 'deferred' });
  }, [config]);

  useEffect(() => {
    decide();
  }, [decide]);

  useEffect(() => onThemeChange(decide), [decide]);

  // Warm the renderer while the observer below waits: the Mermaid module fetch
  // is the long pole of a cache-miss render, and a deferred macro is going to
  // need it the moment it scrolls in. loadMermaid caches the promise, so this
  // overlaps the network fetch with the scroll without changing when we render
  // — and costs nothing on the cache-hit path, which never enters 'deferred'.
  useEffect(() => {
    if (state.status !== 'deferred' || !config) return;
    loadMermaid(config.mermaidVersion).catch(() => {
      // A fetch failure surfaces from the real render below, with an error
      // state to land in; here it would just be an unhandled rejection.
    });
  }, [state.status, config]);

  // Lazy-load trigger: only once a deferred macro is on screen do we mark it
  // visible, which kicks off the render below. rootMargin starts the load a bit
  // before it enters the viewport so scrolling feels instant. A cache hit is
  // never 'deferred', so this observer is a no-op on the fast path.
  useEffect(() => {
    if (state.status !== 'deferred') return;
    const el = deferRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true); // no IO support: fall back to eager render
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [state.status]);

  // Render once the deferred macro is on screen. This is the only path that
  // loads Mermaid. We do not write the result back into config here: the macro
  // view has no scope-free way to persist config (that needs a resolver or a
  // scope the app forbids), so the cache is populated only by saving in the
  // editor. An uncached diagram renders fresh on every view.
  useEffect(() => {
    if (state.status !== 'deferred' || !visible || !config) return;
    let cancelled = false;
    (async () => {
      try {
        const { svg } = await renderDiagram({
          source: (config.source ?? '').trim(),
          versionPref: config.mermaidVersion,
          theme: resolveTheme(config.theme),
          useMaxWidth: config.useMaxWidth !== false,
        });
        // This bundle is doing the rendering right now, so its semver is the
        // truthful label.
        if (!cancelled)
          setState({ status: 'ready', svg, version: resolvedVersion(config.mermaidVersion) });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', ...describeError(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.status, visible, config]);

  // Let the SVG land, measure, then ask the host for the right height. Depend on
  // the ready SVG (null on every other state) so a re-render into a new diagram
  // re-measures; kept in a variable so the dep array stays statically checkable.
  const readySvg = state.status === 'ready' ? state.svg : null;
  useEffect(() => {
    if (state.status === 'ready') requestAnimationFrame(resize);
  }, [state.status, readySvg]);

  if (state.status === 'loading') {
    return <div className="message empty">Loading diagram…</div>;
  }

  if (state.status === 'empty') {
    return (
      <div className="message empty">
        No diagram yet. Select the macro and choose <strong>Edit diagram</strong> to write some
        Mermaid.
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="message error" role="alert">
        <strong>
          This diagram has a syntax error
          {state.line ? ` on line ${state.line}` : ''}.
        </strong>
        <pre>{state.message}</pre>
      </div>
    );
  }

  // Cache miss waiting to scroll into view. This element is what the
  // IntersectionObserver watches, so it must render before the diagram does.
  if (state.status === 'deferred') {
    return (
      <div ref={deferRef} className="message empty">
        Loading diagram…
      </div>
    );
  }

  // Unreachable: status is only 'ready' once config has loaded and decide() ran.
  // The guard narrows config to non-null for the render below.
  if (!config) return null;

  return (
    <div className="root">
      <Stage
        svg={state.svg}
        useMaxWidth={config.useMaxWidth !== false}
        height={normalizeHeight(config.height)}
        // A render prop rather than a plain node: copy and export need the
        // stage's own SVG and its failure slot, both of which Stage owns.
        toolbarExtras={(actions) => <ViewActions {...actions} source={config.source ?? ''} />}
      />
      <div className="meta">Mermaid {state.version}</div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { renderDiagram, describeError, sanitizeSvg } from '../lib/render.js';
import { resolvedVersion } from '../lib/mermaid-registry.js';
import { enableTheme, getConfig, onThemeChange, resolveTheme, resize } from '../lib/host.js';
import { pickCachedSvg } from '../lib/cache.js';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * SVG -> PNG entirely in the browser: serialize, load into an Image via a data
 * URL, paint to a canvas. No upload, no server, no attachment. Rendered at 2x
 * because a 1x flowchart pasted into a deck looks like a fax.
 */
async function exportPng(svgEl, scale = 2) {
  const clone = svgEl.cloneNode(true);
  const { width, height } = svgEl.getBoundingClientRect();
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  const markup = new XMLSerializer().serializeToString(clone);
  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('Could not rasterize the diagram'));
    image.src = encoded;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.drawImage(image, 0, 0);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not rasterize the diagram');
  download(blob, 'diagram.png');
}

function Toolbar({ stageRef, source, onZoom, onReset, zoom }) {
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState(null);

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
    const svg = stageRef.current?.querySelector('svg');
    if (!svg) return;
    const markup = new XMLSerializer().serializeToString(svg);
    download(new Blob([markup], { type: 'image/svg+xml' }), 'diagram.svg');
  };

  const savePng = async () => {
    const svg = stageRef.current?.querySelector('svg');
    if (!svg) return;
    try {
      await exportPng(svg);
    } catch (err) {
      setFailure(err.message);
    }
  };

  const fullscreen = () => {
    const target = stageRef.current;
    if (document.fullscreenElement) document.exitFullscreen();
    else target?.requestFullscreen?.();
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Diagram actions">
      <button type="button" onClick={copySource}>
        {copied ? 'Copied' : 'Copy source'}
      </button>
      <button type="button" onClick={saveSvg}>
        SVG
      </button>
      <button type="button" onClick={savePng}>
        PNG
      </button>
      <button type="button" onClick={() => onZoom(-0.2)} aria-label="Zoom out">
        &minus;
      </button>
      <button
        type="button"
        className="zoom-level"
        onClick={onReset}
        title="Reset view"
        aria-label="Reset view"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" onClick={() => onZoom(0.2)} aria-label="Zoom in">
        +
      </button>
      <button type="button" onClick={fullscreen}>
        Fullscreen
      </button>
      {failure && <span className="sr-only">{failure}</span>}
    </div>
  );
}

function Stage({ svg, useMaxWidth }) {
  const stageRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef(null);

  const clamp = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  const onWheel = useCallback((event) => {
    if (document.fullscreenElement) return; // fullscreen is a fixed fit-to-screen view
    if (!event.ctrlKey && !event.metaKey) return; // let the page scroll
    event.preventDefault();
    setZoom((z) => clamp(z - event.deltaY * 0.002));
  }, []);

  // Drag by tracking deltas from the pointerdown origin.
  const handleMove = (event) => {
    if (!drag.current) return;
    setPan({
      x: drag.current.px + (event.clientX - drag.current.x),
      y: drag.current.py + (event.clientY - drag.current.y),
    });
  };

  const handleDown = (event) => {
    // In fullscreen the diagram is a fixed, centred fit-to-screen view. Panning
    // there would silently move the diagram once you exit, so it's disabled.
    if (document.fullscreenElement) return;
    drag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleUp = () => {
    drag.current = null;
  };

  return (
    <>
      {/* The .stage is a fixed clipping frame in normal flow: it establishes the
          height (from the untransformed .pan inside it) and clips overflow, so
          panning never grows the auto-sizing iframe. The transform lives on the
          inner .pan, which moves within the frame. */}
      <div
        ref={stageRef}
        className={`stage${useMaxWidth ? '' : ' no-shrink'}${drag.current ? ' dragging' : ''}`}
        onWheel={onWheel}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      >
        <div
          className="pan"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {/* Lives inside .stage so it's part of the fullscreen element (the
            toolbar is a sibling and hidden in fullscreen). CSS shows it only
            when fullscreen. */}
        <button
          type="button"
          className="fs-exit"
          onClick={() => document.exitFullscreen?.()}
          aria-label="Exit fullscreen"
        >
          Exit fullscreen
        </button>
      </div>
      <ToolbarPortal
        stageRef={stageRef}
        zoom={zoom}
        onZoom={(delta) => setZoom((z) => clamp(z + delta))}
        onReset={() => {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }}
      />
    </>
  );
}

// Toolbar needs the stage ref and the diagram source; keep the wiring in one place.
const ToolbarContext = React.createContext('');
function ToolbarPortal(props) {
  const source = React.useContext(ToolbarContext);
  return <Toolbar {...props} source={source} />;
}

function App() {
  const [state, setState] = useState({ status: 'loading' });
  const [config, setConfig] = useState(null);
  const [visible, setVisible] = useState(false);
  const deferRef = useRef(null);

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
  const decide = useCallback(() => {
    if (!config) return;

    const source = (config.source ?? '').trim();
    if (!source) {
      setState({ status: 'empty' });
      return;
    }

    const theme = resolveTheme(config.theme);

    // Cache hit: the editor already rendered this diagram to SVG for this theme
    // and stored it in config. Paint it and never load Mermaid — the whole win.
    // Re-sanitize: this SVG comes from macro config, which anyone who can edit
    // the page can author, so it gets the same DOMPurify pass a fresh render does.
    const cached = pickCachedSvg(config, theme);
    if (cached) {
      setState({ status: 'ready', svg: sanitizeSvg(cached) });
      return;
    }

    setState({ status: 'deferred' });
  }, [config]);

  useEffect(() => {
    decide();
  }, [decide]);

  useEffect(() => onThemeChange(decide), [decide]);

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
        if (!cancelled) setState({ status: 'ready', svg });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', ...describeError(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.status, visible, config]);

  // Let the SVG land, measure, then ask the host for the right height.
  useEffect(() => {
    if (state.status === 'ready') requestAnimationFrame(resize);
  }, [state.status, state.svg]);

  if (state.status === 'loading') {
    return <div className="message empty">Loading diagram…</div>;
  }

  if (state.status === 'empty') {
    return (
      <div className="message empty">
        No diagram yet. Select the macro and choose <strong>Edit diagram</strong> to write
        some Mermaid.
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

  return (
    <ToolbarContext.Provider value={config.source ?? ''}>
      <div className="root">
        <Stage svg={state.svg} useMaxWidth={config.useMaxWidth !== false} />
        <div className="meta">Mermaid {resolvedVersion(config.mermaidVersion)}</div>
      </div>
    </ToolbarContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<App />);

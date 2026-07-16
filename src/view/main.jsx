import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { renderDiagram, describeError, sanitizeSvg } from '../lib/render.js';
import { resolvedVersion } from '../lib/mermaid-registry.js';
import { enableTheme, getConfig, onThemeChange, resolveTheme, resize } from '../lib/host.js';
import { pickCachedSvg } from '../lib/cache.js';
import { normalizeHeight } from '../lib/sizing.js';
import { anchoredZoom, fitView, untransformedRect } from '../lib/zoom.js';

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
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef(null);

  // Close the export menu on an outside click or Escape, the two things a user
  // expects to dismiss a popup.
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e) => {
      if (!exportRef.current?.contains(e.target)) setExportOpen(false);
    };
    const onKey = (e) => {
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
      <div className="export" ref={exportRef}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={exportOpen}
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

function Stage({ svg, useMaxWidth, height }) {
  const stageRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Coords live in a ref (a pointermove shouldn't re-render for them), but the
  // grabbing cursor needs real state: mutating a ref repaints nothing, which is
  // why the cursor used to stay grabbing after a release.
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);

  // The wheel/fullscreen listeners below are bound once, so they'd close over
  // the initial state. These refs hand them the current values.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;

  // Zoom to `nextZoom` while keeping the point at client coords (anchorX,
  // anchorY) fixed, by shifting the pan. Shared by the wheel (anchor = cursor)
  // and the toolbar +/- buttons (anchor = stage centre). .pan transforms from
  // its top-left, so its live on-screen rect is the reference; that rect already
  // includes the margin-auto centring, so the offset cancels out.
  const zoomTo = (nextZoom, anchorX, anchorY) => {
    const panRect = stageRef.current?.querySelector('.pan')?.getBoundingClientRect();
    if (!panRect) return;
    const next = anchoredZoom({
      oldZoom: zoomRef.current,
      nextZoom,
      pan: panRef.current,
      anchorX,
      anchorY,
      panLeft: panRect.left,
      panTop: panRect.top,
    });
    if (!next) return; // at a clamp bound; nothing to do
    setZoom(next.zoom);
    setPan(next.pan);
  };

  // Scale the diagram to fill the screen and centre it. Mirrors zoomTo: measure
  // live rects, hand the math to the pure helper, apply the result.
  const fitToStage = () => {
    const stage = stageRef.current;
    const panEl = stage?.querySelector('.pan');
    if (!panEl) return false;

    // .pan's rect carries whatever transform is applied right now, so invert it to
    // recover the untransformed rect fitView needs. The caller resets to identity
    // first, but a React state change may not have painted by the time we measure,
    // so read the transform from the refs rather than assuming it's gone.
    const content = untransformedRect({
      rect: panEl.getBoundingClientRect(),
      zoom: zoomRef.current,
      pan: panRef.current,
    });

    // The viewport is the stage's content box: its rect inset by the padding the
    // :fullscreen rule adds (read, not hardcoded, so the CSS stays the one owner).
    const stageRect = stage.getBoundingClientRect();
    const style = getComputedStyle(stage);
    const inset = (side) => parseFloat(style.getPropertyValue(`padding-${side}`)) || 0;
    const view = {
      left: stageRect.left + inset('left'),
      top: stageRect.top + inset('top'),
      width: stageRect.width - inset('left') - inset('right'),
      height: stageRect.height - inset('top') - inset('bottom'),
    };

    const next = fitView({ content, view });
    if (!next) return false;
    setZoom(next.zoom);
    setPan(next.pan);
    return true;
  };

  // Re-fit on every stage resize while fullscreen. Whether fullscreenchange fires
  // before or after the element has been resized to the screen varies (and an
  // iframe adds a hop: the parent resizes us, then our document relayouts), so
  // rather than guess when the size is final, treat "the size changed" as the
  // trigger. A measurement taken too early is then self-correcting — the next
  // resize refits — instead of permanently mis-centring the diagram.
  //
  // Refitting can't loop: in fullscreen the stage is pinned to the viewport, and
  // .pan's transform doesn't feed back into layout. Inline, the guard skips out,
  // so a page-column resize never disturbs a view the user set themselves.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      if (document.fullscreenElement !== stage) return;
      fitToStage();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Fullscreen reuses the inline pan/zoom, so we snapshot the view on enter and
  // open on the whole diagram, fitted to the screen and centred, for a
  // predictable start; on exit we restore the snapshot, so navigating in
  // fullscreen never disturbs the inline diagram. Exiting also re-reveals the
  // macro: exiting fullscreen from inside a Forge iframe drops the parent
  // Confluence page's scroll to the top of our macro (a cross-origin quirk we
  // can't read the scroll position around), and scrollIntoView scrolls the parent
  // frame back to it, which needs no scope.
  const preFullscreen = useRef(null);
  useEffect(() => {
    const onFsChange = () => {
      if (document.fullscreenElement) {
        preFullscreen.current = { zoom: zoomRef.current, pan: panRef.current };
        // Reset first: if the fit below and the observer both somehow miss, this
        // is exactly the whole-diagram view that shipped before — never nonsense.
        setZoom(1);
        setPan({ x: 0, y: 0 });
        // Fit now in case entering fullscreen doesn't change the stage's size and
        // so never fires the observer. If the size isn't final yet this fit is
        // wrong, and the observer corrects it when the resize lands.
        fitToStage();
      } else {
        if (preFullscreen.current) {
          setZoom(preFullscreen.current.zoom);
          setPan(preFullscreen.current.pan);
          preFullscreen.current = null;
        }
        stageRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Ctrl/⌘ + wheel zooms the diagram. This MUST be a native, non-passive
  // listener: React registers its onWheel prop as passive, so preventDefault()
  // there is ignored and the browser still runs its own ctrl+wheel gesture —
  // which zooms the whole Confluence page. Binding wheel ourselves with
  // { passive: false } lets preventDefault actually cancel that page zoom, so
  // only the diagram scales.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (event) => {
      // Inline: require Ctrl/⌘ so a plain scroll still moves the page. Fullscreen:
      // nothing is behind the diagram, so a plain wheel zooms like an image viewer.
      if (!document.fullscreenElement && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      // Zoom toward the cursor.
      zoomTo(zoomRef.current - event.deltaY * 0.002, event.clientX, event.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Drag by tracking deltas from the pointerdown origin.
  const handleMove = (event) => {
    if (!drag.current) return;
    // Nothing held? The release happened somewhere we never heard about — the
    // parent Confluence page, which is cross-origin, so our document sees no
    // pointerup and pointer capture can't reach across the iframe boundary. The
    // drag would otherwise resume the moment the cursor came back. A stuck drag
    // is only observable through a later move, so this check is the backstop
    // that catches every path.
    if (event.buttons === 0) {
      handleUp();
      return;
    }
    setPan({
      x: drag.current.px + (event.clientX - drag.current.x),
      y: drag.current.py + (event.clientY - drag.current.y),
    });
  };

  const handleDown = (event) => {
    // Don't start a pan when the press lands on the fullscreen exit button:
    // capturing the pointer to the stage steals its pointerup, so the button's
    // click never fires (the cause of the exit working only intermittently).
    if (event.target.closest('.fs-exit')) return;
    drag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  // Called from several paths (pointerup, pointercancel, lostpointercapture, and
  // the buttons check above), so it has to be idempotent.
  const handleUp = () => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <>
      {/* The .stage is a fixed clipping frame in normal flow: it establishes the
          height (from the untransformed .pan inside it) and clips overflow, so
          panning never grows the auto-sizing iframe. The transform lives on the
          inner .pan, which moves within the frame. */}
      <div
        ref={stageRef}
        className={`stage${useMaxWidth ? '' : ' no-shrink'}${height ? ' sized' : ''}${dragging ? ' dragging' : ''}`}
        // The editor's chosen height is applied as a CSS variable the .sized
        // rules read; the SVG scales to it, keeping its aspect ratio, and the
        // existing pan/zoom reaches anything wider than the column.
        style={height ? { '--diagram-height': `${height}px` } : undefined}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        // Fires when capture breaks — including the release-outside-the-iframe
        // case, which delivers neither pointerup nor pointercancel. Ends the drag
        // even if the cursor never comes back to trigger the check in handleMove.
        onLostPointerCapture={handleUp}
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
        onZoom={(delta) => {
          // Zoom toward the middle of the visible diagram.
          const rect = stageRef.current?.getBoundingClientRect();
          if (!rect) return;
          zoomTo(zoomRef.current + delta, rect.left + rect.width / 2, rect.top + rect.height / 2);
        }}
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
        <Stage
          svg={state.svg}
          useMaxWidth={config.useMaxWidth !== false}
          height={normalizeHeight(config.height)}
        />
        <div className="meta">Mermaid {resolvedVersion(config.mermaidVersion)}</div>
      </div>
    </ToolbarContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<App />);

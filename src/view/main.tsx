import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { renderDiagram, describeError, sanitizeSvg } from '../lib/render.js';
import { resolvedVersion } from '../lib/mermaid-registry.js';
import { enableTheme, getConfig, onThemeChange, resolveTheme, resize } from '../lib/host.js';
import { pickCachedSvg, pickCachedVersion } from '../lib/cache.js';
import { normalizeHeight } from '../lib/sizing.js';
import { anchoredZoom, fitView, untransformedRect } from '../lib/zoom.js';
import { download, exportPng } from '../lib/png-export.js';

type StageRef = { current: HTMLDivElement | null };

type ToolbarProps = {
  stageRef: StageRef;
  source: string;
  onZoom: (delta: number) => void;
  onReset: () => void;
  onFullscreen: () => void;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  zoom: number;
};

function Toolbar({
  stageRef,
  source,
  onZoom,
  onReset,
  onFullscreen,
  onKeyDown,
  zoom,
}: ToolbarProps) {
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
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
      setFailure(err instanceof Error ? err.message : String(err));
    }
  };

  // A failure sits over the diagram, so it clears itself. Keyed on the message,
  // so a different failure arriving mid-display gets its own full six seconds.
  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => setFailure(null), 6000);
    return () => clearTimeout(timer);
  }, [failure]);

  return (
    // The diagram's shortcuts are handled here too: the toolbar is a *sibling* of
    // the stage, so a keydown on one of these buttons never bubbles through it,
    // and Tabbing to the toolbar would otherwise silently lose every key.
    <div className="toolbar" role="toolbar" aria-label="Diagram actions" onKeyDown={onKeyDown}>
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
      <button type="button" onClick={onFullscreen}>
        Fullscreen
      </button>
      {/* Visible, not sr-only: a blocked clipboard or a failed PNG export is
          something the sighted user has to see too — they just watched a button
          do nothing. role="status" keeps the polite announcement sr-only gave. */}
      {failure && (
        <span className="status" role="status">
          {failure}
        </span>
      )}
    </div>
  );
}

// How far one arrow press moves the view, in client px (Shift for the coarse
// step). Fixed rather than proportional to the zoom: the diagram scales under
// the transform, but the stage the user is looking through does not, so a
// constant on-screen distance is what stays predictable at every zoom level.
const PAN_STEP = 32;
const PAN_STEP_LARGE = 128;

function Stage({
  svg,
  useMaxWidth,
  height,
}: {
  svg: string;
  useMaxWidth: boolean;
  height: number | null;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Coords live in a ref (a pointermove shouldn't re-render for them), but the
  // grabbing cursor needs real state: mutating a ref repaints nothing, which is
  // why the cursor used to stay grabbing after a release.
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
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
  const zoomTo = (nextZoom: number, anchorX: number, anchorY: number) => {
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
    if (!stage) return false;
    const panEl = stage.querySelector('.pan');
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
    const inset = (side: string) => parseFloat(style.getPropertyValue(`padding-${side}`)) || 0;
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
  const preFullscreen = useRef<{ zoom: number; pan: { x: number; y: number } } | null>(null);
  // Whether the exit we're about to see is one we asked for. The browser exits on
  // Escape without necessarily handing us the keydown, so the key can't be the
  // signal — but every exit of *ours* passes through toggleFullscreen or the
  // .fs-exit button, so anything else is Escape (or the browser's own control).
  const selfExit = useRef(false);
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
        // Entering from the toolbar button leaves focus on a button that is now
        // outside the fullscreen element, so the keys wouldn't reach the stage.
        // Fullscreen is also where they matter most: the toolbar is hidden there,
        // making the keyboard the only way to zoom or reset.
        stageRef.current?.focus();
      } else {
        if (preFullscreen.current) {
          setZoom(preFullscreen.current.zoom);
          setPan(preFullscreen.current.pan);
          preFullscreen.current = null;
        }
        stageRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
        // An exit we didn't ask for is Escape, and Escape means "let me out" —
        // all the way out. Entering fullscreen took focus, so without this the
        // stage lands back inline still holding the keyboard and the user has to
        // press Escape a second time to be released. Our own exits (F, the
        // toolbar, the Exit button) keep focus, so F stays a real toggle.
        //
        // Only ever release focus we took: fullscreenchange is a document event,
        // so it reaches every macro on the page, and blurring whatever happens to
        // be focused would let one diagram steal the keyboard back from another.
        const focused = document.activeElement;
        if (!selfExit.current && stageRef.current?.contains(focused)) {
          (focused as HTMLElement).blur();
        }
        selfExit.current = false;
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
    const onWheel = (event: WheelEvent) => {
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
  const handleMove = (event: React.PointerEvent<HTMLDivElement>) => {
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

  const handleDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Don't start a pan when the press lands on the fullscreen exit button:
    // capturing the pointer to the stage steals its pointerup, so the button's
    // click never fires (the cause of the exit working only intermittently).
    if ((event.target as Element).closest('.fs-exit')) return;
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

  // The three actions below are shared by the toolbar buttons and the keyboard
  // handler, so both triggers stay one behaviour rather than two that drift.

  // Zoom a step toward the middle of the visible diagram.
  const zoomByStep = (delta: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomTo(zoomRef.current + delta, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const resetView = () => {
    // In fullscreen the toolbar is hidden, so the 0 key is the only reset there —
    // and an identity reset would strand the diagram at 100% in the top-left
    // rather than the fitted, centred view fullscreen opens with. Inline, and
    // whenever the fit can't measure, this is the plain reset that always shipped.
    if (document.fullscreenElement === stageRef.current && fitToStage()) return;
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const toggleFullscreen = () => {
    const target = stageRef.current;
    if (document.fullscreenElement) {
      selfExit.current = true; // ours, so keep focus (see the fullscreenchange handler)
      document.exitFullscreen();
    } else target?.requestFullscreen?.();
  };

  // Keyboard equivalents for the pointer gestures: without these the diagram is
  // operable only with a mouse (WCAG 2.1 SC 2.1.1). No new geometry — every key
  // routes into the same helpers the pointer and toolbar paths use.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Leave chords to the browser and the OS: ⌘/Ctrl+arrow and friends are
    // navigation shortcuts we have no business swallowing.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // A text control owns its own arrows, +/-, and 0. Nothing inside the stage is
    // one today, but the guard is what keeps that true if something is added.
    if ((event.target as Element).closest('input, textarea, select, [contenteditable]')) return;

    // Escape hands the keyboard back. Until it does, this handler swallows the
    // arrows, so without a release the user has no way to stop us capturing them.
    if (event.key === 'Escape') {
      // Fullscreen: the browser's own Escape exits it, and it may not even
      // deliver us this keydown, so we don't fight it. The release still happens
      // — the fullscreenchange handler blurs on any exit it didn't ask for, which
      // is what makes a single Escape both leave fullscreen and hand back the
      // keyboard.
      if (document.fullscreenElement) return;
      // One Escape, one effect: if the export menu is open, Toolbar's own Escape
      // listener is closing it right now, so don't also drop focus out of the
      // button the user is standing on.
      if (stageRef.current?.parentElement?.querySelector('.export-menu')) return;
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }

    // Arrows move the *view*, the way a map or an image viewer does, so
    // ArrowRight reveals what's off the right edge — the pan translation
    // therefore moves the opposite way (dragging right, by contrast, carries the
    // content itself right). Unclamped, matching drag-pan.
    const step = event.shiftKey ? PAN_STEP_LARGE : PAN_STEP;
    switch (event.key) {
      case 'ArrowLeft':
        setPan((p) => ({ ...p, x: p.x + step }));
        break;
      case 'ArrowRight':
        setPan((p) => ({ ...p, x: p.x - step }));
        break;
      case 'ArrowUp':
        setPan((p) => ({ ...p, y: p.y + step }));
        break;
      case 'ArrowDown':
        setPan((p) => ({ ...p, y: p.y - step }));
        break;
      // '=' is the unshifted key '+' lives on, so both reach zoom in.
      case '+':
      case '=':
        zoomByStep(0.2);
        break;
      case '-':
      case '_':
        zoomByStep(-0.2);
        break;
      case '0':
        resetView();
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      // Everything else — Tab, Escape, screen-reader navigation — falls through
      // untouched, and without a preventDefault.
      default:
        return;
    }
    // Only for the keys handled above: arrows would otherwise scroll the page
    // out from under the diagram the user is panning.
    event.preventDefault();
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
        style={height ? ({ '--diagram-height': `${height}px` } as React.CSSProperties) : undefined}
        // Focusable so the diagram itself can be operated from the keyboard, with
        // the keys named in the label — there's no visible affordance to read
        // them off. role="group" rather than "application": application would
        // hand this whole subtree's keystrokes to us and take the SVG away from
        // a screen reader's browse mode, which we'd gain nothing by doing.
        // (The diagram's *text alternative* is a separate concern — see #92.)
        tabIndex={0}
        role="group"
        aria-roledescription="interactive diagram"
        aria-label="Diagram. Arrow keys pan, plus and minus zoom, 0 resets the view, F toggles fullscreen, Escape releases the diagram."
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight + - 0 F Escape"
        onKeyDown={handleKeyDown}
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
        {/* The shortcuts have no visible affordance otherwise — nothing on screen
            says the diagram takes keys at all. CSS shows this only while the
            macro holds keyboard focus. Inside .stage so it survives into
            fullscreen, where the toolbar is hidden and the keys are the only
            controls left. aria-hidden: the stage's aria-label already reads the
            same list to a screen reader, and twice is noise.

            Two variants, swapped by CSS, because F reads as the way *out* once
            you're in fullscreen. Escape is in neither: pressing it to get out of
            something is what a user already expects, so spending a third of the
            chip teaching it buys nothing. It stays in the aria-label. */}
        <div className="keys" aria-hidden="true">
          <span className="keys-inline">↑↓←→ pan · +/− zoom · 0 reset · F full screen</span>
          <span className="keys-fs">↑↓←→ pan · +/− zoom · 0 reset · F exit full screen</span>
        </div>
        {/* Lives inside .stage so it's part of the fullscreen element (the
            toolbar is a sibling and hidden in fullscreen). CSS shows it only
            when fullscreen. */}
        <button
          type="button"
          className="fs-exit"
          onClick={() => {
            selfExit.current = true;
            document.exitFullscreen?.();
          }}
          aria-label="Exit fullscreen"
        >
          Exit fullscreen
        </button>
      </div>
      <ToolbarPortal
        stageRef={stageRef}
        zoom={zoom}
        onZoom={zoomByStep}
        onReset={resetView}
        onFullscreen={toggleFullscreen}
        onKeyDown={handleKeyDown}
      />
    </>
  );
}

// Toolbar needs the stage ref and the diagram source; keep the wiring in one place.
const ToolbarContext = React.createContext('');
function ToolbarPortal(props: Omit<ToolbarProps, 'source'>) {
  const source = React.useContext(ToolbarContext);
  return <Toolbar {...props} source={source} />;
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
      setState({
        status: 'ready',
        svg: sanitizeSvg(cached),
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
    <ToolbarContext.Provider value={config.source ?? ''}>
      <div className="root">
        <Stage
          svg={state.svg}
          useMaxWidth={config.useMaxWidth !== false}
          height={normalizeHeight(config.height)}
        />
        <div className="meta">Mermaid {state.version}</div>
      </div>
    </ToolbarContext.Provider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);

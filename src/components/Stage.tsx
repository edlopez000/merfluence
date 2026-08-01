import React, { useEffect, useRef, useState } from 'react';

import { anchoredZoom, fitView, untransformedRect } from '../lib/zoom.js';

/**
 * The interactive diagram surface, shared by the reader view and the config
 * editor's live preview. Wheel zoom, drag-pan, keyboard pan/zoom, fit, and
 * maximize all live here; the geometry is delegated to the pure helpers in
 * src/lib/zoom.js, which carry their own unit tests.
 *
 * Both bundles render the same component so the editor preview behaves — and
 * measures — exactly like what a reader ends up looking at. What differs is the
 * toolbar: the zoom/fit/maximize controls are Stage's own, while view-only
 * actions (copy source, export) are injected by the reader through
 * `toolbarExtras`. That split is deliberate rather than a boolean flag, so the
 * clipboard and PNG-export code never enters the config bundle.
 */

/** What `toolbarExtras` is handed so an injected action can reach the diagram. */
export type StageActions = {
  /** The rendered SVG element, or null before it lands. */
  getSvg: () => SVGSVGElement | null;
  /** Show a message in the toolbar's shared failure slot. */
  setFailure: (message: string) => void;
};

type ToolbarExtras = (actions: StageActions) => React.ReactNode;

type StageToolbarProps = {
  zoom: number;
  onZoom: (delta: number) => void;
  onReset: () => void;
  onFullscreen: () => void;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  getSvg: () => SVGSVGElement | null;
  extras?: ToolbarExtras;
};

function StageToolbar({
  zoom,
  onZoom,
  onReset,
  onFullscreen,
  onKeyDown,
  getSvg,
  extras,
}: StageToolbarProps) {
  const [failure, setFailure] = useState<string | null>(null);

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
      {extras?.({ getSvg, setFailure })}
      <button type="button" onClick={() => onZoom(-0.2)} aria-label="Zoom out">
        &minus;
      </button>
      <button
        type="button"
        className="zoom-level"
        onClick={onReset}
        title="Reset view"
        // The visible label is the zoom level, so the accessible name has to
        // contain it (WCAG 2.1 SC 2.5.3 Label in Name) — speech control aside,
        // a name of "Reset view" alone is also the only place the current zoom
        // is stated, so without this a screen-reader user never hears that
        // pressing + did anything.
        aria-label={`Reset view, currently ${Math.round(zoom * 100)}%`}
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

export function Stage({
  svg,
  useMaxWidth,
  height,
  toolbarExtras,
}: {
  svg: string;
  useMaxWidth: boolean;
  height: number | null;
  toolbarExtras?: ToolbarExtras;
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

  // The CSS-pinned fallback for when the browser won't give us real fullscreen
  // (see enterFallback). State drives the class; the ref is what the once-bound
  // listeners and the maximized() predicate read.
  const [fallback, setFallback] = useState(false);
  const fallbackRef = useRef(false);

  // "The diagram is filling the screen", by either route. Every branch that used
  // to test document.fullscreenElement goes through this instead. Reads only
  // refs, so the listeners bound once below can call it safely.
  const maximized = () => document.fullscreenElement === stageRef.current || fallbackRef.current;

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
    // maximized rule adds (read, not hardcoded, so the CSS stays the one owner).
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

  // Re-fit on every stage resize while maximized. Whether fullscreenchange fires
  // before or after the element has been resized to the screen varies (and an
  // iframe adds a hop: the parent resizes us, then our document relayouts), so
  // rather than guess when the size is final, treat "the size changed" as the
  // trigger. A measurement taken too early is then self-correcting — the next
  // resize refits — instead of permanently mis-centring the diagram. The CSS
  // fallback leans on this harder still: its class only lands on the next paint,
  // so the fit inside enterMaximized always measures the pre-pin box.
  //
  // Refitting can't loop: maximized, the stage is pinned to the viewport, and
  // .pan's transform doesn't feed back into layout. Inline, the guard skips out,
  // so a page-column resize never disturbs a view the user set themselves.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      if (!maximized()) return;
      fitToStage();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Maximizing reuses the inline pan/zoom, so we snapshot the view on enter and
  // open on the whole diagram, fitted to the screen and centred, for a
  // predictable start; on exit we restore the snapshot, so navigating there never
  // disturbs the inline diagram. Exiting also re-reveals the macro: exiting
  // fullscreen from inside a Forge iframe drops the parent Confluence page's
  // scroll to the top of our macro (a cross-origin quirk we can't read the scroll
  // position around), and scrollIntoView scrolls the parent frame back to it,
  // which needs no scope.
  const preMaximize = useRef<{ zoom: number; pan: { x: number; y: number } } | null>(null);
  // Whether the exit we're about to see is one we asked for. The browser exits on
  // Escape without necessarily handing us the keydown, so the key can't be the
  // signal — but every exit of *ours* passes through toggleFullscreen or the
  // .fs-exit button, so anything else is Escape (or the browser's own control).
  const selfExit = useRef(false);

  // The enter/exit sequences, factored out so the native fullscreenchange path
  // and the CSS fallback below run byte-identical behaviour. Both touch only
  // refs and setState, so the once-bound listener closing over the first
  // instance is safe.
  const enterMaximized = () => {
    preMaximize.current = { zoom: zoomRef.current, pan: panRef.current };
    // Reset first: if the fit below and the observer both somehow miss, this
    // is exactly the whole-diagram view that shipped before — never nonsense.
    setZoom(1);
    setPan({ x: 0, y: 0 });
    // Fit now in case entering doesn't change the stage's size and so never
    // fires the observer. If the size isn't final yet this fit is wrong, and the
    // observer corrects it when the resize lands.
    fitToStage();
    // Entering from the toolbar button leaves focus on a button that is now
    // outside the fullscreen element, so the keys wouldn't reach the stage.
    // Maximized is also where they matter most: the toolbar is hidden there,
    // making the keyboard the only way to zoom or reset.
    stageRef.current?.focus();
  };

  const exitMaximized = () => {
    if (preMaximize.current) {
      setZoom(preMaximize.current.zoom);
      setPan(preMaximize.current.pan);
      preMaximize.current = null;
    }
    stageRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
    // An exit we didn't ask for is Escape, and Escape means "let me out" —
    // all the way out. Entering took focus, so without this the stage lands
    // back inline still holding the keyboard and the user has to press Escape
    // a second time to be released. Our own exits (F, the toolbar, the Exit
    // button) keep focus, so F stays a real toggle.
    //
    // Only ever release focus we took: fullscreenchange is a document event,
    // so it reaches every macro on the page, and blurring whatever happens to
    // be focused would let one diagram steal the keyboard back from another.
    const focused = document.activeElement;
    if (!selfExit.current && stageRef.current?.contains(focused)) {
      (focused as HTMLElement).blur();
    }
    selfExit.current = false;
  };

  useEffect(() => {
    const onFsChange = () => {
      if (document.fullscreenElement) enterMaximized();
      else exitMaximized();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
    // Bound once, deliberately. enterMaximized/exitMaximized touch only refs and
    // setState — never a value that goes stale — so closing over the first
    // instance is correct, and listing them would rebind a document listener on
    // every pan frame for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The fallback for a host that won't grant real fullscreen: pin the stage over
  // the viewport with CSS instead. This exists for the Forge macro-config modal,
  // whose iframe may not carry allow="fullscreen" — requestFullscreen then
  // rejects, and without this the editor's maximize button would simply do
  // nothing. Note the pin is to the *iframe's* viewport, not the browser
  // window's; in the config modal that iframe fills the modal, so it reads as a
  // real maximize. The reader's macro iframe is only as tall as the macro, but
  // the reader never lands here — native fullscreen is granted there.
  const enterFallback = () => {
    fallbackRef.current = true;
    setFallback(true);
    enterMaximized();
  };

  const exitFallback = () => {
    fallbackRef.current = false;
    setFallback(false);
    exitMaximized();
  };

  const toggleFullscreen = () => {
    const target = stageRef.current;
    if (document.fullscreenElement) {
      selfExit.current = true; // ours, so keep focus (see the fullscreenchange handler)
      document.exitFullscreen();
      return;
    }
    if (fallbackRef.current) {
      selfExit.current = true;
      exitFallback();
      return;
    }
    if (!target) return;
    // No API at all, or the host refuses: fall back. The rejected promise is the
    // reliable signal — document.fullscreenEnabled is not, since a nested iframe
    // can be blocked in ways the flag on our own document doesn't report.
    if (typeof target.requestFullscreen !== 'function') {
      enterFallback();
      return;
    }
    Promise.resolve(target.requestFullscreen()).catch(enterFallback);
  };

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
      // Inline: require Ctrl/⌘ so a plain scroll still moves the page. Maximized:
      // nothing is behind the diagram, so a plain wheel zooms like an image viewer.
      if (!maximized() && !event.ctrlKey && !event.metaKey) return;
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
    // Maximized the toolbar is hidden, so the 0 key is the only reset there —
    // and an identity reset would strand the diagram at 100% in the top-left
    // rather than the fitted, centred view maximizing opens with. Inline, and
    // whenever the fit can't measure, this is the plain reset that always shipped.
    if (maximized() && fitToStage()) return;
    setZoom(1);
    setPan({ x: 0, y: 0 });
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
      // Native fullscreen: the browser's own Escape exits it, and it may not even
      // deliver us this keydown, so we don't fight it. The release still happens
      // — the fullscreenchange handler blurs on any exit it didn't ask for, which
      // is what makes a single Escape both leave fullscreen and hand back the
      // keyboard.
      if (document.fullscreenElement) return;
      // The CSS fallback has no browser-provided exit, so Escape has to be it.
      // selfExit stays false, so exitMaximized also releases the keyboard —
      // matching what Escape does to a natively-fullscreen stage.
      if (fallbackRef.current) {
        exitFallback();
        event.preventDefault();
        return;
      }
      // One Escape, one effect: if the export menu is open, the injected action's
      // own Escape listener is closing it right now, so don't also drop focus out
      // of the button the user is standing on.
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
        className={`stage${useMaxWidth ? '' : ' no-shrink'}${height ? ' sized' : ''}${dragging ? ' dragging' : ''}${fallback ? ' maximized' : ''}`}
        // The editor's chosen height is applied as a CSS variable the .sized
        // rules read; the SVG scales to it, keeping its aspect ratio, and the
        // existing pan/zoom reaches anything wider than the column.
        style={height ? ({ '--diagram-height': `${height}px` } as React.CSSProperties) : undefined}
        // Focusable so the diagram itself can be operated from the keyboard, with
        // the keys named in the label — there's no visible affordance to read
        // them off. role="group" rather than "application": application would
        // hand this whole subtree's keystrokes to us and take the SVG away from
        // a screen reader's browse mode, which we'd gain nothing by doing — and
        // would now cost us something, since the SVG inside carries its own role
        // and accessible name (see a11y-name.js) and needs to stay reachable.
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
            when maximized. */}
        <button
          type="button"
          className="fs-exit"
          onClick={() => {
            selfExit.current = true;
            if (fallbackRef.current) exitFallback();
            else document.exitFullscreen?.();
          }}
          aria-label="Exit fullscreen"
        >
          Exit fullscreen
        </button>
      </div>
      <StageToolbar
        zoom={zoom}
        onZoom={zoomByStep}
        onReset={resetView}
        onFullscreen={toggleFullscreen}
        onKeyDown={handleKeyDown}
        getSvg={() => stageRef.current?.querySelector('svg') ?? null}
        extras={toolbarExtras}
      />
    </>
  );
}

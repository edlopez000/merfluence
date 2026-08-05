/**
 * Interactive zoom math for the diagram stage, in both the reader view and the
 * editor's live preview.
 *
 * Zooming keeps a chosen anchor point fixed on screen — the cursor for wheel
 * zoom, the stage centre for the +/- buttons — by shifting the pan translation.
 * The .pan layer transforms from its top-left (transform-origin 0 0), so the
 * anchor is measured against that layer's current on-screen top-left.
 *
 * This is factored out of the component because the pan-shift formula is the one
 * piece here that fails silently when wrong (the diagram drifts under the cursor
 * instead of throwing), so it carries a unit test.
 */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

/**
 * The factor one zoom step multiplies by — a button press, a +/- key, or 100
 * units of wheel delta. Multiplicative rather than additive because the zoom
 * this scales is itself relative to a diagram that CSS may already have shrunk
 * (see maxZoomFor): an additive 0.2 is a 3x jump from a base of 0.1 and a 5%
 * nudge near the top, so the same keypress would mean something different at
 * every scale. 1.2 is chosen so one step from 100% still lands on exactly 120%,
 * which is what the additive step did.
 */
export const ZOOM_STEP = 1.2;

type Point = { x: number; y: number };
type Rect = { left: number; top: number; width: number; height: number };

export function clampZoom(z: number, maxZoom: number = MAX_ZOOM) {
  return Math.min(maxZoom, Math.max(MIN_ZOOM, z));
}

/**
 * The interactive zoom ceiling for a diagram the browser has already scaled by
 * `displayScale` — its laid-out width over its intrinsic (viewBox) width.
 *
 * MAX_ZOOM alone is a multiplier on whatever size the diagram is *displayed* at,
 * not on its real size, and Mermaid's useMaxWidth plus `max-width: 100%` shrink
 * a wide diagram to the column (or, maximized, to the screen) before the
 * transform ever applies. So a flat cap gives a big diagram *less* absolute
 * magnification the bigger it gets — a 8000px diagram in a 760px column tops out
 * around 0.38x its natural size, i.e. unreadable. Dividing the cap by the shrink
 * restores the intended meaning: 400% is 400% of the diagram's own pixels, and
 * every diagram can reach it.
 *
 * min(scale, 1) so a Size preset that scales a diagram *up* never lowers the
 * ceiling below MAX_ZOOM; a scale we can't measure falls back to it too.
 */
export function maxZoomFor(displayScale: number) {
  if (!Number.isFinite(displayScale) || displayScale <= 0) return MAX_ZOOM;
  return MAX_ZOOM / Math.min(displayScale, 1);
}

/**
 * Compute the { zoom, pan } that scales to `nextZoom` while holding the point at
 * client coords (anchorX, anchorY) visually fixed. `panLeft`/`panTop` are the
 * pan layer's current on-screen top-left. Returns null when the clamped zoom is
 * unchanged (already at a bound), meaning there's nothing to apply.
 *
 * `maxZoom` defaults to the flat MAX_ZOOM; callers that can measure the
 * diagram's shrink-to-fit pass the ceiling from maxZoomFor instead.
 *
 * Derivation: the content point under the anchor is c = (anchor - panLeft)/old.
 * To keep it under the anchor after zooming, the translation must move by
 * (anchor - panLeft) * (1 - new/old).
 */
export function anchoredZoom({
  oldZoom,
  nextZoom,
  pan,
  anchorX,
  anchorY,
  panLeft,
  panTop,
  maxZoom = MAX_ZOOM,
}: {
  oldZoom: number;
  nextZoom: number;
  pan: Point;
  anchorX: number;
  anchorY: number;
  panLeft: number;
  panTop: number;
  maxZoom?: number;
}) {
  const zoom = clampZoom(nextZoom, maxZoom);
  if (zoom === oldZoom) return null;
  const shift = 1 - zoom / oldZoom;
  return {
    zoom,
    pan: {
      x: pan.x + (anchorX - panLeft) * shift,
      y: pan.y + (anchorY - panTop) * shift,
    },
  };
}

/**
 * Recover a layer's untransformed client rect from the rect the browser reports
 * while `zoom`/`pan` are applied to it — the layout box the transform was built
 * on. Lets a caller measure without first resetting the transform to identity
 * and waiting a frame to re-measure.
 *
 * Derivation: with transform-origin 0 0, `translate(pan) scale(z)` maps a local
 * point p to layout + pan + z*p. At p = 0 that gives the reported left/top, so
 * layout = reported - pan; the size is simply scaled, so it divides out.
 */
export function untransformedRect({ rect, zoom, pan }: { rect: Rect; zoom: number; pan: Point }) {
  return {
    left: rect.left - pan.x,
    top: rect.top - pan.y,
    width: rect.width / zoom,
    height: rect.height / zoom,
  };
}

/**
 * Compute the { zoom, pan } that scales `content` to fit inside `view` and
 * centres it there. Both are client-coord rects ({ left, top, width, height }),
 * and `content` MUST be the layer's *untransformed* rect (see untransformedRect)
 * — pan is applied as an unscaled translate, so its values are client px and map
 * 1:1 onto the offsets returned here. Returns null if either rect is degenerate
 * (a diagram that has not laid out yet), meaning the caller should fall back to
 * a plain reset.
 *
 * The `- content.left` term is why this takes rects rather than sizes: it
 * absorbs wherever the pan layer's own margin already placed it, so the caller
 * never has to know about the CSS centring.
 */
export function fitView({ content, view }: { content: Rect; view: Rect }) {
  const dims = [content.width, content.height, view.width, view.height];
  if (!dims.every((n) => Number.isFinite(n) && n > 0)) return null;
  // min so the binding axis fits; clamp so a tiny diagram stops at MAX_ZOOM
  // rather than filling the screen at absurd scale.
  //
  // Deliberately the *flat* MAX_ZOOM, not maxZoomFor's ceiling: this clamp only
  // ever binds on a diagram small enough to be magnified, and a small diagram is
  // never shrunk to fit, so its measured ceiling would be MAX_ZOOM anyway. The
  // raised ceiling is for what the user can push past this fit to, by hand.
  const zoom = clampZoom(Math.min(view.width / content.width, view.height / content.height));
  return {
    zoom,
    // Halve the leftover space on each axis. Uses the *clamped* zoom, so a
    // clamped diagram still lands centred rather than offset by the shortfall.
    pan: {
      x: view.left + (view.width - content.width * zoom) / 2 - content.left,
      y: view.top + (view.height - content.height * zoom) / 2 - content.top,
    },
  };
}

/**
 * fitView, but shrink-only — the fit for a diagram sitting inside a pane rather
 * than filling the screen. Same arguments, same null contract.
 *
 * Two differences from fitView, both because the caller is a fixed preview pane:
 * we never magnify (fitView scales a small diagram up to fill the screen, which
 * is right in fullscreen and wrong in a preview), and when nothing needs
 * shrinking we snap all the way back to identity rather than merely capping the
 * zoom at 1. Capping alone would keep fitView's centring offset, which would
 * move a diagram that was already where the CSS put it and leave a non-zero pan
 * at 100%; snapping is also what makes Large -> Natural land back at 1:1 instead
 * of stranding the diagram at the zoom the larger preset needed.
 */
export function shrinkToFit({ content, view }: { content: Rect; view: Rect }) {
  const fit = fitView({ content, view });
  if (!fit) return null;
  if (fit.zoom >= 1) return { zoom: 1, pan: { x: 0, y: 0 } };
  return fit;
}

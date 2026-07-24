/**
 * Interactive zoom math for the reader view.
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

type Point = { x: number; y: number };
type Rect = { left: number; top: number; width: number; height: number };

export function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * Compute the { zoom, pan } that scales to `nextZoom` while holding the point at
 * client coords (anchorX, anchorY) visually fixed. `panLeft`/`panTop` are the
 * pan layer's current on-screen top-left. Returns null when the clamped zoom is
 * unchanged (already at a bound), meaning there's nothing to apply.
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
}: {
  oldZoom: number;
  nextZoom: number;
  pan: Point;
  anchorX: number;
  anchorY: number;
  panLeft: number;
  panTop: number;
}) {
  const zoom = clampZoom(nextZoom);
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

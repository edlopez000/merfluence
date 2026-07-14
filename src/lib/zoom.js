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

export function clampZoom(z) {
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
export function anchoredZoom({ oldZoom, nextZoom, pan, anchorX, anchorY, panLeft, panTop }) {
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

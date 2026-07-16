/**
 * Diagram height override (pixels).
 *
 * A user picks a diagram's height from the editor's Size dropdown (SIZE_PRESETS
 * below); the chosen height is persisted to macro config as `height` and every
 * reader renders at that size. It is applied purely as a display-time CSS height
 * on the rendered SVG (which keeps its aspect ratio from the viewBox), so it
 * never alters the cached SVG markup — resizing does NOT invalidate the
 * light/dark cache in cache.js.
 *
 * Unset (or invalid) means "natural size": fall back to the fit-to-column rules.
 */
export const MIN_HEIGHT = 120;
export const MAX_HEIGHT = 2000;

/** Clamp a raw pixel height into the allowed range and round to a whole pixel. */
export function clampHeight(px) {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(px)));
}

/**
 * Coerce a stored config value into a usable height, or null when unset/invalid.
 * Macro config can be authored by anyone who can edit the page, so a garbage or
 * hostile `height` must degrade to natural sizing rather than break layout.
 */
export function normalizeHeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return clampHeight(n);
}

/**
 * The size choices the editor offers. `natural` (height null) clears the
 * override and lets the SVG render at its own size; the rest set an explicit
 * height, persisted to config as `height` exactly as a drag would have. The
 * reader is unaware of presets — it only ever reads the resulting `height`.
 */
export const SIZE_PRESETS = [
  { id: 'natural', label: 'Natural', height: null },
  { id: 'small', label: 'Small', height: 320 },
  { id: 'medium', label: 'Medium', height: 560 },
  { id: 'large', label: 'Large', height: 800 },
];

/** The height (px, or null) for a preset id; null for an unknown id. */
export function heightForPreset(id) {
  const preset = SIZE_PRESETS.find((p) => p.id === id);
  return preset ? preset.height : null;
}

/**
 * Which preset a stored height corresponds to, so the dropdown reflects the
 * saved value. An unset height is `natural`; any other value snaps to the
 * nearest preset, so a height saved by an earlier build (or hand-edited config)
 * still selects a sensible option instead of showing nothing.
 */
export function presetForHeight(value) {
  const h = normalizeHeight(value);
  if (h === null) return 'natural';
  let best = null;
  for (const preset of SIZE_PRESETS) {
    if (preset.height === null) continue;
    if (best === null || Math.abs(preset.height - h) < Math.abs(best.height - h)) {
      best = preset;
    }
  }
  return best.id;
}

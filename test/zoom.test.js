import { describe, expect, it } from 'vitest';
import { MIN_ZOOM, MAX_ZOOM, clampZoom, anchoredZoom } from '../src/lib/zoom.js';

describe('clampZoom', () => {
  it('clamps to the zoom bounds and passes an in-range value through', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
  });
});

describe('anchoredZoom', () => {
  const base = {
    oldZoom: 1,
    pan: { x: 0, y: 0 },
    anchorX: 100,
    anchorY: 50,
    panLeft: 0,
    panTop: 0,
  };

  it('returns null when the clamped zoom is unchanged', () => {
    expect(anchoredZoom({ ...base, nextZoom: 1 })).toBeNull();
    // Already at the max bound: nextZoom clamps back to it, so no change.
    expect(anchoredZoom({ ...base, oldZoom: MAX_ZOOM, nextZoom: 99 })).toBeNull();
  });

  it('leaves pan unchanged when the anchor sits on the pan origin', () => {
    const r = anchoredZoom({ ...base, anchorX: 0, anchorY: 0, nextZoom: 2 });
    expect(r.zoom).toBe(2);
    expect(r.pan).toEqual({ x: 0, y: 0 });
  });

  it('shifts pan to keep an off-origin anchor fixed', () => {
    // shift = 1 - 2/1 = -1, so pan moves by -(anchor - panLeft).
    const r = anchoredZoom({ ...base, pan: { x: 10, y: 20 }, nextZoom: 2 });
    expect(r.pan).toEqual({ x: 10 - 100, y: 20 - 50 });
  });

  it('holds the anchored content point under the cursor (invariant)', () => {
    // Independently recompute where the anchored point lands after zooming; it
    // must stay under the anchor. This catches a wrong pan-shift formula, unlike
    // an assertion that just mirrors the implementation.
    const params = {
      oldZoom: 1.5,
      pan: { x: 30, y: -10 },
      anchorX: 240,
      anchorY: 130,
      panLeft: 20,
      panTop: 15,
    };
    const r = anchoredZoom({ ...params, nextZoom: 3 });

    // Layout origin of the pan layer (screen top-left minus the current pan).
    const layoutX = params.panLeft - params.pan.x;
    const layoutY = params.panTop - params.pan.y;
    // Content coord under the anchor before the zoom.
    const cx = (params.anchorX - params.panLeft) / params.oldZoom;
    const cy = (params.anchorY - params.panTop) / params.oldZoom;
    // Where that content coord renders after the zoom.
    const screenX = layoutX + r.pan.x + cx * r.zoom;
    const screenY = layoutY + r.pan.y + cy * r.zoom;

    expect(screenX).toBeCloseTo(params.anchorX);
    expect(screenY).toBeCloseTo(params.anchorY);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MIN_ZOOM,
  MAX_ZOOM,
  clampZoom,
  anchoredZoom,
  fitView,
  untransformedRect,
} from '../src/lib/zoom.js';

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

describe('fitView', () => {
  // A 1000x600 screen inset by the stage's 24px padding.
  const view = { left: 24, top: 24, width: 952, height: 552 };

  // Where the fitted content's edges land on screen, recomputed independently of
  // the implementation: layout position + pan, and the scaled size.
  const placed = (content, r) => ({
    left: content.left + r.pan.x,
    top: content.top + r.pan.y,
    width: content.width * r.zoom,
    height: content.height * r.zoom,
  });
  const expectCentred = (content, r) => {
    const box = placed(content, r);
    expect(box.left - view.left).toBeCloseTo(view.left + view.width - (box.left + box.width));
    expect(box.top - view.top).toBeCloseTo(view.top + view.height - (box.top + box.height));
  };

  it('scales a small diagram up and centres it on both axes', () => {
    const content = { left: 400, top: 24, width: 200, height: 150 };
    const r = fitView({ content, view });
    // height binds: 552/150 = 3.68 < 952/200 = 4.76
    expect(r.zoom).toBeCloseTo(552 / 150);
    expectCentred(content, r);
  });

  it('scales an oversized diagram down, letting the tighter axis bind', () => {
    // Wide: width binds (952/2000 = 0.476 < 552/300 = 1.84).
    const wide = { left: 24, top: 24, width: 2000, height: 300 };
    const rWide = fitView({ content: wide, view });
    expect(rWide.zoom).toBeCloseTo(952 / 2000);
    expectCentred(wide, rWide);

    // Tall: height binds (552/1500 = 0.368 < 952/300 = 3.17).
    const tall = { left: 24, top: 24, width: 300, height: 1500 };
    const rTall = fitView({ content: tall, view });
    expect(rTall.zoom).toBeCloseTo(552 / 1500);
    expectCentred(tall, rTall);
  });

  it('stops at MIN_ZOOM for a diagram too large to ever fit', () => {
    // Past ~4x the view, MIN_ZOOM wins and the fit deliberately gives up on
    // showing the whole thing — it stays centred and you pan to the rest.
    const content = { left: 24, top: 24, width: 40000, height: 300 };
    const r = fitView({ content, view });
    expect(r.zoom).toBe(MIN_ZOOM);
    expectCentred(content, r);
  });

  it('leaves pan at the origin when the content already fills the view exactly', () => {
    const content = { left: view.left, top: view.top, width: view.width, height: view.height };
    const r = fitView({ content, view });
    expect(r.zoom).toBe(1);
    expect(r.pan.x).toBeCloseTo(0);
    expect(r.pan.y).toBeCloseTo(0);
  });

  it('centres at the clamped zoom when the content is tiny enough to clamp', () => {
    // 952/10 and 552/10 both far exceed MAX_ZOOM, so the fit clamps. Centring
    // must use the clamped zoom — computing pan from the unclamped one would
    // shove the diagram off-centre by the shortfall.
    const content = { left: 500, top: 300, width: 10, height: 10 };
    const r = fitView({ content, view });
    expect(r.zoom).toBe(MAX_ZOOM);
    expectCentred(content, r);
  });

  it('absorbs a content offset from the pan layer’s own margin centring', () => {
    // Same diagram, but margin:auto already placed it elsewhere. The fit must
    // land in the same place on screen regardless of that starting offset.
    const size = { width: 200, height: 150 };
    const a = fitView({ content: { left: 24, top: 24, ...size }, view });
    const b = fitView({ content: { left: 400, top: 90, ...size }, view });
    expect(a.zoom).toBe(b.zoom);
    expect(placed({ left: 24, top: 24, ...size }, a)).toEqual(
      placed({ left: 400, top: 90, ...size }, b),
    );
  });

  it('returns null for a degenerate rect', () => {
    const content = { left: 0, top: 0, width: 200, height: 150 };
    expect(fitView({ content: { ...content, width: 0 }, view })).toBeNull();
    expect(fitView({ content: { ...content, height: NaN }, view })).toBeNull();
    expect(fitView({ content, view: { ...view, width: 0 } })).toBeNull();
  });

  it('fits and centres from a live rect measured mid-transform (invariant)', () => {
    // The real caller measures .pan while a transform is still applied, so model
    // the whole path: browser-reported rect -> untransformedRect -> fitView ->
    // where the diagram actually lands. An error in either step shows up as an
    // off-centre result here, which is how it would fail in the browser — silently.
    const layout = { left: 380, top: 24, width: 240, height: 180 }; // untransformed
    const zoom = 1.75;
    const pan = { x: -60, y: 35 };

    // What getBoundingClientRect() reports under `translate(pan) scale(zoom)`
    // with transform-origin 0 0, derived from the CSS transform rules rather
    // than from untransformedRect's own formula.
    const reported = {
      left: layout.left + pan.x,
      top: layout.top + pan.y,
      width: layout.width * zoom,
      height: layout.height * zoom,
    };

    const content = untransformedRect({ rect: reported, zoom, pan });
    expect(content).toEqual(layout);

    const r = fitView({ content, view });
    const box = placed(layout, r);
    // Fully inside the view, and evenly gapped on both axes.
    expect(box.left).toBeGreaterThanOrEqual(view.left - 0.001);
    expect(box.top).toBeGreaterThanOrEqual(view.top - 0.001);
    expectCentred(layout, r);
    // ...and one axis flush against the view, i.e. it actually fills it.
    const fillsX = Math.abs(box.width - view.width) < 0.001;
    const fillsY = Math.abs(box.height - view.height) < 0.001;
    expect(fillsX || fillsY).toBe(true);
  });
});

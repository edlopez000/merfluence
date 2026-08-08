import { describe, expect, it } from 'vitest';
import { exportScaleFor } from '../src/lib/png-export.js';

/**
 * The canvas-ceiling arithmetic behind exportPng, unit-tested away from a real
 * canvas. The rasterization itself is covered end to end in
 * test/browser/export.e2e.test.js — this is the part with branches, and the part
 * whose failure mode (a silently blank PNG, because an oversized canvas returns
 * blank rather than throwing) is invisible in an end-to-end assertion that only
 * checks a Blob came back.
 */

// The limits the helper is written against: 16384px per side, 32MP of canvas.
const MAX_DIM = 16384;
const MAX_AREA = 32e6;

describe('exportScaleFor', () => {
  it('gives an ordinary diagram exactly what was asked for', () => {
    // The class diagram from the bug report: 2x is nowhere near either ceiling.
    expect(exportScaleFor({ width: 694, height: 438 }, 2)).toBe(2);
    // And the sequence diagram, the one this whole change is about: 3966x5386
    // is 21MP, still inside the budget, so it exports at the full 2x.
    expect(exportScaleFor({ width: 1983, height: 2693 }, 2)).toBe(2);
  });

  it('clamps on the long side before a single dimension overflows', () => {
    // Wide and short: the area is trivial, so only the dimension cap binds.
    const scale = exportScaleFor({ width: 20000, height: 10 }, 2);
    expect(scale).toBeCloseTo(MAX_DIM / 20000, 6);
    expect(20000 * scale).toBeLessThanOrEqual(MAX_DIM);
  });

  it('clamps on total pixels when both sides are individually fine', () => {
    // 4000x4000: each side is under 16384, but 2x would be 64MP.
    const scale = exportScaleFor({ width: 4000, height: 4000 }, 2);
    expect(scale).toBeCloseTo(Math.sqrt(MAX_AREA / 16e6), 6);
    expect(4000 * scale * (4000 * scale)).toBeLessThanOrEqual(MAX_AREA + 1);
  });

  it('goes below 1:1 rather than hand back a blank canvas', () => {
    // A diagram that cannot be rastered at its own size. Downscaled is a worse
    // export; blank is not an export at all.
    const scale = exportScaleFor({ width: 20000, height: 20000 }, 2);
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThan(0);
  });

  it('never scales up past what was asked for', () => {
    // The ceilings are a cap, not a target: a tiny diagram still exports at 2x.
    expect(exportScaleFor({ width: 10, height: 10 }, 2)).toBe(2);
  });

  it('defers to the caller on a size it cannot reason about', () => {
    // naturalSize fell all the way through (an SVG outside the render tree, no
    // viewBox); there is nothing to clamp against, so don't invent a limit.
    expect(exportScaleFor({ width: 0, height: 100 }, 2)).toBe(2);
    expect(exportScaleFor({ width: Number.NaN, height: Number.NaN }, 2)).toBe(2);
  });
});

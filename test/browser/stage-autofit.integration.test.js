import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ZOOM, maxZoomFor, shrinkToFit, untransformedRect } from '../../src/lib/zoom.js';

/**
 * The two DOM facts the editor preview's auto-fit rests on, which jsdom cannot
 * reach: what the Size preset's CSS actually lays out, and how a real
 * ResizeObserver behaves around a transform.
 *
 * Stage watches the .pan content layer and re-fits whenever its box changes.
 * That is only safe because a fit writes a *transform*, and transforms are
 * paint-time — they move what getBoundingClientRect reports (which is why
 * measure() has to invert them through untransformedRect) without changing the
 * layout box a ResizeObserver reports. If that were ever untrue the observer
 * would re-fire on its own output and loop. It is asserted here rather than
 * argued in a comment.
 *
 * No React: the browser project has no JSX transform, and mounting <Stage> would
 * mean widening the shared vitest config for less than these four facts give.
 * The component wiring is covered in test/config-app.test.jsx.
 */

// The stage rules the editor's preview uses, copied from src/config/index.html.
// The .sized pair is the one under test: an explicit height, width derived from
// the viewBox, and no max-width to clamp the now-wider diagram.
const STAGE_CSS = `
  .stage { position: relative; overflow: hidden; width: 400px; height: 300px; }
  .pan { width: fit-content; max-width: 100%; margin: 0 auto; }
  .stage svg { display: block; width: var(--diagram-width, 100%); max-width: 100% !important; height: auto; }
  .stage.sized:not(:fullscreen):not(.maximized) .pan { max-width: none; }
  .stage.sized:not(:fullscreen):not(.maximized) svg {
    height: var(--diagram-height) !important;
    width: auto !important;
    max-width: none !important;
  }
  .stage.maximized { position: fixed; inset: 0; padding: 24px; box-sizing: border-box; }
`;

// A stand-in for what Mermaid emits: a viewBox, width="100%", and no height —
// so exactly one of width/height has to be pinned for the box to resolve, which
// is what the .sized rule does.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200" width="100%"></svg>';

let mounted = [];
let styleEl = null;

function mount(svg = SVG) {
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.textContent = STAGE_CSS;
    document.head.append(styleEl);
  }
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.innerHTML = `<div class="pan">${svg}</div>`;
  document.body.append(stage);
  mounted.push(stage);
  const svgEl = stage.querySelector('svg');
  // What Stage publishes once the SVG lands, so the rules above have the width
  // they read (see the --diagram-width note in src/components/Stage.tsx). Set by
  // hand here, as the CSS is; that Stage really publishes it is asserted against
  // a mounted component in stage-width.integration.test.js.
  stage.style.setProperty('--diagram-width', `${svgEl.viewBox.baseVal.width}px`);
  return { stage, pan: stage.querySelector('.pan'), svg: svgEl };
}

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
});

// Wait n animation frames. ResizeObserver callbacks are delivered during "update
// the rendering", so a frame is the unit of "has it fired yet?".
const frames = (n) =>
  new Promise((resolve) => {
    let left = n;
    const tick = () => (left-- > 0 ? requestAnimationFrame(tick) : resolve());
    requestAnimationFrame(tick);
  });

/** Count observations delivered to `target`, the way Stage's observer sees them. */
function watch(target) {
  const state = { count: 0 };
  const observer = new ResizeObserver(() => {
    state.count += 1;
  });
  observer.observe(target);
  state.stop = () => observer.disconnect();
  return state;
}

describe('the Size preset lays out the box the fit measures', () => {
  it('sizes the diagram to --diagram-height, deriving the width from the viewBox', async () => {
    const { stage, pan } = mount();

    stage.style.setProperty('--diagram-height', '800px');
    stage.classList.add('sized');
    await frames(1);

    // The measurement the whole feature depends on: Large really is 800px tall
    // here, and the 1:2 viewBox makes it 400 wide — not the pane's 300px.
    const rect = pan.getBoundingClientRect();
    expect(rect.height).toBeCloseTo(800, 1);
    expect(rect.width).toBeCloseTo(400, 1);

    // ...and it overflows a 300px pane, which is the bug being fixed.
    expect(rect.height).toBeGreaterThan(stage.getBoundingClientRect().height);
  });

  it('feeds a fit that shrinks the diagram to the pane, end to end', async () => {
    const { stage, pan } = mount();
    stage.style.setProperty('--diagram-height', '800px');
    stage.classList.add('sized');
    await frames(1);

    // Exactly what Stage.measure() does, against real layout rather than
    // fabricated rects: invert the (identity) transform, inset by the padding.
    const content = untransformedRect({
      rect: pan.getBoundingClientRect(),
      zoom: 1,
      pan: { x: 0, y: 0 },
    });
    const stageRect = stage.getBoundingClientRect();
    const view = {
      left: stageRect.left,
      top: stageRect.top,
      width: stageRect.width,
      height: stageRect.height,
    };

    const fit = shrinkToFit({ content, view });
    // Height binds (300/800 < 400/400), so the fitted diagram is flush top and
    // bottom — y stays 0 — and the 250px of width it no longer needs halves into
    // a centring offset.
    expect(fit.zoom).toBeCloseTo(300 / 800, 5);
    expect(fit.pan.x).toBeCloseTo(125, 1);
    expect(fit.pan.y).toBeCloseTo(0, 1);
  });
});

/**
 * Mermaid's own output shape for a wide diagram with useMaxWidth on: a viewBox
 * carrying the intrinsic size, width="100%", and an inline max-width at that
 * intrinsic width. 4000 wide against a 400px stage is a 10x shrink.
 */
const WIDE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4000 1000" width="100%" style="max-width: 4000px;"></svg>';

/** A diagram small enough that nothing shrinks it — the control. */
const SMALL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="100%" style="max-width: 200px;"></svg>';

/** Stage.displayScale(), against real layout: laid-out width over the viewBox's. */
function displayScale(svgEl, zoom = 1, pan = { x: 0, y: 0 }) {
  const intrinsic = svgEl.viewBox.baseVal.width;
  const { width } = untransformedRect({ rect: svgEl.getBoundingClientRect(), zoom, pan });
  return width / intrinsic;
}

describe('the zoom ceiling on a diagram CSS has shrunk', () => {
  it('raises the ceiling inline, where a flat 400% would not reach 1:1', async () => {
    const { svg } = mount(WIDE_SVG);
    await frames(1);

    // The DOM fact jsdom cannot reach: a 4000px diagram really is laid out at a
    // fraction of its size in this column, so every zoom multiplies a box an
    // order of magnitude smaller than the diagram's own pixels.
    const scale = displayScale(svg);
    expect(scale).toBeLessThan(0.2);

    // The bug, stated as an assertion: at the old flat cap the user tops out
    // well below the diagram's own pixels — 0.4x, i.e. unreadable text.
    expect(scale * MAX_ZOOM).toBeLessThan(1);

    // The fix: the ceiling scales with the shrink, so 400% of the diagram's real
    // size is always reachable.
    const ceiling = maxZoomFor(scale);
    expect(ceiling).toBeGreaterThan(MAX_ZOOM);
    expect(scale * ceiling).toBeCloseTo(MAX_ZOOM, 5);
  });

  it('still raises it while maximized — fullscreen is not a workaround', async () => {
    const { stage, svg } = mount(WIDE_SVG);
    stage.classList.add('maximized');
    await frames(2);

    // Maximized, the stage is the viewport, but the unconditional max-width
    // rules still apply, so the diagram is shrunk to the *screen* width instead
    // of the column. Going fullscreen buys the ratio between the two and no
    // more — which is exactly the reported symptom.
    const scale = displayScale(svg);
    expect(scale).toBeLessThan(1);
    expect(scale * MAX_ZOOM).toBeLessThan(MAX_ZOOM);

    const ceiling = maxZoomFor(scale);
    expect(ceiling).toBeGreaterThan(MAX_ZOOM);
    expect(scale * ceiling).toBeCloseTo(MAX_ZOOM, 5);
  });

  it('leaves an unshrunk diagram on the flat 400%, inline and maximized', async () => {
    const { stage, svg } = mount(SMALL_SVG);
    await frames(1);

    expect(displayScale(svg)).toBeCloseTo(1, 5);
    expect(maxZoomFor(displayScale(svg))).toBe(MAX_ZOOM);

    stage.classList.add('maximized');
    await frames(2);
    expect(maxZoomFor(displayScale(svg))).toBe(MAX_ZOOM);
  });

  it('measures the same scale through a live transform', async () => {
    const { pan, svg } = mount(WIDE_SVG);
    await frames(1);
    const before = displayScale(svg);

    // A zoom is already applied when the next gesture measures, so the reading
    // has to be transform-invariant or the ceiling would drift with every press.
    pan.style.transformOrigin = '0 0';
    pan.style.transform = 'translate(37px, 11px) scale(2.5)';
    await frames(2);

    expect(displayScale(svg, 2.5, { x: 37, y: 11 })).toBeCloseTo(before, 5);
  });
});

describe('a real ResizeObserver on the content layer', () => {
  it('delivers an initial observation and one per layout change', async () => {
    const { stage, pan } = mount();
    const seen = watch(pan);
    await frames(2);

    // The initial observation is what fits a diagram that was already oversized
    // when the editor opened — the case a user hits without touching anything.
    expect(seen.count).toBe(1);

    stage.style.setProperty('--diagram-height', '800px');
    stage.classList.add('sized');
    await frames(3);
    expect(seen.count).toBe(2);

    seen.stop();
  });

  it('does not fire for the transform a fit writes, though the rect moves', async () => {
    const { stage, pan } = mount();
    stage.style.setProperty('--diagram-height', '800px');
    stage.classList.add('sized');
    await frames(2);

    const seen = watch(pan);
    await frames(2);
    const settled = seen.count;
    const before = pan.getBoundingClientRect();

    // The output of a fit, applied the way Stage applies it.
    pan.style.transformOrigin = '0 0';
    pan.style.transform = 'translate(0px, 0px) scale(0.375)';
    await frames(5);

    // The reported rect really did change — so this is not a no-op being
    // mistaken for silence...
    const after = pan.getBoundingClientRect();
    expect(after.height).toBeCloseTo(before.height * 0.375, 1);
    // ...and yet no observation was delivered. This is what makes fitting from a
    // ResizeObserver terminate instead of looping on its own output.
    expect(seen.count).toBe(settled);

    seen.stop();
  });
});

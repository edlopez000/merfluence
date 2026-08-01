import { afterEach, describe, expect, it } from 'vitest';
import { shrinkToFit, untransformedRect } from '../../src/lib/zoom.js';

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
  .stage svg { display: block; max-width: 100%; height: auto; }
  .stage.sized:not(:fullscreen):not(.maximized) .pan { max-width: none; }
  .stage.sized:not(:fullscreen):not(.maximized) svg {
    height: var(--diagram-height) !important;
    width: auto !important;
    max-width: none !important;
  }
`;

// A stand-in for what Mermaid emits: a viewBox, width="100%", and no height —
// so exactly one of width/height has to be pinned for the box to resolve, which
// is what the .sized rule does.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200" width="100%"></svg>';

let mounted = [];
let styleEl = null;

function mount() {
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.textContent = STAGE_CSS;
    document.head.append(styleEl);
  }
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.innerHTML = `<div class="pan">${SVG}</div>`;
  document.body.append(stage);
  mounted.push(stage);
  return { stage, pan: stage.querySelector('.pan') };
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

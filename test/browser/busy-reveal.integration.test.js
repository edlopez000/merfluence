import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import configHtml from '../../src/config/index.html?raw';

/**
 * The anti-flash mechanism behind every busy indicator, asserted in a real
 * engine because it is entirely CSS — the jsdom suite can see the class is
 * applied but not what it does.
 *
 * The problem it solves: a small flowchart re-renders in ~20ms, so a chip that
 * mounts and unmounts around the render appears and vanishes inside two frames.
 * That reads as a glitch, not as progress. Rather than spend a JS timer per
 * indicator, the chip mounts immediately and `.reveal` delays it — so work that
 * finishes inside the delay never paints at all.
 *
 * The reason this file exists rather than a comment on the rule: the obvious
 * way to write a delayed reveal is `opacity: 0` with a `forwards` fill, and it
 * is wrong in a way nothing else would catch. It makes the indicator visible
 * *only* while the animation runs, so any future edit that stops the animation
 * — most plausibly a reduced-motion rule saying `animation: none`, which is how
 * every other animation in this repo is disabled — silently removes the
 * indicator for those users instead of merely removing its fade. The last test
 * here is the one that pins that down.
 */

const styleCss = configHtml.match(/<style>([\s\S]*?)<\/style>/)[1];

let styleEl = null;
let mounted = null;

beforeAll(() => {
  styleEl = document.createElement('style');
  styleEl.textContent = styleCss;
  document.head.append(styleEl);
});

afterAll(() => {
  styleEl?.remove();
  styleEl = null;
});

afterEach(() => {
  mounted?.remove();
  mounted = null;
});

/** The preview pane's in-flight chip, exactly as config/main.tsx renders it. */
function mountChip() {
  mounted = document.createElement('div');
  mounted.className = 'preview';
  mounted.innerHTML =
    '<div class="preview-busy reveal" role="status">' +
    '<span class="spinner" aria-hidden="true"></span>Rendering…</div>';
  document.body.append(mounted);
  return mounted.querySelector('.preview-busy');
}

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the delayed reveal', () => {
  it('is invisible through the delay, so a fast render never flashes it', async () => {
    const chip = mountChip();
    await frame();

    // The render this covers would have finished by now. Nothing was painted.
    expect(getComputedStyle(chip).opacity).toBe('0');
  });

  // The measured band this has to clear: warm renders land at 86-112ms and
  // cold-ish ones at 121-175ms. A threshold inside that band is the worst
  // available setting — the chip appears on some renders and not others, and
  // intermittent flicker reads as jank rather than as progress.
  it('stays hidden past the slowest routine render', async () => {
    const chip = mountChip();
    await after(300);

    expect(getComputedStyle(chip).opacity).toBe('0');
  });

  it('becomes fully visible once the wait is worth reporting', async () => {
    const chip = mountChip();
    await after(700);

    expect(getComputedStyle(chip).opacity).toBe('1');
  });

  it('delays rather than dwells, and by more than the render band', async () => {
    const chip = mountChip();
    const timing = chip.getAnimations()[0].effect.getTiming();

    // A delay, not the minimum-dwell the export chip uses: a click has to be
    // acknowledged even if it was instant, but typing acknowledges itself, so
    // this indicator only has to appear when the wait is real.
    expect(timing.delay).toBeGreaterThanOrEqual(300);
    // The fail-safe (see below) depends on this fill direction specifically.
    expect(timing.fill).toBe('backwards');
  });

  // The placeholders that use .reveal bare are the opposite trade: they are the
  // only thing on screen, so a long delay just shows a blank panel. They must
  // NOT inherit the chip's threshold.
  it('leaves the whole-surface placeholders on the short delay', async () => {
    // Held locally, not in `mounted`: mountChip() below claims that slot, and
    // afterEach only cleans up the one element it points at.
    const panel = document.createElement('div');
    panel.className = 'panel loading reveal';
    panel.innerHTML = '<span class="spinner"></span>Loading editor…';
    document.body.append(panel);
    try {
      const placeholderDelay = panel.getAnimations()[0].effect.getTiming().delay;
      const chipDelay = mountChip().getAnimations()[0].effect.getTiming().delay;
      expect(placeholderDelay).toBeLessThan(chipDelay);
    } finally {
      panel.remove();
    }
  });

  // The one that matters. If the animation never runs — cancelled here, but in
  // the field a reduced-motion rule, a rendering engine that skips it, or a
  // future refactor — the indicator must still be on screen. "Shows early" is a
  // cosmetic bug; "never shows" is the feature silently gone.
  it('is visible, not hidden, if the animation never runs at all', async () => {
    const chip = mountChip();
    for (const animation of chip.getAnimations()) animation.cancel();
    await frame();

    expect(getComputedStyle(chip).opacity).toBe('1');
  });

  it('never swallows a pointer gesture aimed at the diagram underneath', async () => {
    const chip = mountChip();
    await after(500);

    // It overlays a live, pannable diagram, so it has to be inert to pointers.
    expect(getComputedStyle(chip).pointerEvents).toBe('none');
  });
});

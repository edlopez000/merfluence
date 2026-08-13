import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { Stage } from '../../src/components/Stage.jsx';
import viewHtml from '../../src/view/index.html?raw';

/**
 * Where the ⌘/Ctrl + scroll pill actually lands, with real layout and the real
 * stylesheet.
 *
 * The unit tests assert the numbers Stage writes into `style.right`/`bottom`.
 * They cannot see whether those numbers put the pill in the corner, because
 * jsdom has no layout: a stray `transform`, an `inset` shorthand, or a
 * `max-content` width that overflowed the stage would all keep them passing
 * while the pill sat somewhere else entirely. Everything here is measured off
 * getBoundingClientRect instead.
 *
 * The second case is the one that motivated the placement. A Natural-height
 * diagram makes the stage taller than the viewport, so its own bottom-right
 * corner is scrolled out of sight, and a pill anchored there is drawn where the
 * reader cannot see it. Stage corrects for that from an IntersectionObserver
 * against the implicit root — and here that root is a genuine one, doing genuine
 * viewport clipping, which is the part no mock can stand in for.
 *
 * The CSS is pulled out of the shipped shell rather than copied, for the reason
 * stage-width.integration.test.js gives: a copy keeps passing after the source
 * has stopped matching it.
 */

// Narrower than the browser project's viewport, on purpose. A column wider than
// the window is horizontally clipped by the viewport, and the placement under
// test correctly answers that by pulling the pill left — which is right, but it
// would make the vertical case below assert two corrections at once. Keep the
// column on screen so each test moves one axis.
const columnWidth = () => Math.min(760, window.innerWidth - 40);
const styleCss = viewHtml.match(/<style>([\s\S]*?)<\/style>/)[1];

// The pill's gap from its corner. Mirrors HINT_MARGIN in Stage.tsx and the
// `right`/`bottom` in the .zoom-hint rule; test/stage-css.test.js is what keeps
// those two honest, so this only has to agree with them.
const MARGIN = 8;

// Stage's own dwell/idle window: a plain wheel has to keep going for longer than
// HINT_DWELL_MS (250) and less than HINT_IDLE_MS (1000) to read as one gesture
// that is trying to zoom. Real timers here, so this is a real wait.
const DWELL_MS = 300;

/**
 * A stand-in diagram, not a Mermaid render.
 *
 * Deliberate: nothing under test here depends on what Mermaid emits — the
 * subject is where an overlay sits inside .stage — and a real render would add a
 * cold Mermaid chunk load to a test whose point is a 300ms wheel gesture. The
 * shape still has to be honest about the one property the stage sizes from, so
 * it carries a viewBox like every SVG Stage is given.
 */
const svgOfHeight = (h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 ${h}" width="100%" ` +
  `style="max-width:300px"><rect width="300" height="${h}" fill="#eee"/></svg>`;

let styleEl = null;
let column = null;

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
  cleanup();
  column?.remove();
  column = null;
  window.scrollTo(0, 0);
});

/** Mount the real component, as stage-width.integration.test.js does. */
function mountStage(svg) {
  column = document.createElement('div');
  column.style.width = `${columnWidth()}px`;
  column.innerHTML = '<div class="root"></div>';
  document.body.append(column);
  render(React.createElement(Stage, { svg, useMaxWidth: true, height: null }), {
    container: column.querySelector('.root'),
  });
  return {
    stage: column.querySelector('.stage'),
    pill: column.querySelector('.zoom-hint'),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Two plain wheels far enough apart to read as one continuing gesture. */
async function keepScrolling(stage) {
  const wheel = () =>
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
  wheel();
  await sleep(DWELL_MS);
  wheel();
  // The class arrives with a React state update, and the browser project runs
  // outside an act environment, so wait for the DOM rather than assuming it.
  for (let i = 0; i < 50 && !stage.querySelector('.zoom-hint.show'); i++) await sleep(10);
}

describe('the scroll-to-zoom pill sits in the corner, measured', () => {
  it('lands in the bottom-right of a fully visible diagram', async () => {
    const { stage, pill } = mountStage(svgOfHeight(200));

    await keepScrolling(stage);
    expect(pill.classList.contains('show')).toBe(true);

    const s = stage.getBoundingClientRect();
    const p = pill.getBoundingClientRect();

    // The corner itself, to the pixel: this is the assertion that a transform or
    // an overriding inset would break.
    expect(Math.abs(s.right - p.right - MARGIN)).toBeLessThan(1);
    expect(Math.abs(s.bottom - p.bottom - MARGIN)).toBeLessThan(1);

    // Inside the stage on every edge — `width: max-content` must not have pushed
    // it out of the box it is anchored to.
    expect(p.left).toBeGreaterThanOrEqual(s.left);
    expect(p.top).toBeGreaterThanOrEqual(s.top);

    // Clear of the bottom-LEFT corner, where the version stamp lives in the full
    // reader view. Being in the right half is what keeps the two from colliding.
    expect(p.left).toBeGreaterThan(s.left + s.width / 2);
  });

  it('follows the visible slice when the diagram is taller than the viewport', async () => {
    // Tall enough that the stage cannot fit on screen at any scroll position, so
    // its own bottom edge is always somewhere below the fold.
    const tall = window.innerHeight * 3;
    const { stage, pill } = mountStage(svgOfHeight(tall));

    // Put the middle of the diagram on screen: its top is above the viewport and
    // its bottom is well below it. A real scroll of the real document, so the
    // observer reports real clipping.
    window.scrollTo(0, Math.round(tall / 2));
    // IntersectionObserver delivers on a frame boundary after the scroll. The
    // 300ms dwell below would cover this on its own; waiting explicitly says so.
    await sleep(100);

    await keepScrolling(stage);
    expect(pill.classList.contains('show')).toBe(true);

    const s = stage.getBoundingClientRect();
    const p = pill.getBoundingClientRect();

    // The point of the whole change: on screen, not at the stage's own bottom.
    expect(p.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(p.top).toBeGreaterThanOrEqual(0);
    // And genuinely lifted, rather than passing because the stage happened to fit.
    expect(s.bottom).toBeGreaterThan(window.innerHeight);
    expect(p.bottom).toBeLessThan(s.bottom - 100);

    // Sitting just above the fold, not floating in the middle of the visible band.
    expect(window.innerHeight - p.bottom).toBeLessThan(MARGIN + 40);
    // Still the right-hand corner; only the vertical inset should have moved.
    expect(Math.abs(s.right - p.right - MARGIN)).toBeLessThan(1);
  });
});

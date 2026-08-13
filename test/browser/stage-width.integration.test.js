import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { renderDiagram } from '../../src/lib/render.js';
import { Stage } from '../../src/components/Stage.jsx';
import viewHtml from '../../src/view/index.html?raw';

/**
 * How wide the browser actually lays a diagram out in the reader's column —
 * issue #141, where every wide diagram resolved to the CSS default intrinsic
 * width of 300px because Mermaid's `width="100%"` has nothing to resolve
 * against inside a shrink-to-fit box.
 *
 * jsdom has no layout, so this is only observable here. Two things make it a
 * regression test rather than a demonstration:
 *
 *  - the CSS is the *shipped* CSS, pulled out of src/view/index.html rather
 *    than copied into the file (a copy would keep passing after the source
 *    stopped matching it), and
 *  - the SVGs are real `renderDiagram()` output, not hand-written stubs of what
 *    Mermaid is assumed to emit.
 *
 * Both shapes Mermaid can produce are covered. Everything renders as
 * `width="100%"` + an inline `max-width` now that useMaxWidth is fixed on, but
 * a config cached by an older build holds the explicit `width`/`height` shape
 * that useMaxWidth:false used to give (see calculateSvgSizeAttrs in the Mermaid
 * bundle), and the reader still injects those verbatim. `asLegacyShape` below
 * reproduces it from the same render, which is why no cache version bump was
 * needed: the stylesheet overrides both.
 */

// A stand-in for the macro column. The reader's own html/body rules are in the
// stylesheet under test, so the harness supplies only what the Forge iframe
// would: a definite width to lay out against.
const COLUMN = 760;

// Long enough left-to-right that it is several times the column, which is the
// case the bug is about.
const WIDE = `flowchart LR\n${Array.from({ length: 24 }, (_, i) => `  N${i}["Step ${i}"] --> N${i + 1}["Step ${i + 1}"]`).join('\n')}`;
// Comfortably narrower than the column, so nothing shrinks it: the control.
const NARROW = 'flowchart TD\n  A[Go] --> B[Stop]';

const styleCss = viewHtml.match(/<style>([\s\S]*?)<\/style>/)[1];

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

/**
 * Mount rendered SVG in the reader's real element chain. `--diagram-width` is
 * set the way Stage does after the fix (from the viewBox, the same source
 * Stage.displayScale reads) — the browser project has no JSX transform, so the
 * component itself can't be mounted here; test/config-app.test.jsx covers the
 * React side.
 */
function mount(svg, { noShrink = false, height = null } = {}) {
  column = document.createElement('div');
  column.style.width = `${COLUMN}px`;
  column.innerHTML =
    `<div class="root"><div class="stage${noShrink ? ' no-shrink' : ''}${height ? ' sized' : ''}">` +
    `<div class="pan">${svg}</div></div></div>`;
  document.body.append(column);

  const stage = column.querySelector('.stage');
  const svgEl = column.querySelector('svg');
  const intrinsic = svgEl.viewBox.baseVal.width;
  stage.style.setProperty('--diagram-width', `${intrinsic}px`);
  if (height) stage.style.setProperty('--diagram-height', `${height}px`);

  return {
    intrinsic,
    root: column.querySelector('.root').getBoundingClientRect(),
    stage: stage.getBoundingClientRect(),
    pan: column.querySelector('.pan').getBoundingClientRect(),
    svg: svgEl.getBoundingClientRect(),
  };
}

afterEach(() => {
  cleanup();
  column?.remove();
  column = null;
});

/**
 * The same column, with the real component in it. `mount` above sets
 * --diagram-width by hand, which proves the CSS but would keep passing if Stage
 * ever stopped publishing it — this is the other half of the loop. React is
 * driven through createElement rather than JSX because the browser project has
 * no JSX transform configured for test files.
 */
function mountComponent(svg, { useMaxWidth = true } = {}) {
  column = document.createElement('div');
  column.style.width = `${COLUMN}px`;
  column.innerHTML = '<div class="root"></div>';
  document.body.append(column);
  const root = column.querySelector('.root');
  render(React.createElement(Stage, { svg, useMaxWidth, height: null }), { container: root });
  return root.querySelector('svg');
}

// A cold Mermaid chunk load plus layout outruns vitest's 5s default on CI.
const RENDER_TIMEOUT = 20_000;

/**
 * The same diagram in the shape an older build cached it in: the viewBox's
 * own numbers as `width`/`height` attributes and no percentage, which is what
 * Mermaid emitted under useMaxWidth:false. Derived from a real render rather
 * than written by hand, so it stays a faithful stand-in for a stored cache.
 */
function asLegacyShape(svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const el = doc.documentElement;
  const box = el.getAttribute('viewBox').split(/\s+/).map(Number);
  el.setAttribute('width', String(box[2]));
  el.setAttribute('height', String(box[3]));
  el.style.removeProperty('max-width');
  return new XMLSerializer().serializeToString(el);
}

let wide;
let narrow;

beforeAll(async () => {
  // Rendered once and reused: re-rendering per case would multiply the suite's
  // runtime for nothing.
  [wide, narrow] = await Promise.all([
    renderDiagram({ source: WIDE }).then((r) => r.svg),
    renderDiagram({ source: NARROW }).then((r) => r.svg),
  ]);
}, RENDER_TIMEOUT);

describe('a diagram wider than the column', () => {
  it('lays out at the column width, not the 300px replaced-element default', () => {
    const { intrinsic, pan, svg, root } = mount(wide);

    // The premise: this really is a diagram several times the column's width.
    expect(intrinsic).toBeGreaterThan(COLUMN * 2);

    // The bug, as an assertion: before the fix both of these read ~300.
    expect(svg.width).toBeCloseTo(COLUMN, 0);
    expect(pan.width).toBeCloseTo(COLUMN, 0);

    // ...and the macro is still exactly its column. The diagram fills the space
    // it has instead of stretching the space to fit.
    expect(root.width).toBeCloseTo(COLUMN, 0);
  });

  it('keeps its own width with "Keep full width", clipped rather than stretching', () => {
    // The *same* markup as the case above — the toggle is a class and nothing
    // else, so the class alone has to make the difference.
    const { intrinsic, pan, svg, root, stage } = mount(wide, { noShrink: true });

    // The toggle's whole purpose, and a no-op before #147: the diagram is laid
    // out at full size and the stage clips it.
    expect(svg.width).toBeCloseTo(intrinsic, 0);
    expect(pan.width).toBeCloseTo(intrinsic, 0);

    // Clipped, not carried out of the column: .stage's overflow: hidden only
    // does that because the chain above it has a definite width. Without this
    // the Forge iframe grows and Confluence scrolls the whole macro sideways,
    // taking the toolbar and version stamp with it.
    expect(stage.width).toBeCloseTo(COLUMN, 0);
    expect(root.width).toBeCloseTo(COLUMN, 0);
  });
});

describe('the component and the stylesheet, together', () => {
  it('publishes the diagram width so a real <Stage> fills the column', () => {
    const svgEl = mountComponent(wide);

    // Nothing set the variable by hand here: Stage read the viewBox and put it
    // on the stage element, which is the half of the fix that lives in TSX.
    expect(svgEl.getBoundingClientRect().width).toBeCloseTo(COLUMN, 0);
    const stage = svgEl.closest('.stage');
    expect(stage.style.getPropertyValue('--diagram-width')).toBe(
      `${svgEl.viewBox.baseVal.width}px`,
    );
  });

  it('leaves a full-width diagram at its own size', () => {
    const svgEl = mountComponent(wide, { useMaxWidth: false });

    expect(svgEl.closest('.stage').classList.contains('no-shrink')).toBe(true);
    expect(svgEl.getBoundingClientRect().width).toBeCloseTo(svgEl.viewBox.baseVal.width, 0);
    expect(column.querySelector('.root').getBoundingClientRect().width).toBeCloseTo(COLUMN, 0);
  });
});

describe('an SVG cached in the pre-toggle-split shape', () => {
  // Why CACHE_VERSION was not bumped when "Keep full width" stopped reaching the
  // renderer: a config cached with useMaxWidth off carries explicit px width and
  // height, and the reader injects it verbatim. These rules have to override
  // that as completely as they override the percentage shape, or every such page
  // would keep opening full-width after the option was switched off.
  it('shrinks to the column all the same, and still honours the class', () => {
    const legacy = asLegacyShape(wide);
    expect(legacy).not.toMatch(/width="100%"/);

    const fit = mount(legacy);
    expect(fit.intrinsic).toBeGreaterThan(COLUMN * 2);
    expect(fit.svg.width).toBeCloseTo(COLUMN, 0);
    column.remove();

    const full = mount(legacy, { noShrink: true });
    expect(full.svg.width).toBeCloseTo(full.intrinsic, 0);
    expect(full.root.width).toBeCloseTo(COLUMN, 0);
  });
});

describe('a diagram narrower than the column', () => {
  it('stays at its own size and centres, in both modes', () => {
    for (const noShrink of [false, true]) {
      const { intrinsic, pan, svg, root } = mount(narrow, { noShrink });

      expect(intrinsic).toBeLessThan(COLUMN);
      // Never magnified to fill the column — that is what the fit-content
      // sizing on .pan is for, and it has to survive the fix.
      expect(svg.width).toBeCloseTo(intrinsic, 0);
      expect(pan.width).toBeCloseTo(intrinsic, 0);
      // Centred by .pan's margin: 0 auto.
      expect(pan.left - root.left).toBeCloseTo((COLUMN - intrinsic) / 2, 0);

      column.remove();
    }
  });
});

describe('a Size preset', () => {
  it('still sizes from the height and keeps the macro in its column', () => {
    const { pan, svg, root } = mount(wide, { height: 320 });

    // The preset owns both axes here: an explicit height, width derived from
    // the viewBox ratio. The new width rule must not reach this path.
    expect(svg.height).toBeCloseTo(320, 0);
    expect(pan.height).toBeCloseTo(320, 0);
    expect(svg.width).toBeGreaterThan(COLUMN);

    // Wider than the column, so the stage clips it and the macro stays put.
    expect(root.width).toBeCloseTo(COLUMN, 0);
  });
});

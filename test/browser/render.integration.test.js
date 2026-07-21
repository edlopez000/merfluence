import { afterEach, describe, expect, it } from 'vitest';
import { renderDiagram, measureSvg, sanitizeSvg } from '../../src/lib/render.js';

/**
 * The end-to-end render, which the jsdom corpus cannot reach.
 *
 * parse.test.js stops at mermaid.parse() because mermaid.render() needs
 * SVGElement.getBBox(), absent in jsdom. This suite runs in a real Chromium
 * (vitest browser project), so it exercises the whole renderDiagram pipeline —
 * initialize -> parse -> render -> sanitizeSvg — against a live DOM, and proves
 * the "three independent layers" actually compose on a genuinely rendered SVG
 * rather than on hand-written markup. The adversarial half of that proof lives
 * in xss.e2e.test.js; this file is the happy-path and positive-control half.
 */

// Load fixture sources at build time. import.meta.glob is the browser-mode
// equivalent of parse.test.js's fs.readFileSync — the ?raw query hands back the
// file's text. Keyed by path, so derive a basename map for readable test names.
const rawFixtures = import.meta.glob('../fixtures/*.mmd', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const fixtures = Object.fromEntries(
  Object.entries(rawFixtures).map(([path, src]) => [
    path.split('/').pop().replace('.mmd', ''),
    src,
  ]),
);

// A representative subset spanning several grammars, all valid in both majors.
// Rendering the full 18-type corpus across both themes is slower than it is
// informative; the pipeline is type-agnostic, so a cross-section proves it.
const SUBSET = ['flowchart', 'sequence', 'class', 'state', 'er', 'pie'];

// Inject rendered markup the way the reader view does, so getBoundingClientRect
// reflects real layout. Each case cleans up after itself.
let mounted = [];
function mount(svg) {
  const host = document.createElement('div');
  host.innerHTML = svg;
  document.body.appendChild(host);
  mounted.push(host);
  return host;
}
afterEach(() => {
  for (const host of mounted) host.remove();
  mounted = [];
});

describe('renderDiagram end-to-end', () => {
  for (const theme of ['light', 'dark']) {
    describe(`theme: ${theme}`, () => {
      for (const name of SUBSET) {
        it(`renders ${name} to a laid-out <svg>`, async () => {
          const source = fixtures[name];
          expect(source, `fixture ${name} exists`).toBeTruthy();

          const { svg, major } = await renderDiagram({ source, theme });
          expect(major).toBe('11');

          const host = mount(svg);
          const el = host.querySelector('svg');
          // A real render, not a stub: the element exists and the browser gave
          // it non-zero layout (which is exactly what getBBox feeds).
          expect(el).not.toBeNull();
          const box = el.getBoundingClientRect();
          expect(box.width).toBeGreaterThan(0);
          expect(box.height).toBeGreaterThan(0);

          const measured = measureSvg(host);
          expect(measured.width).toBeGreaterThan(0);
          expect(measured.height).toBeGreaterThan(0);
        });
      }
    });
  }
});

describe('the three layers compose on a real SVG (positive control)', () => {
  // If the security tests passed by stripping everything, they would be
  // worthless. This asserts a normal diagram keeps the legitimate SVG features
  // Mermaid emits and the sanitizer is meant to preserve — so a regression that
  // over-sanitizes is caught here, and the xss suite's "inert" assertions carry
  // weight.
  it('keeps styles, transforms and markers a flowchart legitimately emits', async () => {
    const { svg } = await renderDiagram({ source: fixtures.flowchart });
    const host = mount(svg);

    expect(host.querySelector('svg')).not.toBeNull();
    // Mermaid decorates nodes/edges with inline styles and transforms; zoom.js
    // depends on transform surviving, and unsafe-inline exists for style.
    expect(host.querySelector('[style]')).not.toBeNull();
    expect(host.querySelector('[transform]')).not.toBeNull();
    // Arrowheads are <marker>s referenced by edges — a real structural feature,
    // not active content.
    expect(host.querySelector('marker')).not.toBeNull();
  });
});

describe('parse-before-render invariant', () => {
  // render.js parses before it renders precisely so a syntax error never leaves
  // an orphan container pinned to the document (a real Mermaid failure mode).
  // Assert both halves: the rejection, and the clean document.
  it('rejects invalid source and leaves no orphan container', async () => {
    const before = document.querySelectorAll('div[id^="dmmd-"], div[id^="mmd-"]').length;

    await expect(
      renderDiagram({ source: 'flowchart TD\n  A --> B\n  C[unterminated' }),
    ).rejects.toBeTruthy();

    const after = document.querySelectorAll('div[id^="dmmd-"], div[id^="mmd-"]').length;
    expect(after).toBe(before);
  });

  it('rejects empty source before touching Mermaid', async () => {
    await expect(renderDiagram({ source: '   ' })).rejects.toThrow(/empty/i);
  });

  it('cleans up its own render container on success', async () => {
    await renderDiagram({ source: fixtures.flowchart });
    // The temp element render() uses carries a dmmd-/mmd- id; it must be gone
    // once the promise resolves, whether or not we mounted the result.
    expect(document.querySelector('body > div[id^="dmmd-"], body > div[id^="mmd-"]')).toBeNull();
  });
});

describe('cache re-sanitize boundary', () => {
  // The view re-runs cached SVG (from macro config, an untrusted boundary)
  // through sanitizeSvg before injecting. Prove a tampered cache string comes
  // back inert even in a live DOM.
  it('strips a script smuggled into a cached SVG string', () => {
    const tampered =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__cachePwned = 1</script><rect width="10" height="10"/></svg>';
    const host = mount(sanitizeSvg(tampered));
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('rect')).not.toBeNull();
    expect(window.__cachePwned).toBeUndefined();
  });
});

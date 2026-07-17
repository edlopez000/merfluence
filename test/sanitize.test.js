import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from '../src/lib/render.js';

/**
 * The output-side canary for the safety claim.
 *
 * securityLevel: 'strict', htmlLabels: false and DOMPurify are three
 * independent layers, and the point of independence is that any one of them
 * failing must not open a hole. Everything else in the suite tests the first
 * two at parse level — this file tests the layer that has to hold when those
 * fail, by handing sanitizeSvg() markup that Mermaid would never emit and
 * asserting it comes back inert.
 *
 * sanitizeSvg is the honest unit to test here, for two reasons. It is the one
 * chokepoint both injection paths funnel through: a fresh render sanitizes
 * inside renderDiagram, and the view re-sanitizes cached SVG from macro config
 * (an untrusted boundary — it may have been hand-edited to bypass the sanitize
 * that ran at save time). And a full source-to-SVG test is not reachable in
 * jsdom regardless, since mermaid.render needs getBBox(). See parse.test.js.
 *
 * The regression this guards is a dependency bump — a Mermaid or DOMPurify
 * major quietly changing what the SVG profile permits is exactly the kind of
 * thing that reopens this silently, with a green pipeline.
 */

/** Every assertion works on the parsed result, so no test can pass on string luck. */
function sanitizedDoc(markup) {
  const out = sanitizeSvg(markup);
  const doc = new DOMParser().parseFromString(`<div>${out}</div>`, 'text/html');
  return { out, doc };
}

describe('sanitizeSvg strips active content', () => {
  it('removes a <script> element', () => {
    const { out, doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>window.pwned = 1</script><rect /></svg>',
    );
    expect(doc.querySelector('script')).toBeNull();
    expect(out).not.toContain('pwned');
    // The benign sibling survives: proves the case failed on the script, not
    // on the whole input being dropped.
    expect(doc.querySelector('rect')).not.toBeNull();
  });

  it('removes event-handler attributes', () => {
    const { doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<rect onload="window.pwned = 1" onclick="window.pwned = 1" width="10" />' +
        '</svg>',
    );
    const rect = doc.querySelector('rect');
    expect(rect).not.toBeNull();
    expect(rect.getAttribute('onload')).toBeNull();
    expect(rect.getAttribute('onclick')).toBeNull();
    expect(rect.getAttribute('width')).toBe('10');
  });

  it('removes javascript: URLs from href and xlink:href', () => {
    const { out, doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<a href="javascript:window.pwned=1"><text>one</text></a>' +
        '<a xlink:href="javascript:window.pwned=1"><text>two</text></a>' +
        '</svg>',
    );
    expect(out).not.toContain('javascript:');
    for (const a of doc.querySelectorAll('a')) {
      expect(a.getAttribute('href')).toBeNull();
      expect(a.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBeNull();
    }
  });

  it('removes <foreignObject> and the HTML inside it', () => {
    // htmlLabels: false means nothing legitimate produces a foreignObject, so
    // the SVG profile dropping it costs us nothing and closes the widest hole
    // — it is the one element that can carry arbitrary HTML into the SVG.
    const { out, doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>' +
        '<img src="x" onerror="window.pwned = 1" />' +
        '</foreignObject></svg>',
    );
    expect(doc.querySelector('foreignObject')).toBeNull();
    expect(doc.querySelector('img')).toBeNull();
    expect(out).not.toContain('onerror');
  });

  it('handles nullish input without throwing', () => {
    // The cached-SVG path can hand this an absent config value.
    expect(sanitizeSvg(null)).toBe('');
    expect(sanitizeSvg(undefined)).toBe('');
  });
});

describe('sanitizeSvg preserves what Mermaid legitimately emits', () => {
  // Positive controls. Without these the suite would pass just as well against
  // a sanitizer that returned '' for everything.
  it('keeps transform-origin, which zoom.js depends on', () => {
    const { doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg"><g transform-origin="0 0" transform="scale(2)">' +
        '<path d="M0 0 L10 10" /></g></svg>',
    );
    const g = doc.querySelector('g');
    expect(g.getAttribute('transform-origin')).toBe('0 0');
    expect(g.getAttribute('transform')).toBe('scale(2)');
    expect(doc.querySelector('path').getAttribute('d')).toBe('M0 0 L10 10');
  });

  it('keeps inline styles, which is why the manifest grants unsafe-inline', () => {
    const { doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg"><text style="fill: #ff0000">hi</text></svg>',
    );
    const text = doc.querySelector('text');
    expect(text.getAttribute('style')).toContain('fill');
    expect(text.textContent).toBe('hi');
  });

  it('keeps markers and filter primitives used by real diagrams', () => {
    // svgFilters is in USE_PROFILES for this reason; arrowheads are markers.
    const { doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
        '<marker id="arrow"><path d="M0 0 L5 5" /></marker>' +
        '<filter id="blur"><feGaussianBlur stdDeviation="2" /></filter>' +
        '</defs></svg>',
    );
    expect(doc.querySelector('marker')).not.toBeNull();
    expect(doc.querySelector('feGaussianBlur')).not.toBeNull();
  });
});

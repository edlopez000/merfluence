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

describe('sanitizeSvg strips external resource references', () => {
  // Script execution is closed by the layers above; this block guards the
  // *egress* vector. An external <image href> or a style url(http…) fires an
  // outbound request when the browser paints it — a tracking pixel leaking the
  // reader's IP/UA/page-view. These must not survive sanitization. See the
  // uponSanitizeAttribute hook in render.js.
  it('drops an external <image href>', () => {
    const { out, doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<image href="https://evil.example/pixel.png" width="1" height="1" /></svg>',
    );
    const image = doc.querySelector('image');
    // The element may survive, but with no source it can't egress.
    expect(image?.getAttribute('href') ?? null).toBeNull();
    expect(out).not.toContain('evil.example');
  });

  it('drops an external <image xlink:href>', () => {
    const { out, doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<image xlink:href="https://evil.example/pixel.png" /></svg>',
    );
    const image = doc.querySelector('image');
    expect(image?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? null).toBeNull();
    expect(out).not.toContain('evil.example');
  });

  it('treats a protocol-relative //host href as external', () => {
    const { out } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="//evil.example/p.png" /></svg>',
    );
    expect(out).not.toContain('evil.example');
  });

  it('scrubs an external url() from the style attribute', () => {
    const { out, doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<rect style="fill:url(https://evil.example/f.svg#p)" width="10" height="10" /></svg>',
    );
    const rect = doc.querySelector('rect');
    expect(rect).not.toBeNull();
    expect(rect.getAttribute('style') ?? '').not.toContain('evil.example');
    expect(out).not.toContain('evil.example');
  });

  it('scrubs an external url() from a presentation attribute (fill)', () => {
    const { out, doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<rect fill="url(https://evil.example/f.svg#p)" width="10" height="10" /></svg>',
    );
    const rect = doc.querySelector('rect');
    expect(rect.getAttribute('fill') ?? '').not.toContain('evil.example');
    expect(out).not.toContain('evil.example');
  });
});

describe('sanitizeSvg strips external references from <style> element text', () => {
  // The attribute cases above are the ones #64 closed. CSS reaches the network
  // just as readily from element *text*, and <style> is allow-listed by the SVG
  // profile — Mermaid emits one on every diagram — so it has to be scrubbed
  // rather than dropped. Each case asserts on the parsed <style> text, not on
  // the output string, so none can pass on serialization luck.
  function styleText(css) {
    const { out, doc } = sanitizedDoc(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect width="10" height="10" /></svg>`,
    );
    return { out, css: doc.querySelector('style')?.textContent ?? '' };
  }

  it('drops an external @import url()', () => {
    const { out, css } = styleText('@import url(https://evil.example/x.css);');
    expect(css).not.toContain('evil.example');
    expect(out).not.toContain('evil.example');
  });

  it('drops a bare-string external @import', () => {
    // The string form carries no url() token, so the url() strip alone misses it.
    const { out, css } = styleText('@import "https://evil.example/x.css";');
    expect(css).not.toContain('evil.example');
    expect(out).not.toContain('evil.example');
  });

  it('scrubs an external url() in a rule body', () => {
    const { out, css } = styleText('.a{fill:url(https://evil.example/leak)}');
    expect(css).not.toContain('evil.example');
    expect(out).not.toContain('evil.example');
  });

  it('scrubs an external background-image url()', () => {
    const { out, css } = styleText('.b{background-image:url("https://evil.example/pixel.png")}');
    expect(css).not.toContain('evil.example');
    expect(out).not.toContain('evil.example');
  });

  it('scrubs a protocol-relative //host url()', () => {
    const { out, css } = styleText('.c{background-image:url(//evil.example/p.png)}');
    expect(css).not.toContain('evil.example');
    expect(out).not.toContain('evil.example');
  });

  it('blanks the block when a CSS escape evades the pattern strip', () => {
    // `\68` is `h`, so this fetches https://… while matching nothing that looks
    // for "https". The verify pass decodes escapes, sees the ref survived, and
    // fails closed by dropping the whole block.
    const { out, css } = styleText('.d{background-image:url(\\68 ttps://evil.example/p.png)}');
    expect(css).toBe('');
    expect(out).not.toContain('evil.example');
  });

  it('leaves the rest of the SVG intact while scrubbing the style', () => {
    // Proves the cases above fail on the CSS, not on the whole input being dropped.
    const { doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<style>.a{fill:url(https://evil.example/leak)}</style>' +
        '<rect width="10" height="10" /></svg>',
    );
    expect(doc.querySelector('rect')?.getAttribute('width')).toBe('10');
    expect(doc.querySelector('style')).not.toBeNull();
  });
});

describe('the egress scrubbers’ fast-path guards change nothing', () => {
  // Both scrub paths skip their work when the input provably cannot carry an
  // external reference: a `style` value with no `url(`, no `@import` and no
  // backslash, and a `<style>` block with no backslash (the only thing the
  // escape-decoding verify pass can act on). These are perf guards, so the
  // property that matters is equivalence — the guarded answer must equal the
  // unguarded one — not merely "the payload was stripped".

  // The guards' own trigger conditions, so a value that reaches the scrubber
  // by one route is checked against every route.
  const PAYLOADS = [
    // Skipped by both guards: nothing to strip.
    '.a{fill:#333;stroke-width:2px}',
    'fill:#333;stroke:#666',
    // Not skipped: literal tokens.
    '.b{background-image:url(https://evil.example/p.png)}',
    '.c{background-image:url(//evil.example/p.png)}',
    '@import url(https://evil.example/x.css);',
    '@import "https://evil.example/x.css";',
    '.d{background-image:URL(HTTPS://EVIL.EXAMPLE/p.png)}',
    // Not skipped: escapes. `\68` is `h`, `\75` is `u`, so each spells a live
    // fetch that no literal-substring search would find.
    '.e{background-image:url(\\68 ttps://evil.example/p.png)}',
    '.f{background-image:\\75 rl(https://evil.example/p.png)}',
    // Must survive untouched — the arrowheads and gradients every diagram draws.
    '.g{marker-end:url(#arrowhead);fill:url(#grad)}',
    'fill:url(#grad);marker-end:url(#arrowhead)',
    // A URL that is only mentioned, never fetched.
    '.h{content:"see https://example.com/docs"}',
  ];

  // The unguarded reference implementation, kept deliberately verbatim from
  // render.ts's scrubbers so the comparison is against the old behavior rather
  // than against the new code restated.
  const EXTERNAL_URL_FN = /url\(\s*['"]?\s*(?:https?:)?\/\//i;
  const EXTERNAL_IMPORT = /@import\s+['"]?\s*(?:https?:)?\/\//i;
  const stripRefs = (value) =>
    value
      .replace(/@import\b[^;]*;?/gi, (rule) =>
        EXTERNAL_IMPORT.test(rule) || EXTERNAL_URL_FN.test(rule) ? '' : rule,
      )
      .replace(/url\(\s*['"]?\s*(?:https?:)?\/\/[^)]*\)/gi, '');
  const decodeEscapes = (value) =>
    value
      .replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/\\(.)/g, '$1');
  const unguardedStyleText = (css) => {
    const scrubbed = stripRefs(css);
    const decoded = decodeEscapes(scrubbed);
    return EXTERNAL_URL_FN.test(decoded) || EXTERNAL_IMPORT.test(decoded) ? '' : scrubbed;
  };

  it('scrubs <style> text exactly as the unguarded verify pass would', () => {
    for (const css of PAYLOADS) {
      const { doc } = sanitizedDoc(
        `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect width="10" height="10"/></svg>`,
      );
      // The DOM round-trip decodes entities, so compare against the scrub of
      // what actually reached the hook rather than of the source string.
      const expected = unguardedStyleText(css);
      expect(doc.querySelector('style')?.textContent ?? '', `<style> ${css}`).toBe(expected);
    }
  });

  it('scrubs the style attribute exactly as the unguarded strip would', () => {
    for (const value of PAYLOADS) {
      const { doc } = sanitizedDoc(
        `<svg xmlns="http://www.w3.org/2000/svg"><rect style="${value.replace(/"/g, '&quot;')}" width="10" height="10"/></svg>`,
      );
      const got = doc.querySelector('rect')?.getAttribute('style');
      // A value the sanitizer drops outright is equally fine — what must not
      // differ is a value that survives.
      if (got !== null) expect(got, `style="${value}"`).toBe(stripRefs(value));
    }
  });

  it('still blanks an escape-obfuscated <style> block (the guard lets escapes through to the verify)', () => {
    // The one case the backslash check exists for: skipping the verify here
    // would ship a live fetch. Re-asserted directly, not just by equivalence.
    const { out, doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<style>.d{background-image:url(\\68 ttps://evil.example/p.png)}</style>' +
        '<rect width="10" height="10"/></svg>',
    );
    expect(doc.querySelector('style')?.textContent).toBe('');
    expect(out).not.toContain('evil.example');
  });
});

describe('sanitizeSvg keeps internal references the fix must not break', () => {
  // Positive controls for the egress guard. Mermaid draws arrowheads, gradients
  // and clip-paths as internal url(#id) refs; a blanket url() strip would erase
  // every diagram's arrowheads. These prove the strip is surgical.
  it('keeps an internal url(#id) marker-end (arrowheads)', () => {
    const { doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M0 0 L10 0" marker-end="url(#arrow)" /></svg>',
    );
    expect(doc.querySelector('path').getAttribute('marker-end')).toBe('url(#arrow)');
  });

  it('keeps an internal url(#id) fill (gradients) in style and attribute form', () => {
    const { doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<rect fill="url(#grad)" width="10" height="10" />' +
        '<circle style="fill:url(#grad)" r="5" /></svg>',
    );
    expect(doc.querySelector('rect').getAttribute('fill')).toBe('url(#grad)');
    expect(doc.querySelector('circle').getAttribute('style')).toContain('url(#grad)');
  });

  it('keeps an internal url(#id) clip-path', () => {
    const { doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<g clip-path="url(#c)"><rect width="10" height="10" /></g></svg>',
    );
    expect(doc.querySelector('g').getAttribute('clip-path')).toBe('url(#c)');
  });

  it('keeps internal url(#id) refs inside a <style> element', () => {
    const css = '.c{marker-end:url(#arrow)} .d{fill:url(#grad)}';
    const { doc } = sanitizedDoc(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style></svg>`,
    );
    expect(doc.querySelector('style').textContent).toBe(css);
  });

  it('keeps a realistic Mermaid theme <style> byte-for-byte', () => {
    // The load-bearing keep-test: Mermaid puts its theming in a <style> on every
    // diagram, so a scrub that blanked or mangled this would unstyle everything
    // while the egress cases above still passed.
    const css =
      '#mmd-1{font-family:"trebuchet ms",verdana,arial,sans-serif;font-size:16px;fill:#333;}' +
      '#mmd-1 .error-icon{fill:#552222;}' +
      '#mmd-1 .marker{fill:#333333;stroke:#333333;}' +
      '#mmd-1 .node rect{fill:#ECECFF;stroke:#9370DB;stroke-width:1px;}' +
      '#mmd-1 .edgePath .path{stroke:#333333;stroke-width:2.0px;marker-end:url(#arrowhead);}' +
      '#mmd-1 .cluster rect{fill:url(#gradient);}';
    const { doc } = sanitizedDoc(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style></svg>`,
    );
    expect(doc.querySelector('style').textContent).toBe(css);
  });

  it('keeps a url() that merely mentions a host in a content string', () => {
    // The verify pass fails closed, so its detectors are narrow on purpose: a
    // stylesheet naming a URL in text must not blank the whole block.
    const css = '.e::after{content:"see https://example.com for docs";}';
    const { doc } = sanitizedDoc(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style></svg>`,
    );
    expect(doc.querySelector('style').textContent).toBe(css);
  });

  it('keeps a data: image href (inline, no egress — per policy)', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const { doc } = sanitizedDoc(
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="${dataUri}" /></svg>`,
    );
    expect(doc.querySelector('image')?.getAttribute('href')).toBe(dataUri);
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

  // The text alternative (WCAG 2.1 SC 1.1.1) is only as good as what survives
  // this policy. `role` in particular is NOT in DOMPurify's svg attribute list
  // — it lives in the html one, which USE_PROFILES:{svg} doesn't pull in — so it
  // needs an explicit ADD_ATTR entry, and it was silently being dropped before
  // #92. The rest ride on ALLOW_ARIA_ATTR and the svg tag profile; asserting
  // them here means a DOMPurify major that narrows either one fails loudly
  // rather than quietly un-naming every diagram.
  it('keeps the role and aria wiring that names the diagram', () => {
    const { doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg" role="graphics-document document" ' +
        'aria-roledescription="Flowchart diagram" aria-labelledby="t1" aria-describedby="d1" ' +
        'aria-label="spare">' +
        '<title id="t1">Deploy pipeline</title>' +
        '<desc id="d1">Code flows from pull request to production.</desc>' +
        '<rect /></svg>',
    );
    const svg = doc.querySelector('svg');
    expect(svg.getAttribute('role')).toBe('graphics-document document');
    expect(svg.getAttribute('aria-roledescription')).toBe('Flowchart diagram');
    expect(svg.getAttribute('aria-labelledby')).toBe('t1');
    expect(svg.getAttribute('aria-describedby')).toBe('d1');
    expect(svg.getAttribute('aria-label')).toBe('spare');
    // The referenced elements have to survive too, ids included — an
    // aria-labelledby pointing at nothing is not a name.
    expect(doc.querySelector('title#t1').textContent).toBe('Deploy pipeline');
    expect(doc.querySelector('desc#d1').textContent).toContain('production');
  });

  it('keeps role="img" on a diagram the author described', () => {
    const { doc } = sanitizedDoc(
      '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="t1">' +
        '<title id="t1">Deploy pipeline</title></svg>',
    );
    expect(doc.querySelector('svg').getAttribute('role')).toBe('img');
  });
});

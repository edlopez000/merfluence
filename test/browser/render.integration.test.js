import { afterEach, describe, expect, it } from 'vitest';
import { renderDiagram, measureSvg, sanitizeSvg } from '../../src/lib/render.js';
import { ensureAccessibleName } from '../../src/lib/a11y-name.js';

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

// Every fixture renders once; a six-type subset also renders in dark.
//
// The split is by what each axis actually proves. Rendering is NOT type-agnostic
// the way our wrapper is: Mermaid lazy-loads a different layout engine per type
// (cytoscape for architecture/mindmap, others for xychart/sankey/gitgraph/…),
// and that per-type integration is the seam a Mermaid bump breaks. parse.test.js
// runs all 18 on both majors but never invokes a layout engine, so only a real
// render catches it — hence one render for every type, derived from the glob so
// a new fixture is covered the moment it lands (CLAUDE.md: "new diagram type ->
// new fixture").
//
// Theme is the cheaper axis: it varies colours and inline styles, not layout
// code, and the place theme genuinely bites — the save-time light/dark race
// behind CACHE_VERSION = 2 — is covered in the view tests. So the second theme
// stays on the original cross-section rather than doubling the corpus.
const ALL = Object.keys(fixtures).sort();
const SUBSET = ['flowchart', 'sequence', 'class', 'state', 'er', 'pie'];

// A cold cytoscape/ELK/KaTeX chunk load plus layout comfortably outruns vitest's
// 5s default on a CI runner. Local to these cases, so nothing else loosens: a
// timeout here would be indistinguishable from the regression this suite exists
// to catch.
const RENDER_TIMEOUT = 20_000;

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

async function expectLaidOut(name, theme) {
  const source = fixtures[name];
  expect(source, `fixture ${name} exists`).toBeTruthy();

  const { svg, major } = await renderDiagram({ source, theme });
  expect(major).toBe('11');

  const host = mount(svg);
  const el = host.querySelector('svg');
  // A real render, not a stub: the element exists and the browser gave it
  // non-zero layout (which is exactly what getBBox feeds).
  expect(el).not.toBeNull();
  const box = el.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);

  const measured = measureSvg(host);
  expect(measured.width).toBeGreaterThan(0);
  expect(measured.height).toBeGreaterThan(0);
}

describe('renderDiagram end-to-end', () => {
  // The corpus is discovered, not listed, so guard the discovery itself: a glob
  // that silently resolved to nothing would leave a suite that passes by running
  // no renders at all. parse.test.js keeps the same guard for the same reason.
  it('discovered the whole fixture corpus', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(18);
    for (const name of SUBSET) expect(ALL, `subset member ${name}`).toContain(name);
  });

  describe('every diagram type renders', () => {
    for (const name of ALL) {
      it(
        `renders ${name} to a laid-out <svg>`,
        async () => {
          await expectLaidOut(name, 'light');
        },
        RENDER_TIMEOUT,
      );
    }
  });

  describe('theme: dark', () => {
    for (const name of SUBSET) {
      it(
        `renders ${name} to a laid-out <svg>`,
        async () => {
          await expectLaidOut(name, 'dark');
        },
        RENDER_TIMEOUT,
      );
    }
  });
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

describe('the rendered diagram has a text alternative (WCAG 2.1 SC 1.1.1)', () => {
  // The acceptance test for #92, and the only place the whole chain is real:
  // Mermaid genuinely parsing accTitle/accDescr, genuinely emitting the
  // <title>/<desc> wiring, ensureAccessibleName genuinely reading it, and
  // sanitizeSvg genuinely letting it through. a11y-name.test.js unit-tests the
  // transform against markup we wrote ourselves — this proves that markup is
  // the shape Mermaid actually produces.

  /** Resolve the accessible name the way assistive tech does. */
  function accessibleName(el) {
    const label = el.getAttribute('aria-label');
    if (label) return label;
    const id = el.getAttribute('aria-labelledby');
    return id ? el.querySelector(`#${CSS.escape(id)}`)?.textContent : null;
  }

  it('names a diagram from its accTitle and describes it from accDescr', async () => {
    const { svg } = await renderDiagram({ source: fixtures['acc-labelled'] });
    const el = mount(svg).querySelector('svg');

    expect(accessibleName(el)).toBe('Deploy pipeline');
    const descId = el.getAttribute('aria-describedby');
    expect(el.querySelector(`#${CSS.escape(descId)}`).textContent).toContain('production');

    // The author supplied the alternative, so the graphic is atomic.
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-roledescription')).toBe('Flowchart diagram');
  });

  it('names an undescribed diagram after its type, keeping the text browsable', async () => {
    const { svg } = await renderDiagram({ source: fixtures.flowchart });
    const el = mount(svg).querySelector('svg');

    expect(accessibleName(el)).toBe('Flowchart diagram');
    // NOT role="img": with only a synthesised name, hiding every node label
    // behind it would lose more than it gains.
    expect(el.getAttribute('role')).toBe('graphics-document document');
    expect(el.textContent).toContain('Rethink');
  });

  it(
    'names every diagram type in the corpus',
    async () => {
      // The guarantee is unconditional, so assert it over the whole corpus rather
      // than on one type — and derived from the glob, so a new fixture is covered
      // the moment it lands.
      for (const name of SUBSET) {
        const { svg } = await renderDiagram({ source: fixtures[name] });
        const el = mount(svg).querySelector('svg');
        expect(accessibleName(el), `${name} has an accessible name`).toBeTruthy();
        expect(el.getAttribute('role'), `${name} has a role`).toBeTruthy();
      }
    },
    RENDER_TIMEOUT,
  );

  it('backfills a cached SVG that predates the naming code', async () => {
    // A cache written by an older build: Mermaid's own role was stripped by the
    // sanitizer of the day, and nothing ever named it. The view runs the same
    // two steps on this string that renderDiagram runs on a fresh render, which
    // is why no CACHE_VERSION bump was needed.
    const legacy =
      '<svg xmlns="http://www.w3.org/2000/svg" id="mmd-old-0" ' +
      'aria-roledescription="sequence" width="100" height="50">' +
      '<g><text>Alice</text></g></svg>';
    const el = mount(sanitizeSvg(ensureAccessibleName(legacy))).querySelector('svg');

    expect(accessibleName(el)).toBe('Sequence diagram');
    expect(el.getAttribute('role')).toBe('graphics-document document');
  });
});

describe('mindmap labels sit inside their nodes', () => {
  // Mermaid 11's mindmap stylesheet is missing the
  // `.node .label text { text-anchor: middle }` rule every other unified-renderer
  // diagram emits, so with htmlLabels off — which is not optional for us — the
  // label of the root circle and of every explicitly shaped node starts at the
  // node's centre and runs off its right edge. centerMindmapLabels repairs it;
  // this measures the real geometry, so it fails both if the repair regresses
  // and if a future Mermaid fixes the bug in a way that makes the repair wrong.

  /** The drawn shape: a direct child of the node group, never the label's own rects. */
  function shapeOf(node) {
    return node.querySelector(':scope > circle, :scope > rect, :scope > polygon, :scope > path');
  }

  it(
    'centres every node label horizontally, whatever the shape',
    async () => {
      const { svg } = await renderDiagram({ source: fixtures.mindmap });
      const host = mount(svg);

      const nodes = [...host.querySelectorAll('g.mindmap-node')];
      // The fixture has a root circle, a shaped node and a dozen plain ones —
      // all three code paths through Mermaid's shape helpers.
      expect(nodes.length).toBeGreaterThanOrEqual(3);
      expect(host.querySelector('g.mindmap-node > circle')).not.toBeNull();

      for (const node of nodes) {
        const text = node.querySelector('text');
        const shape = shapeOf(node);
        if (!text || !shape || !text.textContent.trim()) continue;

        const t = text.getBoundingClientRect();
        const s = shape.getBoundingClientRect();
        const label = text.textContent.trim();

        // Centred on the node, and — the user-visible half — actually inside it.
        expect(
          Math.abs((t.left + t.right) / 2 - (s.left + s.right) / 2),
          `${label} centred`,
        ).toBeLessThanOrEqual(2);
        expect(t.left, `${label} within left edge`).toBeGreaterThanOrEqual(s.left - 1);
        expect(t.right, `${label} within right edge`).toBeLessThanOrEqual(s.right + 1);
      }
    },
    RENDER_TIMEOUT,
  );
});

describe('no-orphan-on-error invariant', () => {
  // A syntax error must never leave an orphan container pinned to the document
  // (a real Mermaid failure mode). The mechanism differs per major — 11 honors
  // suppressErrorRendering so render() cleans up after its own parse failure;
  // 10 ignores that flag, so render.js screens the source with parse() first —
  // but the observable contract is one and the same. Assert both halves on both
  // majors: the rejection, and the clean document.
  const INVALID = 'flowchart TD\n  A --> B\n  C[unterminated';

  it('rejects invalid source and leaves no orphan container (major 11)', async () => {
    const before = document.querySelectorAll('div[id^="dmmd-"], div[id^="mmd-"]').length;

    await expect(renderDiagram({ source: INVALID })).rejects.toBeTruthy();

    const after = document.querySelectorAll('div[id^="dmmd-"], div[id^="mmd-"]').length;
    expect(after).toBe(before);
  });

  it(
    'rejects invalid source and leaves no orphan container (major 10)',
    async () => {
      const before = document.querySelectorAll('div[id^="dmmd-"], div[id^="mmd-"]').length;

      await expect(renderDiagram({ source: INVALID, versionPref: '10' })).rejects.toBeTruthy();

      const after = document.querySelectorAll('div[id^="dmmd-"], div[id^="mmd-"]').length;
      expect(after).toBe(before);
    },
    RENDER_TIMEOUT,
  );

  it('still reports the offending line from a render-time parse failure', async () => {
    // The editor's error gutter reads describeError(err).line. On major 11 the
    // error now surfaces from render() rather than a screening parse(); the
    // thrown object must stay line-addressable either way.
    const { describeError } = await import('../../src/lib/render.js');
    const err = await renderDiagram({ source: INVALID }).catch((e) => e);
    expect(describeError(err).line).not.toBeNull();
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

describe('concurrent renders on the shared mermaid singleton', () => {
  // initialize() writes module-global config that the render after it reads
  // back, so interleaved callers (the editor's live preview against save())
  // could produce an SVG themed for the *other* caller — the bug class behind
  // the CACHE_VERSION v1→v2 bump. render.js serializes the critical section;
  // this proves it on real renders. The ordering itself is unit-tested in
  // test/render-lock.test.js.

  /** The diagram's theme CSS with its per-render id normalized away. */
  function themeCss(svg) {
    const style = mount(svg).querySelector('style');
    return (style?.textContent ?? '').replace(/mmd-[a-z0-9]+-\d+/g, 'ID');
  }

  it(
    'concurrent light and dark renders each keep their own theme',
    async () => {
      const source = fixtures.flowchart;
      // Sequential references first — and prove the probe distinguishes them.
      const light = themeCss((await renderDiagram({ source, theme: 'light' })).svg);
      const dark = themeCss((await renderDiagram({ source, theme: 'dark' })).svg);
      expect(dark).not.toBe(light);

      const [a, b] = await Promise.all([
        renderDiagram({ source, theme: 'light' }),
        renderDiagram({ source, theme: 'dark' }),
      ]);
      expect(themeCss(a.svg)).toBe(light);
      expect(themeCss(b.svg)).toBe(dark);
    },
    RENDER_TIMEOUT,
  );
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

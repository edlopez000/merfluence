import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createEvent, fireEvent, waitFor } from '@testing-library/react';

import { CACHE_VERSION } from '../src/lib/cache.js';
import { resolvedVersion } from '../src/lib/mermaid-registry.js';

/**
 * The reader view's App state machine — the decision that makes the zero-backend
 * cache worthwhile: paint a cache hit without loading Mermaid, defer a miss until
 * it scrolls in, and only then render. main.jsx self-mounts into #root and
 * exports nothing, so we seed a #root and re-import it fresh per test rather than
 * touch source. The browser project covers the real render; here renderDiagram is
 * mocked so we can assert the orchestration in jsdom.
 */

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Stable spies shared across the module resets below.
const h = vi.hoisted(() => ({
  enableTheme: vi.fn(),
  getConfig: vi.fn(),
  onThemeChange: vi.fn(() => () => {}),
  resolveTheme: vi.fn((pref) => (pref === 'dark' ? 'dark' : 'light')),
  resize: vi.fn(),
  surfaceColor: vi.fn(),
  renderDiagram: vi.fn(),
}));

vi.mock('../src/lib/host.js', () => ({
  enableTheme: h.enableTheme,
  getConfig: h.getConfig,
  onThemeChange: h.onThemeChange,
  resolveTheme: h.resolveTheme,
  resize: h.resize,
  surfaceColor: h.surfaceColor,
}));

// Partial mock: only renderDiagram is browser-only. sanitizeSvg (the cache-hit
// re-sanitize) and describeError (the error path) stay real, so those assertions
// exercise the genuine code.
vi.mock('../src/lib/render.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, renderDiagram: h.renderDiagram };
});

// Partial mock: loadMermaid would dynamically import the real ~850KB module,
// which the speculative-warm-up assertions only need to observe, not perform.
// resolvedVersion stays real — the version-label tests assert against it.
const r = vi.hoisted(() => ({ loadMermaid: vi.fn() }));
vi.mock('../src/lib/mermaid-registry.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, loadMermaid: r.loadMermaid };
});

// The Toolbar's export buttons call into png-export, which draws to a canvas —
// covered directly by test/browser. Here we only need to prove the toolbar wires
// the click to it with the stage's <svg>, so spy the two functions.
const p = vi.hoisted(() => ({
  exportSvg: vi.fn(),
  exportPng: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/lib/png-export.js', () => ({ exportSvg: p.exportSvg, exportPng: p.exportPng }));

// jsdom implements neither observer the view relies on. Both stubs record and
// are driven by hand: the IntersectionObserver to run the deferral, the
// ResizeObserver to prove what the reader does — and does not — do with a resize
// (see the auto-fit describe at the bottom).
let ioInstances = [];
let roInstances = [];
class MockIntersectionObserver {
  constructor(cb) {
    this.cb = cb;
    this.elements = [];
    ioInstances.push(this);
  }
  observe(el) {
    this.elements.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  // Test hook: pretend the watched element scrolled into view.
  intersect() {
    this.cb(
      this.elements.map((target) => ({ isIntersecting: true, target })),
      this,
    );
  }
}

beforeEach(() => {
  for (const key of Object.keys(h)) h[key].mockReset();
  h.onThemeChange.mockReturnValue(() => {});
  h.resolveTheme.mockImplementation((pref) => (pref === 'dark' ? 'dark' : 'light'));
  // A recognizable stand-in for the resolved --ds-surface token; the real
  // light/dark resolution is covered in test/host.test.js.
  h.surfaceColor.mockImplementation((theme) => `surface-${theme}`);
  p.exportSvg.mockReset();
  p.exportPng.mockReset().mockImplementation(() => Promise.resolve());
  r.loadMermaid.mockReset().mockResolvedValue({});
  ioInstances = [];
  roInstances = [];
  globalThis.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
      roInstances.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    unobserve(target) {
      this.targets = this.targets.filter((t) => t !== target);
    }
    disconnect() {
      this.targets = [];
    }
  };
  globalThis.IntersectionObserver = MockIntersectionObserver;
  // jsdom implements none of these; the Stage/Toolbar handlers call them. Stub as
  // no-ops so the handlers run (their math is delegated to zoom.ts, tested there).
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  HTMLElement.prototype.scrollIntoView ??= () => {};
  // fullscreenElement is a read-only getter in jsdom; make it settable per test.
  setFullscreen(null);
  document.exitFullscreen = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = '';
});

async function mountView() {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  await act(async () => {
    await import('../src/view/main.jsx');
  });
}

const root = () => document.getElementById('root');

describe('empty config', () => {
  it('shows the "no diagram yet" prompt and never loads Mermaid', async () => {
    h.getConfig.mockResolvedValue({ source: '' });
    await mountView();

    expect(root().textContent).toMatch(/No diagram yet/i);
    expect(h.renderDiagram).not.toHaveBeenCalled();
  });
});

describe('cache hit', () => {
  it('paints the cached SVG, re-sanitized, without loading Mermaid', async () => {
    h.getConfig.mockResolvedValue({
      source: 'flowchart TD\n A-->B',
      theme: 'light',
      cacheV: CACHE_VERSION,
      // A tampered cache: the <script> must be stripped on the way in, proving
      // the reader re-sanitizes config it did not itself produce.
      svgLight:
        '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__viewPwned=1</script><rect id="rect-light" width="10" height="10"/></svg>',
    });
    await mountView();

    const svg = root().querySelector('svg');
    expect(svg).not.toBeNull();
    expect(root().querySelector('#rect-light')).not.toBeNull();
    expect(root().querySelector('script')).toBeNull();
    expect(window.__viewPwned).toBeUndefined();
    // The whole point: a cache hit loads zero Mermaid.
    expect(h.renderDiagram).not.toHaveBeenCalled();
  });

  // A cache written before #92 has no name and — because the sanitizer of the
  // day dropped `role` — not even the role Mermaid put there. Naming it at
  // inject time rather than at render time is what let those caches keep working
  // instead of being invalidated by a CACHE_VERSION bump, which the reader view
  // could never have repopulated (it cannot write config).
  it('gives a cached SVG that predates the naming code a text alternative', async () => {
    h.getConfig.mockResolvedValue({
      source: 'sequenceDiagram\n Alice->>John: hi',
      theme: 'light',
      cacheV: CACHE_VERSION,
      svgLight:
        '<svg xmlns="http://www.w3.org/2000/svg" id="mmd-old-0" aria-roledescription="sequence">' +
        '<g><text>Alice</text></g></svg>',
    });
    await mountView();

    const svg = root().querySelector('svg');
    expect(svg.getAttribute('aria-label')).toBe('Sequence diagram');
    expect(svg.getAttribute('role')).toBe('graphics-document document');
    expect(h.renderDiagram).not.toHaveBeenCalled();
  });
});

describe('cache miss', () => {
  it('defers until visible, then renders once with the config inputs', async () => {
    h.getConfig.mockResolvedValue({
      source: 'flowchart TD\n A-->B',
      theme: 'light',
      mermaidVersion: 'auto',
      // Set, and deliberately not the default, to prove it does NOT reach the
      // renderer: "Keep full width" is a CSS class on the Stage and the markup
      // is the same either way, so passing it would only cost a re-render.
      useMaxWidth: false,
    });
    h.renderDiagram.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect id="rect-fresh" width="10" height="10"/></svg>',
    });
    await mountView();

    // Deferred: watched, not yet rendered.
    expect(root().textContent).toMatch(/Loading diagram/i);
    expect(h.renderDiagram).not.toHaveBeenCalled();
    expect(ioInstances.length).toBe(1);

    // Scroll it into view.
    await act(async () => {
      ioInstances[0].intersect();
    });

    expect(h.renderDiagram).toHaveBeenCalledTimes(1);
    expect(h.renderDiagram).toHaveBeenCalledWith({
      source: 'flowchart TD\n A-->B',
      versionPref: 'auto',
      theme: 'light',
    });
    expect(root().querySelector('#rect-fresh')).not.toBeNull();
    expect(root().querySelector('.stage').className).toMatch(/no-shrink/);
  });
});

// The label is the diagram's provenance: a bug report quotes it. On a cache hit
// the SVG on screen was rendered by whatever version the *editor* was running at
// save time, which drifts from this bundle's as the app upgrades — so the number
// has to come from the cache, not from the registry constant (issue #37).
describe('version label', () => {
  const meta = () => root().querySelector('.meta')?.textContent;
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

  // A version this bundle cannot possibly be shipping, so a passing assertion
  // can only mean the label was read out of the cache.
  const OLD_VERSION = '11.4.0';

  it('reports the version that rendered a cached SVG, not the current build', async () => {
    h.getConfig.mockResolvedValue({
      source: 'flowchart TD\n A-->B',
      theme: 'light',
      mermaidVersion: 'auto',
      cacheV: CACHE_VERSION,
      renderedVersion: OLD_VERSION,
      svgLight: SVG,
    });
    await mountView();

    expect(meta()).toBe(`Mermaid ${OLD_VERSION}`);
    expect(meta()).not.toContain(resolvedVersion('auto'));
    expect(h.renderDiagram).not.toHaveBeenCalled();
  });

  it('falls back to the current build when a hit carries no stored version', async () => {
    // Reachable only by hand-editing config: cacheV matches but the field is
    // gone. Nothing better is knowable, so the pre-v3 label stands.
    h.getConfig.mockResolvedValue({
      source: 'flowchart TD\n A-->B',
      theme: 'light',
      mermaidVersion: 'auto',
      cacheV: CACHE_VERSION,
      svgLight: SVG,
    });
    await mountView();

    expect(meta()).toBe(`Mermaid ${resolvedVersion('auto')}`);
  });

  it('reports this build on a fresh render, ignoring a stale cached version', async () => {
    // Stale cacheV -> cache miss -> this bundle renders, so its own semver is
    // the honest label even though the config still carries an older stamp.
    h.getConfig.mockResolvedValue({
      source: 'flowchart TD\n A-->B',
      theme: 'light',
      mermaidVersion: '11',
      cacheV: CACHE_VERSION - 1,
      renderedVersion: OLD_VERSION,
      svgLight: CACHED_SVG,
    });
    h.renderDiagram.mockResolvedValue({ svg: SVG });
    await mountView();

    await act(async () => {
      ioInstances[0].intersect();
    });

    expect(meta()).toBe(`Mermaid ${resolvedVersion('11')}`);
  });
});

describe('render error', () => {
  it('surfaces the line number describeError extracts', async () => {
    h.getConfig.mockResolvedValue({ source: 'flowchart TD\n A-->B', theme: 'light' });
    h.renderDiagram.mockRejectedValue(new Error('Parse error on line 3: something'));
    await mountView();

    await act(async () => {
      ioInstances[0].intersect();
    });

    expect(root().textContent).toMatch(/syntax error on line 3/i);
    expect(root().textContent).toMatch(/Parse error on line 3/);
  });
});

describe('host theme flip', () => {
  it('re-runs the decision and swaps to the other cached variant', async () => {
    h.getConfig.mockResolvedValue({
      source: 'flowchart TD\n A-->B',
      theme: 'auto',
      cacheV: CACHE_VERSION,
      svgLight:
        '<svg xmlns="http://www.w3.org/2000/svg"><rect id="rect-light" width="10" height="10"/></svg>',
      svgDark:
        '<svg xmlns="http://www.w3.org/2000/svg"><rect id="rect-dark" width="10" height="10"/></svg>',
    });
    await mountView();

    // Registered a listener, and started on the light variant.
    expect(h.onThemeChange).toHaveBeenCalledWith(expect.any(Function));
    expect(root().querySelector('#rect-light')).not.toBeNull();
    expect(root().querySelector('#rect-dark')).toBeNull();

    // Flip the host to dark and fire the captured trigger. onThemeChange
    // re-registers whenever `decide` changes (config null -> loaded), so the live
    // handler bound to the loaded config is the most recent registration.
    const trigger = h.onThemeChange.mock.calls.at(-1)[0];
    h.resolveTheme.mockReturnValue('dark');
    await act(async () => {
      trigger();
    });

    expect(root().querySelector('#rect-dark')).not.toBeNull();
    expect(root().querySelector('#rect-light')).toBeNull();
  });
});

describe('theme trigger resolving to the same theme', () => {
  it('does not kick a freshly rendered cache miss back to deferred', async () => {
    // The expensive case the decide() gate exists for: a cache miss that has
    // already paid for its render must not be re-rendered — or even re-deferred
    // — by a theme event that resolves to the theme it was rendered with
    // (host churn, or an explicit light/dark override that ignores the host).
    h.getConfig.mockResolvedValue({ source: 'flowchart TD\n A-->B', theme: 'light' });
    h.renderDiagram.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect id="rect-fresh" width="10" height="10"/></svg>',
    });
    await mountView();
    await act(async () => {
      ioInstances[0].intersect();
    });
    expect(root().querySelector('#rect-fresh')).not.toBeNull();
    const observersBefore = ioInstances.length;

    const trigger = h.onThemeChange.mock.calls.at(-1)[0];
    await act(async () => {
      trigger();
    });

    // Still the same rendered diagram: one render total, no new observer bound,
    // never back through 'deferred'.
    expect(h.renderDiagram).toHaveBeenCalledTimes(1);
    expect(root().querySelector('#rect-fresh')).not.toBeNull();
    expect(ioInstances.length).toBe(observersBefore);
  });
});

describe('speculative Mermaid warm-up', () => {
  it('starts fetching Mermaid as soon as a miss is deferred, before visibility', async () => {
    h.getConfig.mockResolvedValue({ source: 'flowchart TD\n A-->B', theme: 'light' });
    await mountView();

    // Deferred and off-screen: the render has not run, but the module fetch has.
    expect(h.renderDiagram).not.toHaveBeenCalled();
    expect(r.loadMermaid).toHaveBeenCalledTimes(1);
    expect(r.loadMermaid).toHaveBeenCalledWith(undefined);
  });

  it('never touches Mermaid on a cache hit', async () => {
    h.getConfig.mockResolvedValue({
      source: 'flowchart TD\n A-->B',
      theme: 'light',
      cacheV: CACHE_VERSION,
      svgLight: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
    });
    await mountView();

    expect(r.loadMermaid).not.toHaveBeenCalled();
    expect(h.renderDiagram).not.toHaveBeenCalled();
  });
});

// --- Toolbar and Stage interactions -----------------------------------------
// These drive the reader view's interactive surface (the 88 lines the state-
// machine tests above never touch). A cache hit is the cheapest way to mount a
// real Stage + Toolbar with an <svg> present, without loading Mermaid.

const CACHED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect id="r" width="10" height="10"/></svg>';

async function mountReady(source = 'flowchart TD\n A-->B', theme = 'light') {
  h.getConfig.mockResolvedValue({
    source,
    theme,
    cacheV: CACHE_VERSION,
    // The cached SVG has to be under the key for the theme being resolved, or
    // this is a cache miss and Mermaid (mocked away here) would be asked to run.
    ...(theme === 'dark' ? { svgDark: CACHED_SVG } : { svgLight: CACHED_SVG }),
  });
  await mountView();
}

// Buttons are matched by trimmed visible text or aria-label, so "Fullscreen"
// never collides with the "Exit fullscreen" button inside the stage.
const btnByText = (re) =>
  [...root().querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
const btnByLabel = (re) =>
  [...root().querySelectorAll('button')].find((b) => re.test(b.getAttribute('aria-label') || ''));
const stageEl = () => root().querySelector('.stage');
// A PNG export starts one animation frame after the click — the frame that lets
// the "Exporting…" chip paint before the rasterize begins — so it is never
// observable in the click's own tick.
const waitForPng = () => waitFor(() => expect(p.exportPng).toHaveBeenCalled());
const zoomLabel = () => root().querySelector('.zoom-level')?.textContent;

/**
 * Dispatch a wheel event and let the zoom land. Stage coalesces wheel ticks
 * into one requestAnimationFrame — a trackpad delivers several per frame, and
 * each one used to force a synchronous layout — so the zoom applies on the
 * next frame rather than inside the dispatch.
 */
async function wheel(el, init) {
  await act(async () => {
    el.dispatchEvent(new WheelEvent('wheel', { cancelable: true, ...init }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

// fullscreenElement is a getter in jsdom; redefine it so a test can pretend the
// stage is (or isn't) the fullscreen element.
function setFullscreen(el) {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: el });
}

describe('toolbar: copy source', () => {
  it('writes the source to the clipboard and flips the label to Copied', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await mountReady('graph TD\n X-->Y');

    await act(async () => {
      fireEvent.click(btnByText(/^copy source$/i));
    });

    expect(writeText).toHaveBeenCalledWith('graph TD\n X-->Y');
    expect(btnByText(/^copied$/i)).toBeTruthy();
  });

  it('surfaces a blocked-clipboard failure visibly, not only to screen readers', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('blocked')));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await mountReady();

    await act(async () => {
      fireEvent.click(btnByText(/^copy source$/i));
    });

    // A sighted user just watched the button do nothing, so the message has to be
    // on screen — it used to render into an sr-only span.
    const status = root().querySelector('[role="status"]');
    expect(status.textContent).toMatch(/clipboard is blocked/i);
    expect(status.className).not.toMatch(/sr-only/);
  });
});

describe('toolbar: export menu', () => {
  it('opens on click and dismisses on Escape and on an outside click', async () => {
    await mountReady();

    fireEvent.click(btnByText(/^export/i));
    expect(root().querySelector('.export-menu')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(root().querySelector('.export-menu')).toBeNull();

    // Reopen, then click outside the export container to close.
    fireEvent.click(btnByText(/^export/i));
    expect(root().querySelector('.export-menu')).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(root().querySelector('.export-menu')).toBeNull();
  });

  it('exports SVG and PNG with the stage svg, closing the menu each time', async () => {
    await mountReady();

    fireEvent.click(btnByText(/^export/i));
    fireEvent.click(btnByText(/^svg$/i));
    expect(p.exportSvg).toHaveBeenCalledTimes(1);
    expect(p.exportSvg.mock.calls[0][0].tagName.toLowerCase()).toBe('svg');
    expect(root().querySelector('.export-menu')).toBeNull();

    fireEvent.click(btnByText(/^export/i));
    fireEvent.click(btnByText(/^png \(transparent\)$/i));
    // Not called in the same tick, deliberately: savePng waits a frame first so
    // the "Exporting…" chip paints before the rasterize starts (see MIN_BUSY_MS
    // in src/view/main.tsx). Every PNG assertion below has to wait for it.
    await waitForPng();
    expect(p.exportPng).toHaveBeenCalledTimes(1);
    expect(p.exportPng.mock.calls[0][0].tagName.toLowerCase()).toBe('svg');
  });

  // Both exports used to be called `diagram`, so saving three of them produced
  // `diagram (2).png`. What the name is built from is export-name.js's problem
  // and is tested there; what this pins is the wiring — that the toolbar hands
  // it the *source* (hence the title showing up) and the *stage's* SVG, and that
  // both formats go through it.
  it('names both downloads after the diagram, with a timestamp', async () => {
    await mountReady('---\ntitle: Deploy pipeline\n---\nflowchart TD\n A-->B');

    fireEvent.click(btnByText(/^export/i));
    fireEvent.click(btnByText(/^svg$/i));
    const svgName = p.exportSvg.mock.calls[0][1];
    expect(svgName).toMatch(/^deploy-pipeline-\d{8}-\d{6}\.svg$/);

    fireEvent.click(btnByText(/^export/i));
    fireEvent.click(btnByText(/^png \(with background\)$/i));
    await waitForPng();
    const pngName = p.exportPng.mock.calls[0][1].filename;
    expect(pngName).toMatch(/^deploy-pipeline-\d{8}-\d{6}\.png$/);
  });

  it('surfaces a PNG export failure', async () => {
    p.exportPng.mockImplementation(() => Promise.reject(new Error('canvas tainted')));
    await mountReady();

    fireEvent.click(btnByText(/^export/i));
    fireEvent.click(btnByText(/^png \(with background\)$/i));
    await waitForPng();

    await waitFor(() => expect(root().textContent).toMatch(/canvas tainted/i));
  });
});

// --- Transparent is not always the export you want ---------------------------
// Mermaid paints no backdrop, so the PNG was transparent and nothing said so.
// That composites beautifully onto a coloured slide and disappears when pasted
// into dark-mode Slack, where a dark-themed diagram is light text on nothing.
// Both are now offered explicitly; which pixels each produces is asserted in
// test/browser/export.e2e.test.js, where there is a real canvas to read back.
describe('toolbar: PNG background choice', () => {
  const menuItems = () =>
    [...root().querySelectorAll('.export-menu [role="menuitem"]')].map((b) => b.textContent.trim());

  it('offers both variants, with the safer paste first', async () => {
    await mountReady();
    fireEvent.click(btnByText(/^export/i));

    // Order is the feature: the top item is the one that survives being pasted
    // onto an unknown backdrop, and it is where the old plain "PNG" item sat.
    expect(menuItems()).toEqual(['PNG (with background)', 'PNG (transparent)', 'SVG']);
  });

  it('paints the stage surface colour for the resolved theme', async () => {
    await mountReady('flowchart TD\n A-->B', 'dark');

    fireEvent.click(btnByText(/^export/i));
    fireEvent.click(btnByText(/^png \(with background\)$/i));
    await waitForPng();

    // The diagram rendered dark, so the backdrop is resolved for dark too —
    // white behind a dark diagram is the unreadable case.
    expect(h.surfaceColor).toHaveBeenCalledWith('dark');
    expect(p.exportPng.mock.calls[0][1]).toMatchObject({ background: 'surface-dark' });
  });

  it('asks for no background at all on the transparent variant', async () => {
    await mountReady();

    fireEvent.click(btnByText(/^export/i));
    fireEvent.click(btnByText(/^png \(transparent\)$/i));
    await waitForPng();

    // null, not a colour: this is the export that has to stay alpha-zero. An
    // absent key would default to null too, so assert the key is really there.
    expect(p.exportPng.mock.calls[0][1]).toHaveProperty('background', null);
  });
});

// --- The export is not instant, and used to say so to nobody -----------------
// A PNG is rasterized at twice the diagram's own size and encoded; that is fast
// but not free, and the toolbar it was clicked from fades out as soon as the
// pointer leaves (`.root:hover .toolbar`). So the click produced no
// acknowledgement at all, and the natural response — click it again — started a
// second full-size encode on top of the first.
describe('toolbar: PNG export progress', () => {
  /** An export that stays in flight until the test resolves it. */
  function deferExport() {
    let settle;
    p.exportPng.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle = { resolve, reject };
        }),
    );
    return {
      finish: async () => {
        await act(async () => settle.resolve());
      },
      fail: async (message) => {
        await act(async () => settle.reject(new Error(message)));
      },
    };
  }

  const busy = () => root().querySelector('.status.busy');

  async function startExport() {
    fireEvent.click(btnByText(/^export/i));
    fireEvent.click(btnByText(/^png \(with background\)$/i));
    await waitForPng();
  }

  it('shows a live-region chip for as long as the export runs', async () => {
    const held = deferExport();
    await mountReady();

    expect(busy()).toBeNull();
    await startExport();

    // Announced politely rather than silently drawn: this is the only signal a
    // screen-reader user gets that the button did anything.
    expect(busy()).not.toBeNull();
    expect(busy().getAttribute('role')).toBe('status');
    expect(busy().textContent).toMatch(/exporting/i);

    // It is a .status element, which is what `.toolbar:has(.status)` keys the
    // toolbar's visibility on — that rule is what keeps the toolbar on screen
    // once the pointer has moved off the macro.
    expect(busy().classList.contains('status')).toBe(true);

    await held.finish();
    await waitFor(() => expect(busy()).toBeNull());
  });

  it('cannot be told to export twice while one is running', async () => {
    const held = deferExport();
    await mountReady();
    await startExport();

    // The trigger is disabled, so the menu cannot even be reopened...
    expect(btnByText(/^export/i).disabled).toBe(true);
    fireEvent.click(btnByText(/^export/i));
    expect(root().querySelector('.export-menu')).toBeNull();

    await held.finish();
    await waitFor(() => expect(busy()).toBeNull());
    expect(p.exportPng).toHaveBeenCalledTimes(1);
  });

  it('clears the chip when the export fails, and shows why', async () => {
    const held = deferExport();
    await mountReady();
    await startExport();

    await held.fail('canvas tainted');

    // The finally path: a failure must not strand the toolbar in "Exporting…".
    await waitFor(() => expect(busy()).toBeNull());
    expect(root().textContent).toMatch(/canvas tainted/i);
    expect(btnByText(/^export/i).disabled).toBe(false);
  });
});

describe('toolbar: zoom controls', () => {
  it('zoom in raises the level and Reset returns it to 100%', async () => {
    await mountReady();
    expect(zoomLabel()).toBe('100%');

    fireEvent.click(btnByLabel(/zoom in/i));
    expect(zoomLabel()).toBe('120%');

    fireEvent.click(btnByLabel(/zoom out/i));
    expect(zoomLabel()).toBe('100%');

    fireEvent.click(btnByLabel(/zoom in/i));
    fireEvent.click(btnByLabel(/reset view/i));
    expect(zoomLabel()).toBe('100%');
  });

  // The visible label is the level, so the name must carry it (SC 2.5.3), and
  // it is the only announcement a screen-reader user gets that zoom moved.
  it('names the reset control with the current zoom level', async () => {
    await mountReady();
    expect(btnByLabel(/reset view/i).getAttribute('aria-label')).toBe('Reset view, currently 100%');

    fireEvent.click(btnByLabel(/zoom in/i));
    expect(btnByLabel(/reset view/i).getAttribute('aria-label')).toBe('Reset view, currently 120%');
  });

  // The zoom gesture's only mouse-discoverable surface. The .keys chip names it
  // too, but only on :focus-visible, and the scroll-to-zoom pill only fires for
  // someone who already scrolled and got the page instead — so a reader who
  // hovers and clicks these buttons would otherwise never learn the shortcut.
  it('names the scroll shortcut in the zoom buttons’ tooltips', async () => {
    await mountReady();

    // Either modifier: modifierLabel() reads navigator.userAgentData/platform and
    // resolves to Ctrl under jsdom. Pinning the glyph would test the platform
    // sniff, which host.test.js-style unit coverage owns, rather than the wording.
    expect(btnByLabel(/^zoom in$/i).getAttribute('title')).toMatch(/(⌘|Ctrl) \+ scroll/);
    expect(btnByLabel(/^zoom out$/i).getAttribute('title')).toMatch(/(⌘|Ctrl) \+ scroll/);
  });

  // The load-bearing half of the pair above. A future edit "helpfully" folding the
  // tooltip into the accessible name would push a mouse-only gesture into what a
  // screen-reader user hears for a button they reach by keyboard — and would put
  // text in the name that is not in the visible label (WCAG 2.1 SC 2.5.3).
  it('keeps the gesture out of the accessible name', async () => {
    await mountReady();

    expect(btnByLabel(/^zoom in$/i).getAttribute('aria-label')).toBe('Zoom in');
    expect(btnByLabel(/^zoom out$/i).getAttribute('aria-label')).toBe('Zoom out');
  });
});

describe('toolbar: fullscreen', () => {
  it('requests fullscreen on the stage, and exits when already fullscreen', async () => {
    await mountReady();
    const stage = stageEl();
    stage.requestFullscreen = vi.fn();

    setFullscreen(null);
    fireEvent.click(btnByText(/^fullscreen$/i));
    expect(stage.requestFullscreen).toHaveBeenCalledTimes(1);

    setFullscreen(stage);
    fireEvent.click(btnByText(/^fullscreen$/i));
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  // A host that refuses fullscreen rejects the promise rather than throwing.
  // The reader is granted it in practice, so this path exists for the config
  // modal's iframe — but the fallback lives in the shared Stage, so it is
  // reachable from here too and is asserted where the rest of Stage is.
  it('falls back to the CSS maximize when requestFullscreen rejects', async () => {
    await mountReady();
    const stage = stageEl();
    stage.requestFullscreen = vi.fn(() => Promise.reject(new TypeError('blocked')));

    await act(async () => {
      fireEvent.click(btnByText(/^fullscreen$/i));
    });
    expect(stage.className).toMatch(/maximized/);

    // The button stays a toggle: pressing it again leaves the fallback.
    await act(async () => {
      fireEvent.click(btnByText(/^fullscreen$/i));
    });
    expect(stage.className).not.toMatch(/maximized/);
  });

  it('snapshots on enter and restores + scrolls back on exit', async () => {
    await mountReady();
    const stage = stageEl();
    const scrollIntoView = vi.fn();
    stage.scrollIntoView = scrollIntoView;

    // Enter: resets to a fitted whole-diagram view (fitToStage no-ops on jsdom's
    // zero-size rects, but the enter branch still runs).
    setFullscreen(stage);
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    // Exit: restores the snapshot and scrolls the macro back into view.
    setFullscreen(null);
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(scrollIntoView).toHaveBeenCalled();
  });
});

describe('stage: wheel zoom', () => {
  it('ctrl+wheel zooms toward the cursor', async () => {
    await mountReady();
    expect(zoomLabel()).toBe('100%');

    await wheel(stageEl(), { deltaY: -100, ctrlKey: true, clientX: 5, clientY: 5 });

    // 1 - (-100 * 0.002) = 1.2 -> 120%.
    expect(zoomLabel()).toBe('120%');
  });

  it('ignores a plain wheel (no ctrl/meta) while inline', async () => {
    await mountReady();

    await wheel(stageEl(), { deltaY: -100 });

    expect(zoomLabel()).toBe('100%');
  });

  it('applies a burst of ticks once, summing the deltas', async () => {
    // The coalescing has to be exact, not approximate: the zoom is exponential
    // in the total delta, so summing before applying gives the same result the
    // per-event path did — one repaint instead of four.
    await mountReady();

    await act(async () => {
      for (let i = 0; i < 4; i++) {
        stageEl().dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -25,
            ctrlKey: true,
            clientX: 5,
            clientY: 5,
            cancelable: true,
          }),
        );
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(zoomLabel()).toBe('120%'); // same as one -100 tick
  });
});

/**
 * The hint that names ⌘/Ctrl + scroll.
 *
 * The behaviour under test is mostly a negative: a plain wheel over an inline
 * diagram must keep scrolling the Confluence page it sits in, exactly as it did
 * before the hint existed. The hint is a label drawn over a gesture we
 * deliberately do not claim, and the assertion that it stays uncancelled is the
 * one that keeps it that way.
 *
 * Only Date and the timeouts are faked: requestAnimationFrame has to stay real,
 * because the wheel() helper above awaits one to let a zoom land.
 */
describe('stage: scroll-to-zoom hint', () => {
  const HINT_DWELL_MS = 250;
  const HINT_LINGER_MS = 1800;

  const hintShown = () => root().querySelector('.zoom-hint')?.classList.contains('show') ?? false;

  // Two plain wheels far enough apart to read as one continuing gesture — what
  // someone does when they scroll, see the page move, and try again.
  async function keepScrolling(el, at = { clientX: 0, clientY: 0 }) {
    await wheel(el, { deltaY: 100, ...at });
    await act(async () => {
      vi.advanceTimersByTime(HINT_DWELL_MS + 50);
    });
    await wheel(el, { deltaY: 100, ...at });
  }

  const fakeClock = () => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the gesture once a plain scroll keeps going over the diagram', async () => {
    await mountReady();
    fakeClock();

    await keepScrolling(stageEl());

    expect(hintShown()).toBe(true);
    expect(root().querySelector('.zoom-hint').textContent).toMatch(/scroll to zoom/i);
  });

  it('places itself on the cursor, not in the middle of the diagram', async () => {
    // The stage is as tall as the diagram, so its centre is often scrolled well
    // out of view in the host page — which we cannot measure from inside a
    // cross-origin iframe. The cursor is the one point we know they can see.
    await mountReady();
    const stage = stageEl();
    stage.getBoundingClientRect = () => ({
      left: 20,
      top: 40,
      width: 800,
      height: 2000, // a long diagram: centring would put the hint at y=1000
    });
    fakeClock();

    await keepScrolling(stage, { clientX: 320, clientY: 190 });

    const style = root().querySelector('.zoom-hint').style;
    expect(style.left).toBe('300px'); // 320 - 20
    expect(style.top).toBe('150px'); // 190 - 40
  });

  it('stays quiet for a single flick past the diagram', async () => {
    // The common case by far: a reader scrolling down a page whose cursor
    // crosses a diagram on the way. One burst, then gone — no hint.
    await mountReady();
    fakeClock();

    await wheel(stageEl(), { deltaY: 100 });
    await act(async () => {
      vi.advanceTimersByTime(HINT_DWELL_MS + 50);
    });

    expect(hintShown()).toBe(false);
  });

  it('never consumes the scroll, hint or no hint', async () => {
    // The load-bearing one. If this ever fails, the hint has become the scroll
    // trap it exists to avoid: the Confluence page would freeze around every
    // diagram the cursor happens to cross.
    await mountReady();
    fakeClock();

    await keepScrolling(stageEl());
    expect(hintShown()).toBe(true);

    let event;
    await act(async () => {
      event = new WheelEvent('wheel', { deltaY: 100, cancelable: true });
      stageEl().dispatchEvent(event);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(event.defaultPrevented).toBe(false);
    expect(zoomLabel()).toBe('100%'); // and it did not zoom either
  });

  it('drops the hint for good once the user zooms with the modifier', async () => {
    await mountReady();
    fakeClock();

    await keepScrolling(stageEl());
    expect(hintShown()).toBe(true);

    // A trackpad pinch arrives as exactly this event, so it counts as learning
    // the gesture too.
    await wheel(stageEl(), { deltaY: -100, ctrlKey: true, clientX: 5, clientY: 5 });
    expect(hintShown()).toBe(false);
    expect(zoomLabel()).toBe('120%');

    await keepScrolling(stageEl());
    expect(hintShown()).toBe(false);
  });

  it('says nothing when maximized, where a plain wheel already zooms', async () => {
    await mountReady();
    setFullscreen(stageEl());
    fakeClock();

    await wheel(stageEl(), { deltaY: -100, clientX: 5, clientY: 5 });

    expect(zoomLabel()).toBe('120%');
    expect(hintShown()).toBe(false);
  });

  it('fades out on its own after the scrolling stops', async () => {
    await mountReady();
    fakeClock();

    await keepScrolling(stageEl());
    expect(hintShown()).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(HINT_LINGER_MS + 50);
    });

    expect(hintShown()).toBe(false);
  });
});

describe('stage: pointer pan', () => {
  it('pans by the drag delta and clears the dragging state on release', async () => {
    await mountReady();
    const stage = stageEl();

    fireEvent.pointerDown(stage, { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 });
    expect(stage.className).toMatch(/dragging/);

    fireEvent.pointerMove(stage, { clientX: 30, clientY: 20, buttons: 1 });
    expect(root().querySelector('.pan').style.transform).toContain('translate(30px, 20px)');

    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(stage.className).not.toMatch(/dragging/);
  });

  it('ends a stuck drag when a later move reports no buttons held', async () => {
    await mountReady();
    const stage = stageEl();

    fireEvent.pointerDown(stage, { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 });
    expect(stage.className).toMatch(/dragging/);

    // The release happened off-iframe: no pointerup reached us; the next move with
    // buttons=0 is the backstop that ends the drag.
    fireEvent.pointerMove(stage, { clientX: 10, clientY: 10, buttons: 0 });
    expect(stage.className).not.toMatch(/dragging/);
  });

  it('ends the drag on lostpointercapture', async () => {
    await mountReady();
    const stage = stageEl();

    fireEvent.pointerDown(stage, { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 });
    fireEvent.lostPointerCapture(stage, { pointerId: 1 });
    expect(stage.className).not.toMatch(/dragging/);
  });

  it('moves the layer without re-rendering, and hands the position back on release', async () => {
    // A drag writes .pan's transform straight to the DOM: a pointermove stream
    // is one event per frame at best, and re-rendering Stage and its toolbar on
    // each was the cost. React state has to catch up on release, or the next
    // render would snap the diagram back to where the drag started.
    await mountReady();
    const stage = stageEl();
    const pan = root().querySelector('.pan');
    const svgBefore = root().querySelector('svg');

    fireEvent.pointerDown(stage, { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 });
    for (const [x, y] of [
      [10, 5],
      [20, 12],
      [30, 20],
    ]) {
      fireEvent.pointerMove(stage, { clientX: x, clientY: y, buttons: 1 });
    }
    expect(pan.style.transform).toContain('translate(30px, 20px)');
    // Same nodes throughout: nothing was re-created under the gesture.
    expect(root().querySelector('.pan')).toBe(pan);
    expect(root().querySelector('svg')).toBe(svgBefore);

    fireEvent.pointerUp(stage, { pointerId: 1 });
    // State now agrees with the DOM — asserted through a re-render the drag did
    // not cause, so a state that lagged behind would show up as a snap-back.
    await act(async () => {
      fireEvent.keyDown(stage, { key: 'ArrowLeft' });
    });
    expect(pan.style.transform).toContain('translate(62px, 20px)'); // 30 + PAN_STEP
  });

  it('survives a re-render that lands mid-gesture', async () => {
    // The gesture writes the DOM behind React's back, so a re-render arriving
    // mid-drag must not repaint the layer from the pan state React still holds.
    // It doesn't: React patches only the style props that changed between
    // renders, and pan state is untouched during the drag. Pinned because the
    // direct-DOM write depends on that.
    await mountReady();
    const stage = stageEl();

    await act(async () => {
      fireEvent.pointerDown(stage, { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 });
      fireEvent.pointerMove(stage, { clientX: 40, clientY: 25, buttons: 1 });
    });

    expect(root().querySelector('.pan').style.transform).toContain('translate(40px, 25px)');
  });
});

// --- Keyboard operability (WCAG 2.1 SC 2.1.1) --------------------------------
// Without these keys the diagram is reachable only with a pointer. The zoom math
// is zoom.ts's (tested there); what's asserted here is that each key reaches the
// right action, and that the guards keep the rest of the keyboard working.

describe('stage: keyboard', () => {
  const panTransform = () => root().querySelector('.pan').style.transform;

  it('is focusable and names its shortcuts', async () => {
    await mountReady();
    const stage = stageEl();

    expect(stage.tabIndex).toBe(0);
    expect(stage.getAttribute('aria-roledescription')).toBe('interactive diagram');
    expect(stage.getAttribute('aria-label')).toMatch(/arrow keys/i);

    stage.focus();
    expect(document.activeElement).toBe(stage);
  });

  it('arrows pan the view, Shift pans further, and the page never scrolls', async () => {
    await mountReady();
    const stage = stageEl();

    // Arrows move the view, so the pan translation moves the other way:
    // ArrowRight reveals what is off the right edge.
    const right = createEvent.keyDown(stage, { key: 'ArrowRight' });
    fireEvent(stage, right);
    expect(panTransform()).toContain('translate(-32px, 0px)');
    // Suppressed, or the arrow would scroll the page out from under the diagram.
    expect(right.defaultPrevented).toBe(true);

    fireEvent.keyDown(stage, { key: 'ArrowDown' });
    expect(panTransform()).toContain('translate(-32px, -32px)');

    fireEvent.keyDown(stage, { key: 'ArrowLeft', shiftKey: true });
    expect(panTransform()).toContain('translate(96px, -32px)');

    fireEvent.keyDown(stage, { key: 'ArrowUp', shiftKey: true });
    expect(panTransform()).toContain('translate(96px, 96px)');
  });

  it('+, = and - zoom by the same step as the toolbar buttons', async () => {
    await mountReady();

    fireEvent.keyDown(stageEl(), { key: '+' });
    expect(zoomLabel()).toBe('120%');

    // '=' is the unshifted key '+' sits on, so it zooms in too. The step is a
    // ratio, not an addend (see ZOOM_STEP), so two of them compound to 1.2^2
    // rather than adding to 140% — which is what keeps one press meaning the
    // same proportional change at every scale.
    fireEvent.keyDown(stageEl(), { key: '=' });
    expect(zoomLabel()).toBe('144%');

    // ...and '-' is its exact inverse, so it lands back where '+' left off.
    fireEvent.keyDown(stageEl(), { key: '-' });
    expect(zoomLabel()).toBe('120%');
  });

  it('0 resets both pan and zoom', async () => {
    await mountReady();
    const stage = stageEl();

    fireEvent.keyDown(stage, { key: 'ArrowRight' });
    fireEvent.keyDown(stage, { key: '+' });
    expect(zoomLabel()).toBe('120%');

    fireEvent.keyDown(stage, { key: '0' });
    expect(zoomLabel()).toBe('100%');
    expect(panTransform()).toContain('translate(0px, 0px)');
  });

  it('0 still resets in fullscreen, where the toolbar is hidden', async () => {
    await mountReady();
    const stage = stageEl();
    setFullscreen(stage);

    fireEvent.keyDown(stage, { key: 'ArrowRight' });
    // The fit runs first here, but jsdom's zero-size rects make it a no-op
    // (fitView returns null), so the plain reset behind it is what lands.
    fireEvent.keyDown(stage, { key: '0' });
    expect(panTransform()).toContain('translate(0px, 0px)');
  });

  it('f toggles fullscreen', async () => {
    await mountReady();
    const stage = stageEl();
    stage.requestFullscreen = vi.fn();

    fireEvent.keyDown(stage, { key: 'f' });
    expect(stage.requestFullscreen).toHaveBeenCalledTimes(1);

    setFullscreen(stage);
    fireEvent.keyDown(stage, { key: 'F' });
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('shows the shortcuts, without repeating them to a screen reader', async () => {
    await mountReady();
    const keys = root().querySelector('.keys');

    // Visibility is CSS's job (:has(:focus-visible), and which variant shows is
    // :fullscreen's); what matters here is that the hint exists, reads correctly
    // in each mode, and is muted for screen readers — the stage's aria-label
    // already reads the same list.
    expect(keys.querySelector('.keys-inline').textContent).toMatch(/pan.+zoom.+full screen/i);
    expect(keys.querySelector('.keys-fs').textContent).toMatch(/exit full screen/i);
    // Escape is deliberately absent: getting out with Esc is what a user expects
    // anyway, so the chip spends its room on the keys they can't guess.
    expect(keys.textContent).not.toMatch(/esc/i);
    expect(stageEl().getAttribute('aria-label')).toMatch(/escape/i);
    expect(keys.getAttribute('aria-hidden')).toBe('true');
  });

  it('works from the toolbar too, which the stage handler alone never sees', async () => {
    await mountReady();
    const stage = stageEl();
    stage.requestFullscreen = vi.fn();
    const button = btnByText(/^copy source$/i);
    button.focus();

    fireEvent.keyDown(button, { key: '+' });
    expect(zoomLabel()).toBe('120%');

    fireEvent.keyDown(button, { key: '0' });
    expect(zoomLabel()).toBe('100%');

    fireEvent.keyDown(button, { key: 'f' });
    expect(stage.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('Escape releases the diagram so it stops swallowing keys', async () => {
    await mountReady();
    const stage = stageEl();
    stage.focus();
    fireEvent.keyDown(stage, { key: 'ArrowRight' });
    expect(panTransform()).toContain('translate(-32px, 0px)');

    fireEvent.keyDown(stage, { key: 'Escape' });
    expect(document.activeElement).not.toBe(stage);
  });

  it('Escape leaves fullscreen to the browser rather than dropping focus', async () => {
    await mountReady();
    const stage = stageEl();
    stage.focus();
    setFullscreen(stage);

    // The browser may not even deliver this keydown; either way we don't fight
    // it. The release rides on the exit itself — see the two tests below.
    fireEvent.keyDown(stage, { key: 'Escape' });
    expect(document.activeElement).toBe(stage);
  });

  it('releases the keyboard when the browser exits fullscreen (one Escape, not two)', async () => {
    await mountReady();
    const stage = stageEl();
    stage.focus();

    setFullscreen(stage);
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    // Escape's exit: nothing of ours asked for it. Entering took focus, so
    // without the release the diagram lands back inline still eating arrows.
    setFullscreen(null);
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(document.activeElement).not.toBe(stage);
  });

  it('keeps focus when F leaves fullscreen, so it stays a toggle', async () => {
    await mountReady();
    const stage = stageEl();
    stage.requestFullscreen = vi.fn();
    stage.focus();

    setFullscreen(stage);
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    // Our own exit: F asked for it, so focus stays put and F can go back in.
    fireEvent.keyDown(stage, { key: 'f' });
    expect(document.exitFullscreen).toHaveBeenCalled();
    setFullscreen(null);
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(document.activeElement).toBe(stage);
  });

  it('Escape with the export menu open closes the menu and keeps focus', async () => {
    await mountReady();
    const exportBtn = btnByText(/^export/i);
    fireEvent.click(exportBtn);
    exportBtn.focus();
    expect(root().querySelector('.export-menu')).not.toBeNull();

    fireEvent.keyDown(exportBtn, { key: 'Escape' });
    expect(root().querySelector('.export-menu')).toBeNull();
    // One Escape, one effect: the menu closed, the user keeps their place.
    expect(document.activeElement).toBe(exportBtn);
  });

  it('takes focus on entering fullscreen, where the toolbar is gone', async () => {
    await mountReady();
    const stage = stageEl();

    // Entering from the toolbar button leaves focus on a button outside the
    // fullscreen element; the keys have to land on the stage regardless.
    btnByText(/^fullscreen$/i).focus();
    setFullscreen(stage);
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(document.activeElement).toBe(stage);
  });

  it('leaves modified chords, unhandled keys, and text controls alone', async () => {
    await mountReady();
    const stage = stageEl();

    // A browser/OS chord is not ours to swallow.
    const chord = createEvent.keyDown(stage, { key: 'ArrowRight', ctrlKey: true });
    fireEvent(stage, chord);
    expect(panTransform()).toContain('translate(0px, 0px)');
    expect(chord.defaultPrevented).toBe(false);

    // An unhandled key falls straight through — Tab must still move focus.
    const tab = createEvent.keyDown(stage, { key: 'Tab' });
    fireEvent(stage, tab);
    expect(tab.defaultPrevented).toBe(false);

    // A text control inside the stage owns its own arrows and digits.
    const input = document.createElement('input');
    stage.appendChild(input);
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(panTransform()).toContain('translate(0px, 0px)');
  });
});

// --- The reader does not auto-fit ---------------------------------------------
// Stage's autoFit is opt-in and only the editor's preview opts in. That is not a
// preference: "Keep full width" here deliberately clips a diagram wider than the
// column and lets the user pan to the rest (see the no-shrink rules in
// src/view/index.html), which a shrink-to-fit would silently undo — and the
// reader sizes its own iframe from the measured content, so fitting to that
// content would be circular. These are the guards for that.
describe('stage: the reader never fits inline', () => {
  const panTransform = () => root().querySelector('.pan').style.transform;

  // Give the stage a diagram far too tall for it, i.e. exactly what makes the
  // editor's preview shrink.
  function stubOversized() {
    root().querySelector('.stage').getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
    });
    root().querySelector('.pan').getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 400,
      height: 800,
    });
  }

  it('binds no observer on the content layer at all', async () => {
    await mountReady();
    const pan = root().querySelector('.pan');
    // The content observer is autoFit's trigger and is not bound without it, so
    // this fails loudly if the prop's default is ever flipped.
    expect(roInstances.some((o) => o.targets.includes(pan))).toBe(false);
    expect(roInstances.some((o) => o.targets.includes(root().querySelector('.stage')))).toBe(true);
  });

  it('leaves an oversized diagram at 100% when the column resizes', async () => {
    await mountReady();
    stubOversized();

    await act(async () => {
      for (const o of roInstances) o.cb([], o);
    });

    expect(zoomLabel()).toBe('100%');
    expect(panTransform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('still magnifies to fill the screen when maximized', async () => {
    await mountReady();
    const stage = stageEl();
    // Small enough that the two policies disagree: fullscreen scales it up 2x,
    // where a shrink-only fit would leave it at 1:1.
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 });
    root().querySelector('.pan').getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 150,
    });

    setFullscreen(stage);
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(zoomLabel()).toBe('200%');
  });
});

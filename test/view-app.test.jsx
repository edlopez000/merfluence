import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';

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
  renderDiagram: vi.fn(),
}));

vi.mock('../src/lib/host.js', () => ({
  enableTheme: h.enableTheme,
  getConfig: h.getConfig,
  onThemeChange: h.onThemeChange,
  resolveTheme: h.resolveTheme,
  resize: h.resize,
}));

// Partial mock: only renderDiagram is browser-only. sanitizeSvg (the cache-hit
// re-sanitize) and describeError (the error path) stay real, so those assertions
// exercise the genuine code.
vi.mock('../src/lib/render.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, renderDiagram: h.renderDiagram };
});

// The Toolbar's export buttons call into png-export, which draws to a canvas —
// covered directly by test/browser. Here we only need to prove the toolbar wires
// the click to it with the stage's <svg>, so spy the two functions.
const p = vi.hoisted(() => ({
  download: vi.fn(),
  exportPng: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/lib/png-export.js', () => ({ download: p.download, exportPng: p.exportPng }));

// jsdom implements neither observer the view relies on. Stub ResizeObserver
// (Stage binds one) and make IntersectionObserver controllable so we can drive
// the deferral by hand.
let ioInstances = [];
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
  p.download.mockReset();
  p.exportPng.mockReset().mockImplementation(() => Promise.resolve());
  ioInstances = [];
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
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
      cacheV: 2,
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
});

describe('cache miss', () => {
  it('defers until visible, then renders once with the config inputs', async () => {
    h.getConfig.mockResolvedValue({
      source: 'flowchart TD\n A-->B',
      theme: 'light',
      mermaidVersion: 'auto',
      useMaxWidth: true,
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
      useMaxWidth: true,
    });
    expect(root().querySelector('#rect-fresh')).not.toBeNull();
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
      cacheV: 2,
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

// --- Toolbar and Stage interactions -----------------------------------------
// These drive the reader view's interactive surface (the 88 lines the state-
// machine tests above never touch). A cache hit is the cheapest way to mount a
// real Stage + Toolbar with an <svg> present, without loading Mermaid.

const CACHED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect id="r" width="10" height="10"/></svg>';

async function mountReady(source = 'flowchart TD\n A-->B') {
  h.getConfig.mockResolvedValue({ source, theme: 'light', cacheV: 2, svgLight: CACHED_SVG });
  await mountView();
}

// Buttons are matched by trimmed visible text or aria-label, so "Fullscreen"
// never collides with the "Exit fullscreen" button inside the stage.
const btnByText = (re) =>
  [...root().querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
const btnByLabel = (re) =>
  [...root().querySelectorAll('button')].find((b) => re.test(b.getAttribute('aria-label') || ''));
const stageEl = () => root().querySelector('.stage');
const zoomLabel = () => root().querySelector('.zoom-level')?.textContent;

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

  it('surfaces a blocked-clipboard failure instead of throwing', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('blocked')));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await mountReady();

    await act(async () => {
      fireEvent.click(btnByText(/^copy source$/i));
    });

    expect(root().textContent).toMatch(/clipboard is blocked/i);
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
    expect(p.download).toHaveBeenCalledTimes(1);
    const [blob, name] = p.download.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(name).toBe('diagram.svg');
    expect(root().querySelector('.export-menu')).toBeNull();

    fireEvent.click(btnByText(/^export/i));
    await act(async () => {
      fireEvent.click(btnByText(/^png$/i));
    });
    expect(p.exportPng).toHaveBeenCalledTimes(1);
    expect(p.exportPng.mock.calls[0][0].tagName.toLowerCase()).toBe('svg');
  });

  it('surfaces a PNG export failure', async () => {
    p.exportPng.mockImplementation(() => Promise.reject(new Error('canvas tainted')));
    await mountReady();

    fireEvent.click(btnByText(/^export/i));
    await act(async () => {
      fireEvent.click(btnByText(/^png$/i));
    });

    expect(root().textContent).toMatch(/canvas tainted/i);
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

    await act(async () => {
      stageEl().dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -100,
          ctrlKey: true,
          clientX: 5,
          clientY: 5,
          cancelable: true,
        }),
      );
    });

    // 1 - (-100 * 0.002) = 1.2 -> 120%.
    expect(zoomLabel()).toBe('120%');
  });

  it('ignores a plain wheel (no ctrl/meta) while inline', async () => {
    await mountReady();

    await act(async () => {
      stageEl().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    });

    expect(zoomLabel()).toBe('100%');
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
});

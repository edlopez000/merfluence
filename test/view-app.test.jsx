import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

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
  ioInstances = [];
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.IntersectionObserver = MockIntersectionObserver;
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

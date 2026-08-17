import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
// Reached via EditorView.findFromDOM so a test can type through the real
// CodeMirror instance, exercising the same onChange -> setSource path a user
// does — the only source change that must still be debounced.
import { EditorView } from '@codemirror/view';
import { TEMPLATES } from '../src/lib/templates.js';
import { LiveUrlError } from '../src/lib/live-url.js';
import { CACHE_VERSION } from '../src/lib/cache.js';
import { resolvedVersion } from '../src/lib/mermaid-registry.js';

/**
 * The config editor's Panel orchestration: a debounced live preview, and a save
 * that renders both themes and stashes them as the reader's cache. config/main.jsx
 * self-mounts into #root and exports nothing, so we seed #root and re-import fresh
 * per test. renderDiagram is mocked (browser-only); cache.js (buildCacheFields)
 * and describeError stay real so the payload we assert on is genuinely built.
 */

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  enableTheme: vi.fn(),
  getConfig: vi.fn(),
  resolveTheme: vi.fn((pref) => (pref === 'dark' ? 'dark' : 'light')),
  submitConfig: vi.fn(),
  closeConfig: vi.fn(),
  renderDiagram: vi.fn(),
  decodeLiveUrl: vi.fn(),
}));

vi.mock('../src/lib/host.js', () => ({
  enableTheme: h.enableTheme,
  getConfig: h.getConfig,
  resolveTheme: h.resolveTheme,
  submitConfig: h.submitConfig,
  closeConfig: h.closeConfig,
}));

vi.mock('../src/lib/render.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, renderDiagram: h.renderDiagram };
});

vi.mock('../src/lib/live-url.js', async (importActual) => {
  // isMermaidLiveUrl and LiveUrlError stay real — URL parsing and a class,
  // both of which jsdom can run. decodeLiveUrl is the DecompressionStream path,
  // which jsdom does not implement, so it is stubbed the same way renderDiagram
  // is: the decoder itself is proven in test/browser/live-url.test.js, where it
  // can actually run (Chromium), and this file proves the wiring around it —
  // including that the panel only prints LiveUrlError messages.
  const actual = await importActual();
  return { ...actual, decodeLiveUrl: h.decodeLiveUrl };
});

const SOURCE = 'flowchart TD\n A-->B';

// Every ResizeObserver the mounted Stage binds, with what it was pointed at, so
// a test can deliver the observation jsdom never would. Reset per test.
let observers = [];

/**
 * Deliver one observation to whichever observer is watching `selector`. jsdom
 * implements no ResizeObserver at all, so this is the only way to reach the
 * auto-fit path — what it proves is the wiring and the policy, not the geometry
 * (the rects below are fabricated). The real-layout half is in
 * test/browser/stage-autofit.integration.test.js.
 */
async function fireObserver(selector) {
  // Wait for the observer rather than assuming one is already bound. The element
  // being in the DOM does not mean the effect that observes it has run: React
  // commits the DOM first and flushes passive effects on a later task, so on a
  // slow machine the two can be a tick apart. waitFor retries inside act, which
  // is what lets that tick happen. (This is a test-harness fact, not a product
  // one — nothing here waits on a real ResizeObserver.)
  let observing = [];
  await waitFor(() => {
    const target = document.querySelector(selector);
    observing = observers.filter((o) => o.targets.includes(target));
    expect(observing.length).toBeGreaterThan(0);
  });
  await act(async () => {
    for (const o of observing) o.callback([], o);
  });
}

/**
 * Give .stage and .pan real numbers to measure. jsdom reports every rect as
 * 0x0, which makes fitView bail — so without this the fit is a silent no-op.
 * getComputedStyle's padding comes back '' and measure() already reads that as
 * 0, so only the rects need stubbing.
 *
 * `pan` is the diagram's *layout* size. What the stub reports is that box with
 * the transform React has written onto .pan applied, exactly as a real
 * getBoundingClientRect does — which is the whole reason measure() has to invert
 * it through untransformedRect. A stub that ignored the transform would quietly
 * test a measurement path the browser never takes.
 */
async function stubRects({ stage, pan }) {
  // Same reason fireObserver waits: the stage is mounted a tick after the
  // preview is reported ready, so reaching for it synchronously is a race.
  let stageEl;
  let panEl;
  await waitFor(() => {
    stageEl = document.querySelector('.preview .stage');
    panEl = document.querySelector('.preview .pan');
    expect(panEl).not.toBeNull();
  });
  stageEl.getBoundingClientRect = () => ({ left: 0, top: 0, ...stage });
  panEl.getBoundingClientRect = () => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
      panEl.style.transform,
    );
    const [x, y, z] = m ? m.slice(1).map(Number) : [0, 0, 1];
    return { left: x, top: y, width: pan.width * z, height: pan.height * z };
  };
}

beforeEach(() => {
  for (const key of Object.keys(h)) h[key].mockReset();
  // The preview renders the shared Stage (src/components/Stage.tsx), which binds
  // ResizeObservers and drives pointer capture — none of which jsdom implements.
  // The observer stub records rather than no-ops, so the auto-fit tests below can
  // fire an observation by hand; it never fires on its own, so every other test
  // sees the old no-op behaviour.
  observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
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
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  HTMLElement.prototype.scrollIntoView ??= () => {};
  h.resolveTheme.mockImplementation((pref) => (pref === 'dark' ? 'dark' : 'light'));
  h.submitConfig.mockResolvedValue(undefined);
  h.getConfig.mockResolvedValue({ source: SOURCE });
  // Default: preview and save renders resolve, tagged by the theme they ran in.
  h.renderDiagram.mockImplementation(async ({ theme }) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" data-theme="${theme}"><rect width="10" height="10"/></svg>`,
  }));
  // Default: a mermaid.live URL decodes cleanly to a distinctive source, so the
  // paste/drop tests can tell the imported diagram from the seeded SOURCE.
  h.decodeLiveUrl.mockResolvedValue('flowchart TD\n  X[from live] --> Y');
});

afterEach(() => {
  document.body.innerHTML = '';
});

async function mountConfig() {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  await act(async () => {
    await import('../src/config/main.jsx');
  });
}

// Selected by position, not by label: the label reads "Saving…" while a save is
// in flight, and a text match would silently return undefined there — turning
// every `saveButton()?.disabled` assertion into a false pass.
const saveButton = () => document.querySelector('.actions button.primary');

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

// Wait for the debounced preview to land and enable the Save button.
async function waitForPreview() {
  await waitFor(() => {
    expect(h.renderDiagram).toHaveBeenCalled();
    expect(saveButton()?.disabled).toBe(false);
  });
}

describe('live preview', () => {
  it('debounces then renders the current source, enabling save', async () => {
    await mountConfig();
    await waitForPreview();

    expect(h.renderDiagram).toHaveBeenCalledWith({
      source: SOURCE,
      versionPref: 'auto',
      theme: 'light',
    });
    expect(document.querySelector('.preview .stage .pan svg')).not.toBeNull();
  });
});

// --- Interactive preview (issue #105) ----------------------------------------
// The preview renders the same Stage the reader view does, so authoring a large
// diagram no longer means saving and reopening just to look at it. The zoom/pan
// math is zoom.ts's and the reader's suite covers the component itself; what's
// asserted here is that the editor really mounts it, wired to the editor's own
// Size / full-width settings, and that it carries the reader-only actions.

describe('interactive preview', () => {
  const stageEl = () => document.querySelector('.preview .stage');
  const zoomLabel = () => document.querySelector('.preview .zoom-level')?.textContent;
  const panTransform = () => document.querySelector('.preview .pan').style.transform;
  const btnByText = (re) =>
    [...document.querySelectorAll('.preview button')].find((b) => re.test(b.textContent.trim()));

  it('offers zoom, fit and maximize but not the reader-only copy/export', async () => {
    await mountConfig();
    await waitForPreview();

    expect(btnByText(/^−|^-$/)).toBeDefined();
    expect(zoomLabel()).toBe('100%');
    expect(btnByText(/^fullscreen$/i)).toBeDefined();
    // Copy source and Export stay in the view bundle: the source is already in
    // the pane next to this one, and keeping them out is what keeps png-export
    // out of the config bundle.
    expect(btnByText(/copy source/i)).toBeUndefined();
    expect(btnByText(/^export/i)).toBeUndefined();
  });

  it('zooms on ctrl+wheel and resets with 0', async () => {
    await mountConfig();
    await waitForPreview();

    await wheel(stageEl(), { deltaY: -100, ctrlKey: true, clientX: 5, clientY: 5 });
    // 1 - (-100 * 0.002) = 1.2 -> 120%.
    expect(zoomLabel()).toBe('120%');

    fireEvent.keyDown(stageEl(), { key: '0' });
    expect(zoomLabel()).toBe('100%');
  });

  it('pans by a pointer drag', async () => {
    await mountConfig();
    await waitForPreview();
    const stage = stageEl();

    fireEvent.pointerDown(stage, { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 });
    expect(stage.className).toMatch(/dragging/);

    fireEvent.pointerMove(stage, { clientX: 30, clientY: 20, buttons: 1 });
    expect(panTransform()).toContain('translate(30px, 20px)');

    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(stage.className).not.toMatch(/dragging/);
  });

  // The whole point of reusing Stage: the Size preset and the full-width toggle
  // now drive the preview through the same classes the reader's CSS reads, so
  // the preview is the render rather than a lookalike of it.
  it('reflects the Size preset and the full-width toggle on the stage', async () => {
    await mountConfig();
    await waitForPreview();
    expect(stageEl().className).not.toMatch(/sized/);
    expect(stageEl().className).not.toMatch(/no-shrink/);

    await act(async () => {
      fireEvent.change(selectByLabel('Size'), { target: { value: 'medium' } });
      fireEvent.click(document.querySelector('.controls input[type="checkbox"]'));
    });

    await waitFor(() => {
      expect(stageEl().className).toMatch(/sized/);
      expect(stageEl().className).toMatch(/no-shrink/);
    });
    expect(stageEl().style.getPropertyValue('--diagram-height')).toBe('560px');
  });

  // The config modal's iframe may not carry allow="fullscreen", in which case
  // requestFullscreen rejects. Without the fallback the maximize button would
  // simply do nothing — the one failure mode this feature can't afford.
  it('falls back to the CSS maximize when the host refuses fullscreen', async () => {
    await mountConfig();
    await waitForPreview();
    const stage = stageEl();
    stage.requestFullscreen = vi.fn(() => Promise.reject(new TypeError('blocked')));

    await act(async () => {
      fireEvent.click(btnByText(/^fullscreen$/i));
    });
    expect(stage.className).toMatch(/maximized/);

    // Escape is one way out of the fallback — the browser provides none of its own.
    await act(async () => {
      fireEvent.keyDown(stage, { key: 'Escape' });
    });
    expect(stage.className).not.toMatch(/maximized/);
  });

  // The other refusal shape: no Fullscreen API at all, which is also jsdom's
  // default, so this test deliberately assigns no requestFullscreen stub.
  it('falls back when there is no Fullscreen API, and the Exit button leaves it', async () => {
    await mountConfig();
    await waitForPreview();
    const stage = stageEl();
    expect(stage.requestFullscreen).toBeUndefined();

    await act(async () => {
      fireEvent.click(btnByText(/^fullscreen$/i));
    });
    expect(stage.className).toMatch(/maximized/);

    // The on-diagram Exit button is the visible way out — the toolbar is hidden
    // while maximized, so it is the only one a mouse user can see.
    await act(async () => {
      fireEvent.click(btnByText(/^exit fullscreen$/i));
    });
    expect(stage.className).not.toMatch(/maximized/);
  });
});

// --- Auto-fit -----------------------------------------------------------------
// The editor's stage is a fixed pane, so a Size preset taller than it used to be
// clipped at 100%: nothing re-fitted inline, because every route to a fit was
// gated on being maximized. `autoFit` (config-only) re-fits whenever the
// diagram's own box changes. These cover the wiring and the policy against
// fabricated rects; that the rects the browser really reports behave this way is
// test/browser/stage-autofit.integration.test.js's job.
describe('auto-fit in the preview', () => {
  const stageEl = () => document.querySelector('.preview .stage');
  const zoomLabel = () => document.querySelector('.preview .zoom-level')?.textContent;
  const panTransform = () => document.querySelector('.preview .pan').style.transform;
  const btnByText = (re) =>
    [...document.querySelectorAll('.preview button')].find((b) => re.test(b.textContent.trim()));

  // A 400x300 pane holding an 800px-tall diagram — i.e. the Large preset in a
  // short pane, the case that reported the bug. 300/800 = 0.375, and the leftover
  // width halves to 125px; the height is flush, so y stays 0.
  const CLIPPED = { stage: { width: 400, height: 300 }, pan: { width: 400, height: 800 } };
  const FITS = { stage: { width: 400, height: 300 }, pan: { width: 200, height: 150 } };

  it('shrinks a diagram taller than the pane, and centres what is left over', async () => {
    await mountConfig();
    await waitForPreview();
    await stubRects(CLIPPED);

    await act(async () => {
      fireEvent.change(selectByLabel('Size'), { target: { value: 'large' } });
    });
    // The preset alone changes nothing — it is CSS, and it is the resulting
    // relayout of .pan that triggers the fit.
    await fireObserver('.preview .pan');

    expect(zoomLabel()).toBe('38%');
    expect(panTransform()).toBe('translate(125px, 0px) scale(0.375)');
  });

  it('leaves a diagram that already fits at 1:1', async () => {
    await mountConfig();
    await waitForPreview();
    await stubRects(FITS);

    await fireObserver('.preview .pan');

    // Not scaled up to fill the pane the way maximizing does, and not nudged off
    // where the CSS put it either.
    expect(zoomLabel()).toBe('100%');
    expect(panTransform()).toBe('translate(0px, 0px) scale(1)');
  });

  it('keeps a zoom the user set through a pane resize, but not through a new diagram', async () => {
    await mountConfig();
    await waitForPreview();
    await stubRects(CLIPPED);

    await wheel(stageEl(), { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(zoomLabel()).toBe('120%');

    // The pane resizing is not a reason to throw away a view they chose...
    await fireObserver('.preview .stage');
    expect(zoomLabel()).toBe('120%');

    // ...but the diagram's own box changing is: the old view was computed for a
    // box that no longer exists.
    await fireObserver('.preview .pan');
    expect(zoomLabel()).toBe('38%');
  });

  it('re-fits when the pane itself grows, as long as the view is still ours', async () => {
    await mountConfig();
    await waitForPreview();
    await stubRects(CLIPPED);
    await fireObserver('.preview .pan');
    expect(zoomLabel()).toBe('38%');

    // The modal is resized, or the 720px breakpoint drops the panes into one
    // column: the diagram hasn't changed, but the room for it has.
    await stubRects({ stage: { width: 400, height: 600 }, pan: { width: 400, height: 800 } });
    await fireObserver('.preview .stage');

    expect(zoomLabel()).toBe('75%');
    expect(panTransform()).toBe('translate(50px, 0px) scale(0.75)');
  });

  it('resets to the fit rather than to 100%', async () => {
    await mountConfig();
    await waitForPreview();
    await stubRects(CLIPPED);
    await fireObserver('.preview .pan');
    expect(zoomLabel()).toBe('38%');

    await wheel(stageEl(), { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    fireEvent.keyDown(stageEl(), { key: '0' });

    // 100% here would put the user straight back into the clipped view this
    // whole feature exists to remove.
    expect(zoomLabel()).toBe('38%');
  });

  it('leaves the maximized fit alone, in and out', async () => {
    await mountConfig();
    await waitForPreview();
    // A diagram small enough that the two policies disagree loudly: maximizing
    // magnifies it to 200%, auto-fit would snap it back to 100%.
    await stubRects(FITS);

    await wheel(stageEl(), { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(zoomLabel()).toBe('120%');

    // No Fullscreen API in jsdom, so this takes the CSS fallback — the path the
    // Forge config modal actually takes.
    await act(async () => {
      fireEvent.click(btnByText(/^fullscreen$/i));
    });
    expect(zoomLabel()).toBe('200%');

    // Dropping the .sized rules on enter resizes .pan, which must not hand the
    // view to auto-fit while maximized.
    await fireObserver('.preview .pan');
    expect(zoomLabel()).toBe('200%');

    await act(async () => {
      fireEvent.keyDown(stageEl(), { key: 'Escape' });
    });
    expect(zoomLabel()).toBe('120%');

    // And the relayout on the way back out — which arrives after maximized() has
    // already gone false — must not overwrite the restored view either.
    await fireObserver('.preview .pan');
    expect(zoomLabel()).toBe('120%');
  });
});

describe('save', () => {
  it('reuses the preview render for its theme and renders only the other', async () => {
    await mountConfig();
    await waitForPreview();
    const previewCalls = h.renderDiagram.mock.calls.length;

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(h.submitConfig).toHaveBeenCalledTimes(1));

    // The preview just rendered light from these exact inputs, so save pays for
    // exactly one more render — the dark leg.
    const saveCalls = h.renderDiagram.mock.calls.slice(previewCalls);
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0][0]).toMatchObject({ theme: 'dark' });

    const payload = h.submitConfig.mock.calls[0][0];
    expect(payload).toMatchObject({
      source: SOURCE,
      mermaidVersion: 'auto',
      theme: 'auto',
      useMaxWidth: true,
      cacheV: CACHE_VERSION,
      // Stamped so the reader can label a cache hit with the version that drew
      // it, rather than whatever bundle serves the page later (issue #37).
      renderedVersion: resolvedVersion('auto'),
    });
    expect(payload.svgLight).toContain('data-theme="light"');
    expect(payload.svgDark).toContain('data-theme="dark"');
  });

  it('renders both themes fresh, sequentially, when a setting changed after the preview', async () => {
    await mountConfig();
    await waitForPreview();

    // Gated implementation: the light render hangs until released, so if save
    // runs its two renders sequentially, dark cannot start while light pends.
    // Under Promise.all both would fire together — the singleton-theme-race bug
    // this ordering (and the render.js lock beneath it) prevents.
    let releaseLight;
    let lightPending = false;
    let darkStartedWhileLightPending = false;
    // Only save's own light leg is gated — it is the first light call once the
    // click below is issued in the same act as the setting change. A setting
    // change now also renders the preview immediately (it stopped waiting out
    // the typing debounce), so a second, ungated light call arrives from that;
    // gating it too would hang a render this test is not about, and counting it
    // as "pending" would make the sequencing assertion below lie. In the real
    // app the two are serialized by the lock in render.ts, which this bare mock
    // does not model.
    let lightCalls = 0;
    h.renderDiagram.mockImplementation(({ theme }) => {
      if (theme === 'light') {
        lightCalls += 1;
        if (lightCalls > 1) {
          return Promise.resolve({ svg: '<svg data-theme="light-preview"><rect/></svg>' });
        }
        lightPending = true;
        return new Promise((resolve) => {
          releaseLight = () => {
            lightPending = false;
            resolve({ svg: '<svg data-theme="light-fresh"><rect/></svg>' });
          };
        });
      }
      if (lightPending) darkStartedWhileLightPending = true;
      return Promise.resolve({ svg: '<svg data-theme="dark-fresh"><rect/></svg>' });
    });

    // Flip a render input after the preview landed, then save in the same act
    // so the click lands before the re-render can update the stored tuple: the
    // tuple no longer matches, so save must not trust it for either leg. Doing
    // both in one act is what makes this deterministic — it no longer relies on
    // a 300ms debounce being slower than the test. The version, not the
    // full-width checkbox: that one no longer changes the markup, so it is
    // deliberately not in the tuple (see the reuse test below).
    const versionSelect = selectByLabel('Mermaid');
    await act(async () => {
      fireEvent.change(versionSelect, {
        target: { value: [...versionSelect.querySelectorAll('option')].at(-1).value },
      });
      fireEvent.click(saveButton());
    });

    expect(releaseLight).toBeDefined(); // the light leg went to a fresh render
    await act(async () => {
      releaseLight();
    });

    await waitFor(() => expect(h.submitConfig).toHaveBeenCalledTimes(1));
    expect(darkStartedWhileLightPending).toBe(false);
    const payload = h.submitConfig.mock.calls[0][0];
    expect(payload).toMatchObject({
      mermaidVersion: versionSelect.value,
      cacheV: CACHE_VERSION,
    });
    expect(payload.svgLight).toContain('light-fresh');
    expect(payload.svgDark).toContain('dark-fresh');
  });

  it('reuses the preview render when only the full-width toggle changed', async () => {
    await mountConfig();
    await waitForPreview();
    const previewCalls = h.renderDiagram.mock.calls.length;

    // "Keep full width" adds a CSS class to the stage and nothing else, so the
    // SVG on screen is already the SVG to cache. Flipping it must not throw away
    // the preview render — it used to, costing two fresh renders on save.
    await act(async () => {
      fireEvent.click(document.querySelector('.controls input[type="checkbox"]'));
    });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(h.submitConfig).toHaveBeenCalledTimes(1));

    const saveCalls = h.renderDiagram.mock.calls.slice(previewCalls);
    expect(saveCalls).toHaveLength(1); // the dark leg only, same as an untouched save
    expect(saveCalls[0][0]).toMatchObject({ theme: 'dark' });
    // The setting itself still persists — it is the reader's stage class.
    expect(h.submitConfig.mock.calls[0][0]).toMatchObject({
      useMaxWidth: false,
      cacheV: CACHE_VERSION,
    });
  });

  it('persists source alone (no cache) when a save-time render throws', async () => {
    await mountConfig();
    await waitForPreview();

    // Preview already succeeded and enabled Save; now make the save renders fail.
    // The cache must never block a save — the source still persists.
    h.renderDiagram.mockRejectedValue(new Error('render blew up at save time'));

    await act(async () => {
      fireEvent.click(saveButton());
    });

    await waitFor(() => expect(h.submitConfig).toHaveBeenCalledTimes(1));
    const payload = h.submitConfig.mock.calls[0][0];
    expect(payload).toMatchObject({ source: SOURCE, cacheV: CACHE_VERSION });
    expect(payload).not.toHaveProperty('svgLight');
    expect(payload).not.toHaveProperty('svgDark');
    // Nothing cached, so there is no render for renderedVersion to describe.
    expect(payload).not.toHaveProperty('renderedVersion');
  });
});

// --- Drag-drop, error gutter, template picker, settings ----------------------
// These drive the editor's interactive controls the save/preview tests above
// never touch. The Panel binds capture-phase drag listeners to `window`, so a
// synthetic DragEvent carrying a Files dataTransfer exercises the real drop path.

// jsdom's DragEvent/DataTransfer are thin, so build a minimal event: a Files-typed
// dataTransfer is all the handlers read (hasFiles + files[0]).
function fireFileDrag(type, file) {
  const dataTransfer = { types: ['Files'], dropEffect: '', files: file ? [file] : [] };
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer, configurable: true });
  window.dispatchEvent(ev);
}

const selectByLabel = (label) =>
  [...document.querySelectorAll('.controls label')]
    .find((l) => l.textContent.includes(label))
    ?.querySelector('select');

describe('drag-drop', () => {
  it('shows the drop overlay while a file drag is over the panel', async () => {
    await mountConfig();
    await waitForPreview();

    await act(async () => {
      fireFileDrag('dragenter');
      fireFileDrag('dragover');
    });
    expect(document.querySelector('.drop-overlay')).not.toBeNull();

    await act(async () => {
      fireFileDrag('dragleave');
    });
    expect(document.querySelector('.drop-overlay')).toBeNull();
  });

  it('loads a dropped .mmd file into the editor source', async () => {
    await mountConfig();
    await waitForPreview();
    h.renderDiagram.mockClear();

    const dropped = 'sequenceDiagram\n A->>B: hi';
    const file = new File([dropped], 'diagram.mmd', { type: 'text/plain' });

    await act(async () => {
      fireFileDrag('drop', file);
    });

    // The real extractMermaidSource returns the raw .mmd text; setSource then
    // drives a fresh debounced preview render of the dropped diagram.
    await waitFor(() =>
      expect(h.renderDiagram).toHaveBeenCalledWith(expect.objectContaining({ source: dropped })),
    );
    expect(document.querySelector('.drop-overlay')).toBeNull();
  });

  it('reports a markdown file with no mermaid block instead of loading it', async () => {
    await mountConfig();
    await waitForPreview();

    const file = new File(['# just prose, no diagram'], 'notes.md', { type: 'text/markdown' });

    await act(async () => {
      fireFileDrag('drop', file);
    });

    await waitFor(() => {
      const alert = document.querySelector('.diagnostic[role="alert"]');
      expect(alert?.textContent).toMatch(/no ```?mermaid code block/i);
    });
  });

  it('reports an empty mermaid block instead of blanking the editor', async () => {
    await mountConfig();
    await waitForPreview();

    // extractMermaidSource finds the block and returns { source: '' }, which is
    // not an error — the panel's own emptiness check is what stands between the
    // author and a wiped editor. This is the other half of the empty-block case
    // pinned in test/mermaid-file.test.js.
    const file = new File(['```mermaid\n   \n```\n'], 'empty.md', { type: 'text/markdown' });

    await act(async () => {
      fireFileDrag('drop', file);
    });

    await waitFor(() => {
      const alert = document.querySelector('.diagnostic[role="alert"]');
      expect(alert?.textContent).toMatch(/no mermaid content/i);
    });
  });
});

// --- Mermaid Live editor import (issue #106) --------------------------------
// decodeLiveUrl is stubbed (DecompressionStream is not in jsdom — the decoder
// is proven in the browser project); isMermaidLiveUrl stays real. What these
// prove is the editing wiring: a paste or a text/uri-list drop of a mermaid.live
// link reaches the decoder and the decoded source fills the editor preview, and
// anything that is not one of those links either falls through to normal paste
// or surfaces the dropError. "Not fetched" is asserted via a fetch stub in
// every case — the whole feature exists because the fragment needs no network.

function firePaste(text) {
  // CodeMirror's own paste handling lives inside .cm-content and reads
  // clipboardData; this synthetic event carries it, and dispatching on the
  // .editor wrapper runs the document-level capture listener that guards it.
  const clipboardData = { getData: (type) => (type === 'text/plain' ? text : '') };
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: clipboardData, configurable: true });
  document.querySelector('.editor').dispatchEvent(ev);
}

/**
 * Drag a hyperlink onto `selector` (the editor by default). Same shape as the
 * file-drag helper: a text/uri-list drag carries no files, only the URI types
 * and data the Panel reads. Dispatched on a real element rather than on window,
 * because where the link lands decides what happens — the window capture
 * listeners still see it on the way down.
 *
 * Returns the dragover and drop events, because `defaultPrevented` is the
 * assertion that matters for a link the panel does not import: preventing it is
 * what stops the browser navigating the config iframe to that URL and taking
 * the unsaved diagram with it, and leaving the drop alone is what lets
 * CodeMirror insert the URL as text. dragover is fired for real here rather
 * than skipped, because preventing it is also what makes the drop event happen
 * at all — an unclaimed dragover means the browser navigates and no drop
 * handler ever runs.
 */
function fireUriDrop(uri, selector = '.editor') {
  const dataTransfer = {
    types: ['text/uri-list'],
    dropEffect: '',
    files: [],
    getData: (type) => (type === 'text/uri-list' ? uri : ''),
  };
  const target = document.querySelector(selector);
  const fired = {};
  for (const type of ['dragenter', 'dragover', 'drop']) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer, configurable: true });
    target.dispatchEvent(ev);
    fired[type] = ev;
  }
  return fired;
}

const LIVE_URL = 'https://mermaid.live/edit#pako:eJxLrMgsKCj2AAr8AK4T';

describe('mermaid.live import', () => {
  let fetchSpy;
  beforeEach(() => {
    // Prove the no-network invariant at the wiring boundary: nothing in the
    // editor may fetch the URL it was handed. Stubbed to fail loudly if called.
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pastes a mermaid.live URL into the editor source', async () => {
    await mountConfig();
    await waitForPreview();
    h.renderDiagram.mockClear();

    await act(async () => {
      firePaste(LIVE_URL);
    });

    await waitFor(() => expect(h.decodeLiveUrl).toHaveBeenCalledWith(LIVE_URL));
    // The decoded source flows into the same debounced preview as typed source.
    await waitFor(() =>
      expect(h.renderDiagram).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'flowchart TD\n  X[from live] --> Y' }),
      ),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('drags a mermaid.live link onto the editor via the same path', async () => {
    await mountConfig();
    await waitForPreview();
    h.renderDiagram.mockClear();

    await act(async () => {
      fireUriDrop(LIVE_URL);
    });

    await waitFor(() => expect(h.decodeLiveUrl).toHaveBeenCalledWith(LIVE_URL));
    await waitFor(() =>
      expect(h.renderDiagram).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'flowchart TD\n  X[from live] --> Y' }),
      ),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces an error when a mermaid.live link can't be decoded", async () => {
    h.decodeLiveUrl.mockRejectedValue(new LiveUrlError("Couldn't decode that Mermaid Live link."));
    await mountConfig();
    await waitForPreview();

    await act(async () => {
      firePaste(LIVE_URL);
    });

    await waitFor(() => {
      const alert = document.querySelector('.diagnostic[role="alert"]');
      expect(alert?.textContent).toMatch(/couldn't decode that mermaid live link/i);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes the decoder's own message through, so an empty link says so", async () => {
    // A link that decodes to an empty diagram is a different problem from a
    // corrupt one, and the decoder words it that way; flattening both into
    // "couldn't decode" would tell the user to check the wrong thing.
    h.decodeLiveUrl.mockRejectedValue(
      new LiveUrlError('That Mermaid Live link has no diagram in it.'),
    );
    await mountConfig();
    await waitForPreview();

    await act(async () => {
      firePaste(LIVE_URL);
    });

    await waitFor(() => {
      const alert = document.querySelector('.diagnostic[role="alert"]');
      expect(alert?.textContent).toMatch(/no diagram in it/i);
    });
  });

  it('falls back to the generic message when a failure carries none', async () => {
    h.decodeLiveUrl.mockRejectedValue(new LiveUrlError(''));
    await mountConfig();
    await waitForPreview();

    await act(async () => {
      firePaste(LIVE_URL);
    });

    await waitFor(() => {
      const alert = document.querySelector('.diagnostic[role="alert"]');
      expect(alert?.textContent).toMatch(/couldn't decode that mermaid live link/i);
    });
  });

  it('never shows the text of an error that merely escaped the decoder', async () => {
    // Only LiveUrlError messages are copy chosen for this panel. A bug escaping
    // the decoder still has to be reported, but its internal wording is not
    // something to hand the user.
    h.decodeLiveUrl.mockRejectedValue(new TypeError('x.slice is not a function'));
    await mountConfig();
    await waitForPreview();

    await act(async () => {
      firePaste(LIVE_URL);
    });

    await waitFor(() => {
      const alert = document.querySelector('.diagnostic[role="alert"]');
      expect(alert?.textContent).toMatch(/couldn't decode that mermaid live link/i);
    });
    expect(document.querySelector('.diagnostic[role="alert"]').textContent).not.toMatch(/slice/i);
  });

  it('leaves a non-mermaid.live link dropped on the editor to CodeMirror', async () => {
    await mountConfig();
    await waitForPreview();

    let fired;
    await act(async () => {
      fired = fireUriDrop('https://evil.example/diagram.mmd');
    });

    // The drop is not prevented: CodeMirror's own drop handler inserts the URL
    // as text, which is how a `click A href "…"` target gets written. Claiming
    // it to answer with an error would take that away — and the URL is not
    // fetched either way, which is the part that matters.
    expect(fired.drop.defaultPrevented).toBe(false);
    expect(h.decodeLiveUrl).not.toHaveBeenCalled();
    expect(document.querySelector('.diagnostic[role="alert"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets a link drag that carries no URI fall through untouched', async () => {
    await mountConfig();
    await waitForPreview();

    let fired;
    await act(async () => {
      fired = fireUriDrop('');
    });

    // Nothing to import and nothing to complain about: over the editor this is
    // CodeMirror's drop, whatever it turns out to hold.
    expect(fired.drop.defaultPrevented).toBe(false);
    expect(document.querySelector('.diagnostic[role="alert"]')).toBeNull();
    expect(h.decodeLiveUrl).not.toHaveBeenCalled();
  });

  it('swallows a link dropped outside the editor so the frame cannot navigate', async () => {
    await mountConfig();
    await waitForPreview();

    let fired;
    await act(async () => {
      fired = fireUriDrop('https://example.com/page', '.controls');
    });

    // The default action for a link dropped on a page is to navigate to it, and
    // this page is the config iframe — navigating it would throw away the
    // diagram being edited, unsaved. Both halves of the gesture are refused:
    // dragover, or the browser navigates before a drop event ever fires, and
    // the drop itself. Only the editor is an import target, though, so nothing
    // is imported and nothing is said — dragging a link onto the settings row
    // was never an import gesture.
    expect(fired.dragover.defaultPrevented).toBe(true);
    expect(fired.drop.defaultPrevented).toBe(true);
    expect(h.decodeLiveUrl).not.toHaveBeenCalled();
    expect(document.querySelector('.diagnostic[role="alert"]')).toBeNull();
    expect(document.querySelector('.drop-overlay')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets ordinary pasted text fall through to normal editing', async () => {
    await mountConfig();
    await waitForPreview();

    await act(async () => {
      firePaste('flowchart TD\n  A --> B');
    });

    // Not a mermaid.live URL, so the intercept handler stands down.
    expect(h.decodeLiveUrl).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets text that merely contains a live link paste as text', async () => {
    await mountConfig();
    await waitForPreview();

    await act(async () => {
      firePaste(`flowchart TD\n  A-->B\n  click A href "${LIVE_URL}"`);
    });

    // Pasting a diagram that cites a Live link must not replace the document
    // with whatever that link holds — the paste belongs to CodeMirror.
    expect(h.decodeLiveUrl).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('drops a decode that lands after the source has moved on', async () => {
    // The decode is async, so a slow one can resolve long after the user gave
    // up waiting and did something else. It must not overwrite what they did.
    let resolveDecode;
    h.decodeLiveUrl.mockReturnValue(
      new Promise((resolve) => {
        resolveDecode = resolve;
      }),
    );
    await mountConfig();
    await waitForPreview();
    h.renderDiagram.mockClear();

    await act(async () => {
      firePaste(LIVE_URL);
    });
    await waitFor(() => expect(h.decodeLiveUrl).toHaveBeenCalledWith(LIVE_URL));

    const template = TEMPLATES[1];
    await act(async () => {
      fireEvent.change(selectByLabel('Start from'), { target: { value: template.id } });
    });
    await waitFor(() =>
      expect(h.renderDiagram).toHaveBeenCalledWith(
        expect.objectContaining({ source: template.source }),
      ),
    );
    h.renderDiagram.mockClear();

    await act(async () => {
      resolveDecode('flowchart TD\n  X[from live] --> Y');
    });

    // The template the user picked stands; the stale decode is discarded, and
    // nothing re-renders behind their back.
    expect(h.renderDiagram).not.toHaveBeenCalled();
    expect(document.querySelector('.diagnostic[role="alert"]')).toBeNull();
  });
});

describe('error gutter', () => {
  it('renders the line-tagged diagnostic when the preview render fails', async () => {
    h.getConfig.mockResolvedValue({ source: SOURCE });
    h.renderDiagram.mockRejectedValue(new Error('Parse error on line 3: unexpected token'));
    await mountConfig();

    await waitFor(() => {
      const alert = document.querySelector('.diagnostic[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert.textContent).toMatch(/line 3/i);
      expect(alert.textContent).toMatch(/Parse error on line 3/);
    });
    // The error line is pushed into CodeMirror's decoration field.
    expect(document.querySelector('.cm-editor')).not.toBeNull();
  });
});

describe('editor accessibility', () => {
  it('names the source field, which CodeMirror leaves an unlabelled textbox', async () => {
    await mountConfig();

    const content = document.querySelector('.cm-content');
    expect(content?.getAttribute('role')).toBe('textbox');
    expect(content?.getAttribute('aria-label')).toBe('Mermaid source');
  });

  // Tab is captured for indentation, so SC 2.1.2 wants the escape hatch stated,
  // not merely bound. It is stated on the field rather than permanently above
  // it, in two halves: the accessible description carries it to a screen reader
  // on the way in, and pressing Tab reveals the same words to a sighted keyboard
  // user at the moment they discover they are stuck.
  it('describes the way out of the editor for assistive tech, from the start', async () => {
    await mountConfig();

    const content = document.querySelector('.cm-content');
    const hint = document.getElementById(content.getAttribute('aria-describedby'));
    expect(hint).not.toBeNull();
    expect(hint.textContent).toMatch(/Esc then Tab/);
    expect(hint.closest('.pane-title')).not.toBeNull();
    // In the accessibility tree from the first paint, so it is only ever hidden
    // the sr-only way — never display:none, and never removed.
    expect(hint.className).toMatch(/exit-hint/);
    expect(hint.className).not.toMatch(/shown/);
  });

  it('shows it on screen once Tab is swallowed, and not before', async () => {
    await mountConfig();
    const hint = () => document.getElementById('editor-exit-hint');
    const content = document.querySelector('.cm-content');

    // Typing is not a reason to explain Tab.
    fireEvent.keyDown(content, { key: 'a' });
    expect(hint().className).not.toMatch(/shown/);

    // Nor is a chord: a modified Tab is the browser's, and moves focus normally.
    fireEvent.keyDown(content, { key: 'Tab', ctrlKey: true });
    expect(hint().className).not.toMatch(/shown/);

    await act(async () => {
      fireEvent.keyDown(content, { key: 'Tab' });
    });
    expect(hint().className).toMatch(/shown/);
  });
});

describe('template picker', () => {
  it('loads the chosen template source and re-previews it', async () => {
    await mountConfig();
    await waitForPreview();
    h.renderDiagram.mockClear();

    const template = TEMPLATES[1];
    await act(async () => {
      fireEvent.change(selectByLabel('Start from'), { target: { value: template.id } });
    });

    await waitFor(() =>
      expect(h.renderDiagram).toHaveBeenCalledWith(
        expect.objectContaining({ source: template.source }),
      ),
    );
  });
});

describe('theme flip in the editor', () => {
  it('reconfigures the theme in place, keeping the editor and its history', async () => {
    // The theme used to be baked into the EditorView's extensions, so flipping
    // it destroyed and rebuilt the whole view — losing the undo history and the
    // cursor along with it. A CodeMirror compartment swaps it in place.
    await mountConfig();
    await waitForPreview();

    const editorBefore = document.querySelector('.cm-editor');
    const contentBefore = document.querySelector('.cm-content').textContent;
    expect(editorBefore).not.toBeNull();
    expect(document.querySelector('.editor').className).not.toContain('editor-dark');

    await act(async () => {
      fireEvent.change(selectByLabel('Theme'), { target: { value: 'dark' } });
    });
    // Let the dynamically-imported dark theme land.
    await waitFor(() => {
      expect(document.querySelector('.cm-editor')).toBe(editorBefore);
    });

    // Same view instance, same document: nothing was torn down.
    expect(document.querySelector('.cm-editor')).toBe(editorBefore);
    expect(document.querySelector('.cm-content').textContent).toBe(contentBefore);

    // The syntax colours follow the flip too. They resolve from --mf-tok-*
    // custom properties that this class re-points at the dark palette, so
    // without it the tokens would keep their light values on the dark surface.
    expect(document.querySelector('.editor').className).toContain('editor-dark');
  });
});

describe('settings flow into the save payload', () => {
  it('carries theme, size, version and full-width toggle; cancel closes', async () => {
    await mountConfig();
    await waitForPreview();

    // Change every control. useMaxWidth is inverted: the checkbox is "keep full
    // width", so checking it sets useMaxWidth=false.
    const versionSelect = selectByLabel('Mermaid');
    const versionValue = [...versionSelect.querySelectorAll('option')].at(-1).value;
    await act(async () => {
      fireEvent.change(selectByLabel('Theme'), { target: { value: 'dark' } });
      fireEvent.change(selectByLabel('Size'), { target: { value: 'medium' } });
      fireEvent.change(versionSelect, { target: { value: versionValue } });
      fireEvent.click(document.querySelector('.controls input[type="checkbox"]'));
    });

    await act(async () => {
      fireEvent.click(saveButton());
    });

    await waitFor(() => expect(h.submitConfig).toHaveBeenCalledTimes(1));
    expect(h.submitConfig.mock.calls[0][0]).toMatchObject({
      theme: 'dark',
      height: 560,
      mermaidVersion: versionValue,
      useMaxWidth: false,
    });

    // Cancel routes to the host's close.
    const cancel = [...document.querySelectorAll('button')].find((b) =>
      /cancel/i.test(b.textContent),
    );
    fireEvent.click(cancel);
    expect(h.closeConfig).toHaveBeenCalledTimes(1);
  });
});

// --- The editor rendered in silence -----------------------------------------
// Switching template, typing, or flipping theme left the *previous* diagram on
// screen for the debounce plus the whole render, with nothing saying a new one
// was coming. On a diagram type whose engine chunk has not loaded yet (kanban,
// architecture, c4) that silence also covers a multi-megabyte fetch. The chip
// overlays rather than replaces, because the render you are looking at — and
// the pan and zoom you set on it — must survive a keystroke.
describe('preview: in-flight indicator', () => {
  /** A preview render that stays in flight until the test resolves it. */
  function deferRender() {
    let settle;
    h.renderDiagram.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle = { resolve, reject };
        }),
    );
    return {
      finish: async (svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="next"/></svg>') => {
        await act(async () => settle.resolve({ svg }));
      },
      fail: async (message) => {
        await act(async () => settle.reject(new Error(message)));
      },
    };
  }

  const chip = () => document.querySelector('.preview-busy');
  const previewPane = () => document.querySelector('.preview');

  it('announces a re-render politely while it runs, then clears', async () => {
    await mountConfig();
    await waitForPreview();
    expect(chip()).toBeNull();

    const held = deferRender();
    await act(async () => {
      fireEvent.change(selectByLabel('Start from'), { target: { value: 'sequence' } });
    });

    await waitFor(() => expect(chip()).not.toBeNull());
    expect(chip().getAttribute('role')).toBe('status');
    expect(chip().textContent).toMatch(/rendering/i);
    expect(chip().querySelector('.spinner').getAttribute('aria-hidden')).toBe('true');
    // The pane itself is marked busy: that is the attribute meaning "this
    // region's contents are being updated", which is exactly the claim here.
    expect(previewPane().getAttribute('aria-busy')).toBe('true');

    await held.finish();
    await waitFor(() => expect(chip()).toBeNull());
    expect(previewPane().getAttribute('aria-busy')).toBe('false');
  });

  // The load-bearing assertion for overlaying instead of replacing. If the
  // Stage is ever unmounted for a re-render, this fails — and with it goes the
  // user's zoom on every keystroke.
  it('leaves the previous diagram mounted, zoomed and panned, while it renders', async () => {
    await mountConfig();
    await waitForPreview();
    await stubRects({ stage: { width: 400, height: 300 }, pan: { width: 200, height: 150 } });

    const before = document.querySelector('.preview .stage');
    await wheel(before, { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 150 });
    const zoomed = document.querySelector('.preview .zoom-level')?.textContent;
    const panned = document.querySelector('.preview .pan').style.transform;
    const svgBefore = document.querySelector('.preview .pan').innerHTML;

    const held = deferRender();
    await act(async () => {
      fireEvent.change(selectByLabel('Start from'), { target: { value: 'sequence' } });
    });
    await waitFor(() => expect(chip()).not.toBeNull());

    // Same node, not a remount: React would hand back a different element if
    // the ready branch had been swapped out and back.
    expect(document.querySelector('.preview .stage')).toBe(before);
    expect(document.querySelector('.preview .pan').innerHTML).toBe(svgBefore);
    expect(document.querySelector('.preview .zoom-level')?.textContent).toBe(zoomed);
    expect(document.querySelector('.preview .pan').style.transform).toBe(panned);

    await held.finish();
    await waitFor(() => expect(chip()).toBeNull());
  });

  it('does not double up on the first-ever render, which already says so', async () => {
    const held = deferRender();
    await mountConfig();

    // The empty pane already reads "Rendering…" in the middle; a chip in the
    // corner saying the same thing is noise.
    await waitFor(() => expect(h.renderDiagram).toHaveBeenCalled());
    expect(chip()).toBeNull();
    expect(previewPane().textContent).toMatch(/rendering/i);

    await held.finish();
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });

  it('clears the chip when the render fails, leaving the error to the gutter', async () => {
    await mountConfig();
    await waitForPreview();

    const held = deferRender();
    await act(async () => {
      fireEvent.change(selectByLabel('Start from'), { target: { value: 'sequence' } });
    });
    await waitFor(() => expect(chip()).not.toBeNull());

    await held.fail('Parse error on line 2');
    await waitFor(() => expect(chip()).toBeNull());
    expect(previewPane().getAttribute('aria-busy')).toBe('false');
    expect(document.querySelector('.diagnostic[role="alert"]')).not.toBeNull();
  });
});

// --- Save ran two renders and a bridge call behind a live button -------------
// The click produced nothing: no label change, no disabled state. The natural
// response to a button that appears to have done nothing is to click it again,
// which started a second pair of full renders on top of the first.
describe('save: in-flight feedback', () => {
  /** A submit that stays in flight until the test resolves it. */
  function deferSubmit() {
    let settle;
    h.submitConfig.mockImplementation(
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

  it('labels and disables the button for as long as the save runs', async () => {
    const held = deferSubmit();
    await mountConfig();
    await waitForPreview();

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(saveButton().textContent).toMatch(/saving/i));
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().getAttribute('aria-busy')).toBe('true');

    await held.finish();
    await waitFor(() => expect(saveButton().textContent).toMatch(/save diagram/i));
    expect(saveButton().disabled).toBe(false);
  });

  it('cannot be told to save twice', async () => {
    deferSubmit();
    await mountConfig();
    await waitForPreview();

    // Both clicks inside one act(), so the second lands before React has
    // re-rendered the disabled attribute. That is the case the guard inside
    // save() exists for — the attribute alone does not cover it.
    await act(async () => {
      fireEvent.click(saveButton());
      fireEvent.click(saveButton());
    });

    await waitFor(() => expect(h.submitConfig).toHaveBeenCalledTimes(1));
    expect(h.submitConfig).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed save and gives the button back', async () => {
    const held = deferSubmit();
    await mountConfig();
    await waitForPreview();

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    await held.fail('bridge exploded');

    // Assertive, not polite: a save that silently did nothing is worth
    // interrupting for.
    await waitFor(() => {
      const alert = document.querySelector('.diagnostic[role="alert"]');
      expect(alert?.textContent).toMatch(/couldn't save/i);
    });
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().textContent).toMatch(/save diagram/i);
  });
});

// --- The editor mount ---------------------------------------------------------
describe('editor mount', () => {
  it('announces the config fetch politely, with a delayed spinner', async () => {
    h.getConfig.mockReturnValue(new Promise(() => {}));
    await mountConfig();

    const busy = document.querySelector('[role="status"]');
    expect(busy).not.toBeNull();
    expect(busy.textContent).toMatch(/loading editor/i);
    expect(busy.querySelector('.spinner').getAttribute('aria-hidden')).toBe('true');
    expect(busy.classList.contains('reveal')).toBe(true);
  });
});

// --- The debounce was charging discrete clicks for a keystroke's problem ------
// The preview effect is keyed [source, mermaidVersion, theme] and put every one
// of them behind the same 300ms timer. But the timer exists to coalesce typing:
// a template pick, a theme flip or a version change is a single final gesture
// with no next keystroke coming, so the wait bought nothing and was most of the
// latency. Measured in Chromium on a warm engine, a template switch spent
// ~300ms waiting and ~95ms rendering.
describe('preview: discrete actions skip the typing debounce', () => {
  // One macrotask. A setTimeout(0) has fired by the time this resolves; a
  // setTimeout(300) has not. That gap is the whole assertion below, and it
  // needs no fake timers — which this suite deliberately does not use.
  const oneTask = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

  /** The live CodeMirror instance, so a test can type the way a user does. */
  const editorView = () => EditorView.findFromDOM(document.querySelector('.cm-editor'));

  it('still debounces the first render, which nothing discrete asked for', async () => {
    await mountConfig();

    // The control for every test below: with no discrete trigger, the timer is
    // the full debounce and one macrotask is nowhere near enough.
    await oneTask();
    expect(h.renderDiagram).not.toHaveBeenCalled();

    await waitForPreview();
  });

  it('renders a template pick on the next tick', async () => {
    await mountConfig();
    await waitForPreview();
    h.renderDiagram.mockClear();

    const template = TEMPLATES[1];
    await act(async () => {
      fireEvent.change(selectByLabel('Start from'), { target: { value: template.id } });
    });
    await oneTask();

    expect(h.renderDiagram).toHaveBeenCalledWith(
      expect.objectContaining({ source: template.source }),
    );
  });

  it('renders a theme change on the next tick', async () => {
    await mountConfig();
    await waitForPreview();
    h.renderDiagram.mockClear();

    await act(async () => {
      fireEvent.change(selectByLabel('Theme'), { target: { value: 'dark' } });
    });
    await oneTask();

    expect(h.renderDiagram).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
  });

  it('renders a Mermaid version change on the next tick', async () => {
    await mountConfig();
    await waitForPreview();
    h.renderDiagram.mockClear();

    await act(async () => {
      fireEvent.change(selectByLabel('Mermaid'), { target: { value: '10' } });
    });
    await oneTask();

    expect(h.renderDiagram).toHaveBeenCalledWith(expect.objectContaining({ versionPref: '10' }));
  });

  // Typing is the case the debounce is for, and the one that must not regress.
  it('still debounces typing', async () => {
    await mountConfig();
    await waitForPreview();
    h.renderDiagram.mockClear();

    const view = editorView();
    await act(async () => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n  B --> C' } });
    });
    await oneTask();

    expect(h.renderDiagram).not.toHaveBeenCalled();
    await waitFor(() => expect(h.renderDiagram).toHaveBeenCalled());
  });

  // The subtle way this breaks: consume the flag in the timer instead of at
  // schedule time, or forget to clear it, and every later keystroke inherits
  // the no-debounce path — turning the debounce off for the one input it exists
  // to serve, on a machine slow enough that it matters.
  it('does not leave the fast path armed for the next keystroke', async () => {
    await mountConfig();
    await waitForPreview();

    await act(async () => {
      fireEvent.change(selectByLabel('Start from'), { target: { value: TEMPLATES[1].id } });
    });
    await oneTask();
    await waitForPreview();
    h.renderDiagram.mockClear();

    const view = editorView();
    await act(async () => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n  Z --> Y' } });
    });
    await oneTask();

    expect(h.renderDiagram).not.toHaveBeenCalled();
  });
});

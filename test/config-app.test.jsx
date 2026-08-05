import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
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

const saveButton = () =>
  [...document.querySelectorAll('button')].find((b) => /save diagram/i.test(b.textContent));

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
      useMaxWidth: true,
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

    await act(async () => {
      stageEl().dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 }),
      );
    });
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

    await act(async () => {
      stageEl().dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 }),
      );
    });
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

    await act(async () => {
      stageEl().dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 }),
      );
    });
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
    h.renderDiagram.mockImplementation(({ theme }) => {
      if (theme === 'light') {
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

    // Flip a render input after the preview landed, then save before the
    // debounce re-renders: the stored preview tuple no longer matches, so save
    // must not trust it for either leg.
    await act(async () => {
      fireEvent.click(document.querySelector('.controls input[type="checkbox"]'));
    });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(releaseLight).toBeDefined(); // the light leg went to a fresh render
    await act(async () => {
      releaseLight();
    });

    await waitFor(() => expect(h.submitConfig).toHaveBeenCalledTimes(1));
    expect(darkStartedWhileLightPending).toBe(false);
    const payload = h.submitConfig.mock.calls[0][0];
    expect(payload).toMatchObject({ useMaxWidth: false, cacheV: CACHE_VERSION });
    expect(payload.svgLight).toContain('light-fresh');
    expect(payload.svgDark).toContain('dark-fresh');
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

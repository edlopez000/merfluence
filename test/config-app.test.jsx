import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { TEMPLATES } from '../src/lib/templates.js';
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

const SOURCE = 'flowchart TD\n A-->B';

beforeEach(() => {
  for (const key of Object.keys(h)) h[key].mockReset();
  // The preview renders the shared Stage (src/components/Stage.tsx), which binds
  // a ResizeObserver and drives pointer capture — none of which jsdom implements.
  // Stub as no-ops so the handlers run; their math belongs to zoom.ts's own tests.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
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

describe('save', () => {
  it('renders dark only after light resolves (sequential, not Promise.all)', async () => {
    await mountConfig();
    await waitForPreview();

    // Swap in a gated implementation: the light render hangs until we release it,
    // so if save awaited the two renders sequentially, dark cannot have started.
    // Under Promise.all both calls would fire synchronously and dark would start
    // immediately — which is the singleton-theme-race bug this ordering prevents.
    let releaseLight;
    let darkStarted = false;
    h.renderDiagram.mockImplementation(({ theme }) => {
      if (theme === 'light') {
        return new Promise((resolve) => {
          releaseLight = () => resolve({ svg: '<svg data-theme="light"><rect/></svg>' });
        });
      }
      darkStarted = true;
      return Promise.resolve({ svg: '<svg data-theme="dark"><rect/></svg>' });
    });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(darkStarted).toBe(false); // light is still pending

    await act(async () => {
      releaseLight();
    });
    expect(darkStarted).toBe(true);

    await waitFor(() => expect(h.submitConfig).toHaveBeenCalledTimes(1));
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
  // not merely bound.
  it('tells the user how to move focus out of the editor', async () => {
    await mountConfig();

    const title = [...document.querySelectorAll('.pane-title')].find((el) =>
      /mermaid source/i.test(el.textContent),
    );
    expect(title.textContent).toMatch(/Esc then Tab/);
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

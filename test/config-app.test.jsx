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
    expect(document.querySelector('.preview-svg svg')).not.toBeNull();
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

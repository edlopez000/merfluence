import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';

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
      cacheV: 2,
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
    expect(payload).toMatchObject({ source: SOURCE, cacheV: 2 });
    expect(payload).not.toHaveProperty('svgLight');
    expect(payload).not.toHaveProperty('svgDark');
  });
});

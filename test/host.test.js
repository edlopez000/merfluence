import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The one @forge/bridge surface host.js touches. Hoisted so the mock factory and
// every test share the same spy object across the module resets below.
const { view } = vi.hoisted(() => ({
  view: {
    getContext: vi.fn(),
    submit: vi.fn(),
    close: vi.fn(),
    theme: { enable: vi.fn() },
    resize: vi.fn(),
  },
}));
vi.mock('@forge/bridge', () => ({ view }));

// host.js caches the host colour mode at module scope, filled by getConfig and
// refreshed by onThemeChange. Re-import fresh per test so that cache starts null
// and one test's theme can't leak into the next.
async function freshHost() {
  vi.resetModules();
  return import('../src/lib/host.js');
}

const tick = () => new Promise((r) => setTimeout(r));

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  view.getContext.mockReset();
  view.submit.mockReset().mockResolvedValue(undefined);
  view.close.mockReset().mockResolvedValue(undefined);
  view.theme.enable.mockReset();
  view.resize.mockReset();
  view.getContext.mockResolvedValue({});
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  document.documentElement.removeAttribute('data-color-mode');
});

describe('resolveTheme', () => {
  it('returns an explicit light/dark override untouched', async () => {
    const { resolveTheme } = await freshHost();
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('falls back to the OS media query when the host mode is unknown', async () => {
    const { resolveTheme } = await freshHost();
    window.matchMedia = () => ({ matches: true });
    expect(resolveTheme('auto')).toBe('dark');
    window.matchMedia = () => ({ matches: false });
    expect(resolveTheme('auto')).toBe('light');
  });

  it('prefers the cached host colour mode over the OS query', async () => {
    const host = await freshHost();
    view.getContext.mockResolvedValue({ theme: { colorMode: 'dark' } });
    // getConfig fills the cache from getContext().theme.
    await host.getConfig();
    window.matchMedia = () => ({ matches: false }); // OS says light...
    expect(host.resolveTheme('auto')).toBe('dark'); // ...host still wins
  });

  it('resolves to light when neither host mode nor matchMedia is available', async () => {
    const { resolveTheme } = await freshHost();
    // Some Forge iframes have no matchMedia; the optional chain must not throw.
    delete window.matchMedia;
    expect(resolveTheme('auto')).toBe('light');
  });
});

describe('getConfig', () => {
  it('returns the saved fields from extension.config', async () => {
    const host = await freshHost();
    view.getContext.mockResolvedValue({
      theme: { colorMode: 'light' },
      extension: { config: { source: 'flowchart TD\n A-->B' } },
    });
    await expect(host.getConfig()).resolves.toEqual({ source: 'flowchart TD\n A-->B' });
  });

  it('returns an empty object when there is no config', async () => {
    const host = await freshHost();
    view.getContext.mockResolvedValue({ theme: { colorMode: 'light' } });
    await expect(host.getConfig()).resolves.toEqual({});
  });

  it('swallows a getContext failure and returns an empty object', async () => {
    const host = await freshHost();
    view.getContext.mockRejectedValue(new Error('bridge down'));
    await expect(host.getConfig()).resolves.toEqual({});
  });
});

describe('submitConfig', () => {
  it('wraps the fields as { config } — the shape the host requires', async () => {
    const host = await freshHost();
    await host.submitConfig({ source: 'x', theme: 'auto' });
    // Passing the fields unwrapped makes Confluence reject the save; this wrapper
    // is the real fix for that bug, so pin it.
    expect(view.submit).toHaveBeenCalledWith({ config: { source: 'x', theme: 'auto' } });
  });
});

describe('onThemeChange', () => {
  it('fires the handler when data-color-mode flips, and stops after cleanup', async () => {
    const host = await freshHost();
    view.getContext.mockResolvedValue({ theme: { colorMode: 'dark' } });
    const handler = vi.fn();
    const stop = host.onThemeChange(handler);

    document.documentElement.setAttribute('data-color-mode', 'dark');
    await tick();
    expect(handler).toHaveBeenCalledTimes(1);

    stop();
    document.documentElement.setAttribute('data-color-mode', 'light');
    await tick();
    expect(handler).toHaveBeenCalledTimes(1); // no further calls after unbind
  });
});

describe('defensive bridge wrappers', () => {
  it('enableTheme swallows a rejected enable()', async () => {
    const host = await freshHost();
    view.theme.enable.mockReturnValue(Promise.reject(new Error('no theming')));
    expect(() => host.enableTheme()).not.toThrow();
  });

  it('enableTheme tolerates a host with no theme surface', async () => {
    const host = await freshHost();
    const saved = view.theme;
    view.theme = undefined;
    try {
      expect(() => host.enableTheme()).not.toThrow();
    } finally {
      view.theme = saved;
    }
  });

  it('resize swallows a rejected resize()', async () => {
    const host = await freshHost();
    view.resize.mockReturnValue(Promise.reject(new Error('no resize')));
    expect(() => host.resize()).not.toThrow();
  });
});

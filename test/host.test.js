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

// The backdrop for the reader's "PNG (with background)" export. It has to be
// the colour the stage is actually painted, not a second copy of it: the CSS
// paints var(--ds-surface, #fff), and two independent hardcodings would drift
// the first time Atlassian moves the token.
describe('surfaceColor', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--ds-surface');
  });

  it('prefers the live --ds-surface token over the fallbacks', async () => {
    const { surfaceColor } = await freshHost();
    document.documentElement.style.setProperty('--ds-surface', '#123456');

    // The theme argument is only the fallback selector, so the token wins in
    // both — this is what keeps the PNG matching what is on screen.
    expect(surfaceColor('light')).toBe('#123456');
    expect(surfaceColor('dark')).toBe('#123456');
  });

  it('falls back per theme when the host has injected no tokens', async () => {
    const { surfaceColor } = await freshHost();
    // Before enableTheme() lands, or on a host too old for --ds-* entirely.
    expect(surfaceColor('light')).toBe('#ffffff');
    // Not white: a dark-themed diagram's light text on white is unreadable,
    // which is the failure this whole option exists to avoid.
    expect(surfaceColor('dark')).toBe('#1f1f21');
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

  it('skips the handler when the resolved mode did not change', async () => {
    const host = await freshHost();
    view.getContext.mockResolvedValue({ theme: { colorMode: 'dark' } });
    await host.getConfig(); // cache filled: dark
    const handler = vi.fn();
    const stop = host.onThemeChange(handler);

    // The startup echo: enableTheme() makes the host write data-color-mode with
    // the mode we already cached. The value is still re-read from the typed
    // signal — the trigger just must not cascade into a consumer re-decide.
    const callsBefore = view.getContext.mock.calls.length;
    document.documentElement.setAttribute('data-color-mode', 'dark');
    await tick();

    expect(view.getContext.mock.calls.length).toBe(callsBefore + 1);
    expect(handler).not.toHaveBeenCalled();
    stop();
  });

  it('coalesces triggers arriving while a refresh is in flight, without losing the change', async () => {
    const host = await freshHost();
    view.getContext.mockResolvedValue({ theme: { colorMode: 'light' } });
    await host.getConfig(); // cache filled: light

    // Hand-resolved contexts so triggers can pile up behind a pending refresh.
    const pending = [];
    view.getContext.mockImplementation(() => new Promise((r) => pending.push(r)));
    const handler = vi.fn();
    const stop = host.onThemeChange(handler);

    document.documentElement.setAttribute('data-color-mode', 'dark');
    await tick(); // first refresh now in flight
    expect(pending.length).toBe(1);

    // A burst of further triggers must not fan out into parallel round trips.
    document.documentElement.setAttribute('data-color-mode', 'light');
    await tick();
    document.documentElement.setAttribute('data-color-mode', 'dark');
    await tick();
    expect(pending.length).toBe(1);

    // The in-flight refresh lands on dark: one notification...
    pending.shift()({ theme: { colorMode: 'dark' } });
    await tick();
    expect(handler).toHaveBeenCalledTimes(1);

    // ...and exactly one queued re-check for the burst, which — still dark —
    // notifies nobody.
    expect(pending.length).toBe(1);
    pending.shift()({ theme: { colorMode: 'dark' } });
    await tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(pending.length).toBe(0);
    stop();
  });

  it('fires when the OS preference flips while the host mode is unknown', async () => {
    const host = await freshHost();
    // Host never reports a mode (auto): resolution falls to the media query,
    // so the gate has to compare that too, not just the cached host mode.
    view.getContext.mockResolvedValue({});
    await host.getConfig();

    let matches = false;
    let mqListener;
    window.matchMedia = () => ({
      get matches() {
        return matches;
      },
      addEventListener: (_, fn) => {
        mqListener = fn;
      },
      removeEventListener: () => {},
    });

    const handler = vi.fn();
    const stop = host.onThemeChange(handler);

    matches = true; // OS goes dark
    mqListener();
    await tick();
    expect(handler).toHaveBeenCalledTimes(1);

    mqListener(); // spurious re-fire, still dark
    await tick();
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
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

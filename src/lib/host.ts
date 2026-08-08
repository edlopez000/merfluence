import { view } from '@forge/bridge';

/**
 * The host colour mode, taken from the statically-typed `getContext().theme`
 * (FullContext.theme.colorMode: 'light' | 'dark' | 'auto'). We cache it here
 * because getContext() is async but resolveTheme() must stay synchronous — the
 * cache is filled by getConfig() at startup and refreshed by onThemeChange().
 * `null` means "unknown / auto", which defers to the OS preference.
 */
let hostColorMode: 'light' | 'dark' | null = null;

function normalizeMode(mode: unknown) {
  return mode === 'light' || mode === 'dark' ? mode : null;
}

async function refreshHostTheme() {
  try {
    const context = await view.getContext();
    hostColorMode = normalizeMode(context?.theme?.colorMode);
    return context;
  } catch {
    return null; // keep the last known mode
  }
}

/**
 * Resolve the theme to render in. `pref` is the diagram's own override; when it
 * is `auto` we use the host colour mode from getContext().theme, then fall back
 * to the OS preference, then to light.
 */
export function resolveTheme(pref: string | null | undefined) {
  if (pref === 'light' || pref === 'dark') return pref;
  if (hostColorMode) return hostColorMode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The colour the stage is painted on, for an export that needs an opaque
 * backdrop rather than a transparent one.
 *
 * Read from the live `--ds-surface` token rather than hardcoded, so a PNG
 * exported "with background" matches what the reader is looking at — the stage
 * paints the same token (see `.stage:fullscreen` in src/view/index.html), and
 * two independent copies of the colour would drift the first time Atlassian
 * moves it. The token is only present once enableTheme() has run and the host
 * has injected the --ds-* variables, so the fallbacks are the same light/dark
 * pair the CSS declares, chosen by the theme the diagram actually rendered in.
 */
export function surfaceColor(theme: 'light' | 'dark') {
  const token = getComputedStyle(document.documentElement).getPropertyValue('--ds-surface').trim();
  if (token) return token;
  return theme === 'dark' ? '#1f1f21' : '#ffffff';
}

/**
 * The mode resolveTheme('auto') would pick right now: the typed host signal
 * when known, otherwise the OS preference. This is what onThemeChange gates
 * its notifications on — comparing hostColorMode alone would go blind to an
 * OS flip while the host mode is unknown/auto.
 */
function effectiveMode() {
  if (hostColorMode) return hostColorMode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Re-render when the host flips light/dark while the page is open. The DOM
 * attribute and the OS media query are only used as *triggers* here; the actual
 * value is re-read from getContext().theme, the typed signal, before we notify.
 *
 * Triggers arrive in bursts and repeat without a change behind them —
 * enableTheme()'s own startup write of data-color-mode is one guaranteed
 * no-op trigger per macro on the page — and each used to cost a getContext()
 * round trip plus a full consumer re-decide. Two guards close that: concurrent
 * triggers coalesce into one in-flight refresh (re-checked after it lands, so
 * a change arriving mid-refresh is not lost), and the handler only fires when
 * the mode a consumer would resolve actually changed.
 */
export function onThemeChange(handler: () => void) {
  // The mode the consumer last acted on — seeded now, while the registering
  // consumer is deciding against the current cache. Compared against a *fresh*
  // read after each refresh; sampling "before" at trigger time instead would
  // race the very change being reported (the DOM/OS already flipped by then).
  let lastMode = effectiveMode();
  let inFlight = false;
  let queued = false;

  const onTrigger = async () => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      do {
        queued = false;
        await refreshHostTheme();
        const mode = effectiveMode();
        if (mode !== lastMode) {
          lastMode = mode;
          handler();
        }
      } while (queued);
    } finally {
      inFlight = false;
    }
  };

  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', onTrigger);

  const observer = new MutationObserver(onTrigger);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-color-mode'],
  });

  return () => {
    mq?.removeEventListener?.('change', onTrigger);
    observer.disconnect();
  };
}

export async function getConfig() {
  const context = await refreshHostTheme();
  return context?.extension?.config ?? {};
}

/**
 * Opt this iframe into Atlassian theming. Confluence then injects the design
 * tokens our CSS reads (the --ds-* variables) and keeps `data-color-mode` on the
 * root element in sync, which is the mutation onThemeChange() listens for as a
 * re-render trigger. The colour mode value itself comes from getContext().theme;
 * without this call the --ds-* tokens stay at their hardcoded light fallbacks.
 *
 * Defensive: `view.theme` is a newer bridge surface, and a theming failure must
 * never blank the macro. On an older host the CSS fallback colours still apply.
 */
export function enableTheme() {
  try {
    const result = view.theme?.enable?.();
    if (result?.catch) result.catch(() => {});
  } catch {
    /* theming unsupported here; the CSS variable fallbacks cover it */
  }
}

/**
 * Ask the host to resize the iframe. Wrapped because the surface has moved
 * between Forge versions and a missing method should not blank the macro.
 */
export function resize() {
  try {
    // @ts-expect-error `resize` is not in the shipped @forge/bridge types — it's
    // a surface that has moved between Forge versions, so we probe for it
    // defensively (optional call) rather than depend on it.
    const result = view.resize?.();
    if (result?.catch) result.catch(() => {});
  } catch {
    /* the CSS fallback in index.html handles it */
  }
}

export async function submitConfig(values: Record<string, unknown>) {
  // A Confluence Custom UI macro config must submit its fields WRAPPED as
  // { config: fields }. Passing the fields object directly makes the host reject
  // the save with `view.submit(): Invalid "config" provided. Expected object`,
  // because it reads payload.config and finds it undefined. The saved fields
  // come back from view.getContext() under extension.config (see getConfig).
  await view.submit({ config: values });
}

export async function closeConfig() {
  try {
    await view.close();
  } catch {
    /* closed by the host */
  }
}

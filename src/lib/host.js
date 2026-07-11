import { view } from '@forge/bridge';

/**
 * The host colour mode, taken from the statically-typed `getContext().theme`
 * (FullContext.theme.colorMode: 'light' | 'dark' | 'auto'). We cache it here
 * because getContext() is async but resolveTheme() must stay synchronous — the
 * cache is filled by getConfig() at startup and refreshed by onThemeChange().
 * `null` means "unknown / auto", which defers to the OS preference.
 */
let hostColorMode = null;

function normalizeMode(mode) {
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
export function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  if (hostColorMode) return hostColorMode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Re-render when the host flips light/dark while the page is open. The DOM
 * attribute and the OS media query are only used as *triggers* here; the actual
 * value is re-read from getContext().theme, the typed signal, before we notify.
 */
export function onThemeChange(handler) {
  const onTrigger = async () => {
    await refreshHostTheme();
    handler();
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
    const result = view.resize?.();
    if (result?.catch) result.catch(() => {});
  } catch {
    /* the CSS fallback in index.html handles it */
  }
}

export async function submitConfig(values) {
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

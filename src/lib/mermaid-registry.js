/**
 * Mermaid version registry.
 *
 * Mermaid ships breaking syntax changes across majors. A diagram authored in
 * 2024 must not silently become an error banner in 2027. So every diagram may
 * pin a major, and `auto` tracks whatever ships with the current app release.
 *
 * Each major is a separate dynamic import, so a page that never pins an old
 * version never downloads one.
 */

export const DEFAULT_MAJOR = '11';

// Both packages expose their `.` entry as `dist/mermaid.core.mjs` — the *core*
// build, which registers every diagram type and layout engine as a lazy dynamic
// import rather than bundling them in. So this plain `import()` is already the
// split the bundle wants: a flowchart page pulls mermaid.core + the flowchart
// chunk (~850KB) and defers cytoscape / KaTeX / elkjs (~2.3MB) until a diagram
// that needs them actually renders. We deliberately do NOT call
// registerExternalDiagrams/registerLayoutLoaders ourselves — core already does,
// and re-registering would only risk double-loading. (Measured 2026-07-11; if a
// future major changes its default export, re-check that heavy libs stay lazy.)
const LOADERS = {
  11: () => import('mermaid').then((m) => m.default),
  10: () => import('mermaid-10').then((m) => m.default),
};

const RESOLVED = {
  11: __MERMAID_11_VERSION__,
  10: __MERMAID_10_VERSION__,
};

const cache = new Map();

/** Options offered in the config panel's version dropdown. */
export const VERSION_OPTIONS = [
  { value: 'auto', label: `Auto (currently ${RESOLVED[DEFAULT_MAJOR]})` },
  { value: '11', label: `Pinned to ${RESOLVED[11]}` },
  { value: '10', label: `Pinned to ${RESOLVED[10]}` },
];

export function resolveMajor(pref) {
  if (pref && pref !== 'auto' && LOADERS[pref]) return String(pref);
  return DEFAULT_MAJOR;
}

/** The exact semver that will do the rendering, for display. */
export function resolvedVersion(pref) {
  return RESOLVED[resolveMajor(pref)];
}

export async function loadMermaid(pref = 'auto') {
  const major = resolveMajor(pref);
  if (!cache.has(major)) {
    cache.set(major, LOADERS[major]());
  }
  return cache.get(major);
}

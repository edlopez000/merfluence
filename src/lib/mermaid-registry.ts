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
// The two mermaid majors have divergent, large type surfaces, so the loaded
// module is `any`: render.ts uses only the stable initialize/parse/render calls,
// which the fixture corpus exercises on both majors.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LOADERS: Record<string, () => Promise<any>> = {
  11: () => import('mermaid').then((m) => m.default),
  10: () => import('mermaid-10').then((m) => m.default),
};

const RESOLVED: Record<string, string> = {
  11: __MERMAID_11_VERSION__,
  10: __MERMAID_10_VERSION__,
};

/**
 * Which library renders, fixed at build time (MERFLUENCE_ENGINE, see
 * vite.view.config.js). 'pele' is an experiment; it bypasses the per-major
 * loaders below but leaves them, and the pinned versions, untouched.
 */
export const ENGINE: 'mermaid' | 'pele' = __RENDER_ENGINE__ === 'pele' ? 'pele' : 'mermaid';

const cache = new Map();

/** Options offered in the config panel's version dropdown. */
export const VERSION_OPTIONS = [
  { value: 'auto', label: `Auto (currently ${RESOLVED[DEFAULT_MAJOR]})` },
  { value: '11', label: `Pinned to ${RESOLVED[11]}` },
  { value: '10', label: `Pinned to ${RESOLVED[10]}` },
];

export function resolveMajor(pref?: string) {
  if (pref && pref !== 'auto' && LOADERS[pref]) return String(pref);
  return DEFAULT_MAJOR;
}

/** The exact semver that will do the rendering, for display. */
export function resolvedVersion(pref?: string) {
  // Prefixed so a Pele render can never be mistaken for a Mermaid semver — the
  // cache uses this to keep the two engines' stored SVGs apart.
  if (ENGINE === 'pele') return `pele ${__PELE_VERSION__}`;
  return RESOLVED[resolveMajor(pref)];
}

/** Start fetching whichever renderer this build uses, without rendering. */
export function warmRenderer(pref = 'auto'): Promise<unknown> {
  if (ENGINE === 'pele') return import('./pele-engine.js').then((m) => m.loadPele());
  return loadMermaid(pref);
}

export async function loadMermaid(pref = 'auto') {
  const major = resolveMajor(pref);
  if (!cache.has(major)) {
    cache.set(major, LOADERS[major]());
  }
  return cache.get(major);
}

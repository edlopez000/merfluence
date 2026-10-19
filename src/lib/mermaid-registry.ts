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
 * The version preference that opts a diagram into Pele, an experimental
 * alternative renderer (see pele-engine.ts). It rides in the same config field
 * as the Mermaid pins rather than a field of its own, so an older bundle that
 * doesn't know it falls through resolveMajor() to the default major and renders
 * the diagram with Mermaid instead of failing.
 */
export const PELE = 'pele';

export function isPele(pref?: string) {
  return pref === PELE;
}

const cache = new Map();

/** Options offered in the config panel's version dropdown. */
export const VERSION_OPTIONS = [
  { value: 'auto', label: `Auto (currently ${RESOLVED[DEFAULT_MAJOR]})` },
  { value: '11', label: `Pinned to ${RESOLVED[11]}` },
  { value: '10', label: `Pinned to ${RESOLVED[10]}` },
  { value: PELE, label: `Pele ${__PELE_VERSION__} (experimental)` },
];

export function resolveMajor(pref?: string) {
  if (pref && pref !== 'auto' && LOADERS[pref]) return String(pref);
  return DEFAULT_MAJOR;
}

/**
 * The exact version that will do the rendering, for display. A bare semver means
 * Mermaid; Pele is named, so the reader's label (and the renderedVersion a cache
 * stores) says which library drew the diagram.
 */
export function resolvedVersion(pref?: string) {
  if (isPele(pref)) return `Pele ${__PELE_VERSION__}`;
  return RESOLVED[resolveMajor(pref)];
}

/** Start fetching Pele without rendering — the counterpart to loadMermaid. */
export function loadPele(): Promise<unknown> {
  return import('./pele-engine.js').then((m) => m.loadPele());
}

export async function loadMermaid(pref = 'auto') {
  const major = resolveMajor(pref);
  if (!cache.has(major)) {
    cache.set(major, LOADERS[major]());
  }
  return cache.get(major);
}

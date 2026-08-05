// Bundle-size budget for the two initial-load entry chunks.
//
// Why this exists: bundle size IS the product story. A page of plain
// flowcharts loads ~850 KB raw and *defers* ~2.3 MB of heavier engines
// (Cytoscape, KaTeX, ELK) that fetch only when a diagram needs them. Nothing
// else in CI guards that split. A stray *static* import that folds a deferred
// engine into an entry chunk, or a dependency bump that inflates it, would
// otherwise merge with no signal. This job is that signal.
//
// What it measures: the initial load of each Vite bundle — the JS the iframe
// fetches before any diagram renders. That is now two chunks, the app's own
// `entry-[hash]` and the shared `vendor-[hash]` (React, DOMPurify, Vite's
// preload helper), so both are listed under one budget: splitting them was a
// cache-stability change, not a size change, and budgeting only the entry
// would have quietly halved what this guards. Both names are deliberate (see
// the Vite configs) so these globs can target them without also matching
// Mermaid's lazily-loaded `index-*`/`chunk-*` internals. The heavy per-diagram
// chunks are deferred by design and are deliberately NOT budgeted.
//
// size-limit reports brotli-compressed size (its default) — the transfer size
// the Forge CDN actually serves.
//
// Baselines measured 2026-07-21 (Mermaid 11.x / 10.x, size-limit 12.1), when
// each bundle was still a single entry chunk:
//   reader view entry    — 73.57 kB brotli   (budget 80 kB,  ~9% headroom)
//   config editor entry  — 153.76 kB brotli  (budget 165 kB, ~7% headroom)
// Re-measured 2026-08-05, now summing entry + vendor, after the vendor split
// and after the editor's dark theme moved to a dynamic import (it loads only
// when the editor is actually dark):
//   reader view          — 76.59 kB brotli   (budget 80 kB,  ~4% headroom)
//   config editor        — 158.68 kB brotli  (budget 162 kB, ~2% headroom)
// Both rose against the 2026-07-21 baselines despite those splits — ordinary
// dependency churn since, plus the vendor chunk's own module wrappers — so the
// config budget is tightened rather than raised. Headroom absorbs ordinary
// dependency churn while still failing hard on a folded-in engine (the smallest
// deferred engine is far larger than the gap).
// Raising a limit should be a conscious edit here, with the new baseline noted.
export default [
  {
    name: 'reader view — initial load (entry + vendor)',
    path: ['static/view/dist/assets/entry-*.js', 'static/view/dist/assets/vendor-*.js'],
    limit: '80 kB',
  },
  {
    name: 'config editor — initial load (entry + vendor)',
    path: ['static/config/dist/assets/entry-*.js', 'static/config/dist/assets/vendor-*.js'],
    limit: '162 kB',
  },
];

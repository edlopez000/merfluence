// Bundle-size budget for the two initial-load entry chunks.
//
// Why this exists: bundle size IS the product story. A page of plain
// flowcharts loads ~850 KB raw and *defers* ~2.3 MB of heavier engines
// (Cytoscape, KaTeX, ELK) that fetch only when a diagram needs them. Nothing
// else in CI guards that split. A stray *static* import that folds a deferred
// engine into an entry chunk, or a dependency bump that inflates it, would
// otherwise merge with no signal. This job is that signal.
//
// What it measures: only the entry chunk of each Vite bundle — the JS the
// iframe loads before any diagram renders. The entry is named `entry-[hash]`
// (see the Vite configs) precisely so this glob can target it without also
// matching Mermaid's lazily-loaded `index-*` internal chunks. The heavy
// per-diagram chunks are deferred by design and are deliberately NOT budgeted.
//
// size-limit reports brotli-compressed size (its default) — the transfer size
// the Forge CDN actually serves.
//
// Baselines measured 2026-07-21 (Mermaid 11.x / 10.x, size-limit 12.1):
//   reader view entry   — 73.57 kB brotli   (budget 80 kB,  ~9% headroom)
//   config editor entry  — 153.76 kB brotli  (budget 165 kB, ~7% headroom)
// Headroom absorbs ordinary dependency churn while still failing hard on a
// folded-in engine (the smallest deferred engine is far larger than the gap).
// Raising a limit should be a conscious edit here, with the new baseline noted.
export default [
  {
    name: 'reader view — entry chunk (initial load)',
    path: 'static/view/dist/assets/entry-*.js',
    limit: '80 kB',
  },
  {
    name: 'config editor — entry chunk (initial load)',
    path: 'static/config/dist/assets/entry-*.js',
    limit: '165 kB',
  },
];

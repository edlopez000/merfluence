import { defineConfig } from 'vitest/config';
import { mermaidVersions } from './vite.view.config.js';

// src/lib/mermaid-registry.js reads __MERMAID_*_VERSION__ at module top level,
// so anything importing it — render.js included — throws at import time without
// these. Reuse the same defines the real bundles are built with rather than
// stubbing: a test that renders under different version constants than
// production ships is testing a build that does not exist.
export default defineConfig({
  define: mermaidVersions,
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
  },
});

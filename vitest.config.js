import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import react from '@vitejs/plugin-react';
import { mermaidVersions } from './vite.view.config.js';

// src/lib/mermaid-registry.js reads __MERMAID_*_VERSION__ at module top level,
// so anything importing it — render.js included — throws at import time without
// these. Reuse the same defines the real bundles are built with rather than
// stubbing: a test that renders under different version constants than
// production ships is testing a build that does not exist.
//
// Injected via a config() plugin, not a top-level `define`: with `projects`, a
// project object's top-level `define` is not reliably applied, but a plugin's
// config() return is merged into every project it is listed on.
const mermaidDefine = {
  name: 'merfluence:mermaid-version-define',
  config: () => ({ define: mermaidVersions }),
};

export default defineConfig({
  test: {
    // Coverage is a root-level concern; it aggregates across both projects.
    // Thresholds are the measured floor after the runtime tests landed, not an
    // aspirational round number — CI fails if coverage drops below this, and
    // the numbers ratchet up as tests are added, never down silently.
    coverage: {
      provider: 'v8',
      // json-summary so CI can print the real aggregate (the text reporter
      // collapses fully-covered files, which understates what the gate sees).
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['src/**'],
      // index.html shells carry no branch logic worth gating on; they would
      // only depress the ratio with noise.
      exclude: ['src/**/*.html'],
      // The floor measured after each coverage-bearing suite lands, with a
      // couple of points of slack so the real render's run-to-run path variation
      // can't red the build. The pure lib/ modules sit at ~97%; the remaining
      // drag is the view DOM code (Stage pan/zoom, Toolbar interactions) that
      // only a mounted-component driver would reach. Last ratcheted when the
      // config-save + PNG-export browser tests landed (PNG export extracted to
      // lib/png-export.ts and covered directly). Ratchet up as more gets
      // covered — never down.
      thresholds: {
        lines: 70,
        statements: 65,
        functions: 63,
        branches: 58,
      },
    },
    projects: [
      {
        // JSX in the view/config tests needs a transform; the react plugin
        // gives the automatic runtime that React 19 + Testing Library expect.
        plugins: [react(), mermaidDefine],
        test: {
          name: 'unit',
          environment: 'jsdom',
          setupFiles: ['./test/setup.unit.js'],
          include: ['test/**/*.test.{js,jsx}'],
          // The browser project owns these; jsdom can't run mermaid.render.
          exclude: ['test/browser/**'],
        },
      },
      {
        plugins: [mermaidDefine],
        test: {
          name: 'browser',
          include: ['test/browser/**/*.test.js'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            // Chromium only: the pipeline is provider-agnostic, and one engine
            // is enough to prove mermaid.render + DOMPurify hold in a real DOM.
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});

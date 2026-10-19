import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { mermaidVersions } from './vite.view.config.js';

// Not a test suite: `npm run compare:engines` borrows the browser runner to
// render every fixture through both engines in a real Chromium (Mermaid needs
// getBBox, so Node cannot do it) and write the SVGs to docs/engine-compare/.
// Kept out of vitest.config.js so `npm test` never runs it.
export default defineConfig({
  define: mermaidVersions,
  test: {
    include: ['scripts/engine-compare/*.compare.js'],
    browser: {
      enabled: true,
      // Installed Google Chrome by default, so the comparison doesn't depend on
      // the Playwright browser download; PW_BUNDLED=1 uses Playwright's own.
      provider: playwright(process.env.PW_BUNDLED ? {} : { launchOptions: { channel: 'chrome' } }),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});

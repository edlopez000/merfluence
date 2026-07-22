import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Bake the real resolved Mermaid versions into the bundle so the UI can
// tell the user exactly what rendered their diagram. Bug reports arrive
// with a version attached instead of a shrug.
export const mermaidVersions = {
  __MERMAID_11_VERSION__: JSON.stringify(require('mermaid/package.json').version),
  __MERMAID_10_VERSION__: JSON.stringify(require('mermaid-10/package.json').version),
};

export default defineConfig({
  root: 'src/view',
  base: './',
  plugins: [react()],
  define: mermaidVersions,
  build: {
    outDir: '../../static/view/dist',
    emptyOutDir: true,
    target: 'es2020',
    // Mermaid is large. It loads as its own chunk, fetched from the app's
    // own origin (the Forge CDN), never a third-party CDN.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // Name the entry chunk `entry-[hash]` so the size-limit budget can
        // glob it unambiguously. A bare `index-*` glob would also match
        // Mermaid's lazily-loaded `index-*` internal chunk, folding a deferred
        // engine into the initial-load budget. The [hash] keeps filenames
        // content-addressed for the immutable-cache guarantee.
        entryFileNames: 'assets/entry-[hash].js',
      },
    },
  },
});

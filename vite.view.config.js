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

/**
 * Split the framework dependencies into their own chunk, shared by both builds
 * (each emits its own copy — they are separate bundles served from separate
 * Forge resource paths — but the shape is the same, so it lives here).
 *
 * The point is cache stability, not size. Rolldown hoists shared runtime
 * helpers into whichever chunk it considers the host, and that was the entry:
 * eleven chunks imported `entry-[hash].js` directly, so every chunk's content
 * hash derived transitively from the app's own code. One line changed anywhere
 * in src/ re-hashed essentially the whole Mermaid graph, and a returning reader
 * re-downloaded ~1.4 MB brotli of renderer that had not changed at all. Giving
 * React and DOMPurify a home of their own moves that role off the entry.
 *
 * Deliberately narrow: only leaf dependencies that no app module is imported
 * *by*. Pulling src/lib helpers in here risks a cycle (vendor importing an app
 * module that imports vendor), and Mermaid must never appear — it is lazily
 * imported per major, which is the whole load-time story.
 */
export const VENDOR_GROUP = {
  name: 'vendor',
  // Vite's preload helper is in here for the same reason as the libraries, and
  // it is the one that actually mattered: every Mermaid chunk imports it (it
  // wraps their dynamic imports), and it was living in the entry, which is what
  // chained their hashes to app code. It is Vite's own code, so it belongs with
  // the dependencies rather than with ours.
  test: /[\\/]node_modules[\\/](react|react-dom|scheduler|dompurify)[\\/]|preload-helper/,
  priority: 10,
};

export default defineConfig({
  root: 'src/view',
  base: './',
  plugins: [react()],
  define: mermaidVersions,
  build: {
    outDir: '../../static/view/dist',
    emptyOutDir: true,
    target: 'es2022',
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
        advancedChunks: { groups: [VENDOR_GROUP] },
      },
    },
  },
});

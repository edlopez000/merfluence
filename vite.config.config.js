import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VENDOR_GROUP, mermaidVersions } from './vite.view.config.js';

export default defineConfig({
  root: 'src/config',
  base: './',
  plugins: [react()],
  define: mermaidVersions,
  build: {
    outDir: '../../static/config/dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // Name the entry chunk `entry-[hash]` so the size-limit budget can
        // glob it unambiguously (see vite.view.config.js for the full why).
        entryFileNames: 'assets/entry-[hash].js',
        advancedChunks: { groups: [VENDOR_GROUP] },
      },
    },
  },
});

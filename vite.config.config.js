import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mermaidVersions } from './vite.view.config.js';

export default defineConfig({
  root: 'src/config',
  base: './',
  plugins: [react()],
  define: mermaidVersions,
  build: {
    outDir: '../../static/config/dist',
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
  },
});

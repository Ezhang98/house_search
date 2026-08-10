import { defineConfig } from 'vite';

// GitHub Pages serves a project site from /<repo>/, so asset URLs need that
// prefix. Local dev and preview keep '/' so nothing has to be reconfigured.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/house_search/' : '/',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
  },
}));

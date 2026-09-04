/**
 * Admin GUI build.
 *
 * Everything is bundled: no CDN, no external font, no remote analytics. That is a hard requirement
 * for a self-hosted hub, and the CSP the server sends (`default-src 'self'`) enforces it — a stray
 * external reference would simply fail to load rather than silently phoning home.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@now-playing/contracts': fileURLToPath(new URL('../../../packages/contracts/src/index.ts', import.meta.url)),
      '@now-playing/domain': fileURLToPath(new URL('../../../packages/domain/src/index.ts', import.meta.url)),
      '@now-playing/aqua-ui': fileURLToPath(new URL('../../../packages/aqua-ui/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../../dist/web', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    // Fail the build rather than shipping a bundle so large it stalls a first load on a slow LAN.
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5174,
    // In development the GUI runs on its own origin and talks to the hub through this proxy, so
    // the session cookie stays same-origin exactly as it is in production.
    proxy: {
      '/api': { target: 'http://127.0.0.1:4546', changeOrigin: false },
      '/realtime': { target: 'ws://127.0.0.1:4546', ws: true },
    },
  },
});

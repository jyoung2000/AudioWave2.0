/**
 * Renderer build.
 *
 * `base: './'` matters: the packaged app loads the interface from `file://`, where an absolute
 * `/assets/...` path resolves to the filesystem root and every asset 404s.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const workspace = (name: string): string => fileURLToPath(new URL(`../../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: {
    alias: {
      '@now-playing/contracts': workspace('contracts'),
      '@now-playing/domain': workspace('domain'),
      '@now-playing/aqua-ui': workspace('aqua-ui'),
    },
  },
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../../dist/renderer', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome130',
  },
  server: { port: 5175, strictPort: true },
});

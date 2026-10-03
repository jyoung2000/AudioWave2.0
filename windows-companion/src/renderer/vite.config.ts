/**
 * Renderer build.
 *
 * `base: './'` matters: the packaged app loads the interface from `file://`, where an absolute
 * `/assets/...` path resolves to the filesystem root and every asset 404s.
 *
 * `index.html` carries the packaged app's content security policy as a `<meta>` tag, because a
 * `file://` page never receives response headers. The dev server needs a looser policy (inline
 * script for HMR), which the main process sends as a header, so the tag is removed while serving.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const devCspMeta: Plugin = {
  name: 'now-playing-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/i, ''),
};

const workspace = (name: string): string => fileURLToPath(new URL(`../../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: {
    alias: {
      '@now-playing/contracts': workspace('contracts'),
      '@now-playing/domain': workspace('domain'),
      // The stylesheet entry must precede the bare package alias: string aliases match by prefix.
      '@now-playing/aqua-ui/airwave-window.css': fileURLToPath(new URL('../../../packages/aqua-ui/src/styles/airwave-window.css', import.meta.url)),
      '@now-playing/aqua-ui': workspace('aqua-ui'),
    },
  },
  plugins: [devCspMeta, react()],
  build: {
    outDir: fileURLToPath(new URL('../../dist/renderer', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome130',
  },
  server: { port: 5175, strictPort: true },
});

/**
 * Player build.
 *
 * Everything is bundled — React, Three.js, the worklet, the fonts, the icons. Nothing is fetched
 * from a CDN, because the player has to work with no network at all: that is the whole premise, and
 * a single external `<script>` would break it on a plane.
 *
 * The AudioWorklet is compiled to a standalone script and emitted as its own asset rather than
 * inlined: it runs on the audio thread, in a separate global scope with no module loader, and must
 * be loadable by URL. `vite-plugins/worklet.ts` does that, and the single-file build shares it.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { audioWorklet } from './vite-plugins/worklet.js';

const workspace = (name: string): string => fileURLToPath(new URL(`../packages/${name}/src/index.ts`, import.meta.url));

/** Where the app is served from: "/" on its own host, "/<repo>/" on a GitHub project page. */
const base = process.env['NP_BASE_PATH'] ?? '/';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  base,
  resolve: {
    alias: {
      '@now-playing/contracts': workspace('contracts'),
      '@now-playing/domain': workspace('domain'),
      // The stylesheet entries must precede the bare package alias: string aliases match by
      // prefix, so otherwise "…/aqua-ui/now-playing.css" is rewritten to "…/src/index.ts/now-playing.css".
      '@now-playing/aqua-ui/now-playing.css': fileURLToPath(new URL('../packages/aqua-ui/src/styles/now-playing.css', import.meta.url)),
      '@now-playing/aqua-ui': workspace('aqua-ui'),
      '@now-playing/audio-core': workspace('audio-core'),
      '@now-playing/recommendations': workspace('recommendations'),
    },
  },
  worker: { format: 'es' },
  plugins: [
    react(),
    audioWorklet(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      manifest: {
        name: 'Airwave',
        short_name: 'Airwave',
        description: 'An offline-first music player for the music already on your device.',
        id: base,
        start_url: base,
        scope: base,
        lang: 'en',
        dir: 'ltr',
        display_override: ['standalone', 'minimal-ui'],
        launch_handler: { client_mode: 'focus-existing' },
        prefer_related_applications: false,
        display: 'standalone',
        orientation: 'any',
        background_color: '#dfe4ea',
        theme_color: '#dfe4ea',
        categories: ['music', 'entertainment'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Library', url: `${base}?view=library` },
          { name: 'Now playing', url: `${base}?view=now-playing` },
        ],
      },
      workbox: {
        // The whole app shell is precached, so a cold start with no network still works.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Audio never enters the service worker cache: files can be hundreds of megabytes and are
        // already on the device or streamed from a hub the user chose.
        navigateFallback: `${base}index.html`,
        // Hub API routes and share pages are served by the hub, never by the app shell.
        navigateFallbackDenylist: [new RegExp(`^${escapeRegExp(base)}api/`), new RegExp(`^${escapeRegExp(base)}s/`), /^\/api\//, /^\/s\//],
        cleanupOutdatedCaches: true,
        // The streaming bridge (docs/AWSP.md §6): answers /awsp/track/<id> from the page's AWSP worker.
        // Plain script in public/, so it runs before Workbox's own fetch routes are registered.
        importScripts: ['awsp-sw.js'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            // Hub artwork is small and worth keeping, but never at the cost of showing stale art.
            urlPattern: /\/api\/v1\/library\/artwork\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'hub-artwork', expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Three.js is only needed by the constellation view; splitting it keeps the first load
        // small for someone who never opens it.
        manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : undefined),
      },
    },
  },
  // The desktop harness assigns a free port through PORT (autoPort); by hand it stays 5173.
  server: { host: '127.0.0.1', port: Number(process.env['PORT']) || 5173 },
});

/**
 * Player build.
 *
 * Everything is bundled — React, Three.js, the worklet, the fonts, the icons. Nothing is fetched
 * from a CDN, because the player has to work with no network at all: that is the whole premise, and
 * a single external `<script>` would break it on a plane.
 *
 * The AudioWorklet is built as its own entry rather than inlined: it runs on the audio thread, in a
 * separate global scope, and must be loadable by URL.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const workspace = (name: string): string => fileURLToPath(new URL(`../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
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
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      manifest: {
        name: 'Now Playing',
        short_name: 'Now Playing',
        description: 'An offline-first music player for the music already on your device.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#dfe4ea',
        theme_color: '#dfe4ea',
        categories: ['music', 'entertainment'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Library', url: '/?view=library' },
          { name: 'Now playing', url: '/?view=now-playing' },
        ],
      },
      workbox: {
        // The whole app shell is precached, so a cold start with no network still works.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Audio never enters the service worker cache: files can be hundreds of megabytes and are
        // already on the device or streamed from a hub the user chose.
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
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
  server: { host: '127.0.0.1', port: 5173 },
});

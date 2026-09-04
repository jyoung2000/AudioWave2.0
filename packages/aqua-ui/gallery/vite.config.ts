import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  build: { outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true },
  resolve: {
    alias: {
      '@now-playing/contracts': fileURLToPath(new URL('../../contracts/src/index.ts', import.meta.url)),
      '@now-playing/domain': fileURLToPath(new URL('../../domain/src/index.ts', import.meta.url)),
    },
  },
});

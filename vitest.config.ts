import { defineConfig } from 'vitest/config';

const alias = {
  '@now-playing/contracts': new URL('./packages/contracts/src/index.ts', import.meta.url).pathname,
  '@now-playing/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
  '@now-playing/audio-core': new URL('./packages/audio-core/src/index.ts', import.meta.url).pathname,
  '@now-playing/recommendations': new URL('./packages/recommendations/src/index.ts', import.meta.url).pathname,
  '@now-playing/test-fixtures': new URL('./packages/test-fixtures/src/index.ts', import.meta.url).pathname,
  // Listed before the bare package alias: string aliases match by prefix, so without this the
  // stylesheet path would be rewritten into "…/src/index.ts/now-playing.css".
  '@now-playing/aqua-ui/now-playing.css': new URL('./packages/aqua-ui/src/styles/now-playing.css', import.meta.url).pathname,
  '@now-playing/aqua-ui': new URL('./packages/aqua-ui/src/index.ts', import.meta.url).pathname,
};

const exclude = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/e2e/**', '**/tests/e2e/**', '**/playwright/**'];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'packages/*/tests/unit/**/*.test.ts', 'docker-container/src/**/*.test.ts', 'docker-container/tests/unit/**/*.test.ts', 'windows-companion/src/**/*.test.ts', 'windows-companion/tests/unit/**/*.test.ts', 'music-player/src/**/*.test.ts', 'music-player/tests/unit/**/*.test.ts'],
          exclude,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['packages/*/src/**/*.dom.test.{ts,tsx}', 'packages/*/tests/dom/**/*.test.{ts,tsx}', 'music-player/src/**/*.dom.test.{ts,tsx}', 'music-player/tests/dom/**/*.test.{ts,tsx}', 'docker-container/src/web/**/*.dom.test.{ts,tsx}', 'docker-container/tests/dom/**/*.test.{ts,tsx}', 'windows-companion/src/renderer/**/*.dom.test.{ts,tsx}', 'windows-companion/tests/dom/**/*.test.{ts,tsx}'],
          exclude,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'contracts',
          environment: 'node',
          include: ['packages/contracts/tests/**/*.test.ts', '**/tests/contract/**/*.test.ts'],
          exclude,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['**/tests/integration/**/*.test.ts'],
          exclude,
          testTimeout: 60_000,
          hookTimeout: 60_000,
          pool: 'forks',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'security',
          environment: 'node',
          include: ['**/tests/security/**/*.test.ts'],
          exclude,
          testTimeout: 60_000,
        },
      },
      {
        // Budgets measured from built output, so this runs after `pnpm build`, not with the rest.
        resolve: { alias },
        test: {
          name: 'perf',
          environment: 'node',
          include: ['tests/perf/**/*.test.ts'],
          exclude,
        },
      },
    ],
  },
});

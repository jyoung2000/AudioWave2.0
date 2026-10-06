import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// fileURLToPath, not URL#pathname: the latter gives "/C:/…" on Windows and keeps %20 for spaces.
const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const alias = {
  '@now-playing/contracts': path('./packages/contracts/src/index.ts'),
  '@now-playing/domain/radio-node': path('./packages/domain/src/radio-node.ts'),
  '@now-playing/domain/tool-install': path('./packages/domain/src/tool-install/index.ts'),
  '@now-playing/domain/catalog': path('./packages/domain/src/catalog/index.ts'),
  '@now-playing/domain': path('./packages/domain/src/index.ts'),
  // Before the bare alias for the same prefix reason as the stylesheets below.
  '@now-playing/audio-core/tempo': path('./packages/audio-core/src/tempo.ts'),
  '@now-playing/audio-core': path('./packages/audio-core/src/index.ts'),
  '@now-playing/recommendations': path('./packages/recommendations/src/index.ts'),
  '@now-playing/test-fixtures': path('./packages/test-fixtures/src/index.ts'),
  // Listed before the bare package alias: string aliases match by prefix, so without this the
  // stylesheet path would be rewritten into "…/src/index.ts/now-playing.css".
  '@now-playing/aqua-ui/now-playing.css': path('./packages/aqua-ui/src/styles/now-playing.css'),
  // The Airwave window's drawn controls (push button, pop-up, checkbox), shared by the hub and the companion.
  '@now-playing/aqua-ui/airwave-art': path('./packages/aqua-ui/src/airwave/aqua-art.ts'),
  '@now-playing/aqua-ui': path('./packages/aqua-ui/src/index.ts'),
  // Supplied by `music-player/vite-plugins/worklet.ts` in a real build. Vitest runs no bundler
  // plugins, so it resolves to the same "no asset" answer the single-file build gives.
  'virtual:np-worklet-url': path('./music-player/src/lib/worklet-url.stub.ts'),
};

// .claude/ holds agent worktrees: whole copies of this repository whose tests would run against
// these packages' sources through the aliases above and fail for reasons that are not theirs.
const exclude = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/e2e/**', '**/tests/e2e/**', '**/playwright/**', '**/.claude/**'];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'packages/*/tests/unit/**/*.test.ts', 'docker-container/src/**/*.test.ts', 'docker-container/tests/unit/**/*.test.ts', 'windows-companion/src/**/*.test.ts', 'windows-companion/tests/unit/**/*.test.ts', 'music-player/src/**/*.test.ts', 'music-player/tests/unit/**/*.test.ts', 'local-helper/src/**/*.test.ts', 'local-helper/tests/unit/**/*.test.ts'],
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

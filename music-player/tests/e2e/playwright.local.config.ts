/**
 * End-to-end configuration for the single-file build.
 *
 * Deliberately separate from `playwright.config.ts`, and the difference is the entire point: there
 * is **no `webServer` here**. The other config starts `vite preview` and drives the app over http,
 * which is right for the served build and useless for this one — every bug this suite exists to
 * catch only happens at a `file://` origin, where the browser refuses the fetches that http allows.
 *
 * Run `pnpm build:local` first; the specs read `dist-local/now-playing.html` from disk.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const launchOptions = process.env['PW_CHROMIUM_PATH'] ? { launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] } } : {};

export default defineConfig({
  testDir: '.',
  testMatch: /local-file\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never', outputFolder: fileURLToPath(new URL('../../playwright-report-local', import.meta.url)) }]] : [['list']],
  outputDir: fileURLToPath(new URL('../../test-results-local', import.meta.url)),
  use: {
    // No baseURL: every navigation in this suite is an absolute file:// URL, on purpose.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: [],
    ...launchOptions,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...launchOptions } }],
});

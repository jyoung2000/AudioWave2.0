/**
 * End-to-end configuration.
 *
 * The tests run against a real production build served by `vite preview`, not the dev server: the
 * service worker, the code-split chunks and the minified bundle are part of what is being tested,
 * and none of them exist in dev mode.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The player asks for microphone-free media only; no permissions are needed, and granting none
    // is part of what the tests verify.
    permissions: [],
    ...(process.env['PW_CHROMIUM_PATH'] ? { launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env['PW_CHROMIUM_PATH'] ? { launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] } } : {}) } }],
  webServer: {
    command: `npx vite preview --port ${PORT} --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    cwd: new URL('../..', import.meta.url).pathname,
  },
});

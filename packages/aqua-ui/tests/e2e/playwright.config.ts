/**
 * The styleguide, opened the way anybody opens it.
 *
 * No web server: `docs/design/styleguide.html` is a single committed file that depends on nothing
 * beside it, and opening it straight off the filesystem is both how it is meant to be used and the
 * strictest version of that claim. If it ever grows a dependency on a server, these tests stop
 * running rather than quietly passing.
 */
import { defineConfig, devices } from '@playwright/test';

const chromium = process.env['PW_CHROMIUM_PATH'] ? { launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] } } : {};

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', ...chromium },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...chromium } }],
});

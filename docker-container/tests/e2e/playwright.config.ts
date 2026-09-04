/**
 * End-to-end configuration for the hub.
 *
 * The tests drive a real browser against the real server: the built admin bundle served by the
 * hub's own static handler, the real API, real argon2, real SQLite. Nothing is stubbed, because the
 * thing being tested here is the first-run gate, and a gate is only worth testing where it actually
 * stands.
 *
 * Each run gets a fresh data directory, so "first run" really is a first run.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { AUTH_STATE } from './shared.js';

const PORT = 4547;
const dataDir = process.env['NP_E2E_DATA_DIR'] ?? mkdtempSync(join(tmpdir(), 'np-hub-e2e-'));
const launchOptions = process.env['PW_CHROMIUM_PATH'] ? { launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] } } : {};

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  // One worker: these tests share one hub, and first-run state is by definition not parallel.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: [],
    ...launchOptions,
  },
  projects: [
    // The first-run walk runs first and saves a signed-in session; everything else reuses it, so
    // the suite signs in a handful of times rather than once per test (the hub rate-limits logins).
    { name: 'setup', testMatch: /.*\.setup\.ts/, use: { ...devices['Desktop Chrome'], ...launchOptions } },
    { name: 'chromium', testIgnore: /.*\.setup\.ts/, dependencies: ['setup'], use: { ...devices['Desktop Chrome'], ...launchOptions, storageState: AUTH_STATE } },
  ],
  webServer: {
    command: 'node dist/server.js',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      NP_DATA_DIR: dataDir,
      NP_PORT: String(PORT),
      NP_BIND_MODE: 'localhost',
      NP_LOG_LEVEL: 'warn',
      NP_DEMO_MODE: 'false',
    },
  },
});

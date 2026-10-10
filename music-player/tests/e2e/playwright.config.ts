/**
 * End-to-end configuration.
 *
 * The tests run against a real production build served by `vite preview`, not the dev server: the
 * service worker, the code-split chunks and the minified bundle are part of what is being tested,
 * and none of them exist in dev mode.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/** 4173 unless NP_E2E_PORT says otherwise: a second checkout's preview on 4173 would otherwise be reused. */
const PORT = Number(process.env['NP_E2E_PORT'] ?? 4173);

/**
 * The ported airwave-np suites play real audio through the engine; Chromium's autoplay gate would
 * refuse an `audio.play()` that no click preceded, so it is lifted for the test browser only.
 *
 * SwiftShader is named explicitly because headless Chromium's default GL path on Windows stalls the
 * main thread on every frame of the 3D stage ("GPU stall due to ReadPixels"): indexing eight small
 * files took ten seconds, and every awaited step in a test paid the same second. In software GL the
 * same work takes tens of milliseconds, and the WebGL views (the statistics wells) still render.
 */
const launchOptions = {
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  ...(process.env['PW_CHROMIUM_PATH'] ? { executablePath: process.env['PW_CHROMIUM_PATH'] } : {}),
};

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  // One retry on CI only: a slow runner's timing hiccup should not turn main red, and Playwright still
  // reports any test that needed it as flaky. Locally (and in pnpm verify) a failure is a failure.
  retries: process.env['CI'] ? 1 : 0,
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
    // The shell registers a service worker, and requests a worker makes do not pass through
    // page.route, so the network stubs every suite relies on would be bypassed. Blocked here; the
    // tests that are about the worker (installable, offline) allow it for themselves.
    serviceWorkers: 'block',
    launchOptions,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions } }],
  webServer: {
    command: `npx vite preview --port ${PORT} --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    // fileURLToPath, not URL#pathname: on Windows the latter is "/C:/…", which is not a directory,
    // and Playwright fails to spawn the preview server with a bare ENOENT.
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
  },
});

/**
 * The cross-app journey: one browser, one hub, one player, both real processes.
 *
 * Every other suite in this repository tests one application. The player's own suites stub the hub
 * with route interception against the contract, which is the right shape for testing the player —
 * but it means nothing has ever checked that the player's assumptions and the hub's real behaviour
 * agree. An invite link is produced by the hub's GUI and consumed by the player's; a profile name is
 * refused by the hub and the refusal has to arrive in the player's interface. Those seams are what
 * this suite is for, and it is the only place they are exercised end to end.
 *
 * Two servers, both built (`pnpm build` first): the hub from its own `dist/server.js` with a fresh
 * data directory, so first run really is a first run, and the player from `vite preview` over
 * `music-player/dist`. Ports are deliberately not the ones the per-application suites use, so this
 * can run beside them without either stealing the other's server.
 *
 * `baseURL` is the hub, because the journey starts in the hub's GUI. The player is reached through
 * `PLAYER_URL`, and the invite link the hub makes points there — which is the point: the link has to
 * name where players open the app, and here that is a real address serving the real player.
 *
 * No origin configuration is needed: `api/security.ts` allows any loopback origin its CORS headers,
 * and the player's device traffic carries a bearer credential rather than the admin cookie, so the
 * cross-origin checks that guard admin writes do not apply to it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const HUB_PORT = 4548;
const PLAYER_PORT = 4174;

/**
 * Set JOURNEY_HUB_URL to run the same pass against a hub that is already up — the Docker container
 * (`docker compose up -d` in docker-container/, then http://127.0.0.1:4546). The hub is then not
 * started here, and it must be at first run: step 01 sets its password.
 */
const EXTERNAL_HUB = process.env['JOURNEY_HUB_URL'];
export const HUB_URL = EXTERNAL_HUB ?? `http://127.0.0.1:${HUB_PORT}`;
export const PLAYER_URL = `http://127.0.0.1:${PLAYER_PORT}`;

const dataDir = process.env['NP_JOURNEY_DATA_DIR'] ?? mkdtempSync(join(tmpdir(), 'np-journey-'));
const repo = fileURLToPath(new URL('../..', import.meta.url));
const launchOptions = process.env['PW_CHROMIUM_PATH'] ? { launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] } } : {};

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  // One worker, and the steps are ordered: this is a journey, not a set of independent checks.
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: HUB_URL,
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    permissions: [],
    ...launchOptions,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...launchOptions } }],
  webServer: [
    ...(EXTERNAL_HUB ? [] : [{
      command: 'node dist/server.js',
      url: `${HUB_URL}/healthz`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      cwd: join(repo, 'docker-container'),
      env: {
        NP_DATA_DIR: dataDir,
        NP_PORT: String(HUB_PORT),
        NP_BIND_MODE: 'localhost',
        NP_LOG_LEVEL: 'info',
        NP_DEMO_MODE: 'false',
        // The repo's rights-clean tone fixtures: a keyless library with real audio, so step 08's
        // paired search and audible preview run against the real thing.
        NP_PUBLIC_DOMAIN_DIR: join(repo, 'packages', 'test-fixtures', 'generated', 'audio'),
      },
    }]),
    {
      command: `npx vite preview --port ${PLAYER_PORT} --host 127.0.0.1`,
      url: PLAYER_URL,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      cwd: join(repo, 'music-player'),
    },
  ],
});

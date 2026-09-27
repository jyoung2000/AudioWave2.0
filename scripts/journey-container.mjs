#!/usr/bin/env node
/**
 * `pnpm test:journey:container` — the cross-app journey against the Docker image instead of a hub
 * process: bring up the disposable journey hub (docker-container/compose.journey.yaml), run the
 * same Playwright pass against it, and remove it again whatever the outcome. The exit code is the
 * pass's own.
 */
import { spawnSync } from 'node:child_process';

const COMPOSE = ['compose', '-f', 'docker-container/compose.journey.yaml'];

function sh(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });
  return r.status ?? 1;
}

// --wait: returns once the hub answers its health check, and fails when it never does.
if (sh('docker', [...COMPOSE, 'up', '-d', '--build', '--wait']) !== 0) {
  sh('docker', [...COMPOSE, 'logs', '--tail', '60']);
  sh('docker', [...COMPOSE, 'down', '-v']);
  process.exit(1);
}
let status;
try {
  status = sh('pnpm', ['exec', 'playwright', 'test', '--config', 'tests/journey/playwright.config.ts'], { JOURNEY_HUB_URL: 'http://127.0.0.1:4550' });
} finally {
  sh('docker', [...COMPOSE, 'down', '-v']);
}
process.exit(status);

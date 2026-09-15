/**
 * The helper, from the browser's side.
 *
 * The unit and integration tests prove the helper's own behaviour. This proves the claim the
 * *product* makes: run one program, and the player opens with the tools wired up — detected, named
 * in Settings, and able to put a real file into the library without anything being configured.
 *
 * yt-dlp is stubbed, as it is in the helper's own tests, and for the same reason: the contract
 * worth testing is the one between this app and a tool that writes a file where it was told to, not
 * whether a particular video still exists. The stub copies a real fixture, so the track that lands
 * is decoded, tagged and played exactly like one off a disk — which is the part that would break if
 * the wiring were wrong.
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = join(REPO, 'packages/test-fixtures/generated/audio/Marlow & the Tidewater/Quiet Arithmetic');
const PORT = 17399;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let helper: ChildProcess | null = null;
let scratch = '';

/** Stands in for yt-dlp: answers `--version`, then copies a real track where it was told to. */
function writeStub(directory: string): string {
  const source = join(FIXTURES, readdirSync(FIXTURES).filter((name) => name.endsWith('.wav'))[0]!);
  const path = join(directory, 'stub-yt-dlp.mjs');
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2026.09.01\\n'); process.exit(0); }
const paths = args[args.indexOf('--paths') + 1];
process.stdout.write('[download]  50.0% of 1.00MiB\\n');
process.stdout.write('[download] 100.0% of 1.00MiB\\n');
copyFileSync(${JSON.stringify(source)}, join(paths, 'Fetched Song.wav'));
process.exit(0);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'np-helper-e2e-'));
  const stub = writeStub(scratch);
  helper = spawn(
    process.execPath,
    [join(REPO, 'local-helper/dist/now-playing-helper.mjs'), '--no-open', '--port', String(PORT), '--app', join(REPO, 'music-player/dist'), '--yt-dlp', stub, '--work-dir', join(scratch, 'work'), '--tools-dir', join(scratch, 'tools')],
    { stdio: 'ignore' },
  );
  // Poll rather than sleep: the helper is ready when it answers, not after a guessed delay.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}/helper/v1/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the helper never came up');
});

test.afterAll(() => {
  helper?.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Settings —/ }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto(ORIGIN);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
});

test('the player finds the helper that served it, with nothing configured', async ({ page }) => {
  await openSettings(page);
  const platforms = page.locator('.aqua-panel').filter({ has: page.locator('.aqua-panel__title', { hasText: 'Platforms' }) });
  await expect(platforms.getByText('Local helper')).toBeVisible();
  // The label comes from the backend rather than from the panel, so this is also the assertion that
  // the panel is reporting what answered rather than describing what it hoped for.
  await expect(platforms.getByText('A helper, serving this page')).toBeVisible();
  // The version it reported, not a claim that something called yt-dlp exists somewhere.
  await expect(platforms.locator('.player-helper-tools')).toContainText('2026.09.01');
  // FFmpeg is genuinely absent in this environment, and the panel says so rather than hiding it.
  await expect(platforms.locator('.player-helper-tools')).toContainText('not installed');
});

test('a tool on this machine is reported beside the platform, never instead of its terms', async ({ page }) => {
  await openSettings(page);
  const youtube = page.locator('.player-platform').filter({ hasText: 'YouTube' });
  // This is the line that matters: the tool changes what is possible here, and changes nothing
  // about what YouTube permits.
  await expect(youtube).toContainText('Save a file: No');
  await expect(youtube).toContainText('Your yt-dlp: can reach it');
  await youtube.getByRole('button', { name: 'Why?' }).click();
  await expect(youtube).toContainText('Whether you may is between you and this platform');
});

test('fetching a link puts a real track in the library', async ({ page }) => {
  await page.getByRole('button', { name: /Add from a link/i }).first().click();
  await expect(page.getByRole('heading', { name: 'Add from a link' })).toBeVisible();

  // Nothing can be fetched until the link parses and a rights basis is chosen.
  const fetchButton = page.getByRole('button', { name: 'Fetch', exact: true });
  await expect(fetchButton).toBeDisabled();
  await page.getByRole('textbox', { name: 'Link' }).fill('https://www.youtube.com/watch?v=test');
  await expect(fetchButton).toBeDisabled();
  await page.getByText('It is mine', { exact: true }).click();
  await expect(fetchButton).toBeEnabled();

  await fetchButton.click();
  await expect(page.locator('tbody tr')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('td.lib-title').first()).toHaveText(/\S/);
  await expect(page.locator('.np-section-head p')).toContainText('1 track');
});

test('a link the helper will not fetch from is refused, with the reason', async ({ page }) => {
  await page.getByRole('button', { name: /Add from a link/i }).first().click();
  await page.getByRole('textbox', { name: 'Link' }).fill('https://evil.example/track');
  await page.getByText('It is mine', { exact: true }).click();
  await page.getByRole('button', { name: 'Fetch', exact: true }).click();
  // The refusal comes from the helper and is shown as it was given, not flattened into "failed".
  await expect(page.locator('.player-notices, .np-notice, [role="status"], [role="alert"]').first()).toContainText(/allowlist/i, { timeout: 15_000 });
});

/**
 * The helper, from the browser's side.
 *
 * The helper's own tests prove its behaviour. This proves the claim the product makes: run one
 * program, open the player it serves, and the tools are found with nothing configured — named in
 * Settings ▸ Sources ▸ Connections — and a link can become a real track in the library, played from
 * this device, once the person has said why they may have the file.
 *
 * yt-dlp is stubbed, as it is in the helper's own tests: the contract worth testing is the one
 * between this app and a tool that writes a file where it was told to. The stub copies a real
 * fixture, so the track that lands is decoded, tagged and played exactly like one off a disk.
 *
 * Rewritten for the shell (DEC-019): the React "Add from a link" sheet and the platform panel are
 * gone. A link row now reaches the library through the shell's search (covered by np/func.spec.ts);
 * here it is added through the same `library:add` seam, and fetched through the transport's
 * Download key, which is what the helper made real.
 */
import { test, expect } from '@playwright/test';
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
    [join(REPO, 'local-helper/dist/now-playing-helper.mjs'), '--no-open', '--port', String(PORT), '--app', join(REPO, 'music-player/dist'), '--yt-dlp', stub, '--work-dir', join(scratch, 'work'), '--tools-dir', join(scratch, 'tools'), '--no-auto-tools'],
    { stdio: 'ignore' },
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${ORIGIN}/helper/v1/health`)).ok) return;
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

test.beforeEach(async ({ page }) => {
  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.NP_READY);
  await page.evaluate(() => window.NP_READY);
});

test('the player finds the helper that served it, with nothing configured', async ({ page }) => {
  await page.click('#profile');
  await page.click('#pt-src');
  // Connections asked the page's own origin at boot, because the helper put its token in the page.
  await expect(page.locator('#cfgConnMsg')).toContainText(/Connected/, { timeout: 10_000 });
  const facts = page.locator('#connAppFacts');
  await expect(facts).toContainText(ORIGIN);
  // The version the tool reported, not a claim that something called yt-dlp exists somewhere.
  await expect(facts).toContainText('yt-dlp 2026.09.01');
  // FFmpeg is absent here, and the pane says so rather than hiding it.
  await expect(facts).toContainText('ffmpeg missing');
});

test('fetching a link puts a real track in the library, and it plays from this device', async ({ page }) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('library:add', { detail: { title: 'A Link', artist: 'Someone', url: 'https://www.youtube.com/watch?v=test', platform: 'YouTube' } })));
  await page.click('#download');
  const sheet = page.locator('#npFetch');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('#npFetchState')).toContainText('Using');
  // Nothing is fetched until the person says why they may have it.
  await sheet.locator('#npFetchGo').click();
  await expect(sheet.locator('#npFetchState')).toContainText('Say why you may have this file first');
  await sheet.getByText('It is mine').click();
  await sheet.locator('#npFetchGo').click();
  await expect(sheet).toBeHidden({ timeout: 30_000 });
  // The link row gave way to the real file, which is now the one playing.
  await expect.poll(() => page.evaluate(() => window.LIBRARY!.filter((s) => s.local).length), { timeout: 10_000 }).toBe(1);
  expect(await page.evaluate(() => window.LIBRARY!.some((s) => s.title === 'A Link'))).toBe(false);
  await expect.poll(() => page.evaluate(() => window.NP_PLAYER!.playing()), { timeout: 10_000 }).toBe(true);
});

test('a link the helper will not fetch from is refused, with the reason', async ({ page }) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('library:add', { detail: { title: 'Elsewhere', url: 'https://evil.example/track', platform: 'Web' } })));
  await page.click('#download');
  const sheet = page.locator('#npFetch');
  await sheet.getByText('It is mine').click();
  await sheet.locator('#npFetchGo').click();
  // The refusal is the helper's own words, not flattened into "failed".
  await expect(sheet.locator('#npFetchState')).toContainText(/allow/i, { timeout: 15_000 });
  await expect(sheet).toBeVisible();
});

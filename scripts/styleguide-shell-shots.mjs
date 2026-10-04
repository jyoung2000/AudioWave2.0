#!/usr/bin/env node
/**
 * `pnpm styleguide:shell` — photograph the served player for the style guide.
 *
 * The player serves `music-player/index.html`, a shell generated from the Airwave design (DEC-019).
 * It is one large document with its own scripts, so the guide cannot render it inside a frame the
 * way it renders the hub's and the companion's views; it shows screenshots instead. This script
 * takes them, from the production build (`pnpm build:player` first) served by `vite preview` on a
 * port of its own, so they cannot quietly drift: it writes `shots.json` beside them with the hash
 * of the shell it photographed, and `pnpm styleguide:check` fails when the shell has changed since.
 *
 * What it does is what a person does: eight songs are added through the shell's own import path,
 * Gantry is played, then Radio (with the station directory unreachable, so the bundled stations
 * show), Live TV (from a companion's helper, stubbed with three channels and a guide) and Settings
 * are opened — at 1280 × 860 and at 390 × 844. Nothing leaves the machine.
 *
 *   node scripts/styleguide-shell-shots.mjs [--out packages/aqua-ui/styleguide/shell] [--port 4183]
 *
 * Uses Playwright's Chromium, or the browser named by NP_STYLEGUIDE_BROWSER or PW_CHROMIUM_PATH.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellHash } from './styleguide-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const OUT = resolve(root, option('out', 'packages/aqua-ui/styleguide/shell'));
const PORT = Number(option('port', '4183'));
const BASE = `http://127.0.0.1:${PORT}`;
const COMPANION = 'http://127.0.0.1:17999';
const SOURCE = 'music-player/index.html';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const VIEWPORTS = [
  { id: 'desktop', width: 1280, height: 860 },
  { id: 'phone', width: 390, height: 844 },
];

/** Two artists, two albums, four songs each — the e2e suites' seed (music-player/tests/e2e/np/_shell.ts). */
const SEED = [
  ['01 Harbour Morning.wav', 'Harbour Morning', 'Alder Quartet', 'First Light'],
  ['02 Gantry.wav', 'Gantry', 'Alder Quartet', 'First Light'],
  ['03 Blue Hour.wav', 'Blue Hour', 'Alder Quartet', 'First Light'],
  ['04 Tideline.wav', 'Tideline', 'Alder Quartet', 'First Light'],
  ['05 Paper Harbour.wav', 'Paper Harbour', 'Birch Ensemble', 'Late Shift'],
  ['06 Closing Hour.wav', 'Closing Hour', 'Birch Ensemble', 'Late Shift'],
  ['07 Ember Line.wav', 'Ember Line', 'Birch Ensemble', 'Late Shift'],
  ['08 Slow Carousel.wav', 'Slow Carousel', 'Birch Ensemble', 'Late Shift'],
];

const soon = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const CHANNELS = {
  channels: [
    { id: 'c-news', name: 'Harbour News', number: 1, group: 'News', logo: null, url: 'https://tv.example/news.m3u8', tvgId: 'news.example' },
    { id: 'c-weather', name: 'Coast Weather', number: 2, group: 'News', logo: null, url: 'https://tv.example/weather.m3u8', tvgId: 'weather.example' },
    { id: 'c-jazz', name: 'Night Jazz', number: 7, group: 'Music', logo: null, url: 'https://tv.example/jazz.m3u8', tvgId: null },
  ],
};
const guide = () => ({
  generatedAt: new Date().toISOString(),
  guide: [
    { tvgId: 'news.example', now: { title: 'Evening Report', start: soon(-10), stop: soon(20), description: null }, next: { title: 'The Late Review', start: soon(20), stop: soon(50), description: null } },
    { tvgId: 'weather.example', now: { title: 'Tides and Winds', start: soon(-5), stop: soon(25), description: null }, next: { title: 'Overnight Outlook', start: soon(25), stop: soon(55), description: null } },
  ],
});
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const json = (body) => ({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function waitFor(url) {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not yet
    }
    await sleep(250);
  }
  throw new Error(`${url} did not answer`);
}

/** Generated in the page: 8 kHz PCM with RIFF INFO tags, added through the shell's own import path. */
async function seed(page) {
  const added = await page.evaluate(async (list) => {
    const wav = (name, secs, tags) => {
      const rate = 8000;
      const n = secs * rate;
      const enc = (s) => {
        const b = new TextEncoder().encode(`${s} `);
        return b.length % 2 ? new Uint8Array([...b, 0]) : b;
      };
      const info = Object.entries(tags).map(([k, v]) => ({ k, e: enc(v) }));
      const listLen = 4 + info.reduce((a, x) => a + 8 + x.e.length, 0);
      const total = 44 + n * 2 + 8 + listLen;
      const buf = new ArrayBuffer(total);
      const v = new DataView(buf);
      const u = new Uint8Array(buf);
      const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      s(0, 'RIFF');
      v.setUint32(4, total - 8, true);
      s(8, 'WAVE');
      s(12, 'fmt ');
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true);
      v.setUint16(22, 1, true);
      v.setUint32(24, rate, true);
      v.setUint32(28, rate * 2, true);
      v.setUint16(32, 2, true);
      v.setUint16(34, 16, true);
      let o = 36;
      s(o, 'LIST');
      v.setUint32(o + 4, listLen, true);
      s(o + 8, 'INFO');
      o += 12;
      for (const x of info) {
        s(o, x.k);
        v.setUint32(o + 4, x.e.length, true);
        u.set(x.e, o + 8);
        o += 8 + x.e.length;
      }
      s(o, 'data');
      v.setUint32(o + 4, n * 2, true);
      o += 8;
      for (let i = 0; i < n; i += 1) v.setInt16(o + i * 2, Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 3000), true);
      return new File([buf], name, { type: 'audio/wav' });
    };
    const files = list.map(([file, title, artist, album]) => wav(file, 120, { INAM: title, IART: artist, IPRD: album }));
    const result = await window.NP_LIBRARY.addFiles(files);
    await new Promise((done) => setTimeout(done, 300));
    return result.added;
  }, SEED);
  if (added !== SEED.length) throw new Error(`the shell indexed ${added} of ${SEED.length} songs`);
}

async function shoot(browser, viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block', reducedMotion: 'no-preference', colorScheme: 'light', locale: 'en-US' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Nothing leaves the machine: the station directory and every other outside host are unreachable,
  // and the companion's helper is answered here.
  await page.route((url) => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', (route) => route.abort());
  await page.route('**/127.0.0.1:8642/**', (route) => route.abort());
  await page.route(`${COMPANION}/helper/v1/tv/channels`, (route) => route.fulfill(json(CHANNELS)));
  await page.route(`${COMPANION}/helper/v1/tv/guide`, (route) => route.fulfill(json(guide())));
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => window.NP_READY);
  await page.evaluate(() => window.NP_READY);
  await sleep(400);
  await seed(page);

  // A new player opens on what was played recently, which is nothing yet; the whole library is one
  // narrowing away (the first album in the Albums drill), cleared — as the e2e suites' resetToLibrary.
  if ((await page.getAttribute('#libScopeClear', 'hidden')) !== null) {
    await page.click('#libMenuBtn');
    await sleep(200);
    await page.click('#ipodMenu .ipod__item[data-i="4"]');
    await sleep(200);
    await page.click('#ipodMenu .ipod__item[data-i="0"]');
    await sleep(300);
  }
  await page.click('#libScopeClear');
  await sleep(300);
  await page.locator('#libraryRows tr:has(.lib-title:text-is("Gantry"))').click();
  await sleep(2500);
  const name = (view) => join(OUT, `player-${viewport.id}-${view}.png`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: name('now-playing') });

  await page.click('.tb__btn[data-view="radio"]');
  await sleep(1500);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: name('radio') });

  const channels = await page.evaluate(async (base) => {
    window.COMPANION = base;
    return window.companionTv();
  }, COMPANION);
  if (channels !== CHANNELS.channels.length) throw new Error(`the guide took ${channels} channels`);
  await page.click('.tb__btn[data-view="live-tv"]');
  await sleep(1200);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: name('live-tv') });

  await page.evaluate(() => {
    location.hash = '#settings';
  });
  await sleep(1800);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: name('settings') });

  await context.close();
  if (errors.length) throw new Error(`the shell reported errors at ${viewport.id}:\n${[...new Set(errors)].join('\n')}`);
  return ['now-playing', 'radio', 'live-tv', 'settings'].map((view) => relative(OUT, name(view)).replace(/\\/g, '/'));
}

async function main() {
  const dist = join(root, 'music-player', 'dist', 'index.html');
  if (!existsSync(dist)) throw new Error('no player build: run pnpm build:player first');
  mkdirSync(OUT, { recursive: true });
  const require = createRequire(join(root, 'package.json'));
  const { chromium } = require('@playwright/test');
  const vite = join(dirname(require.resolve('vite/package.json', { paths: [join(root, 'music-player')] })), 'bin', 'vite.js');
  // One node process, stopped by its PID when done.
  const server = spawn(process.execPath, [vite, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: join(root, 'music-player'), stdio: 'ignore' });
  try {
    await waitFor(`${BASE}/`);
    const executablePath = process.env.NP_STYLEGUIDE_BROWSER || process.env.PW_CHROMIUM_PATH || undefined;
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    try {
      const files = [];
      for (const viewport of VIEWPORTS) files.push(...(await shoot(browser, viewport)));
      const record = {
        source: SOURCE,
        sourceHash: shellHash(readFileSync(join(root, SOURCE), 'utf8')),
        takenAt: new Date().toISOString(),
        how: 'pnpm styleguide:shell (scripts/styleguide-shell-shots.mjs) against pnpm build:player, served by vite preview',
        viewports: VIEWPORTS,
        files,
      };
      writeFileSync(join(OUT, 'shots.json'), `${JSON.stringify(record, null, 2)}\n`);
      console.info(JSON.stringify({ out: relative(root, OUT), files: files.length, sourceHash: record.sourceHash }));
    } finally {
      await browser.close();
    }
  } finally {
    if (server.pid) {
      try {
        process.kill(server.pid);
      } catch {
        // already gone
      }
    }
  }
}

main().catch((error) => {
  console.error(`Shell screenshots: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

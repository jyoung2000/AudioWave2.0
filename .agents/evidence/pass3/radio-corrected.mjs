/**
 * Pass 3 — corrected NP-RADIO-001/002 measurement.
 *
 * Two corrections to the first driver, both mine:
 *  1. `gesture-no-retune` compared a pre-TUNE row against a post-gesture row, so "equal:false"
 *     proved nothing. The playing row is now sampled AFTER the tune, and again after the gesture.
 *  2. WLS turned out to read from a CORS-open FEED, so icyAsk()/now-playing was never called
 *     (correct per NP-RADIO-001, but it means the ICY path was untested). This driver tunes a
 *     station with no feed so the now-playing route is actually exercised and counted.
 *
 * Secrets are read from scratch and never written; the JSON carries no credential material.
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SCRATCH = 'C:/Users/jalon/AppData/Local/hermes/cache/scratch';
const EV = '.agents/evidence/pass3';
const PLAYER = 'http://127.0.0.1:4175';
const credentialId = readFileSync(`${SCRATCH}/dev-cred.txt`, 'utf8').trim();
const secret = readFileSync(`${SCRATCH}/dev-secret.txt`, 'utf8').trim();
const scopes = ['search:use', 'library:read', 'library:share', 'playlists:sync', 'group:member'];

mkdirSync(EV, { recursive: true });
const out = { startedAt: new Date().toISOString(), steps: [], notes: [], findings: [] };
const log = (step, data) => {
  out.steps.push({ step, at: new Date().toISOString(), ...data });
  console.log(`[${step}]`, JSON.stringify(data).slice(0, 340));
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const nowPlaying = [];
const feeds = [];
let to8642 = 0;
page.on('request', (r) => {
  const u = r.url();
  if (/radio\/now-playing/.test(u)) nowPlaying.push(u);
  if (/:8642/.test(u)) to8642 += 1;
  // anything that is a metadata read but NOT the now-playing route
  if (/api|json|icy|stream|feed/i.test(u) && !/now-playing/.test(u) && !/\.css|\.js|\.png|\.svg|\.woff/.test(u)) {
    feeds.push(u.slice(0, 100));
  }
});
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
await page.route('**/itunes.apple.com/**', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [] }) })
);

async function boot(hash = '') {
  await page.goto(PLAYER + '/' + hash);
  await page.waitForFunction(() => window.NP_READY);
  await page.evaluate(() => window.NP_READY);
  await page.waitForTimeout(400);
}
const playingSid = () =>
  page.locator('#radioMenu .rlist tbody tr.is-playing, #radioMenu .rlist tbody tr[aria-selected="true"]').first().getAttribute('data-sid').catch(() => null);

await boot();
await page.evaluate((acct) => window.kv.set('player:hub', acct), {
  base: 'http://127.0.0.1:4546', credentialId, secret, scopes, hubName: 'Now Playing Hub', deviceId: 'pass3',
});
await page.goto('about:blank');
await boot();

await page.click('.tb__btn[data-view="radio"]');
await page.waitForTimeout(1500);
log('directory', {
  stations: await page.locator('#radioMenu .rlist tbody tr').count(),
  nowPlayingCallsWhileDirectoryVisible: nowPlaying.length,
});
await page.screenshot({ path: `${EV}/p3-radio-directory.png` });

// ---- NP-RADIO-001 on a station with no feed: does the now-playing route actually fire? ----
for (const label of ['011.fm', 'WLS 94.7-FM']) {
  const before = nowPlaying.length;
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: label }).first();
  if ((await row.count()) === 0) { log('tune', { label, error: 'no such row' }); continue; }
  await row.dblclick();
  await page.waitForTimeout(21000);
  const log1 = {
    label,
    rowSong: await row.locator('.rlist-song').textContent().catch(() => null),
    rowArtist: await row.locator('.rlist-artist').textContent().catch(() => null),
    headline: await page.locator('.player__title').textContent().catch(() => null),
    nowPlayingCalls: nowPlaying.length - before,
    nowPlayingUrls: [...new Set(nowPlaying.slice(before))].map((u) => u.slice(0, 90)),
    metadataReadsNotNowPlaying: feeds.length,
  };
  log('tune', log1);
  if (nowPlaying.length - before === 0) {
    out.findings.push({
      station: label,
      note: 'no /radio/now-playing call for this station — its title came from a feed or the directory, not the ICY path',
    });
  }
  if (label === '011.fm') await page.screenshot({ path: `${EV}/p3-radio-tuned-011fm.png` });
}

// ---- NP-RADIO-002: the no-retune measurement, corrected ----
// Station choice matters: 011.fm's row carried the PROGRAMME FORMAT ("80s hard rock") and no
// artist, so its menu correctly has no "On air" section and no ls-air-next action. WLS 94.7-FM
// showed a confirmed live title (Piano Man / Billy Joel), so the interaction tests belong there.
const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
const playingAfterTune = await playingSid();
const titleBeforeGesture = await page.locator('.player__title').textContent().catch(() => null);
await row.click({ button: 'right', position: { x: 120, y: 8 } });
await page.waitForTimeout(700);
const playingAfterGesture = await playingSid();
const titleAfterGesture = await page.locator('.player__title').textContent().catch(() => null);
log('no-retune-corrected', {
  playingAfterTune, playingAfterGesture,
  stationUnchanged: playingAfterTune === playingAfterGesture,
  headlineUnchanged: titleBeforeGesture === titleAfterGesture,
  titleBeforeGesture, titleAfterGesture,
});

const menuHead = await page.locator('#ctx .ctx__head').textContent().catch(() => null);
const groupBtn = page.locator('#ctx button', { hasText: 'Add Song to Group Queue' });
log('menu', {
  menuHead,
  items: (await page.locator('#ctx > .ctx__item').allTextContents()).map((s) => s.trim().slice(0, 40)),
  groupQueueDisabled: await groupBtn.isDisabled().catch(() => null),
  groupQueueReason: await groupBtn.getAttribute('title').catch(() => null),
});
await page.screenshot({ path: `${EV}/p3-radio-onair-menu.png` });

// ---- Up Next, then prove it survives a reload (library entry, exactly one) ----
const beforeCount = await page.locator('.lib__row, #libList tr, [data-lib-row]').count().catch(() => 0);
await page.click('#ctx [data-act="ls-air-next"]');
await page.waitForTimeout(1500);
const toast = await page.locator('#toast').textContent().catch(() => null);
log('up-next', { toast });
await boot();
await page.click('.tb__btn[data-view="music"]').catch(() => {});
await page.waitForTimeout(1200);
const afterCount = await page.locator('.lib__row, #libList tr, [data-lib-row]').count().catch(() => 0);
log('up-next-persistence', { rowsBeforeGesture: beforeCount, rowsAfterReload: afterCount, delta: afterCount - beforeCount });

// ---- Playlist: New Playlist path, then the item must land exactly once ----
await page.click('.tb__btn[data-view="radio"]');
await page.waitForTimeout(900);
const row2 = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
await row2.click({ button: 'right', position: { x: 120, y: 8 } });
await page.waitForTimeout(600);
await page.locator('#ctx .ctx__item--parent', { hasText: 'Add Song to Playlist' }).click();
await page.click('#ctx [data-act="ls-air-new"]');
await page.waitForSelector('#sheet[open]', { timeout: 4000 });
await page.fill('#sheetInput', 'Pass3 Heard On Air');
await page.click('#sheetCreate');
await page.waitForTimeout(1200);
log('playlist', { toast: await page.locator('#toast').textContent().catch(() => null) });
await page.screenshot({ path: `${EV}/p3-radio-playlist-added.png` });

// ---- Keyboard: Shift+F10 then arrows through BOTH submenu levels ----
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await row2.focus();
await page.keyboard.press('Shift+F10');
await page.waitForTimeout(600);
const kbOpen = await page.locator('#ctx').isVisible().catch(() => null);
const kbHead = await page.locator('#ctx .ctx__head').textContent().catch(() => null);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(500);
const sub1 = await page.locator('#ctx').isVisible().catch(() => null);
const sub1Items = (await page.locator('#ctx > .ctx__item, #ctx .ctx__sub *').allTextContents()).map((s) => s.trim().slice(0, 30));
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(400);
const sub2 = await page.locator('#ctx').isVisible().catch(() => null);
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(400);
const backAfterLeft = await page.locator('#ctx').isVisible().catch(() => null);
log('keyboard', { shiftF10Opened: kbOpen, kbHead, afterArrowRight1: sub1, sub1Items: sub1Items.slice(0, 6), afterArrowRight2: sub2, afterArrowLeft: backAfterLeft });
await page.screenshot({ path: `${EV}/p3-radio-keyboard-submenu.png` });

out.pageErrors = pageErrors;
out.requestsTo8642 = to8642;
writeFileSync(`${EV}/p3-radio-corrected.json`, JSON.stringify(out, null, 2));
console.log('\nWROTE', `${EV}/p3-radio-corrected.json`);
await browser.close();

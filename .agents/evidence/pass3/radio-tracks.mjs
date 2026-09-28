/**
 * Pass 3 — the last two unmeasured things, read from the REAL storage.
 *
 * Corrects two of my own errors:
 *  - The previous driver guessed kv keys (`kept`, `queue`) that do not exist. The IndexedDB object
 *    stores are actually: artwork, eqBindings, eqPresets, events, files, playlistItems, playlists,
 *    roots, settings, tracks. A kept radio song lands in `tracks`, so that is what is read — via
 *    indexedDB directly, not through guessed kv key names.
 *  - The Shift+F10 block timed out because the radio table was not re-rendered after the reload, so
 *    the row locator had nothing to attach to. The radio tab is now re-opened and the table awaited
 *    explicitly before focusing.
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
const out = { startedAt: new Date().toISOString(), steps: [] };
const log = (step, data) => {
  out.steps.push({ step, at: new Date().toISOString(), ...data });
  console.log(`[${step}]`, JSON.stringify(data).slice(0, 500));
};

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));

  const boot = async () => {
    await page.goto(PLAYER + '/');
    await page.waitForFunction(() => window.NP_READY);
    await page.evaluate(() => window.NP_READY);
    await page.waitForTimeout(500);
  };
  // Read the `tracks` object store — where a kept song actually lives.
  const readTracks = () =>
    page.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('now-playing', 1);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      });
      if (!db) return { error: 'no db' };
      const read = (store) =>
        new Promise((res) => {
          if (!db.objectStoreNames.contains(store)) return res({ absent: true });
          const rq = db.transaction(store, 'readonly').objectStore(store).getAll();
          rq.onsuccess = () =>
            res({
              len: rq.result.length,
              titles: rq.result.map((x) => x?.title ?? x?.name ?? null).slice(0, 8),
              artists: rq.result.map((x) => x?.artistName ?? x?.artist ?? null).slice(0, 8),
            });
          rq.onerror = () => res({ error: true });
        });
      const out2 = {};
      for (const s of ['tracks', 'playlists', 'playlistItems', 'events']) out2[s] = await read(s);
      return out2;
    });

  await boot();
  await page.evaluate((a) => window.kv.set('player:hub', a), {
    base: 'http://127.0.0.1:4546', credentialId, secret, scopes, hubName: 'Now Playing Hub', deviceId: 'pass3',
  });
  await page.goto('about:blank');
  await boot();

  const before = await readTracks();
  log('before-gesture', before);

  // Tune a station and keep what is on air.
  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForSelector('#radioMenu .rlist tbody tr', { timeout: 15000 });
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  await row.dblclick();
  await page.waitForTimeout(18000);
  const song = await row.locator('.rlist-song').textContent().catch(() => null);
  const artist = await row.locator('.rlist-artist').textContent().catch(() => null);
  log('tuned', { song, artist });

  const playingBefore = await page.locator('#radioMenu .rlist tbody tr.is-playing, #radioMenu .rlist tbody tr[aria-selected="true"]').first().getAttribute('data-sid').catch(() => null);

  await row.click({ button: 'right', position: { x: 120, y: 8 } });
  await page.waitForTimeout(700);
  const menuHead = await page.locator('#ctx .ctx__head').textContent().catch(() => null);
  await page.click('#ctx [data-act="ls-air-next"]');
  await page.waitForTimeout(1800);
  const toast = await page.locator('#toast').textContent().catch(() => null);
  const afterClick = await readTracks();
  log('after-up-next', { menuHead, toast, tracks: afterClick.tracks });

  // The gesture must not have retuned the station.
  const playingAfter = await page.locator('#radioMenu .rlist tbody tr.is-playing, #radioMenu .rlist tbody tr[aria-selected="true"]').first().getAttribute('data-sid').catch(() => null);
  log('no-retune', { playingBefore, playingAfter, unchanged: playingBefore === playingAfter });

  // ---- persistence across a real reload ----
  await boot();
  await page.waitForTimeout(900);
  const afterReload = await readTracks();
  log('after-reload', afterReload);
  await page.screenshot({ path: `${EV}/p3-after-reload.png` });

  // ---- Shift+F10 + arrows through BOTH submenu levels ----
  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForSelector('#radioMenu .rlist tbody tr', { timeout: 15000 });
  await page.waitForTimeout(800);
  const row2 = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  await row2.focus();
  await page.waitForTimeout(200);
  await page.keyboard.press('Shift+F10');
  await page.waitForTimeout(700);
  const kb = {
    opened: await page.locator('#ctx').isVisible().catch(() => null),
    head: await page.locator('#ctx .ctx__head').textContent().catch(() => null),
    level0: (await page.locator('#ctx > .ctx__item').allTextContents()).map((s) => s.trim().slice(0, 30)),
  };
  await page.screenshot({ path: `${EV}/p3-shiftf10-open.png` });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(600);
  kb.level1_afterRight = (await page.locator('#ctx > .ctx__item').allTextContents()).map((s) => s.trim().slice(0, 30));
  await page.screenshot({ path: `${EV}/p3-submenu-level1.png` });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(600);
  kb.level2_afterRight = (await page.locator('#ctx > .ctx__item').allTextContents()).map((s) => s.trim().slice(0, 30));
  await page.screenshot({ path: `${EV}/p3-submenu-level2.png` });
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(600);
  kb.afterLeft_level1 = (await page.locator('#ctx > .ctx__item').allTextContents()).map((s) => s.trim().slice(0, 30));
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(600);
  kb.afterLeft_level0 = (await page.locator('#ctx > .ctx__item').allTextContents()).map((s) => s.trim().slice(0, 30));
  log('shift-f10-submenus', kb);
  await page.screenshot({ path: `${EV}/p3-submenu-back.png` });

  out.pageErrors = errs;
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 4).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/p3-tracks-and-keys.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/p3-tracks-and-keys.json`);
  await browser.close();
}

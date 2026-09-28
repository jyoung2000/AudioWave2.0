/**
 * Pass 3 — settle three measurements that came back ambiguous. None may be reported as a defect
 * until they are re-measured under conditions that remove my own measurement error.
 *
 *  1. no-retune: run 1 said stationUnchanged:true, run 2 said unchanged:false. Run 2 read
 *     "playing" immediately after a dblclick tune, and the row may not have settled. Here the
 *     playing row is POLLED until it is stable and equals the tuned station, then the gesture is
 *     made, then it is polled again for stability.
 *  2. persistence: "Up Next" toasts, but the `tracks` store was empty before AND after. Rather than
 *     guess the key (already wrong twice), every object store is dumped before and after and the
 *     DELTA is reported, so wherever the entry lands shows up.
 *  3. ArrowRight/ArrowLeft: run 3 captured `#ctx > .ctx__item` at every level and got identical
 *     arrays, which cannot distinguish "submenu did not open" from "my selector counts both
 *     levels". Here submenu visibility, the expanded class on the parent item, and the visible
 *     item count per level are each captured separately.
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
const log = (s, d) => { out.steps.push({ step: s, at: new Date().toISOString(), ...d }); console.log(`[${s}]`, JSON.stringify(d).slice(0, 520)); };

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
  // Every object store, fully dumped, so the delta finds the entry wherever it lands.
  const dumpStores = () =>
    page.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('now-playing', 1); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
      if (!db) return { error: 'no db' };
      const o = {};
      for (const n of [...db.objectStoreNames]) {
        o[n] = await new Promise((res) => {
          const rq = db.transaction(n, 'readonly').objectStore(n).getAll();
          rq.onsuccess = () => res(rq.result.map((x) => (x && (x.title ?? x.name ?? x.text ?? x.type)) ?? null));
          rq.onerror = () => res(['<err>']);
        });
      }
      return o;
    });
  // Poll until the playing row is stable across two reads, so a settling row cannot be misread.
  const stablePlaying = async (tries = 12) => {
    let prev = null;
    for (let i = 0; i < tries; i++) {
      const sid = await page.locator('#radioMenu .rlist tbody tr.is-playing, #radioMenu .rlist tbody tr[aria-selected="true"]').first().getAttribute('data-sid').catch(() => null);
      if (sid && sid === prev) return { sid, settledAfter: i, stable: true };
      prev = sid;
      await page.waitForTimeout(1500);
    }
    return { sid: prev, settledAfter: tries, stable: false };
  };

  await boot();
  await page.evaluate((a) => window.kv.set('player:hub', a), { base: 'http://127.0.0.1:4546', credentialId, secret, scopes, hubName: 'Now Playing Hub', deviceId: 'pass3' });
  await page.goto('about:blank');
  await boot();

  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForSelector('#radioMenu .rlist tbody tr', { timeout: 15000 });
  const wls = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  const wlsSid = await wls.getAttribute('data-sid');
  const dumpBefore = await dumpStores();

  await wls.dblclick();
  await page.waitForTimeout(15000);
  const tuneSettled = await stablePlaying();
  const title = await page.locator('.player__title').textContent().catch(() => null);
  log('tune-settled', { wlsSid, playing: tuneSettled, isWlsPlaying: tuneSettled.sid === wlsSid, title });

  // ---- 1. no-retune, measured after the row has settled ----
  await wls.click({ button: 'right', position: { x: 120, y: 8 } });
  await page.waitForTimeout(600);
  const gestureSettled = await stablePlaying();
  log('no-retune-settled', { before: tuneSettled.sid, after: gestureSettled.sid, unchanged: tuneSettled.sid === gestureSettled.sid, afterIsWls: gestureSettled.sid === wlsSid });

  // ---- 2. persistence: delta of every store across Up Next + reload ----
  await page.click('#ctx [data-act="ls-air-next"]');
  await page.waitForTimeout(2000);
  const toast = await page.locator('#toast').textContent().catch(() => null);
  const dumpAfterClick = await dumpStores();
  await boot();
  await page.waitForTimeout(1200);
  const dumpAfterReload = await dumpStores();
  const delta = {};
  for (const s of new Set([...Object.keys(dumpBefore), ...Object.keys(dumpAfterReload)])) {
    const a = dumpBefore[s] ?? [], b = dumpAfterReload[s] ?? [];
    if (JSON.stringify(a) !== JSON.stringify(b)) delta[s] = { before: a, after: b, grewBy: b.length - a.length };
  }
  log('persistence-delta', { toast, storesThatChanged: Object.keys(delta), delta });
  await page.screenshot({ path: `${EV}/p3-persistence-after-reload.png` });

  // ---- 3. keyboard submenu levels, measured per level ----
  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForSelector('#radioMenu .rlist tbody tr', { timeout: 15000 });
  await page.waitForTimeout(800);
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  await row.focus();
  await page.keyboard.press('Shift+F10');
  await page.waitForTimeout(700);
  const captureLevel = () =>
    page.evaluate(() => {
      const items = [...document.querySelectorAll('#ctx > .ctx__item')];
      const submenus = [...document.querySelectorAll('#ctx .ctx__sub')];
      const active = document.activeElement;
      return {
        topLevelCount: items.length,
        topLevelLabels: items.map((i) => i.textContent.trim().slice(0, 26)),
        parents: items.filter((i) => i.className.includes('ctx__item--parent')).map((i) => i.querySelector('.ctx__label, span, b')?.textContent?.trim().slice(0, 26) ?? '?'),
        expandedParents: items.filter((i) => i.className.includes('is-open') || i.getAttribute('aria-expanded') === 'true').map((i) => (i.textContent || '').trim().slice(0, 26)),
        visibleSubmenus: submenus.filter((s) => s.offsetParent !== null || !s.hidden).length,
        submenuText: submenus.filter((s) => s.offsetParent !== null || !s.hidden).map((s) => s.textContent.replace(/\s+/g, ' ').trim().slice(0, 90)),
        activeElement: active ? `${active.tagName}#${active.id || ''}` : null,
      };
    });
  const lv0 = await captureLevel();
  await page.screenshot({ path: `${EV}/p3-kb-level0.png` });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(700);
  const lv1 = await captureLevel();
  await page.screenshot({ path: `${EV}/p3-kb-level1.png` });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(700);
  const lv2 = await captureLevel();
  await page.screenshot({ path: `${EV}/p3-kb-level2.png` });
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(700);
  const back1 = await captureLevel();
  log('keyboard-levels', {
    opened: lv0.topLevelCount > 0,
    lv0: { items: lv0.topLevelCount, parents: lv0.parents, visibleSubmenus: lv0.visibleSubmenus, active: lv0.activeElement },
    afterRight1: { items: lv1.topLevelCount, parents: lv1.parents, expanded: lv1.expandedParents, visibleSubmenus: lv1.visibleSubmenus, submenuText: lv1.submenuText, active: lv1.activeElement },
    afterRight2: { items: lv2.topLevelCount, expanded: lv2.expandedParents, visibleSubmenus: lv2.visibleSubmenus, submenuText: lv2.submenuText, active: lv2.activeElement },
    afterLeft: { items: back1.topLevelCount, visibleSubmenus: back1.visibleSubmenus, submenuText: back1.submenuText, active: back1.activeElement },
  });

  out.pageErrors = errs;
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 4).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/p3-settle.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/p3-settle.json`);
  await browser.close();
}

/**
 * Pass 3 — final gap-closing driver. Two things, both previously unmeasured:
 *
 *  1. Up Next persistence. The last run's dumps were EMPTY ({}), because the kv keys were my
 *     guesses. Here the real key namespace is enumerated first, then the kept entry is looked up.
 *  2. Shift+F10. Last run reported opened:false. That may be a real NP-RADIO-002 defect or my own
 *     focus/keyboard handling. §6 requires reproducing before calling anything a defect, so it is
 *     attempted twice per approach and the activeElement is reported each time.
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
const out = { startedAt: new Date().toISOString(), steps: [], notes: [] };
const log = (step, data) => {
  out.steps.push({ step, at: new Date().toISOString(), ...data });
  console.log(`[${step}]`, JSON.stringify(data).slice(0, 420));
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
    await page.waitForTimeout(400);
  };

  await boot();
  await page.evaluate((a) => window.kv.set('player:hub', a), {
    base: 'http://127.0.0.1:4546', credentialId, secret, scopes, hubName: 'Now Playing Hub', deviceId: 'pass3',
  });
  await page.goto('about:blank');
  await boot();

  // ---- enumerate the real kv namespace (no more guessed keys) ----
  const keys = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('now-playing', 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).catch(() => null);
    if (!db) return { error: 'no indexedDB "now-playing"' };
    const names = [...db.objectStoreNames];
    const stores = {};
    for (const n of names) {
      const tx = db.transaction(n, 'readonly');
      stores[n] = await new Promise((res) => {
        const rq = tx.objectStore(n).getAllKeys();
        rq.onsuccess = () => res(rq.result.map(String));
        rq.onerror = () => res([]);
      });
    }
    return { objectStores: names, keys: stores };
  });
  log('kv-namespace', keys);

  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForTimeout(1200);
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  await row.dblclick();
  await page.waitForTimeout(18000);
  log('tuned', { song: await row.locator('.rlist-song').textContent().catch(() => null), artist: await row.locator('.rlist-artist').textContent().catch(() => null) });

  // ---- gap 1: Up Next, then survive a reload, read via the REAL key namespace ----
  const snapshot = () =>
    page.evaluate(async () => {
      const found = {};
      const tryKeys = ['kept', 'queue', 'radio:kept', 'air:kept', 'player:kept', 'library'];
      for (const k of tryKeys) {
        const v = await window.kv.get(k).catch(() => undefined);
        if (v != null) found[k] = Array.isArray(v) ? { len: v.length, titles: v.map((x) => x?.title ?? null).slice(0, 6) } : v;
      }
      return found;
    });
  const beforeGesture = await snapshot();
  await row.click({ button: 'right', position: { x: 120, y: 8 } });
  await page.waitForTimeout(600);
  const menuHead = await page.locator('#ctx .ctx__head').textContent().catch(() => null);
  const airActions = await page.locator('#ctx [data-act^="ls-air"]').evaluateAll((n) => n.map((x) => x.getAttribute('data-act')));
  await page.click('#ctx [data-act="ls-air-next"]');
  await page.waitForTimeout(1600);
  const toast = await page.locator('#toast').textContent().catch(() => null);
  const afterClick = await snapshot();
  await boot();
  await page.waitForTimeout(1000);
  const afterReload = await snapshot();
  log('up-next-persistence', { menuHead, airActions, toast, beforeGesture, afterClick, afterReload });

  // ---- gap 2: Shift+F10, two approaches x two attempts (reproduce before concluding) ----
  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForTimeout(1200);
  const row2 = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  const attempts = [];
  // A: keyboard focus() on the row, then Shift+F10
  for (let i = 0; i < 2; i++) {
    await row2.focus();
    await page.keyboard.press('Shift+F10');
    await page.waitForTimeout(600);
    attempts.push({
      approach: 'focus() + Shift+F10', attempt: i + 1,
      ctxVisible: await page.locator('#ctx').isVisible().catch(() => null),
      head: await page.locator('#ctx .ctx__head').textContent().catch(() => null),
      active: await page.evaluate(() => {
        const a = document.activeElement;
        return a ? `${a.tagName}#${a.id || ''}.${(a.className || '').toString().split(' ')[0]}` : null;
      }),
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  // B: click the row to select, then Shift+F10
  for (let i = 0; i < 2; i++) {
    await row2.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Shift+F10');
    await page.waitForTimeout(600);
    attempts.push({
      approach: 'click() + Shift+F10', attempt: i + 1,
      ctxVisible: await page.locator('#ctx').isVisible().catch(() => null),
      head: await page.locator('#ctx .ctx__head').textContent().catch(() => null),
      active: await page.evaluate(() => {
        const a = document.activeElement;
        return a ? `${a.tagName}#${a.id || ''}.${(a.className || '').toString().split(' ')[0]}` : null;
      }),
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  // Control: right-click is known to work, so the menu itself is reachable.
  await row2.click({ button: 'right', position: { x: 120, y: 8 } });
  await page.waitForTimeout(500);
  const control = {
    rightClickVisible: await page.locator('#ctx').isVisible().catch(() => null),
    head: await page.locator('#ctx .ctx__head').textContent().catch(() => null),
  };
  await page.keyboard.press('Escape');
  log('shift-f10', { attempts, control });

  out.pageErrors = errs;
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 4).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/p3-final-gaps.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/p3-final-gaps.json`);
  await browser.close();
}

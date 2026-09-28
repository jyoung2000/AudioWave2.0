/**
 * Pass 3 — the three NP-RADIO-002 claims that are still UNMEASURED, measured correctly.
 *
 * Each previous attempt failed through a defect in MY measurement, not (necessarily) the product:
 *
 *  1. no-retune. I used `tr.is-playing, tr[aria-selected="true"]` — a COMMA selector, so
 *     .first() returns whichever comes first in DOM order. Right-clicking changes aria-selected, so
 *     I was reading the focused row rather than the playing one, and got `unchanged:false` on a run
 *     that the previous run had scored `true`. Now: `.is-playing` alone for the playing row, and
 *     the focused row is tracked separately so the two are never conflated.
 *  2. persistence. I read object stores but never the KEYS, and my key list was guessed (and wrong
 *     twice). Now: every store's full key list and value is dumped before/after, and the DELTA is
 *     printed with contents, so wherever the kept song lands is visible rather than inferred.
 *  3. keyboard submenus. I counted a submenu "visible" with `offsetParent !== null || !s.hidden`,
 *     and the `|| !s.hidden` branch makes almost everything count. Now: strict geometry
 *     (getBoundingClientRect width>0 && height>0) plus the parent's is-open/aria-expanded state.
 *
 * Nothing here may be reported as a defect until this run produces a clean, non-contradictory read.
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
const log = (s, d) => { out.steps.push({ step: s, at: new Date().toISOString(), ...d }); console.log(`[${s}]`, JSON.stringify(d).slice(0, 600)); };

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
  // Full key list AND values, for every store. This is what makes the delta readable.
  const dump = () =>
    page.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('now-playing', 1); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
      if (!db) return { error: 'no db' };
      const o = {};
      for (const n of [...db.objectStoreNames]) {
        o[n] = await new Promise((res) => {
          const tx = db.transaction(n, 'readonly');
          const st = tx.objectStore(n);
          const kq = st.getAllKeys();
          const vq = st.getAll();
          tx.oncomplete = () =>
            res(kq.result.map((k, i) => {
              const v = vq.result[i];
              const t = v && (v.title ?? v.name ?? v.artistName ?? v.text ?? v.label);
              return { key: String(k), kind: typeof v === 'object' && v !== null ? (Array.isArray(v) ? `array(${v.length})` : 'object') : typeof v, title: t ?? null };
            }));
          tx.onerror = () => res([{ key: '<err>' }]);
        });
      }
      return o;
    });
  // PLAYING row only — no comma selector, no aria-selected.
  const playingRow = () =>
    page.evaluate(() => {
      const el = document.querySelector('#radioMenu .rlist tbody tr.is-playing');
      if (!el) return null;
      return { sid: el.getAttribute('data-sid'), text: el.innerText.replace(/\s+/g, ' ').trim().slice(0, 50) };
    });
  const focusedRow = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el.tagName !== 'TR') return null;
      return { sid: el.getAttribute('data-sid'), ariaSelected: el.getAttribute('aria-selected') };
    });

  await boot();
  await page.evaluate((a) => window.kv.set('player:hub', a), { base: 'http://127.0.0.1:4546', credentialId, secret, scopes, hubName: 'Now Playing Hub', deviceId: 'pass3' });
  await page.goto('about:blank');
  await boot();

  const before = await dump();
  log('baseline-stores', Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.length])));

  // ---- tune ----
  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForSelector('#radioMenu .rlist tbody tr', { timeout: 15000 });
  const wls = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  const wlsSid = await wls.getAttribute('data-sid');
  await wls.dblclick();
  await page.waitForTimeout(16000);
  // Settle: poll the PLAYING row until two consecutive reads agree.
  let playing = await playingRow();
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(2000);
    const now = await playingRow();
    if (now && now.sid === playing?.sid) { playing = now; break; }
    playing = now;
  }
  const titleTuned = await page.locator('.player__title').textContent().catch(() => null);
  log('tuned', { wlsSid, playingRow: playing, isWlsPlaying: playing?.sid === wlsSid, headline: titleTuned });

  // ---- 1. no-retune: PLAYING row before vs after the gesture, focused row tracked separately ----
  const playingBefore = await playingRow();
  const focusBefore = await focusedRow();
  await wls.click({ button: 'right', position: { x: 120, y: 8 } });
  await page.waitForTimeout(1200);
  const playingAfter = await playingRow();
  const focusAfter = await focusedRow();
  const titleAfterGesture = await page.locator('.player__title').textContent().catch(() => null);
  log('no-retune', {
    playingBefore, playingAfter,
    playingUnchanged: playingBefore?.sid === playingAfter?.sid,
    focusBefore, focusAfter,
    focusMovedOnly: focusBefore?.sid !== focusAfter?.sid,
    headlineBefore: titleTuned, headlineAfter: titleAfterGesture,
    headlineUnchanged: titleTuned === titleAfterGesture,
  });

  // ---- 2. persistence: full store delta with contents ----
  const menuHead = await page.locator('#ctx .ctx__head').textContent().catch(() => null);
  const airActions = await page.locator('#ctx [data-act^="ls-air"]').evaluateAll((n) => n.map((x) => x.getAttribute('data-act')));
  await page.click('#ctx [data-act="ls-air-next"]');
  await page.waitForTimeout(2000);
  const toast = await page.locator('#toast').textContent().catch(() => null);
  const afterClick = await dump();
  await boot();
  await page.waitForTimeout(1200);
  const afterReload = await dump();
  const delta = {};
  for (const s of new Set([...Object.keys(before), ...Object.keys(afterReload)])) {
    const a = before[s] ?? [], b = afterReload[s] ?? [];
    if (JSON.stringify(a) !== JSON.stringify(b)) delta[s] = { before: a, after: b };
  }
  log('persistence', { menuHead, airActions, toast, storesChanged: Object.keys(delta), delta });

  // ---- 3. keyboard: STRICT submenu geometry + parent open state ----
  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForSelector('#radioMenu .rlist tbody tr', { timeout: 15000 });
  await page.waitForTimeout(800);
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  await row.focus();
  await page.waitForTimeout(300);
  await page.keyboard.press('Shift+F10');
  await page.waitForTimeout(800);
  // Strict: a submenu counts only if it actually occupies space.
  const level = () =>
    page.evaluate(() => {
      const items = [...document.querySelectorAll('#ctx > .ctx__item')];
      const subs = [...document.querySelectorAll('#ctx .ctx__sub')];
      const real = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
      return {
        topLevel: items.length,
        parentsWithSub: items.filter((i) => i.querySelector('.ctx__sub')).length,
        parentStates: items.filter((i) => i.querySelector('.ctx__sub')).map((i) => ({ label: i.textContent.replace(/\s+/g, ' ').trim().slice(0, 22), isOpen: i.className.includes('is-open'), ariaExpanded: i.getAttribute('aria-expanded') })),
        submenusTotal: subs.length,
        submenusRendered: subs.filter(real).length,
        renderedSubText: subs.filter(real).map((s) => s.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)),
        active: (() => { const a = document.activeElement; return a ? `${a.tagName}[${(a.getAttribute('data-act') || a.className || '').toString().slice(0, 26)}]` : null; })(),
      };
    });
  const l0 = await level();
  await page.screenshot({ path: `${EV}/p3b-kb-0.png` });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(800);
  const l1 = await level();
  await page.screenshot({ path: `${EV}/p3b-kb-1.png` });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(800);
  const l2 = await level();
  await page.screenshot({ path: `${EV}/p3b-kb-2.png` });
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(800);
  const b1 = await level();
  await page.screenshot({ path: `${EV}/p3b-kb-back.png` });
  log('keyboard', {
    opened: l0.topLevel > 0, head: await page.locator('#ctx .ctx__head').textContent().catch(() => null),
    l0, afterRight1: l1, afterRight2: l2, afterLeft: b1,
    right1_changedRenderedSubmenus: l0.submenusRendered !== l1.submenusRendered,
    right1_openedAParent: JSON.stringify(l0.parentStates) !== JSON.stringify(l1.parentStates),
  });

  out.pageErrors = errs;
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 4).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/p3b-corrected-measurements.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/p3b-corrected-measurements.json`);
  await browser.close();
}

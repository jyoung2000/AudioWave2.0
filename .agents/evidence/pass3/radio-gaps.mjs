/**
 * Pass 3 — closes the two NP-RADIO-002 gaps, and writes evidence even on failure.
 *
 * Gap 1: Up Next persistence. The previous driver's DOM row-count selector returned 0 before AND
 *        after, so it measured nothing. Here the queue is read from the player's own storage
 *        (window.kv), which is what the suite's state() helper does, and the DOM list is dumped for
 *        comparison rather than counted with a guessed selector.
 * Gap 2: Shift+F10 + ArrowRight/ArrowLeft through BOTH submenu levels.
 *
 * Evidence is written in a finally block: the previous run died before its JSON reached disk, which
 * meant results existed only in a transcript.
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
  console.log(`[${step}]`, JSON.stringify(data).slice(0, 300));
};

const browser = await chromium.launch();
let page;
try {
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  let to8642 = 0;
  page.on('request', (r) => { if (/:8642/.test(r.url())) to8642 += 1; });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));

  const boot = async () => {
    await page.goto(PLAYER + '/');
    await page.waitForFunction(() => window.NP_READY);
    await page.evaluate(() => window.NP_READY);
    await page.waitForTimeout(400);
  };
  // Read the queue and the kept/library entries from the player's own storage, the way the
  // suite's state() helper does, instead of guessing a CSS selector.
  const readState = () =>
    page.evaluate(async () => {
      const dump = {};
      for (const k of ['queue', 'player:queue', 'kept', 'player:kept', 'radio:kept', 'library:kept']) {
        try { const v = await window.kv.get(k); if (v != null) dump[k] = v; } catch {}
      }
      const q = document.querySelector('#queue, .queue, #upNext');
      return { dump, queueDomText: q ? q.innerText.replace(/\s+/g, ' ').trim().slice(0, 200) : null };
    });

  await boot();
  await page.evaluate((a) => window.kv.set('player:hub', a), {
    base: 'http://127.0.0.1:4546', credentialId, secret, scopes, hubName: 'Now Playing Hub', deviceId: 'pass3',
  });
  await page.goto('about:blank');
  await boot();

  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForTimeout(1200);
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  await row.dblclick();
  await page.waitForTimeout(18000);
  log('tuned', { song: await row.locator('.rlist-song').textContent().catch(() => null), artist: await row.locator('.rlist-artist').textContent().catch(() => null) });

  const before = await readState();

  // ---- gap 1: Up Next, then survive a reload ----
  await row.click({ button: 'right', position: { x: 120, y: 8 } });
  await page.waitForTimeout(600);
  const head = await page.locator('#ctx .ctx__head').textContent().catch(() => null);
  await page.click('#ctx [data-act="ls-air-next"]');
  await page.waitForTimeout(1500);
  const toast = await page.locator('#toast').textContent().catch(() => null);
  const afterClick = await readState();
  await boot();
  await page.waitForTimeout(800);
  const afterReload = await readState();
  const summarise = (s) =>
    Object.fromEntries(Object.entries(s.dump).map(([k, v]) => [k, Array.isArray(v) ? { len: v.length, titles: v.map((x) => x?.title ?? x?.name ?? null).slice(0, 5) } : v]));
  log('up-next-persistence', {
    menuHead: head, toast,
    beforeGesture: summarise(before),
    afterClick: summarise(afterClick),
    afterReload: summarise(afterReload),
    queueDomAfterReload: afterReload.queueDomText,
  });

  // ---- gap 2: Shift+F10, then arrows through BOTH submenu levels ----
  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForTimeout(1000);
  const row2 = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  await row2.click(); // focus the row first; focus() alone timed out before
  await page.waitForTimeout(300);
  await page.keyboard.press('Shift+F10');
  await page.waitForTimeout(700);
  const kb = {
    opened: await page.locator('#ctx').isVisible().catch(() => null),
    head: await page.locator('#ctx .ctx__head').textContent().catch(() => null),
    topLevel: (await page.locator('#ctx > .ctx__item').allTextContents()).map((s) => s.trim().slice(0, 34)),
  };
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  kb.afterRight1_visible = await page.locator('#ctx').isVisible().catch(() => null);
  kb.afterRight1_items = (await page.locator('#ctx > .ctx__item').allTextContents()).map((s) => s.trim().slice(0, 34));
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  kb.afterRight2_visible = await page.locator('#ctx').isVisible().catch(() => null);
  kb.afterRight2_items = (await page.locator('#ctx > .ctx__item').allTextContents()).map((s) => s.trim().slice(0, 34));
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(400);
  kb.afterLeft_visible = await page.locator('#ctx').isVisible().catch(() => null);
  kb.afterLeft_items = (await page.locator('#ctx > .ctx__item').allTextContents()).map((s) => s.trim().slice(0, 34));
  log('keyboard-submenus', kb);
  await page.screenshot({ path: `${EV}/p3-keyboard-submenu.png` });

  out.pageErrors = errs;
  out.requestsTo8642 = to8642;
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 4).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/p3-radio-gaps.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/p3-radio-gaps.json`, '(written in finally)');
  await browser.close();
}

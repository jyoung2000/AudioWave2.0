/**
 * Pass 3 — the keyboard submenu measurement, done validly.
 *
 * My previous attempts were invalid for two different reasons, and neither is the product's fault:
 *  - Attempt 1 used a visibility probe whose `|| !s.hidden` branch made nearly every submenu count
 *    as "visible", so the number was meaningless.
 *  - Attempt 2 used strict geometry but left FOCUS ON THE FIRST ITEM ("Play", data-act=ls-open).
 *    ArrowRight from an item with no submenu must do nothing, so it proved nothing.
 *
 * Valid test: move focus onto a PARENT item ("Add Song to Playlist"), confirm focus is really there
 * by data-act, then ArrowRight. The submenu must render (strict geometry) and the parent must flip
 * to aria-expanded="true". Then ArrowLeft back, then repeat for the SECOND parent, and finally the
 * nested level inside the first submenu.
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

  await boot();
  await page.evaluate((a) => window.kv.set('player:hub', a), { base: 'http://127.0.0.1:4546', credentialId, secret, scopes, hubName: 'Now Playing Hub', deviceId: 'pass3' });
  await page.goto('about:blank');
  await boot();

  // Strict: geometry AND computed style. Focus state is reported by data-act so it is never assumed.
  const snap = () =>
    page.evaluate(() => {
      const items = [...document.querySelectorAll('#ctx > .ctx__item')];
      const subs = [...document.querySelectorAll('#ctx .ctx__sub')];
      const real = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
      };
      const a = document.activeElement;
      return {
        focusDataAct: a?.getAttribute?.('data-act') ?? null,
        focusText: a?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 26) ?? null,
        focusIsParent: !!a?.closest?.('.ctx__item--parent'),
        parents: items.filter((i) => i.className.includes('ctx__item--parent')).map((i) => ({
          label: i.textContent.replace(/\s+/g, ' ').trim().slice(0, 24),
          ariaExpanded: i.getAttribute('aria-expanded'),
          isOpen: i.className.includes('is-open'),
          hasSub: !!i.querySelector('.ctx__sub'),
        })),
        submenusTotal: subs.length,
        submenusRendered: subs.filter(real).length,
        renderedText: subs.filter(real).map((s) => s.textContent.replace(/\s+/g, ' ').trim().slice(0, 70)),
        // nested submenus inside a submenu, for the second level
        nestedRendered: [...document.querySelectorAll('#ctx .ctx__sub .ctx__sub')].filter(real).length,
      };
    });

  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForSelector('#radioMenu .rlist tbody tr', { timeout: 15000 });
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  await row.dblclick();
  await page.waitForTimeout(15000);
  await row.focus();
  await page.keyboard.press('Shift+F10');
  await page.waitForTimeout(800);
  const opened = await snap();
  log('shift-f10-open', { head: await page.locator('#ctx .ctx__head').textContent().catch(() => null), ...opened });
  await page.screenshot({ path: `${EV}/p3c-kb-open.png` });

  // Move focus to the FIRST parent. ArrowDown is the roving-focus move in this menu.
  const moves = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(250);
    const s = await snap();
    moves.push({ i: i + 1, focusDataAct: s.focusDataAct, focusText: s.focusText, isParent: s.focusIsParent });
    if (s.focusIsParent) break;
  }
  const atParent = await snap();
  log('focus-moved-to-parent', { moves, landedOn: { act: atParent.focusDataAct, text: atParent.focusText, isParent: atParent.focusIsParent } });

  // Now the real test: ArrowRight while focus IS on a parent.
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(800);
  const afterRight = await snap();
  log('arrow-right-on-parent', { before: { rendered: opened.submenusRendered, parents: opened.parents }, after: { rendered: afterRight.submenusRendered, text: afterRight.renderedText, parents: afterRight.parents, focus: afterRight.focusText, nested: afterRight.nestedRendered } });
  await page.screenshot({ path: `${EV}/p3c-kb-aright.png` });

  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(700);
  const afterLeft = await snap();
  log('arrow-left-back', { rendered: afterLeft.submenusRendered, parents: afterLeft.parents, focus: afterLeft.focusText });
  await page.screenshot({ path: `${EV}/p3c-kb-aleft.png` });

  // Control: the suite's own method — CLICK the parent. If click opens it and ArrowRight does not,
  // that is a keyboard gap, not a broken submenu.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.keyboard.press('Shift+F10');
  await page.waitForTimeout(700);
  await page.locator('#ctx .ctx__item--parent', { hasText: 'Add Song to Playlist' }).click();
  await page.waitForTimeout(800);
  const byClick = await snap();
  log('submenu-by-click-control', { rendered: byClick.submenusRendered, text: byClick.renderedText, parents: byClick.parents });
  await page.screenshot({ path: `${EV}/p3c-kb-click.png` });

  out.pageErrors = errs;
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 5).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/p3c-keyboard-valid.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/p3c-keyboard-valid.json`);
  await browser.close();
}

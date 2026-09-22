/**
 * The video controller fits the player at every device size: LIVE centred in its box, level with
 * the rail, clear of its neighbours, the bar inside the player, no sideways scroll, and the picture
 * with its controls under the status bar. Ported from airwave-np tests/devices.mjs.
 *
 * The channel is one loaded from a playlist (the shell has no invented guide); the original's film
 * probes (a clock readout) had nothing to play and are not ported.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, seedChannels, silentWav } from './_shell';

const DEVICES: Array<[string, number, number, boolean]> = [
  ['iPhone SE', 320, 568, true], ['Galaxy S', 360, 780, true],
  ['iPhone mini', 375, 812, true], ['iPhone', 390, 844, true],
  ['iPhone Plus', 414, 896, true], ['iPhone Pro Max', 430, 932, true],
  ['iPhone SE land', 568, 320, true], ['iPhone land', 844, 390, true],
  ['Pro Max land', 932, 430, true], ['iPad mini', 744, 1133, true],
  ['iPad', 820, 1180, true], ['iPad Pro 11', 834, 1194, true],
  ['iPad land', 1180, 820, true], ['iPad Pro 13 land', 1366, 1024, true],
  ['Laptop', 1280, 800, false], ['Desktop', 1440, 900, false],
  ['Wide', 1920, 1080, false], ['Narrow window', 500, 800, false],
];

const probe = (p: Page) => p.evaluate(() => {
  const bar = document.getElementById('vp_bar')!, br = bar.getBoundingClientRect();
  const t = document.getElementById('vp_time')!.getBoundingClientRect();
  const el = document.getElementById('vp_live')!;
  const shownOk = !el.hidden && getComputedStyle(el).display !== 'none';
  const other = document.getElementById('vp_clock')!;
  const otherHidden = other.hidden || getComputedStyle(other).display === 'none';
  const rng = document.createRange(); rng.selectNodeContents(el.lastChild!);
  const rail = document.querySelector('#vp_scrub .track')!.getBoundingClientRect();
  const railMid = rail.top + rail.height / 2;
  const dotEl = el.querySelector('.vp-live__dot');
  const dr = dotEl ? dotEl.getBoundingClientRect() : null;
  const txt = rng.getBoundingClientRect();
  const whole = document.createRange(); whole.selectNodeContents(el); const ink = whole.getBoundingClientRect();
  const scrub = document.getElementById('vp_scrub')!.getBoundingClientRect();
  const next = document.getElementById('vp_time')!.parentElement!.nextElementSibling!.getBoundingClientRect();
  const kids = [...bar.children].filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.getBoundingClientRect());
  const fits = kids.every((k) => k.left >= br.left - 0.5 && k.right <= br.right + 0.5);
  const vid = document.getElementById('vp_player')!.getBoundingClientRect();
  return {
    shown: shownOk && otherHidden,
    centred: Math.abs((ink.x + ink.width / 2) - (t.x + t.width / 2)) <= 1,
    level: Math.abs(txt.top + txt.height / 2 - railMid) <= 0.75 && (!dr || Math.abs(dr.top + dr.height / 2 - railMid) <= 0.75),
    clear: ink.left >= scrub.right - 0.5 && ink.right <= next.left + 0.5 && ink.left >= t.left - 0.5 && ink.right <= t.right + 0.5,
    barFits: fits, scrub: Math.round(scrub.width),
    playerInView: vid.left >= -0.5 && vid.right <= innerWidth + 0.5,
    pageScrollX: document.documentElement.scrollWidth > innerWidth + 1,
    text: el.textContent!.trim(),
  };
});

for (const [name, w, h, touch] of DEVICES) {
  test(`${name} ${w}x${h}: the LIVE readout sits right, idle and playing`, async ({ browser }) => {
    const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch && w < 900 });
    const p = await c.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));
    await p.route('**/x.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }));
    await boot(p);
    await seedChannels(p);
    await p.click('.tb__btn[data-view="live-tv"]'); await p.waitForTimeout(500);
    const idle = await probe(p);
    await p.click('#mediaMenu .rlist tbody tr[data-i="0"]'); await p.waitForTimeout(800);
    const playing = await probe(p);
    for (const [k, r] of [['live, idle', idle], ['live, playing', playing]] as const) {
      expect(r.shown && r.centred && r.level && r.clear && r.barFits && r.scrub >= 60 && r.playerInView && !r.pageScrollX, `${name} ${k} ${JSON.stringify(r)}`).toBe(true);
    }
    expect(errors, 'PAGEERROR ' + name).toEqual([]);
    await c.close();
  });
}

for (const [name, w, h] of [['iPhone SE land', 568, 320], ['Galaxy land', 780, 360], ['iPhone land', 844, 390], ['Pro Max land', 932, 430], ['iPad land', 1180, 820], ['Laptop short', 1280, 560], ['iPhone', 390, 844]] as Array<[string, number, number]>) {
  test(`${name} ${w}x${h}: the picture and its controls fit under the status bar`, async ({ browser }) => {
    const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 1200, isMobile: w < 900 });
    const p = await c.newPage();
    await boot(p);
    await p.click('.tb__btn[data-view="live-tv"]'); await p.waitForTimeout(500);
    const g = await p.evaluate(() => {
      const pl = document.getElementById('vp_player')!.getBoundingClientRect();
      return { h: Math.round(pl.height), sb: Math.round(document.querySelector('.statusbar')!.getBoundingClientRect().height), vh: innerHeight };
    });
    expect(g.h + g.sb, `player ${g.h}px tall + status bar ${g.sb} within ${g.vh}`).toBeLessThanOrEqual(g.vh);
    await c.close();
  });
}

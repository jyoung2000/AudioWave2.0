/**
 * LIVE on the video bar, the radio transport, the one volume every stream follows, and one source
 * sounding at a time. Ported from airwave-np tests/livevol.mjs.
 *
 * Live TV's channels are loaded from a playlist (the shell has no invented guide) and their
 * streams answer with decodable audio, so a channel really plays and really loops. The original's
 * film assertions (a clock, a seekable scrubber, "a film counts") had nothing to play — Movies has
 * no import path yet — and are not ported; the LIVE half of each contrast is.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { boot, reload, seedChannels, silentWav, watchErrors } from './_shell';

const WAV = silentWav();
const go = async (p: Page, v: string) => { await p.click('.tb__btn[data-view="' + v + '"]'); await p.waitForTimeout(500); };
const radioReady = async (p: Page) => { await expect(p.locator('#libScopeLabel')).toHaveText('Chicago', { timeout: 15_000 }); await expect(p.locator('#radioMenu .rlist tbody tr').first()).toBeVisible({ timeout: 15_000 }); await p.waitForTimeout(200); };

async function wire(page: Page): Promise<string[]> {
  const errors = watchErrors(page);
  await page.route((u) => /^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1' && !/radio-browser\.info/i.test(u.href) && !/good\.m3u|x\.invalid/.test(u.href),
    (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }));
  await page.route(/radio-browser\.info/i, (r) => r.abort());
  return errors;
}
async function fresh(browser: Browser, opts: Parameters<Browser['newContext']>[0]): Promise<Page> {
  const c = await browser.newContext(opts);
  const p = await c.newPage();
  await wire(p);
  await boot(p);
  return p;
}

let errors: string[];
test.beforeEach(async ({ page }) => { errors = await wire(page); await boot(page); });
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('LIVE on the video bar: the tab is live on arrival and a channel keeps it so', async ({ page }) => {
  await seedChannels(page);
  await go(page, 'live-tv');
  expect((await page.isVisible('#vp_live')) && !(await page.isVisible('#vp_clock')), 'the Live TV tab reads LIVE before anything is chosen').toBe(true);
  await page.click('#mediaMenu .rlist tbody tr[data-i="0"]'); await page.waitForTimeout(800);
  expect(await page.isVisible('#vp_live'), 'a channel puts LIVE on the bar').toBe(true);
  expect(await page.isVisible('#vp_clock'), 'and takes the duration off it').toBe(false);
  expect((await page.textContent('#vp_live'))!.trim(), 'it reads LIVE').toBe('LIVE');
  expect(await page.$eval('#vp_video', (v) => (v as HTMLVideoElement).loop), 'a channel loops, so LIVE stays true').toBe(true);
  expect((await page.getAttribute('#vp_scrub', 'role')) === 'img' && (await page.getAttribute('#vp_scrub', 'aria-valuenow')) === null, 'and the scrubber stops offering a position to seek to').toBe(true);
});

test('the radio transport: Previous and Next read as unavailable, Play does not, and they say why', async ({ page }) => {
  await go(page, 'radio'); await radioReady(page);
  const dis = (s: string) => page.getAttribute(s, 'aria-disabled');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('radio:station', { detail: { station: { id: 'x', name: 'Test FM', url: 'https://example.invalid/s' } } })));
  await page.waitForTimeout(300);
  expect((await dis('#prev')) === 'true' && (await dis('#next')) === 'true', 'Previous and Next read as unavailable on Radio').toBe(true);
  expect(await dis('#play'), 'but Play does not — stopping a stream is a real thing to want').toBe('false');
  expect(await page.getAttribute('#prev', 'title'), 'and they say why').toBe('Not available for radio');
  expect(await page.evaluate(() => (document.getElementById('prev') as HTMLElement).tabIndex), 'they stay reachable from the keyboard').not.toBe(-1);
});

test('volume reaches the stream: the slider, Home and End, and a new station keeps the level', async ({ page }) => {
  await go(page, 'radio'); await radioReady(page);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('radio:station', { detail: { station: { id: 'x', name: 'Test FM', url: 'https://example.invalid/s' } } })));
  await page.waitForTimeout(300);
  const vol = () => page.$eval('#radioAudio', (a) => [(a as HTMLAudioElement).volume, (a as HTMLAudioElement).muted] as [number, boolean]);
  await page.evaluate(() => {
    const t = document.getElementById('volume')!, r = t.getBoundingClientRect();
    t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + r.width / 2, pointerId: 1 }));
    t.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  });
  await page.waitForTimeout(200);
  let [v, m] = await vol();
  expect(Math.abs(v - 0.5), 'dragging the slider to the middle halves the stream: ' + v).toBeLessThan(0.06);
  expect(m, 'and does not mute it').toBe(false);
  await page.focus('#volume'); await page.keyboard.press('Home'); await page.waitForTimeout(200);
  [v, m] = await vol();
  expect(v === 0 && m, 'Home is silence, and silence mutes').toBe(true);
  await page.keyboard.press('End'); await page.waitForTimeout(200);
  [v, m] = await vol();
  expect(v === 1 && !m, 'End is full').toBe(true);

  await page.evaluate(() => document.getElementById('volume')!.focus());
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  const before = (await vol())[0];
  await page.click('#radioMenu .rlist tbody tr[data-i="2"]'); await page.waitForTimeout(900);
  const after = (await vol())[0];
  expect(Math.abs(after - before), 'changing station keeps the level: ' + before + ' -> ' + after).toBeLessThan(0.001);
});

test('the level is remembered across a reload', async ({ page }) => {
  await page.evaluate(() => document.getElementById('volume')!.focus());
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(600);
  await reload(page);
  expect(await page.getAttribute('#volume', 'aria-valuenow'), 'the level is remembered across a reload').toBe('20');
});

test('one thing at a time: a channel stops the station, and tuning back stops the channel', async ({ page }) => {
  await seedChannels(page);
  await go(page, 'radio'); await radioReady(page);
  await page.click('#radioMenu .rlist tbody tr[data-i="0"]'); await page.waitForTimeout(1200);
  expect(await page.$eval('#radioAudio', (a) => !(a as HTMLAudioElement).paused), 'a station is playing').toBe(true);
  await go(page, 'live-tv');
  await page.click('#mediaMenu .rlist tbody tr[data-i="0"]'); await page.waitForTimeout(900);
  expect(await page.$eval('#vp_video', (v) => !(v as HTMLVideoElement).paused), 'a channel starts').toBe(true);
  expect(await page.$eval('#radioAudio', (a) => (a as HTMLAudioElement).paused), 'and the station stops — not both at once').toBe(true);
  await go(page, 'radio'); await page.waitForTimeout(600);
  await page.click('#radioMenu .rlist tbody tr[data-i="0"]'); await page.waitForTimeout(1200);
  expect(await page.$eval('#vp_video', (v) => (v as HTMLVideoElement).paused), 'and tuning back stops the channel').toBe(true);
});

test('the Live TV tab is live before a channel is chosen, and a channel does not follow you on to TV', async ({ browser }) => {
  const q = await fresh(browser, { viewport: { width: 1280, height: 900 } });
  await seedChannels(q);
  const st = () => q.evaluate(() => ({ live: !(document.getElementById('vp_live') as HTMLElement).hidden, clock: !(document.getElementById('vp_clock') as HTMLElement).hidden, paused: (document.getElementById('vp_video') as HTMLVideoElement).paused }));
  await q.click('.tb__btn[data-view="live-tv"]'); await q.waitForTimeout(500);
  let x = await st();
  expect(x.live && !x.clock, 'arriving on Live TV shows LIVE, not a clock').toBe(true);
  await q.click('#mediaMenu .rlist tbody tr[data-i="0"]'); await q.waitForTimeout(800);
  expect(!(await st()).paused, 'a channel plays').toBe(true);
  await q.click('.tb__btn[data-view="tv"]'); await q.waitForTimeout(500);
  x = await st();
  expect(!x.live && x.paused, 'nor does a channel follow you on to TV').toBe(true);
  await q.context().close();
});

for (const [w, touch] of [[390, true], [820, true], [1280, false]] as Array<[number, boolean]>) {
  test(`${w}px LIVE is centred in its box, clear of its neighbours, and the scrubber keeps room`, async ({ browser }) => {
    const q = await fresh(browser, { viewport: { width: w, height: 900 }, hasTouch: touch, isMobile: w < 600 });
    await seedChannels(q);
    await q.click('.tb__btn[data-view="live-tv"]'); await q.waitForTimeout(400);
    await q.click('#mediaMenu .rlist tbody tr[data-i="0"]'); await q.waitForTimeout(900);
    const g = await q.evaluate(() => {
      const t = document.getElementById('vp_time')!.getBoundingClientRect();
      const el = document.getElementById('vp_live')!;
      const rng = document.createRange(); rng.selectNodeContents(el);
      const ink = rng.getBoundingClientRect();
      const scrub = document.getElementById('vp_scrub')!.getBoundingClientRect();
      const next = document.getElementById('vp_time')!.parentElement!.nextElementSibling!.getBoundingClientRect();
      return { off: Math.abs((ink.x + ink.width / 2) - (t.x + t.width / 2)), inside: ink.left >= t.left - 0.5 && ink.right <= t.right + 0.5,
        clearOfScrub: ink.left >= scrub.right - 0.5, clearOfNext: ink.right <= next.left + 0.5, scrubW: scrub.width };
    });
    const tag = w + 'px LIVE';
    expect(g.off, tag + ' is centred in its box (off by ' + g.off.toFixed(1) + 'px)').toBeLessThanOrEqual(1);
    expect(g.inside && g.clearOfScrub && g.clearOfNext, tag + ' stays inside its box and clear of its neighbours').toBe(true);
    expect(g.scrubW, tag + ': the scrubber keeps room to be used (' + Math.round(g.scrubW) + 'px)').toBeGreaterThanOrEqual(60);
    await q.context().close();
  });
}

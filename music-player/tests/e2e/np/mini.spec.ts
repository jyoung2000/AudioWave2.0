/**
 * The mini player in the header while Settings is open, and leaving the video tabs (NPD-029).
 * Ported from airwave-np tests/mini.mjs; the song is a seeded row, the channel a loaded one.
 * The original's film half (a film plays, Music pauses it) had no film to play and is not ported;
 * the same rule is checked with a channel.
 */
import { expect, test } from '@playwright/test';
import { boot, resetToLibrary, seed, seedChannels, silentWav, watchErrors } from './_shell';

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await page.route((u) => /^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1' && !/radio-browser\.info/i.test(u.href) && !/good\.m3u|x\.invalid/.test(u.href),
    (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }));
  await page.route(/radio-browser\.info/i, (r) => r.abort());
  await boot(page);
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('with Settings open, the header shows a mini player that drives the real transport', async ({ page }) => {
  await seed(page);
  expect(await page.$eval('#mini', (m) => (m as HTMLElement).hidden), 'no mini player while the player itself is on screen').toBe(true);
  await page.click('#mode [data-mode="solo"]'); await page.waitForTimeout(300);
  await resetToLibrary(page);
  await page.click('#libraryRows tr:nth-child(2)'); await page.waitForTimeout(800);
  const title = (await page.textContent('.player__title'))!.trim();
  await page.click('#profile'); await page.waitForTimeout(500);
  expect(await page.isVisible('#mini'), 'with Settings open, the header shows a mini player').toBe(true);
  expect(await page.textContent('#miniTitle'), 'with the song’s name: ' + title).toBe(title);
  expect(await page.textContent('#miniTime'), 'and its time and duration').toMatch(/^\d+:\d\d \/ \d+:\d\d$/);
  const was = await page.getAttribute('#play', 'aria-pressed');
  await page.click('#miniPlay'); await page.waitForTimeout(250);
  expect((await page.getAttribute('#play', 'aria-pressed')) !== was && (await page.getAttribute('#miniPlay', 'aria-pressed')) === (await page.getAttribute('#play', 'aria-pressed')), 'play/pause drives the real transport and shows its state').toBe(true);
  await page.click('#miniPlay'); await page.waitForTimeout(250);
  await page.click('#miniNext'); await page.waitForTimeout(600);
  expect(await page.textContent('#miniTitle'), 'skip moves to the next song').not.toBe(title);
  await page.click('#prefsBack'); await page.waitForTimeout(400);
  expect((await page.$eval('#mini', (m) => (m as HTMLElement).hidden)) && (await page.isVisible('#searchBox')), 'back on the player, the search pill returns').toBe(true);

  await page.click('.tb__btn[data-view="radio"]'); await page.waitForTimeout(500);
  await page.click('#profile'); await page.waitForTimeout(500);
  expect(await page.isVisible('#mini'), 'the mini player is there for Radio too').toBe(true);
  await page.click('#prefsBack'); await page.waitForTimeout(400);
});

test('video tabs: Settings from Live TV shows no mini player and disconnects; Music pauses a channel', async ({ page }) => {
  await seedChannels(page);
  await page.click('.tb__btn[data-view="live-tv"]'); await page.waitForTimeout(500);
  await page.click('#mediaMenu .rlist tbody tr[data-i="1"]'); await page.waitForTimeout(1500);
  expect(await page.evaluate(() => !!document.getElementById('vp_video')!.getAttribute('src')), 'a channel is tuned').toBe(true);
  await page.click('#profile'); await page.waitForTimeout(500);
  expect(await page.$eval('#mini', (m) => (m as HTMLElement).hidden), 'Settings from Live TV shows no mini player').toBe(true);
  expect(await page.evaluate(() => { const v = document.getElementById('vp_video') as HTMLVideoElement; return v.paused && !v.getAttribute('src'); }), 'and opening Settings leaves Live TV: paused, stream closed').toBe(true);
  await page.click('#prefsBack'); await page.waitForTimeout(400);
  // ported: no film ships; the same rule is checked with a channel
  await page.click('.tb__btn[data-view="live-tv"]'); await page.waitForTimeout(500);
  await page.click('#mediaMenu .rlist tbody tr[data-i="0"]'); await page.waitForTimeout(1500);
  expect(await page.evaluate(() => !(document.getElementById('vp_video') as HTMLVideoElement).paused), 'a channel plays').toBe(true);
  await page.click('.tb__btn[data-view="music"]'); await page.waitForTimeout(500);
  expect(await page.evaluate(() => (document.getElementById('vp_video') as HTMLVideoElement).paused), 'going back to Music pauses it').toBe(true);
});

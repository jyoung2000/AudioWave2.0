/**
 * The video tabs: Live TV, TV and Movies replace the song list with a guide and the disc with the
 * video player, and Music takes everything back. Ported from airwave-np tests/media.mjs.
 *
 * The original counted an invented catalogue (ten channels, eight shows, ten films) and played
 * base64 sample clips. The shell ships none of that: Live TV's channels come from a playlist a
 * person loads, so two are loaded here through Sources ▸ Live TV, with their streams answered by
 * audio the browser can decode; TV and Movies have no import path yet and are asserted empty —
 * honestly labelled, with their menus and saved shelves intact. Assertions about the quality rung
 * label, show/series drills and playing a film had nothing real to hold on to and are not ported.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, seedChannels, watchErrors } from './_shell';

let errors: string[];
const label = (p: Page) => p.textContent('#libScopeLabel');
const cols = (p: Page) => p.$$eval('#mediaMenu .rlist th', (n) => n.map((x) => x.textContent!.trim()));
const rows = (p: Page) => p.$$eval('#mediaMenu .rlist tbody tr', (n) => n.length);

test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await boot(page);
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('Live TV: the guide replaces the song list, the video player takes the top, and a channel plays', async ({ page }) => {
  expect(await page.getAttribute('#vpWrap', 'hidden'), 'the video player is out of the way on Music').not.toBeNull();
  expect(await page.isVisible('.player__top'), 'the disc and the track information are up on Music').toBe(true);
  await seedChannels(page);

  await page.click('.tb__btn[data-view="live-tv"]'); await page.waitForTimeout(500);
  expect(await page.isVisible('#mediaMenu'), 'the guide replaces the song list').toBe(true);
  expect(await page.isVisible('#library'), 'the song list stands down').toBe(false);
  expect(await page.isVisible('#vpWrap'), 'the video player takes the top of the component').toBe(true);
  expect(await page.isVisible('.player__top'), 'the 3D stage and the song info stand down').toBe(false);
  expect(!(await page.isVisible('.player__scrub')) && !(await page.isVisible('.transport')), 'and so do the audio transport and scrubber').toBe(true);
  expect(await label(page), 'the ribbon reads Live TV').toBe('Live TV');
  expect((await page.$$('#mediaMenu .ipod__bar')).length, 'one ribbon, as everywhere else').toBe(0);
  expect(await cols(page), 'guide columns').toEqual(['Watching', 'Ch', 'Channel', 'Now', 'Next', 'Until']);
  // ported: the two channels of the loaded playlist, not ten invented ones
  expect(await rows(page), 'two channels').toBe(2);
  const g0 = await page.$$eval('#mediaMenu .rlist tbody tr', (n) => n.map((r) => [...r.querySelectorAll('td')].slice(1, 5).map((c) => c.textContent!.trim()).join(' | ')));
  // ported: no schedule is invented for a playlist's channels; the guide says Live, not a programme
  expect(g0.every((r) => r.split(' | ')[2]!.length > 0 && !/\d:\d\d/.test(r)), 'every channel says what is on now, with no schedule invented: ' + JSON.stringify(g0)).toBe(true);

  await page.click('#mediaMenu .rlist tbody tr[data-i="0"]'); await page.waitForTimeout(900);
  expect(await page.$eval('#vp_video', (n) => !!(n as HTMLVideoElement).src), 'the video element has a source').toBe(true);
  expect(await page.$eval('#vp_video', (n) => !(n as HTMLVideoElement).paused), 'and the channel is playing').toBe(true);
  expect((await page.$$('#mediaMenu .rlist tr.is-playing')).length, 'the channel is marked as watching').toBe(1);
});

test('TV: an honest empty guide, with Saved and Playlists behind the library button', async ({ page }) => {
  await page.click('.tb__btn[data-view="tv"]'); await page.waitForTimeout(500);
  expect(await label(page), 'the ribbon reads TV').toBe('TV');
  // ported: no invented shows; the panel says it is empty rather than listing eight
  expect(await rows(page), 'no shows until a source supplies them').toBe(0);
  expect(await page.textContent('#mediaMenu .ipod__empty'), 'and says so').toBe('Empty');
  await page.click('#libMenuBtn'); await page.waitForTimeout(400);
  const root = await page.$$eval('#mediaMenu .ipod__item .ipod__label', (n) => n.map((x) => x.textContent!.trim()));
  expect(root, 'the root menu').toEqual(['TV', 'Saved', 'Playlists']);
  await page.click('#mediaMenu .ipod__item:nth-child(2)'); await page.waitForTimeout(400);
  expect(await label(page), 'the Saved row opens the saved list').toBe('Saved');
  expect(await page.textContent('#mediaMenu .ipod__empty'), 'with nothing kept yet').toContain('No shows saved yet');
});

test('Movies: an honest empty list, and Music takes everything back', async ({ page }) => {
  await seedChannels(page);
  await page.click('.tb__btn[data-view="live-tv"]'); await page.waitForTimeout(400);
  await page.click('#mediaMenu .rlist tbody tr[data-i="0"]'); await page.waitForTimeout(900);
  await page.click('.tb__btn[data-view="movies"]'); await page.waitForTimeout(500);
  expect(await label(page), 'the ribbon reads Movies').toBe('Movies');
  // ported: no invented films
  expect(await rows(page), 'no films until a source supplies them').toBe(0);
  await page.click('#libMenuBtn'); await page.waitForTimeout(400);
  expect(await page.$$eval('#mediaMenu .ipod__item .ipod__label', (n) => n.map((x) => x.textContent!.trim())), 'Movies keeps Saved and Playlists').toEqual(['Movies', 'Saved', 'Playlists']);

  await page.click('.tb__btn[data-view="music"]'); await page.waitForTimeout(600);
  expect(await page.getAttribute('#vpWrap', 'hidden'), 'the video player stands down').not.toBeNull();
  expect(await page.isVisible('.player__top'), 'the disc and track info come back').toBe(true);
  expect((await page.isVisible('.player__scrub')) && (await page.isVisible('.transport')), 'and the audio transport').toBe(true);
  expect(await page.$eval('#vp_video', (n) => (n as HTMLVideoElement).paused), 'the video is paused on the way out').toBe(true);
  expect(await page.isVisible('#library'), 'the song list returns').toBe(true);
  expect(await label(page), 'the ribbon is back on Now Playing').toBe('Now Playing');
});

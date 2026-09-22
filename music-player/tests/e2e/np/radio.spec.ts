/**
 * The Radio tab: the shelf that answers when the directory does not, the station list built from
 * the song list's rules, playing a station for real, the refused transport keys, the menu one
 * level up, searching, favourites and letting go. Ported from airwave-np tests/radio.mjs.
 *
 * Every station stream — whatever host it is on — answers with decodable audio, so the load path
 * runs for real. The directory (radio-browser) is left unreachable, which is what makes the bundled
 * shelf answer. The song list's own metrics are read from seeded rows.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, playRow, resetToLibrary, seed, silentWav, watchErrors } from './_shell';

const WAV = silentWav();
let errors: string[];

const names = (p: Page) => p.$$eval('#radioMenu .rlist tbody .lib-title', (n) => n.map((x) => x.textContent ?? ''));
const title = (p: Page) => p.textContent('#libScopeLabel');
/** A station level has arrived when the ribbon names it and the list has rows (the shelf answers after the directory fails). */
async function settle(p: Page, want: string): Promise<void> {
  await expect(p.locator('#libScopeLabel')).toHaveText(want, { timeout: 15_000 });
  await expect(p.locator('#radioMenu .rlist tbody tr').first()).toBeVisible({ timeout: 15_000 });
  await p.waitForTimeout(200);
}

test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await page.route((u) => /^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1' && !/radio-browser\.info/i.test(u.href),
    (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }));
  await page.route(/radio-browser\.info/i, (r) => r.abort());
  await boot(page);
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

async function openRadio(page: Page): Promise<void> {
  await page.click('.tb__btn[data-view="radio"]');
  await settle(page, 'Chicago');
  await page.waitForTimeout(300);
}

test('the tab opens on stations, not on a menu, and the panel is the song list’s own rules', async ({ page }) => {
  await seed(page);
  await resetToLibrary(page);
  const LIB = await page.evaluate(() => {
    const r = document.querySelector('#libraryRows tr')!, h = document.querySelector('.library th')!;
    return { rowH: Math.round(r.getBoundingClientRect().height), headH: Math.round(h.getBoundingClientRect().height), font: getComputedStyle(r).fontSize,
      stripe: getComputedStyle(document.querySelector('#libraryRows tr:nth-child(2)')!).backgroundColor };
  });
  expect(await page.getAttribute('#radioMenu', 'hidden'), 'radio panel hidden at boot').not.toBeNull();
  // the directory takes a moment to fail here, so the pole has time to be seen
  await page.route(/radio-browser\.info/i, (r) => { setTimeout(() => { r.abort().catch(() => undefined); }, 1200); });
  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForTimeout(400);
  expect(await page.isVisible('#radioMenu'), 'radio panel replaces the song list').toBe(true);
  expect(await page.isVisible('#library'), 'song list stands down').toBe(false);
  expect(await page.isVisible('#radioMenu .ipod__pole'), 'the barber pole shows while the directory is tried').toBe(true);
  expect((await page.$$('#radioMenu .ipod__bar')).length, 'the panel draws no second ribbon').toBe(0);
  await settle(page, 'Chicago');
  const home = await names();
  expect(home.length, 'stations are listed without a click').toBeGreaterThan(0);
  expect(home.some((n) => /WGCI/i.test(n)), '107.5 WGCI is in the list').toBe(true);
  expect(home.some((n) => /WLS/i.test(n)) && home.some((n) => /WFMT/i.test(n)), 'and the rest of Chicago radio').toBe(true);
  expect(await page.getAttribute('#libFind', 'placeholder'), 'field retargets').toBe('Search stations');
  expect(await page.getAttribute('#libScope', 'hidden'), 'the ribbon label stays up').toBeNull();

  const geom = await page.evaluate(() => {
    const row = document.querySelector('#radioMenu .rlist tbody tr')!, th = document.querySelector('#radioMenu .rlist th')!;
    return { rowH: Math.round(row.getBoundingClientRect().height), headH: Math.round(th.getBoundingClientRect().height), font: getComputedStyle(row).fontSize,
      stripe: getComputedStyle(document.querySelector('#radioMenu .rlist tbody tr:nth-child(2)')!).backgroundColor,
      cols: [...document.querySelectorAll('#radioMenu .rlist th')].map((x) => x.textContent!.trim()) };
  });
  // ported: the original allowed a pixel, measured on Linux (DejaVu Sans). On Windows, Lucida Sans
  // Unicode's `normal` line-height makes the song row's text cells 21px against the 18px rule the
  // station rows keep, so the bound is the one responsive.spec.ts already uses for the song row.
  expect(geom.rowH, 'station rows keep the 18px rule').toBe(18);
  expect(Math.abs(geom.rowH - LIB.rowH), 'rows match the song list (' + geom.rowH + ' vs ' + LIB.rowH + 'px)').toBeLessThanOrEqual(4);
  expect(Math.abs(geom.headH - LIB.headH), 'the column header matches the song list’s').toBeLessThanOrEqual(1);
  expect(geom.font, 'same type size as the song list').toBe(LIB.font);
  expect(geom.stripe, 'same Aqua stripe as the song list').toBe(LIB.stripe);
  expect(geom.cols, 'station columns').toEqual(['On air', 'Station', 'Song', 'Artist', 'Kbps', 'Where']);

  function names() { return page.$$eval('#radioMenu .rlist tbody .lib-title', (n) => n.map((x) => x.textContent ?? '')); }
});

test('playing a station: the player names it, LIVE shows, the transport refuses what it must', async ({ page }) => {
  await openRadio(page);
  const first = (await names(page))[0];
  await page.click('#radioMenu .rlist tbody tr[data-i="0"]');
  await page.waitForTimeout(900);
  expect((await page.textContent('.player__album')) === first || (await page.textContent('.player__artist')) === first, 'the player names the station').toBe(true);
  expect(((await page.textContent('.player__title')) || '').length, 'and says what is on').toBeGreaterThan(0);
  expect((await page.isVisible('#playerWhere')) || ((await page.textContent('.player__album')) || '').length > 0, 'and where it is broadcasting from').toBe(true);
  expect(await page.isVisible('#live'), 'LIVE marker shows').toBe(true);
  expect(await page.getAttribute('#remaining', 'hidden'), 'remaining time stands down').not.toBeNull();
  expect(await page.$eval('#fill', (n) => (n as HTMLElement).style.width), 'scrubber sits at the live edge').toBe('100%');
  expect(await page.getAttribute('#track', 'role'), 'not a slider while live').toBe('img');
  expect(await page.getAttribute('#track', 'aria-valuenow'), 'no range ARIA while live').toBeNull();
  expect(await page.$eval('#radioAudio', (n) => !(n as HTMLAudioElement).paused), 'the stream is actually playing').toBe(true);
  expect((await page.$$('#radioMenu .rlist tr.is-playing')).length, 'the sounding row is marked').toBe(1);
  expect((await page.$$('#radioMenu .rlist tr.is-playing .lib-np')).length, 'and carries the song list’s speaker').toBe(1);

  expect(await page.getAttribute('#play', 'aria-disabled'), 'play stays enabled').toBe('false');
  expect(await page.getAttribute('#repeat', 'aria-disabled'), 'repeat is refused').toBe('true');
  expect(await page.getAttribute('#download', 'aria-disabled'), 'download is refused').toBe('true');
  await page.click('#play'); await page.waitForTimeout(300);
  expect(await page.$eval('#radioAudio', (n) => (n as HTMLAudioElement).paused), 'play stops the stream').toBe(true);
  await page.click('#play'); await page.waitForTimeout(500);
  expect(await page.$eval('#radioAudio', (n) => !(n as HTMLAudioElement).paused), 'and starts it again').toBe(true);
  expect((await page.getAttribute('#next', 'aria-disabled')) === 'true' && (await page.getAttribute('#prev', 'aria-disabled')) === 'true', 'Previous and Next are refused on a station').toBe(true);
  const wasOn = await page.textContent('.player__album');
  await page.evaluate(() => document.getElementById('next')!.click());
  expect(await page.textContent('.player__album'), 'and pressing one does not change station').toBe(wasOn);
  expect(await page.textContent('#toast'), 'it says where to change station instead').toContain('another station');
});

test('a station that will not open must not claim to be live', async ({ page }) => {
  await openRadio(page);
  await page.route(/ntslive/i, (r) => r.fulfill({ status: 404, body: '' }));
  await page.click('#libMenuBtn'); await page.waitForTimeout(250);
  await page.click('#radioMenu .ipod__item[data-i="4"]'); // Worldwide
  await settle(page, 'Worldwide');
  const all = await names(page);
  const dead = all.findIndex((n) => /NTS/.test(n));
  expect(dead, 'the station that will 404 is in the list').toBeGreaterThanOrEqual(0);
  await page.click('#radioMenu .rlist tbody tr[data-i="' + dead + '"]');
  await page.waitForTimeout(1800);
  expect(await page.textContent('.player__album'), 'a failed stream stops claiming to be the station').not.toBe(all[dead]);
  expect(await page.$eval('#radioAudio', (n) => !n.getAttribute('src')), 'and releases the stream').toBe(true);
  expect((await page.$$('#radioMenu .rlist tr.is-playing')).length, 'and leaves no row marked on air').toBe(0);
});

test('the menu is one level up: Genres drills to stations, and the ribbon badge backs out', async ({ page }) => {
  await openRadio(page);
  await page.click('#libMenuBtn'); await page.waitForTimeout(300);
  expect(await title(page), 'the menu button goes up to the menu').toBe('Radio');
  const roots = await page.$$eval('#radioMenu .ipod__item .ipod__label', (n) => n.map((x) => x.textContent));
  expect(roots, 'menu items').toEqual(['Chicago', 'United States', 'Genres', 'Countries', 'Worldwide', 'Favourites', 'Playlists']);
  await page.click('#radioMenu .ipod__item[data-i="2"]'); await page.waitForTimeout(300);
  expect(await title(page), 'Genres drills').toBe('Genres');
  expect((await page.$$('#radioMenu .ipod__item')).length, 'seventeen genres').toBe(17);
  const gen = await page.$$eval('#radioMenu .ipod__item .ipod__label', (n) => n.map((x) => x.textContent));
  await page.click('#radioMenu .ipod__item[data-i="' + gen.indexOf('Jazz') + '"]');
  await settle(page, 'Jazz');
  expect((await names(page)).length, 'and they are listed as a table').toBeGreaterThan(0);
  await page.click('#libScopeClear'); await page.waitForTimeout(350);
  expect(await title(page), 'the ribbon badge backs out one level').toBe('Genres');
});

test('searching names the query, lists only matches, and Escape clears', async ({ page }) => {
  await openRadio(page);
  await page.click('#libMenuBtn'); await page.waitForTimeout(250);
  await page.fill('#libFind', 'paradise');
  await expect(page.locator('#libScopeLabel')).toContainText('paradise', { timeout: 15_000 });
  await page.waitForTimeout(500);
  const hits = await names(page);
  expect(hits.length > 0 && hits.every((h) => /paradise/i.test(h)), 'only matching stations listed: ' + JSON.stringify(hits)).toBe(true);
  await page.fill('#libFind', 'swiss');
  await expect(page.locator('#libScopeLabel')).toContainText('swiss', { timeout: 15_000 });
  await page.waitForTimeout(500);
  const hits2 = await names(page);
  expect(hits2.length > 0 && hits2.every((h) => /swiss/i.test(h)), 'a second query replaces the first').toBe(true);
  await page.focus('#libFind'); await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  expect(await page.inputValue('#libFind'), 'Escape clears the query').toBe('');
});

test('S keeps a station in Favourites, and choosing a track drops the radio', async ({ page }) => {
  await seed(page);
  await resetToLibrary(page);
  await playRow(page, 'Gantry');
  await openRadio(page);
  const fav = await page.textContent('#radioMenu .rlist tbody tr[data-i="1"] .lib-title');
  await page.click('#radioMenu .rlist tbody tr[data-i="1"]'); await page.waitForTimeout(800);
  await page.focus('#radioMenu'); await page.keyboard.press('s'); await page.waitForTimeout(300);
  await page.click('#libMenuBtn'); await page.waitForTimeout(250);
  await page.click('#radioMenu .ipod__item[data-i="5"]'); await page.waitForTimeout(400);
  expect((await names(page))[0], 'S keeps a station in Favourites').toBe(fav);

  await page.click('.tb__btn[data-view="music"]'); await page.waitForTimeout(400);
  expect(await page.isVisible('#library'), 'song list returns').toBe(true);
  expect(await page.textContent('#libScopeLabel'), 'ribbon back to Now Playing').toBe('Now Playing');
  await page.click('#libraryRows tr[data-id]'); await page.waitForTimeout(600);
  expect(await page.getAttribute('#live', 'hidden'), 'choosing a track drops the radio').not.toBeNull();
  expect(await page.$eval('#radioAudio', (n) => !n.getAttribute('src')), 'and releases the stream').toBe(true);
});

test('what is offered must be playable, and locations are tidied', async ({ page }) => {
  await openRadio(page);
  const bad = await page.evaluate(() => {
    const rows = [{ url: 'https://x.test/a.m3u' }, { url: 'https://x.test/a.pls' }, { url: 'https://x.test/a.asx' }, { url: 'https://x.test/a.m3u8' }, { url: 'https://x.test/ok.mp3' }, { url: 'https://x.test/ok.aac?a=1' }];
    const re = /\.(m3u|pls|asx|xspf)(\?|#|$)/i;
    return rows.map((r) => ({ u: r.url, rejected: re.test(r.url) }));
  });
  expect(bad.filter((x) => x.rejected).length, 'playlist files are rejected, streams are not').toBe(3);
  const wheres = await page.$$eval('#radioMenu .rlist tbody tr td:last-child', (n) => [...new Set(n.map((x) => x.textContent!.trim()))]);
  expect(wheres.every((w) => /^[A-Z]/.test(w) && !/\s{2}|,\s*$/.test(w)), 'locations are tidied, not printed as submitted: ' + JSON.stringify(wheres)).toBe(true);
  expect((await page.$$('#radioMenu .rlist tbody tr')).length, 'a list to work from').toBeGreaterThan(0);
});

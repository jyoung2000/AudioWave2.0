/**
 * Every tab has playlists, behind the library button, filed through the same contextual menu the
 * song list has always had — with the verb matching the thing (Play a station, Watch a channel).
 * Ported from airwave-np tests/lists.mjs.
 *
 * Radio's rows are the bundled shelf; Live TV's are two channels loaded from a playlist; TV and
 * Movies have no rows to right-click in the shell (no invented catalogue), so what is asserted
 * there is the shelf behind the library button. The song menu is checked on seeded rows.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, reload, resetToLibrary, seed, seedChannels, silentWav, watchErrors } from './_shell';

let errors: string[];
const go = async (p: Page, v: string) => { await p.click('.tb__btn[data-view="' + v + '"]'); await p.waitForTimeout(500); };
const label = (p: Page) => p.textContent('#libScopeLabel');
const menuText = (p: Page) => p.$$eval('#ctx > .ctx__item', (n) => n.map((x) => { const sub = x.querySelector('.ctx__sub'); const t = sub ? x.textContent!.replace(sub.textContent!, '') : x.textContent!; return t.trim(); }));
const openSub = async (p: Page) => { await p.click('#ctx [data-act="parent"]'); await p.waitForTimeout(200); };
const rightClick = async (p: Page, sel: string) => { await p.click(sel, { button: 'right', position: { x: 120, y: 8 } }); await p.waitForTimeout(300); };
const name = async (p: Page, n: string) => { await p.waitForSelector('#sheet[open]', { timeout: 3000 }); await p.fill('#sheetInput', n); await p.click('#sheetCreate'); await p.waitForTimeout(400); };
const radioReady = async (p: Page) => { await expect(p.locator('#libScopeLabel')).toHaveText('Chicago', { timeout: 15_000 }); await expect(p.locator('#radioMenu .rlist tbody tr').first()).toBeVisible({ timeout: 15_000 }); };

test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await page.route((u) => /^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1' && !/radio-browser\.info/i.test(u.href) && !/good\.m3u|x\.invalid/.test(u.href),
    (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }));
  await page.route(/radio-browser\.info/i, (r) => r.abort());
  await boot(page);
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('Radio: a station is played, kept or filed; a new playlist holds it and can be emptied', async ({ page }) => {
  await go(page, 'radio'); await radioReady(page); await page.waitForTimeout(300);
  await rightClick(page, '#radioMenu .rlist tbody tr[data-i="0"]');
  expect(await page.getAttribute('#ctx', 'hidden'), 'right-click opens a menu on a station').toBeNull();
  let items = await menuText(page);
  expect(items.some((t) => t.startsWith('Play ')), 'it offers to play the station: ' + JSON.stringify(items)).toBe(true);
  expect(items, 'and to keep it in Favourites').toContain('Add to Favourites');
  expect(items, 'and to file it in a playlist').toContain('Add to Playlist');
  await openSub(page);
  expect((await page.$$eval('#ctx .ctx__sub .ctx__item', (n) => n.map((x) => x.textContent!.trim())))[0], 'with nothing to file into yet').toBe('No playlists yet');

  await openSub(page);
  await page.click('#ctx [data-act="ls-new-add"]');
  await name(page, 'Chicago Mix');
  expect(await page.evaluate(() => !(document.getElementById('sheet') as HTMLDialogElement).open), 'the sheet closes').toBe(true);

  await rightClick(page, '#radioMenu .rlist tbody tr[data-i="0"]');
  await openSub(page);
  const checked = await page.$$eval('#ctx [data-act="ls-toggle"]', (n) => n.map((x) => { const mark = x.querySelector('.ctx__check'); return [x.textContent!.replace(mark ? mark.textContent! : '', '').trim(), x.getAttribute('aria-checked'), (mark ? mark.textContent! : '').trim()]; }));
  expect(checked, 'the station is ticked in the new playlist').toEqual([['Chicago Mix', 'true', '✓']]);
  await page.keyboard.press('Escape');

  await page.click('#libMenuBtn'); await page.waitForTimeout(300);
  const rootRows = await page.$$eval('#radioMenu .ipod__item .ipod__label', (n) => n.map((x) => x.textContent!.trim()));
  expect(rootRows, 'Radio menu has a Playlists row').toContain('Playlists');
  await page.click(`#radioMenu .ipod__item:nth-child(${rootRows.indexOf('Playlists') + 1})`);
  await page.waitForTimeout(400);
  expect(await label(page), 'which opens the shelf').toBe('Playlists');
  await page.click('#radioMenu .ipod__item'); await page.waitForTimeout(500);
  expect(await label(page), 'and the playlist opens').toBe('Chicago Mix');
  expect(await page.$$eval('#radioMenu .rlist tbody tr', (n) => n.length), 'holding the one station').toBe(1);

  await rightClick(page, '#radioMenu .rlist tbody tr[data-i="0"]');
  items = await menuText(page);
  expect(items.some((t) => t.startsWith('Remove from “Chicago Mix')), 'inside a playlist it offers to take the row out: ' + JSON.stringify(items)).toBe(true);
  await page.click('#ctx [data-act="ls-drop"]'); await page.waitForTimeout(400);
  expect(await page.$$eval('#radioMenu .rlist tbody tr', (n) => n.length), 'and the row goes').toBe(0);
});

test('Live TV: a channel is watched, not played, and its playlist still reads as a guide', async ({ page }) => {
  await seedChannels(page);
  await go(page, 'live-tv');
  await rightClick(page, '#mediaMenu .rlist tbody tr[data-i="0"]');
  const items = await menuText(page);
  expect(items.some((t) => t.startsWith('Watch ')), 'a channel is watched, not played: ' + JSON.stringify(items)).toBe(true);
  expect(items.some((t) => /Save for Later/.test(t)), 'and has nothing to save for later').toBe(false);
  await openSub(page);
  await page.click('#ctx [data-act="ls-new-add"]');
  await name(page, 'Evenings');
  await page.waitForTimeout(300);
  await page.click('#libMenuBtn'); await page.waitForTimeout(400);
  const tvRoot = await page.$$eval('#mediaMenu .ipod__item .ipod__label', (n) => n.map((x) => x.textContent!.trim()));
  expect(tvRoot, 'the library button opens the guide’s root menu').toEqual(['Live TV', 'Playlists']);
  await page.click('#mediaMenu .ipod__item:last-child'); await page.waitForTimeout(400);
  expect(await label(page), 'the shelf opens from the guide').toBe('Playlists');
  await page.click('#mediaMenu .ipod__item'); await page.waitForTimeout(400);
  expect(await label(page), 'and so does the playlist').toBe('Evenings');
  expect(await page.$$eval('#mediaMenu .rlist th', (n) => n.map((x) => x.textContent!.trim())), 'kept channels still read as a guide').toEqual(['Watching', 'Ch', 'Channel', 'Now', 'Next', 'Until']);
});

test('TV and Movies keep Saved and Playlists behind the library button, with no rows to file yet', async ({ page }) => {
  // ported: the shell has no invented shows or films to right-click; the shelves are still there
  for (const [v, root] of [['tv', ['TV', 'Saved', 'Playlists']], ['movies', ['Movies', 'Saved', 'Playlists']]] as Array<[string, string[]]>) {
    await go(page, v);
    expect(await page.$$eval('#mediaMenu .rlist tbody tr', (n) => n.length), 'no rows without a source on ' + v).toBe(0);
    await page.click('#libMenuBtn'); await page.waitForTimeout(400);
    expect(await page.$$eval('#mediaMenu .ipod__item .ipod__label', (n) => n.map((x) => x.textContent!.trim())), v + ' keeps Saved and gains Playlists').toEqual(root);
    await page.click('#mediaMenu .ipod__item:last-child'); await page.waitForTimeout(400);
    expect(await label(page), 'the shelf opens on ' + v).toBe('Playlists');
    expect(await page.textContent('#mediaMenu .ipod__empty'), 'with nothing filed yet on ' + v).toContain('No playlists yet');
  }
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  expect(await page.getAttribute('#ctx', 'hidden'), 'Escape closes the menu').not.toBeNull();
});

test('the song menu is untouched', async ({ page }) => {
  await seed(page);
  await resetToLibrary(page);
  await page.click('#libraryRows tr:nth-child(3)', { button: 'right', position: { x: 200, y: 8 } });
  await page.waitForTimeout(300);
  const items = await menuText(page);
  expect(items.includes('Go to Album') && items.includes('Add to Playlist'), 'the song menu still has its own commands: ' + JSON.stringify(items)).toBe(true);
  await page.keyboard.press('Escape');
});

test('the playlist is still there after a reload', async ({ page }) => {
  await go(page, 'radio'); await radioReady(page); await page.waitForTimeout(300);
  await rightClick(page, '#radioMenu .rlist tbody tr[data-i="0"]');
  await openSub(page);
  await page.click('#ctx [data-act="ls-new-add"]');
  await name(page, 'Chicago Mix');
  await reload(page);
  await go(page, 'radio'); await radioReady(page); await page.waitForTimeout(300);
  await page.click('#libMenuBtn');
  await expect(page.locator('#radioMenu .ipod__item .ipod__label', { hasText: 'Playlists' })).toBeVisible();
  const after = await page.$$eval('#radioMenu .ipod__item .ipod__label', (n) => n.map((x) => x.textContent!.trim()));
  await page.click(`#radioMenu .ipod__item:nth-child(${after.indexOf('Playlists') + 1})`);
  // Polled, not slept on: a slow runner draws the menu after a fixed 400 ms had already read it.
  await expect
    .poll(() => page.$$eval('#radioMenu .ipod__item .ipod__label', (n) => n.map((x) => x.textContent!.trim())), { message: 'the playlist is still there after a reload', timeout: 15_000 })
    .toEqual(['Chicago Mix']);
});

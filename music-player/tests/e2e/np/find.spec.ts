/**
 * The list's find field: title, artist and album matches, the clear badge, Escape, and how it
 * composes with the scope chip and the toolbar view. Ported from airwave-np tests/find.mjs.
 *
 * Counts are of the eight seeded rows (the original counted its sixteen built-in ones), and the
 * Now Playing home view has a row because one was played, not because a demo history shipped.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, playRow, resetToLibrary, seed, titles, watchErrors } from './_shell';

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await boot(page);
  await seed(page);
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

const cell = (page: Page) => page.evaluate(() => document.querySelector('#libraryRows td.lib-empty')?.textContent || '');

test('the bar is always present, opens on Now Playing, and clearing gives the whole library', async ({ page }) => {
  expect(await page.getAttribute('.lib-scope', 'hidden'), 'bar is always present').toBeNull();
  expect((await page.textContent('#libScopeLabel')) === 'Now Playing' && (await page.getAttribute('#libScopeClear', 'hidden')) !== null, 'opens on Now Playing, with no way to clear it').toBe(true);
  await page.click('#libMenuBtn'); await page.waitForTimeout(200);
  await page.click('#ipodMenu .ipod__item[data-i="4"]'); await page.waitForTimeout(200);
  await page.click('#ipodMenu .ipod__item[data-i="0"]'); await page.waitForTimeout(300);
  await resetToLibrary(page);
  expect((await page.textContent('#libScopeLabel')) === 'Library' && (await page.getAttribute('#libScopeClear', 'hidden')) !== null && (await page.getAttribute('#libScopeKind', 'hidden')) !== null, 'clearing gives the whole library').toBe(true);
  expect(await page.getAttribute('#libFindClear', 'hidden'), 'clear badge hidden at rest').not.toBeNull();
  // ported: eight seeded rows, not sixteen built-in ones
  expect((await titles(page)).length, 'starts with 8 rows').toBe(8);
});

test('filters by title, artist and album, case-insensitively, and names an empty query', async ({ page }) => {
  await resetToLibrary(page);
  await page.fill('#libFind', 'harbour'); await page.waitForTimeout(250);
  expect(await titles(page), 'filters by title').toEqual(['Harbour Morning', 'Paper Harbour']);
  expect(await page.getAttribute('#libFindClear', 'hidden'), 'clear badge appears').toBeNull();
  expect(await page.textContent('#libFindLive'), 'announces the count').toContain('2 songs match');
  await page.fill('#libFind', 'alder'); await page.waitForTimeout(250);
  expect((await titles(page)).length, 'filters by artist').toBe(4);
  await page.fill('#libFind', 'late shift'); await page.waitForTimeout(250);
  expect((await titles(page)).length, 'filters by album').toBe(4);
  await page.fill('#libFind', 'GANTRY'); await page.waitForTimeout(250);
  expect(await titles(page), 'case insensitive').toEqual(['Gantry']);
  await page.fill('#libFind', 'zzzz'); await page.waitForTimeout(250);
  expect(await cell(page), 'empty state names the query').toContain('No songs match “zzzz”');
});

test('escape and the clear badge reset the filter, and focus returns to the field', async ({ page }) => {
  await resetToLibrary(page);
  await page.fill('#libFind', 'zzzz'); await page.waitForTimeout(200);
  await page.focus('#libFind'); await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  expect((await titles(page)).length === 8 && (await page.inputValue('#libFind')) === '', 'escape clears the filter').toBe(true);
  await page.fill('#libFind', 'ember'); await page.waitForTimeout(200);
  await page.click('#libFindClear'); await page.waitForTimeout(250);
  expect((await titles(page)).length === 8 && (await page.inputValue('#libFind')) === '', 'clear badge resets').toBe(true);
  expect(await page.evaluate(() => document.activeElement!.id === 'libFind'), 'focus returns to the field').toBe(true);
});

test('composes with the scope chip and with the view, and the playing row keeps its marquee', async ({ page }) => {
  await resetToLibrary(page);
  // row 3 of the title-sorted seed is Ember Line, on Late Shift
  await page.click('#libraryRows tr:nth-child(3)', { button: 'right', position: { x: 200, y: 8 } }); await page.waitForTimeout(200);
  await page.click('#ctx [data-act="go-album"]'); await page.waitForTimeout(350);
  const scoped = (await titles(page)).length;
  await page.fill('#libFind', 'hour'); await page.waitForTimeout(250);
  const both = await titles(page);
  // ported: the album has four songs, one of them with "hour" in its name
  expect(scoped === 4 && both.length === 1 && both[0] === 'Closing Hour', `composes with the scope chip: scope ${scoped} -> +query ${JSON.stringify(both)}`).toBe(true);
  expect(await page.getAttribute('#libScope', 'hidden'), 'scope chip still shown').toBeNull();

  // the home view needs a play to have a row; a play is a click on a row
  await page.fill('#libFind', ''); await page.waitForTimeout(150);
  await playRow(page, 'Closing Hour');

  // Movies has a panel of its own rather than an empty song list
  await page.click('.tb__btn[data-view="movies"]'); await page.waitForTimeout(400);
  expect((await page.inputValue('#libFind')) === '' && (await page.getAttribute('#libScopeClear', 'hidden')) !== null
    && (await page.textContent('#libScopeLabel')) === 'Movies' && (await page.isVisible('#mediaMenu')), 'view switch clears the query and hands the ribbon over').toBe(true);
  await page.click('.tb__btn[data-view="music"]'); await page.waitForTimeout(250);
  await page.click('.tb__btn[data-view="music"]'); await page.waitForTimeout(300);
  expect((await page.textContent('#libScopeLabel')) === 'Now Playing' && (await titles(page)).length > 0
    && (await page.getAttribute('#libScopeClear', 'hidden')) !== null, 'back to the Now Playing home view').toBe(true);

  await page.fill('#libFind', 'closing'); await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.querySelectorAll('tr.is-playing .lib-mq').length), 'playing-row marquee survives filtering').toBe(2);
});

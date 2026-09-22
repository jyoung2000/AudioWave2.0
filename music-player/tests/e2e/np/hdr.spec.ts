/**
 * The header search field belongs to Music: it is gone on the other four tabs, each of which keeps
 * the panel's own field, and an open popover is shut on the way out. Ported from airwave-np
 * tests/hdr.mjs.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, stubOffline, watchErrors } from './_shell';

let errors: string[];
const shown = (p: Page) => p.isVisible('#searchBox');
const go = async (p: Page, v: string) => { await p.click('.tb__btn[data-view="' + v + '"]'); await p.waitForTimeout(450); };

test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await page.route('**/itunes.apple.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    results: [{ trackName: 'Harbour Lights Live', artistName: 'Cassette Bloom', collectionName: 'Pier 9', artworkUrl100: null, previewUrl: null, trackTimeMillis: 251000 }] }) }));
  await stubOffline(page);
  await boot(page);
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('the header field is up on Music and gone on the other tabs, which keep their own field', async ({ page }) => {
  expect(await shown(page), 'the header field is up on Music, where it has songs to find').toBe(true);
  for (const v of ['radio', 'live-tv', 'tv', 'movies']) {
    await go(page, v);
    expect(await shown(page), 'it is gone on ' + v).toBe(false);
    expect(await page.isVisible('#libFind'), 'and the panel keeps its own field on ' + v).toBe(true);
  }
  await go(page, 'music');
  expect(await shown(page), 'it comes back on Music').toBe(true);
});

test('an open popover is shut on the way out', async ({ page }) => {
  await page.click('#q');
  await page.type('#q', 'harbour', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const wasOpen = (await page.getAttribute('#srch', 'hidden')) === null;
  await go(page, 'radio');
  expect(wasOpen && (await page.getAttribute('#srch', 'hidden')) !== null, 'an open popover is shut on the way out' + (wasOpen ? '' : ' (popover never opened)')).toBe(true);
  await go(page, 'music');
  expect((await shown(page)) && (await page.isVisible('#q')), 'and the field is usable again').toBe(true);
});

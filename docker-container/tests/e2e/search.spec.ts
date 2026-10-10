/**
 * The Search tab in a real browser against the real hub (DEC-039; UX-SEARCH-001…012). The hub's
 * own routes answer everything but the catalog, which the page asks of `/api/v1/catalog/*`: those
 * calls are answered here from the stock catalog (packages/aqua-ui/styleguide/fixtures/
 * catalog-stock.json), streamed as NDJSON the way the hub streams it, so no music service is ever
 * reached. The starred list goes to the real hub's /api/v1/catalog/saved.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const stock = JSON.parse(readFileSync(fileURLToPath(new URL('../../../packages/aqua-ui/styleguide/fixtures/catalog-stock.json', import.meta.url)), 'utf8')) as Record<string, unknown> & { search: unknown[]; searchPage2: unknown[]; searchLink: Array<Record<string, unknown>>; playlistUrl: string };

async function stockCatalog(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route('**/api/v1/catalog/**', async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.replace('/api/v1/catalog/', '');
    if (name === 'saved' || name === 'settings') return route.continue();
    asked.push(`${name}${url.search}`);
    if (name === 'search') {
      const q = url.searchParams.get('q') ?? '';
      const chunks = /^https?:/.test(q) ? [{ ...stock.searchLink[0], resolve: q }] : Number(url.searchParams.get('offset') ?? 0) > 0 ? stock.searchPage2 : stock.search;
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' }, body: `${chunks.map((c) => JSON.stringify(c)).join('\n')}\n` });
    }
    const body = { album: stock['album'], artist: stock['artist'], resolve: stock['resolvePlaylist'], lyrics: stock['lyrics'], enrich: stock['enrich'] }[name];
    return body ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ detail: 'Not in the stock' }) });
  });
  return asked;
}

test('searches, opens a song and comes back with the keyboard alone, on stock answers', async ({ page }) => {
  const asked = await stockCatalog(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Search' }).click();
  const field = page.getByRole('searchbox', { name: 'Search for music' });
  await field.fill('harbour');
  await field.press('Enter');
  await expect(page.locator('.srch [role="status"]')).toHaveText('Done: 9 songs, 3 artists, 2 albums, 14 playlists. SoundCloud did not answer.');
  expect(asked[0]).toMatch(/^search\?q=harbour&sections=tracks%2Cartists%2Calbums%2Cplaylists&providers=itunes%2Cdeezer%2Cmusicbrainz%2Cyoutube%2Csoundcloud/);
  const songs = page.getByRole('listbox', { name: 'Songs' });
  // The calm overview: five songs, no pager (UX-SEARCH-007).
  await expect(songs.getByRole('option')).toHaveCount(5);
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await songs.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Harbour Lights', level: 2 })).toBeFocused();
  await expect(page.getByText('Pier Records')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(songs).toBeVisible();
  // See all: the Songs page reads on at once (the next offset of Songs alone), and › lands on page 2's first row.
  await page.getByRole('button', { name: 'See all 9+ songs' }).click();
  const pager = page.getByRole('navigation', { name: 'Songs pages' });
  await expect(pager.getByText('Page 1 of 2')).toBeVisible();
  expect(asked.at(-1)).toMatch(/sections=tracks&.*offset=25/);
  await expect(page.getByText('That’s all 31 songs.')).toBeAttached();
  await pager.getByRole('button', { name: 'Next page of songs' }).click();
  await expect(pager.getByText('Page 2 of 2')).toBeVisible();
  const all = page.getByRole('listbox', { name: 'All songs' });
  await expect(all).toBeFocused();
  await expect(all.locator('[data-page="2"]').first()).toBeInViewport();
  await page.keyboard.press('PageUp');
  await expect(pager.getByText('Page 1 of 2')).toBeVisible();
  // Escape walks back to the overview.
  await page.keyboard.press('Escape');
  await expect(songs).toBeVisible();
});

test('the results are one column centred under the field, and a type page and its footer stay in it', async ({ page }) => {
  await stockCatalog(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByRole('searchbox', { name: 'Search for music' }).fill('harbour');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.locator('.srch [role="status"]')).toHaveText(/^Done/);
  const column = (await page.locator('.srch').boundingBox())!;
  const pane = (await page.locator('.pane').boundingBox())!;
  expect(column.width).toBeLessThanOrEqual(720);
  expect(Math.abs(column.x + column.width / 2 - (pane.x + pane.width / 2))).toBeLessThan(12);
  const field = (await page.getByRole('searchbox', { name: 'Search for music' }).boundingBox())!;
  const songs = (await page.getByRole('listbox', { name: 'Songs' }).boundingBox())!;
  expect(field.y).toBeLessThan(songs.y);
  expect(songs.x).toBeGreaterThanOrEqual(column.x - 1);
  expect(songs.x + songs.width).toBeLessThanOrEqual(column.x + column.width + 1);
  await page.getByRole('button', { name: 'See all 14 playlists' }).click();
  await expect(page.getByRole('listbox', { name: 'All playlists' }).getByRole('option')).toHaveCount(14);
  // The footer stays put at the foot of the pane while the list scrolls under it.
  const foot = page.getByRole('navigation', { name: 'Playlists pages' });
  await expect(foot).toBeInViewport();
  const box = (await foot.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
});

test('a song row’s “…” and right-click open its menu; the keys walk it and Add to Library asks for the rights basis', async ({ page }) => {
  await stockCatalog(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByRole('searchbox', { name: 'Search for music' }).fill('harbour');
  await page.getByRole('button', { name: 'Search' }).click();
  const songs = page.getByRole('listbox', { name: 'Songs' });
  await expect(songs.getByRole('option')).toHaveCount(5);
  await songs.getByRole('option').first().locator('[data-menu]').click();
  const menu = page.getByRole('menu', { name: '“Harbour Lights”' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText([/^Add to Up Next/, /^Add to Playlist/, 'Add to Library…', 'Download…', 'Audition', 'Open Details']);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(songs).toBeFocused();
  await songs.getByRole('option').nth(1).click({ button: 'right' });
  const wall = page.getByRole('menu', { name: '“Harbour Wall”' });
  await expect(wall).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(wall.getByRole('menuitem', { name: 'Add to Library…' })).toBeFocused();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Add “Harbour Wall” to the library' });
  await expect(sheet.getByLabel('Allowed because:')).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);
});

test('Add to Playlist ▸ New Playlist… files a song into the hub’s playlist folder, and Music ▸ Playlists opens it like an album (UX-PL-005, UX-PL-007)', async ({ page }) => {
  await stockCatalog(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByRole('searchbox', { name: 'Search for music' }).fill('harbour');
  await page.getByRole('button', { name: 'Search' }).click();
  const songs = page.getByRole('listbox', { name: 'Songs' });
  await expect(songs.getByRole('option')).toHaveCount(5);
  await songs.getByRole('option').first().locator('[data-menu]').click();
  await page.getByRole('menuitem', { name: 'Add to Playlist' }).click();
  await page.getByRole('menuitem', { name: 'New Playlist…' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Playlist' });
  await sheet.getByLabel('Name:').fill('E2E Harbour');
  // No download in a test run: the library is left out this time.
  await sheet.locator('label.chk', { hasText: 'Also add to Library' }).click();
  await expect(sheet.getByRole('checkbox', { name: 'Also add to Library' })).not.toBeChecked();
  await sheet.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.status')).toContainText('Made “E2E Harbour” with “Harbour Lights” in it.');
  // The menu now ticks it.
  await songs.getByRole('option').first().locator('[data-menu]').click();
  await page.getByRole('menuitem', { name: 'Add to Playlist' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'E2E Harbour' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'Music' }).click();
  const lists = page.getByRole('listbox', { name: 'Playlists' });
  await expect(lists.getByRole('option', { name: /E2E Harbour/ })).toBeVisible();
  await lists.getByRole('option', { name: /E2E Harbour/ }).click();
  await expect(page.getByRole('heading', { name: 'E2E Harbour', level: 2 })).toBeFocused();
  const entries = page.getByRole('listbox', { name: 'Songs' });
  await expect(entries.getByRole('option')).toHaveCount(1);
  await expect(entries.getByRole('option').first()).toContainText('Plays from');
  await expect(page.getByRole('link', { name: 'Export .m3u8' })).toHaveAttribute('download', 'E2E Harbour.m3u8');
  const results = await new AxeBuilder({ page }).include('#playlists').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`).join('\n')).toEqual([]);
  await page.getByRole('button', { name: 'Delete…' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Delete “E2E Harbour”?' });
  await ask.getByRole('button', { name: 'Delete' }).click();
  // Back on the list, which no longer holds it (empty again on a fresh hub).
  await expect(page.getByRole('heading', { name: 'Playlist folder', level: 2 })).toBeVisible();
  await expect(page.locator('#playlists [role="option"]', { hasText: 'E2E Harbour' })).toHaveCount(0);
});

test('a pasted playlist shows its mosaic and platform, opens like an album, and the star keeps it in the hub', async ({ page }) => {
  await stockCatalog(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByRole('searchbox', { name: 'Search for music' }).fill(stock.playlistUrl);
  await page.getByRole('button', { name: 'Search' }).click();
  const row = page.getByRole('listbox', { name: 'The playlist' }).getByRole('option');
  await expect(row).toContainText('Playlist · Spotify · 6 songs');
  await expect(row.locator('.art--mosaic img')).toHaveCount(4);
  await row.click();
  await expect(page.getByRole('listbox', { name: 'Songs in Harbour Mix' }).getByRole('option')).toHaveCount(6);
  const star = page.getByRole('button', { name: /Star this playlist/ });
  await star.click();
  await expect(page.getByRole('button', { name: /Starred playlist/ })).toHaveAttribute('aria-pressed', 'true');
  const saved = await page.evaluate(async () => (await fetch('/api/v1/catalog/saved', { credentials: 'same-origin' })).json());
  expect(saved.items[0].ref).toMatchObject({ platform: 'spotify', kind: 'playlist', title: 'Harbour Mix' });
  await page.getByRole('button', { name: /Starred playlist/ }).click();
  await expect(page.getByRole('button', { name: /Star this playlist/ })).toHaveAttribute('aria-pressed', 'false');
});

test('@a11y the search results, the filter sheet, a type page, a row’s menu and a song have no detectable violations', async ({ page }) => {
  await stockCatalog(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Search' }).click();
  await page.getByRole('searchbox', { name: 'Search for music' }).fill('harbour');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.locator('.srch [role="status"]')).toHaveText(/^Done/);
  const check = async (): Promise<void> => {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations, results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`).join('\n')).toEqual([]);
  };
  await check();
  await page.getByRole('button', { name: 'Filter…' }).click();
  await expect(page.getByRole('dialog', { name: 'Filter the search' })).toBeVisible();
  await check();
  await page.keyboard.press('Escape');
  await page.getByRole('listbox', { name: 'Songs' }).getByRole('option').first().click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'See all 9+ songs' }).click();
  await expect(page.getByRole('navigation', { name: 'Songs pages' }).getByText('Page 1 of 2')).toBeVisible();
  await check();
  await page.getByRole('tab', { name: 'Playlists' }).click();
  await expect(page.getByRole('listbox', { name: 'All playlists' }).getByRole('option')).toHaveCount(14);
  await check();
  await page.getByRole('button', { name: 'Back to Results' }).click();
  await page.getByRole('listbox', { name: 'Songs' }).getByRole('option').first().click();
  await expect(page.getByRole('region', { name: 'Lyrics, timed' })).toBeVisible();
  await check();
});

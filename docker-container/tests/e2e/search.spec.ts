/**
 * The Search tab in a real browser against the real hub (DEC-039; UX-SEARCH-001…008). The hub's
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
  await expect(page.locator('.srch [role="status"]')).toHaveText('Done: 9 songs, 3 artists, 2 albums. SoundCloud did not answer.');
  expect(asked[0]).toMatch(/^search\?q=harbour&sections=tracks%2Cartists%2Calbums&providers=itunes%2Cdeezer%2Cmusicbrainz%2Cyoutube%2Csoundcloud/);
  const songs = page.getByRole('listbox', { name: 'Songs' });
  await expect(songs.getByRole('option')).toHaveCount(8);
  await songs.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Harbour Lights', level: 2 })).toBeFocused();
  await expect(page.getByText('Pier Records')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(songs).toBeVisible();
  // Pages: Next past what is loaded asks for the next offset of Songs alone.
  const pager = page.getByRole('navigation', { name: 'Songs pages' });
  await pager.getByRole('button', { name: 'Next page of songs' }).click();
  await pager.getByRole('button', { name: 'Next page of songs' }).click();
  await expect(pager.getByText('Page 2 of 2')).toBeVisible();
  expect(asked.at(-1)).toMatch(/sections=tracks&.*offset=25/);
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

test('@a11y the search results, the filter sheet and a song have no detectable violations', async ({ page }) => {
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
  await page.getByRole('listbox', { name: 'Songs' }).getByRole('option').first().click();
  await expect(page.getByRole('region', { name: 'Lyrics, timed' })).toBeVisible();
  await check();
});

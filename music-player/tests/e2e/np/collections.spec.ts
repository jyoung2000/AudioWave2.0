/**
 * Albums and playlists from the catalog in the music list (NP-FIND-007), and the silver bar's star
 * that keeps them in the library (NP-FIND-008).
 *
 * A pasted playlist is a listing with its platform and a 2×2 mosaic of its first four songs' covers
 * (its own cover when fewer than four have one); opened, it shows in the music list the way an album
 * does — the bar names it, its songs are the rows, page after page up to its cap. The star beside
 * the name saves it as a SavedCollection in the library's state, the library menu lists it under
 * Playlists (or Albums), and choosing it there reads it again.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, titles, watchErrors } from './_shell';
import { album, collection, COMPANION, done, fulfillStream, json, params, resolved, results, src, status, stubServices, track, useCompanion } from './_catalog';

const LIST = 'https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n';
const COVERS = [1, 2, 3, 4].map((n) => `https://i.scdn.co/image/cover-${n}`);
const song = (n: number) =>
  track(`spotify:t${n}`, `Track ${String(n).padStart(4, '0')}`, {
    artist: 'Various Lanterns',
    album: 'Mixed',
    durationMs: (180 + n) * 1000,
    artworkUrl: n <= 4 ? COVERS[n - 1] : null,
    sources: [src('spotify', `t${n}`, { url: `https://open.spotify.com/track/t${n}`, matchedBy: 'link' })],
  });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await stubServices(page);
  await page.route('https://i.scdn.co/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
});
test.afterEach(() => {
  expect(errors, 'JS errors').toEqual([]);
});

/** Longer than the old cap of 200: the whole list must load (owner, 2026-10-06). */
const TOTAL = 1250;

/**
 * A companion that lists the playlist page by page, as the contract pages it: the offset and limit
 * asked, the total, and hasMore until the last song. Later pages take a moment, so the progress shows.
 */
async function withPlaylist(page: Page): Promise<number[]> {
  const offsets: number[] = [];
  await page.route(`${COMPANION}/helper/v1/catalog/resolve?**`, async (r) => {
    const offset = Number(params(r).get('offset') ?? 0);
    const limit = Number(params(r).get('limit') ?? 100);
    offsets.push(offset);
    if (offset > 0) await new Promise((done) => setTimeout(done, 250));
    const tracks = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, i) => song(offset + i + 1));
    await r.fulfill(json(resolved(LIST, 'spotify', 'playlist', { collection: collection('spotify', 'playlist', '3cEYpjA9oz9GiPac4AsH4n', 'Lantern Mix', tracks, { covers: COVERS, total: TOTAL, offset, hasMore: offset + tracks.length < TOTAL, capped: false, owner: 'Ada' }) })));
  });
  await boot(page);
  await useCompanion(page);
  return offsets;
}

async function paste(page: Page, link: string): Promise<void> {
  await page.fill('#q', link);
  await page.press('#q', 'Enter');
}

test('a pasted playlist: its platform, a 2×2 mosaic, and opened, the music list names it and loads every song, page by page', async ({ page }) => {
  const offsets = await withPlaylist(page);
  await paste(page, LIST);
  const listing = page.locator('.srch__row--coll');
  await expect(listing.locator('.srch__badge')).toHaveText('Spotify');
  await expect(listing.locator('.srch__mosaic img')).toHaveCount(4);
  await expect(listing).toHaveAttribute('aria-label', 'Lantern Mix, Playlist on Spotify · Ada · 1,250 songs. Opens in the music list');
  await listing.click();
  // The popover gives way to the list, which shows the playlist the way it shows an album.
  await expect(page.locator('#srch')).toBeHidden();
  await expect(page.locator('#libScopeLabel')).toHaveText('Lantern Mix');
  // While the pages arrive the bar says how far it has got, and the rows already there can be used.
  await expect(page.locator('#libScopeKind')).toContainText(/Playlist · Spotify · Loading [\d,]+ of 1,250…/);
  await expect(page.locator('#libScopeClear')).toBeVisible();
  await page.locator('#libraryRows tr:has(.lib-title:text-is("Track 0002"))').click();
  await expect(page.locator('#libraryRows tr.is-playing .lib-title')).toHaveText('Track 0002');
  // Every song, in the playlist's own order: pages fetched until the server said there was no more.
  await expect.poll(async () => (await titles(page)).length, { timeout: 30_000 }).toBe(TOTAL);
  await expect(page.locator('#libScopeKind')).toHaveText('Playlist · Spotify · 1,250 songs');
  const shown = await titles(page);
  expect(shown.slice(0, 3)).toEqual(['Track 0001', 'Track 0002', 'Track 0003']);
  expect(shown[TOTAL - 1]).toBe('Track 1250');
  expect(offsets).toEqual([0, 100, 300, 500, 700, 900, 1100]);
  // Its songs are on show, not in the library.
  expect(await page.evaluate(() => (window as unknown as { LIBRARY: unknown[] }).LIBRARY.length)).toBe(0);
  // Clearing the scope returns to the library.
  await page.click('#libScopeClear');
  await expect(page.locator('#libScopeLabel')).toHaveText('Library');
  await expect(page.locator('#libColStar')).toBeHidden();
});

test('the mosaic gives way to the list’s own cover when fewer than four songs have artwork', async ({ page }) => {
  await page.route(`${COMPANION}/helper/v1/catalog/resolve?**`, (r) =>
    r.fulfill(json(resolved(LIST, 'spotify', 'playlist', { collection: collection('spotify', 'playlist', 'x', 'Two Covers', [song(1), song(2)], { covers: COVERS.slice(0, 2), artworkUrl: 'https://i.scdn.co/image/own' }) }))),
  );
  await boot(page);
  await useCompanion(page);
  await paste(page, LIST);
  await expect(page.locator('.srch__row--coll .srch__mosaic')).toHaveCount(0);
  await expect(page.locator('.srch__row--coll .srch__art img')).toHaveAttribute('src', 'https://i.scdn.co/image/own');
});

test('the star in the silver bar saves the list to the library, the menu lists it, and it opens again from there', async ({ page }) => {
  const offsets = await withPlaylist(page);
  await paste(page, LIST);
  await page.locator('.srch__row--coll').click();
  const star = page.locator('#libColStar');
  await expect(star).toBeVisible();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await expect(star).toHaveAttribute('aria-label', 'Save “Lantern Mix” to your library');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  // Kept as the shared SavedCollection shape, in the library's own state.
  const kept = await page.evaluate(() => (window as unknown as { kv: { get(k: string): Promise<{ collections?: unknown[] }> } }).kv.get('library:state'));
  expect(kept.collections).toEqual([
    expect.objectContaining({ ref: { platform: 'spotify', kind: 'playlist', id: '3cEYpjA9oz9GiPac4AsH4n', url: 'https://spotify.example/playlist/3cEYpjA9oz9GiPac4AsH4n', title: 'Lantern Mix', owner: 'Ada' }, covers: COVERS, trackCount: TOTAL }),
  ]);
  // The library menu: Playlists lists it, and choosing it reads it again.
  await page.click('#libScopeClear');
  await page.click('#libMenuBtn');
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Playlists' }).click();
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Lantern Mix' }).click();
  await expect(page.locator('#libScopeLabel')).toHaveText('Lantern Mix');
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await titles(page)).length, { timeout: 30_000 }).toBe(TOTAL);
  expect(offsets.filter((o) => o === 0).length).toBe(2);
  // Un-starred, it leaves the menu.
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await page.click('#libScopeClear');
  await page.click('#libMenuBtn');
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Playlists' }).click();
  await expect(page.locator('#ipodMenu .ipod__item', { hasText: 'Lantern Mix' })).toHaveCount(0);
});

test('an album from search opens in the list too, and starred, it is kept under Albums', async ({ page }) => {
  const songs = [track('deezer:501', 'Quay Song'), track('deezer:502', 'Lamp Song')];
  await page.route(`${COMPANION}/helper/v1/catalog/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/search')) return fulfillStream(route, [results(0, 'deezer', 'night', { albums: [album('deezer:30', 'Night Ferries')] }, status([{ provider: 'deezer', state: 'ok', count: 1 }])), done(1, 'night', [], { albums: false })]);
    return route.fulfill(json({ album: album('deezer:30', 'Night Ferries'), page: { tracks: songs, offset: 0, limit: 100, total: 2, hasMore: false, capped: false }, collection: { platform: 'deezer', kind: 'album', id: '30', url: 'https://www.deezer.com/album/30', title: 'Night Ferries', owner: 'Lantern Choir' } }));
  });
  await boot(page);
  await useCompanion(page);
  await page.fill('#q', 'night');
  await page.press('#q', 'Enter');
  await page.locator('.srch__row--album').click();
  await page.locator('.srch__btn[data-act="list"]').click();
  await expect(page.locator('#libScopeLabel')).toHaveText('Night Ferries');
  await expect(page.locator('#libScopeKind')).toHaveText('Album · Deezer · 2 songs');
  expect(await titles(page)).toEqual(['Quay Song', 'Lamp Song']);
  await page.click('#libColStar');
  await page.click('#libScopeClear');
  await page.click('#libMenuBtn');
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Albums' }).click();
  await expect(page.locator('#ipodMenu .ipod__item', { hasText: 'Night Ferries' })).toHaveCount(1);
});

test('a song on show plays its row and the Download key offers to fetch it through the helper', async ({ page }) => {
  await withPlaylist(page);
  await paste(page, LIST);
  await page.locator('.srch__row--coll').click();
  await expect.poll(async () => (await titles(page)).length, { timeout: 30_000 }).toBe(TOTAL);
  await page.locator('#libraryRows tr:has(.lib-title:text-is("Track 0002"))').click();
  await expect(page.locator('#libraryRows tr.is-playing .lib-title')).toHaveText('Track 0002');
  await page.click('#download');
  await expect(page.locator('#npFetch')).toBeVisible();
  await expect(page.locator('#npFetchMsg')).toContainText('“Track 0002” by Various Lanterns');
  await expect(page.locator('#npFetchMsg')).toContainText('open.spotify.com');
  await page.click('#npFetchCancel');
});

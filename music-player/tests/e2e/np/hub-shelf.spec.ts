/**
 * The paired hub's shelf (DEC-041): its playlist folder and this player's starred lists.
 *
 * - Filing (NP-FIND-013): a song row's Add to Playlist ▸ keeps this player's playlists under "On this
 *   player" and gains "On TOWER" — the hub's folder playlists, ticked from `hasTrack`, and New Playlist
 *   on TOWER… — with `playlists:use`; without it, a line that says so and how to fix it.
 * - Hub playlists (NP-FIND-014): the library menu's Playlists ▸ On TOWER opens one in the music list,
 *   a library entry streaming through the hub (`/library/stream-urls`); only a list this player made
 *   can be renamed, deleted or reordered.
 * - Starred sync (NP-FIND-008): on start and on each star, with an offline un-star's tombstone winning,
 *   and the admin's shared lists shown read-only.
 *
 * Every hub route is answered here with `page.route`; the songs and lists are invented.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { boot, CORS, HUB, reload, resetToLibrary, seed, silentWav, titles, watchErrors } from './_shell';
import { ACCT, collection, done, fulfillStream, hud, json, resolved, results, searchFor, src, status, stubServices, track } from './_catalog';

type Win = {
  kv: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
  NP_PLAYER: { playing(): boolean; trackId(): string | null };
};

const FINAL = status([{ provider: 'deezer', state: 'ok', count: 1 }]);
const ONE = track('deezer:1', 'One', { isrc: 'GBAAA1900001', sources: [src('deezer', '1'), src('youtube', 'y1')] });
const AT = '2026-10-09T12:00:00.000Z';

function summary(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    fileName: `${name}.m3u8`,
    description: null,
    createdAt: AT,
    updatedAt: AT,
    entryCount: 3,
    durationSec: 600,
    covers: [],
    origin: 'airwave',
    readOnly: false,
    createdBy: 'd1',
    hasTrack: null,
    ...over,
  };
}

function entry(id: string, title: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title,
    artist: 'Alder Quartet',
    artists: ['Alder Quartet'],
    album: 'First Light',
    durationSec: 200,
    location: null,
    locationKind: 'url',
    trackId: null,
    catalogId: null,
    isrc: null,
    artworkUrl: null,
    platforms: [],
    sources: [],
    addedAt: AT,
    addedBy: 'd1',
    ...over,
  };
}

const MINE = summary('pl-mine', 'Harbour Mix');
const THEIRS = summary('pl-theirs', 'Kitchen Radio', { createdBy: 'd2' });
const ENTRIES = [
  entry('e1', 'Quay Lights', { location: '../library/Alder Quartet/Quay Lights.flac', locationKind: 'library', trackId: 'trk-1' }),
  entry('e2', 'Night Harbour', { location: 'https://www.deezer.com/track/77', platforms: ['deezer'], sources: [src('deezer', '77', { url: 'https://www.deezer.com/track/77' })], catalogId: 'deezer:77' }),
  entry('e3', 'Lost Tape', { location: null, locationKind: 'missing' }),
];

interface Hub {
  asked: Array<{ method: string; path: string; query: string; body: unknown }>;
  saved: Array<Record<string, unknown>>;
  shared: Array<Record<string, unknown>>;
  offline: boolean;
}

const saved = (id: string, title: string, savedAt: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ref: { platform: 'deezer', kind: 'playlist', id, url: `https://www.deezer.com/playlist/${id}`, title, owner: 'Ada' },
  savedAt,
  artworkUrl: null,
  covers: [],
  trackCount: 2,
  ...over,
});

/** The hub: its catalog (one song), its folder (two lists), its stream URLs and the starred lists. */
async function withHub(page: Page, init: Partial<Hub> = {}): Promise<Hub> {
  const hub: Hub = { asked: [], saved: [], shared: [], offline: false, ...init };
  await page.route(`${HUB}/**`, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (hub.offline) return route.abort('internetdisconnected');
    const url = new URL(req.url());
    const path = url.pathname;
    let body: unknown;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    hub.asked.push({ method: req.method(), path, query: url.search, body });
    if (path === '/api/v1/catalog/search') return fulfillStream(route, [results(0, 'deezer', 'one', { tracks: [ONE] }, FINAL), done(1, 'one', FINAL, { tracks: false })]);
    if (path === '/api/v1/catalog/resolve') {
      const songs = [track('deezer:91', 'Shared Song One'), track('deezer:92', 'Shared Song Two')];
      return route.fulfill(json(resolved(url.searchParams.get('url') ?? '', 'deezer', 'playlist', { collection: collection('deezer', 'playlist', 's1', 'Admin Picks', songs) })));
    }
    if (path === '/api/v1/playlists' && req.method() === 'GET') {
      const asking = url.searchParams.get('catalogId');
      return route.fulfill(json({ folder: { path: '/data/playlists', relativePath: 'playlists', isDefault: true, available: true, reason: null, playlistCount: 2, capped: false }, items: [{ ...MINE, hasTrack: asking ? asking === 'deezer:1' : null }, { ...THEIRS, hasTrack: asking ? false : null }] }));
    }
    if (path === '/api/v1/playlists' && req.method() === 'POST') return route.fulfill(json(summary('pl-new', (body as { name: string }).name, { entryCount: 1 }), 201));
    if (/^\/api\/v1\/playlists\/pl-[a-z]+\/entries$/.test(path)) return route.fulfill(json({ playlist: path.includes('theirs') ? THEIRS : MINE, added: 1, skipped: 0 }));
    if (/^\/api\/v1\/playlists\/pl-[a-z]+\/entries\/move$/.test(path)) return route.fulfill(json(MINE));
    if (path === '/api/v1/playlists/pl-mine' || path === '/api/v1/playlists/pl-theirs') {
      if (req.method() === 'PATCH') return route.fulfill(json({ ...MINE, name: (body as { name: string }).name }));
      const pl = path.endsWith('mine') ? MINE : THEIRS;
      return route.fulfill(json({ playlist: pl, items: ENTRIES, offset: 0, total: 3, hasMore: false }));
    }
    if (path === '/api/v1/library/stream-urls') return route.fulfill(json({ items: [{ trackId: 'trk-1', url: `${HUB}/api/v1/stream/trk-1?sig=abc` }], expiresAt: '2099-01-01T00:00:00.000Z' }));
    if (path === '/api/v1/stream/trk-1') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'audio/wav' }, body: silentWav(30) });
    if (path === '/api/v1/catalog/saved') {
      if (req.method() === 'PUT') {
        const s = body as { ref: { id: string } };
        hub.saved = [...hub.saved.filter((x) => (x['ref'] as { id: string }).id !== s.ref.id), s as Record<string, unknown>];
      }
      if (req.method() === 'DELETE') hub.saved = hub.saved.filter((x) => (x['ref'] as { id: string }).id !== url.searchParams.get('id'));
      return route.fulfill(json({ items: hub.saved, shared: hub.shared }));
    }
    return route.fulfill(json({ title: 'Not here' }, 404));
  });
  return hub;
}

async function pair(page: Page, scopes: string[]): Promise<void> {
  await page.evaluate(async (a) => {
    await (window as unknown as Win).kv.set('player:hub', a);
  }, { ...ACCT, scopes });
}

const ctx = (page: Page) => page.locator('#ctx');
const hubGroup = (page: Page) => page.locator('#ctx .ctx__sub [data-hub-pl]');

async function openSongMenu(page: Page): Promise<void> {
  await searchFor(page, 'one');
  const row = page.locator('#srchList .srch__row', { hasText: 'One' });
  await row.locator('.srch__menu').click();
  await ctx(page).locator('[data-act="parent"]').click();
}

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await stubServices(page);
});
test.afterEach(() => {
  expect(errors, 'JS errors').toEqual([]);
});

test('Add to Playlist ▸ lists the hub’s playlists in a group of their own, ticked where the song is, and files the catalog song (NP-FIND-013)', async ({ page }) => {
  const hub = await withHub(page);
  await boot(page);
  await pair(page, ['search:use', 'playlists:use']);
  await openSongMenu(page);
  // This player's playlists keep their place, under a heading of their own; the hub's follow.
  await expect(page.locator('#ctx .ctx__sub [data-hub-local]')).toHaveText('On this player');
  await expect(hubGroup(page).locator('.ctx__head')).toHaveText('On TOWER');
  await expect(hubGroup(page)).toHaveAttribute('aria-label', 'On TOWER');
  const lists = hubGroup(page).locator('[data-act="hub-file"]');
  await expect(lists).toHaveText(['✓Harbour Mix', 'Kitchen Radio']);
  await expect(lists.first()).toHaveAttribute('aria-checked', 'true');
  await expect(lists.nth(1)).toHaveAttribute('aria-checked', 'false');
  await expect(hubGroup(page).locator('[data-act="hub-new"]')).toHaveText('New Playlist on TOWER…');
  // The ticks came from asking with the song's catalog id and ISRC.
  const listAsk = hub.asked.find((a) => a.path === '/api/v1/playlists' && a.method === 'GET');
  expect(new URLSearchParams(listAsk!.query).get('catalogId')).toBe('deezer:1');
  expect(new URLSearchParams(listAsk!.query).get('isrc')).toBe('GBAAA1900001');
  // The keys reach the hub's lists like any other command.
  await lists.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(lists.nth(1)).toBeFocused();
  // Filing into someone else's list is allowed (filing is additive): the CatalogTrack goes as it is.
  await page.keyboard.press('Enter');
  await expect(hud(page)).toHaveText('Added “One” to “Kitchen Radio” on TOWER');
  const filed = hub.asked.find((a) => a.path === '/api/v1/playlists/pl-theirs/entries');
  expect(filed, 'filed into the list chosen').toBeDefined();
  const sent = (filed!.body as { tracks: Array<{ id: string; isrc: string; sources: unknown[] }> }).tracks;
  expect(sent).toHaveLength(1);
  expect(sent[0]!.id).toBe('deezer:1');
  expect(sent[0]!.isrc).toBe('GBAAA1900001');
  expect(sent[0]!.sources).toHaveLength(2);
  await expect(page.locator('#toast')).toHaveAttribute('role', 'status');
  // A ticked list says the song is there already, and asks the hub nothing.
  await expect(ctx(page)).toBeHidden();
  await page.locator('#srchList .srch__row', { hasText: 'One' }).locator('.srch__menu').click();
  await ctx(page).locator('[data-act="parent"]').click();
  const before = hub.asked.length;
  await hubGroup(page).locator('[data-act="hub-file"]').first().click();
  await expect(hud(page)).toHaveText('“One” is already in “Harbour Mix” on TOWER');
  expect(hub.asked.slice(before).filter((a) => a.method === 'POST')).toEqual([]);
});

test('New Playlist on TOWER… makes a playlist in the hub’s folder with the song in it', async ({ page }) => {
  const hub = await withHub(page);
  await boot(page);
  await pair(page, ['search:use', 'playlists:use']);
  await openSongMenu(page);
  await hubGroup(page).locator('[data-act="hub-new"]').click();
  await expect(page.locator('#hubSheet')).toBeVisible();
  await expect(page.locator('#hubSheetTitle')).toHaveText('New Playlist on TOWER');
  await page.fill('#hubSheetInput', 'Ferry Songs');
  await page.click('#hubSheetGo');
  await expect(hud(page)).toHaveText('Added “One” to “Ferry Songs” on TOWER');
  const made = hub.asked.find((a) => a.path === '/api/v1/playlists' && a.method === 'POST');
  expect((made!.body as { name: string }).name).toBe('Ferry Songs');
  expect((made!.body as { tracks: Array<{ id: string }> }).tracks.map((t) => t.id)).toEqual(['deezer:1']);
});

test('without playlists:use the group says the hub hasn’t allowed it, and how to fix it; a song with no link or ISRC says why it stays here', async ({ page }) => {
  const hub = await withHub(page);
  await boot(page);
  await pair(page, ['search:use']);
  await openSongMenu(page);
  const why = hubGroup(page).locator('[data-act="hub-why"]');
  await expect(why).toHaveText('Your hub hasn’t allowed this player to use its playlists');
  await expect(why).toHaveAttribute('aria-disabled', 'true');
  // Read, not run: it is marked disabled, yet the keys reach it and Enter says why.
  await why.focus();
  await page.keyboard.press('Enter');
  await expect(hud(page)).toHaveText('TOWER hasn’t allowed this player to use its playlists. To fix it, pair again (Settings ▸ Connections) and tick “File into the hub’s playlists”.');
  expect(hub.asked.filter((a) => a.path.startsWith('/api/v1/playlists'))).toEqual([]);
  // With the permission, a song of this device's library with neither a link nor an ISRC cannot go to the hub.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await pair(page, ['search:use', 'playlists:use']);
  await seed(page, [{ file: '01 Quay.wav', title: 'Quay', artist: 'Alder Quartet', album: 'First Light' }]);
  await resetToLibrary(page);
  await page.locator('#libraryRows tr:has(.lib-title:text-is("Quay"))').click({ button: 'right', position: { x: 200, y: 8 } });
  await ctx(page).locator('[data-act="parent"]').click();
  const cant = hubGroup(page).locator('[data-act="hub-why"]');
  await expect(cant).toHaveText('Can’t file this song on TOWER');
  await cant.focus();
  await page.keyboard.press('Enter');
  await expect(hud(page)).toHaveText('The hub’s playlists keep each song’s link or ISRC, and this song has neither, so it can go only in this player’s playlists.');
});

test('a hub playlist opens in the music list like an album; a library entry streams through the hub, and only a list this player made can change (NP-FIND-014)', async ({ page }) => {
  const hub = await withHub(page);
  await boot(page);
  await pair(page, ['playlists:use']);
  await page.click('#libMenuBtn');
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Playlists' }).click();
  await page.locator('#ipodMenu .ipod__item', { hasText: 'On TOWER' }).click();
  await expect(page.locator('#ipodMenu .ipod__title')).toHaveText('On TOWER');
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Harbour Mix' }).click();
  await expect(page.locator('#libScopeLabel')).toHaveText('Harbour Mix');
  await expect(page.locator('#libScopeKind')).toHaveText('Playlist · TOWER · 3 songs');
  await expect(page.locator('#libColStar'), 'a hub playlist is not a catalog list to star').toBeHidden();
  await expect(page.locator('#libColMore')).toBeVisible();
  await expect(page.locator('#libColMore')).toHaveAttribute('aria-label', 'Actions for “Harbour Mix” on TOWER');
  expect(await titles(page)).toEqual(['Quay Lights', 'Night Harbour', 'Lost Tape']);
  // The library entry plays from the hub: a signed stream URL, through the same transport.
  await page.locator('#libraryRows tr:has(.lib-title:text-is("Quay Lights"))').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).NP_PLAYER.playing())).toBe(true);
  const playingId = await page.evaluate(() => (window as unknown as Win).NP_PLAYER.trackId());
  expect(playingId).toMatch(/^hub-pl-mine-e1$/);
  const signed = hub.asked.find((a) => a.path === '/api/v1/library/stream-urls');
  expect(signed!.body).toEqual({ trackIds: ['trk-1'] });
  // This player made it: Alt+↓ moves the highlighted song, on the hub first.
  await page.locator('#libraryRows tr[data-id="hub-pl-mine-e1"]').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(hud(page)).toHaveText('Moved “Quay Lights” down to 2 of 3');
  expect(hub.asked.find((a) => a.path.endsWith('/entries/move'))!.body).toEqual({ entryId: 'e1', to: 1 });
  await expect.poll(() => titles(page)).toEqual(['Night Harbour', 'Quay Lights', 'Lost Tape']);
  // Its "…": Rename…, moves and Delete…, all enabled; Rename asks the hub and the bar follows.
  await page.click('#libColMore');
  await expect(ctx(page).locator('[data-act="hub-rename"]')).toBeEnabled();
  await expect(ctx(page).locator('[data-act="hub-delete"]')).toBeEnabled();
  await ctx(page).locator('[data-act="hub-rename"]').click();
  await page.fill('#hubSheetInput', 'Harbour Mix II');
  await page.click('#hubSheetGo');
  await expect(hud(page)).toContainText('Renamed to “Harbour Mix II”');
  expect(hub.asked.find((a) => a.method === 'PATCH')!.body).toEqual({ name: 'Harbour Mix II' });
  // Someone else's list is read-only here, and says so.
  await page.click('#libScopeClear');
  await page.click('#libMenuBtn');
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Playlists' }).click();
  await page.locator('#ipodMenu .ipod__item', { hasText: 'On TOWER' }).click();
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Kitchen Radio' }).click();
  await expect(page.locator('#libScopeKind')).toHaveText('Playlist · TOWER · 3 songs · Made on another device — read-only');
  await page.click('#libColMore');
  await expect(ctx(page).locator('[data-act="hub-rename"]')).toBeDisabled();
  await expect(ctx(page).locator('[data-act="hub-delete"]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.locator('#libraryRows tr[data-id="hub-pl-theirs-e2"]').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(hud(page)).toHaveText('Made on another device: read-only here');
  expect(hub.asked.filter((a) => a.path.startsWith('/api/v1/playlists/pl-theirs/entries'))).toEqual([]);
});

test('starred lists sync with the hub on start: a union, and an un-star made offline wins over the hub’s older copy (NP-FIND-008)', async ({ page }) => {
  // On the hub: B (starred at 10:00, un-starred here at 11:00 while offline) and C (starred on this player before a reset).
  const hub = await withHub(page, {
    saved: [saved('b', 'B List', '2026-10-09T10:00:00.000Z'), saved('c', 'C List', '2026-10-09T10:30:00.000Z')],
    shared: [saved('s1', 'Admin Picks', '2026-10-08T09:00:00.000Z')],
  });
  await boot(page);
  await page.evaluate(async ({ a, local }) => {
    const w = window as unknown as Win;
    const state = ((await w.kv.get('library:state')) as Record<string, unknown> | null) ?? {};
    await w.kv.set('library:state', { ...state, collections: [local] });
    await w.kv.set('player:saved-sync', { tombstones: [{ platform: 'deezer', kind: 'playlist', id: 'b', at: '2026-10-09T11:00:00.000Z' }] });
    await w.kv.set('player:hub', a);
  }, { a: { ...ACCT, scopes: ['library:sync'] }, local: saved('a', 'A List', '2026-10-09T09:00:00.000Z') });
  await reload(page);
  // Up: A (only here) is PUT, B (un-starred here after the hub's copy) is DELETEd; down: C joins this player.
  await expect.poll(() => hub.saved.map((s) => (s['ref'] as { id: string }).id).sort()).toEqual(['a', 'c']);
  expect(hub.asked.filter((a) => a.method === 'PUT').map((a) => (a.body as { ref: { id: string } }).ref.id)).toEqual(['a']);
  expect(hub.asked.filter((a) => a.method === 'DELETE').map((a) => new URLSearchParams(a.query).get('id'))).toEqual(['b']);
  const kept = async () => ((await page.evaluate(() => (window as unknown as Win).kv.get('library:state'))) as { collections: Array<{ ref: { id: string } }> }).collections.map((c) => c.ref.id);
  await expect.poll(kept).toEqual(['a', 'c']);
  await expect.poll(async () => ((await page.evaluate(() => (window as unknown as Win).kv.get('player:saved-sync'))) as { tombstones: unknown[] }).tombstones).toEqual([]);
  // The library menu lists C with this player's own, and the admin's under "Shared on TOWER".
  await page.click('#libMenuBtn');
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Playlists' }).click();
  await expect(page.locator('#ipodMenu .ipod__item', { hasText: 'C List' })).toHaveCount(1);
  await expect(page.locator('#ipodMenu .ipod__item', { hasText: 'B List' })).toHaveCount(0);
  await expect(page.locator('#ipodMenu .ipod__item', { hasText: 'Shared on TOWER' })).toHaveCount(1);
});

test('a star and an un-star go to the hub; one made while the hub is away is kept as a tombstone and sent once it is back', async ({ page }) => {
  const hub = await withHub(page, { saved: [saved('c', 'C List', '2026-10-09T10:30:00.000Z')] });
  await boot(page);
  await pair(page, ['library:sync']);
  await reload(page);
  await expect.poll(async () => ((await page.evaluate(() => (window as unknown as Win).kv.get('library:state'))) as { collections?: unknown[] }).collections?.length ?? 0).toBe(1);
  // Open C from the library menu (read again through the hub's catalog): the star is on.
  await page.click('#libMenuBtn');
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Playlists' }).click();
  await page.locator('#ipodMenu .ipod__item', { hasText: 'C List' }).click();
  const star = page.locator('#libColStar');
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  // The hub goes away; the un-star is kept as a tombstone, quietly.
  hub.offline = true;
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await expect(hud(page)).toHaveText('Removed “C List” from your library');
  const tombs = async () => ((await page.evaluate(() => (window as unknown as Win).kv.get('player:saved-sync'))) as { tombstones: Array<{ id: string }> } | null)?.tombstones.map((t) => t.id) ?? [];
  await expect.poll(tombs).toEqual(['c']);
  // Back, and started again: the tombstone wins over the hub's older copy, and is settled.
  hub.offline = false;
  await reload(page);
  await expect.poll(() => hub.saved.length).toBe(0);
  await expect.poll(tombs).toEqual([]);
  await expect(hud(page)).not.toContainText('could not');
  // And it stays gone from the library menu.
  await page.click('#libMenuBtn');
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Playlists' }).click();
  await expect(page.locator('#ipodMenu .ipod__item', { hasText: 'C List' })).toHaveCount(0);
});

test('the hub admin’s shared lists open read-only under “Shared on TOWER”: no star, and the bar says so', async ({ page }) => {
  await withHub(page, { shared: [saved('s1', 'Admin Picks', '2026-10-08T09:00:00.000Z')] });
  await boot(page);
  await pair(page, ['library:sync', 'search:use']);
  await reload(page);
  await page.click('#libMenuBtn');
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Playlists' }).click();
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Shared on TOWER' }).click();
  await expect(page.locator('#ipodMenu .ipod__title')).toHaveText('Shared on TOWER');
  await page.locator('#ipodMenu .ipod__item', { hasText: 'Admin Picks' }).click();
  await expect(page.locator('#libScopeLabel')).toHaveText('Admin Picks');
  await expect(page.locator('#libScopeKind')).toContainText('Shared on TOWER — read-only');
  await expect(page.locator('#libColStar')).toBeHidden();
  await expect.poll(() => titles(page)).toEqual(['Shared Song One', 'Shared Song Two']);
});

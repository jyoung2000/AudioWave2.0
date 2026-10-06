/**
 * The header search as the catalog's (DEC-039; NP-FIND-003..006, NP-FIND-009): music only, live, in
 * sections, with a filter, advanced fields, see-all and details.
 *
 * The companion's helper (`/helper/v1/catalog/*`) and the hub (`/api/v1/catalog/*`) are answered from
 * fixtures with `page.route`, in the contract's own shapes (NDJSON chunks for a search); the browser
 * engine's services are stubbed, so nothing here reaches the network.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { boot, HUB, watchErrors } from './_shell';
import { ACCT, album, artist, COMPANION, done, fulfillStream, json, params, results, searchFor, src, status, stubServices, track, useCompanion } from './_catalog';

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await stubServices(page);
});
test.afterEach(() => {
  expect(errors, 'JS errors').toEqual([]);
});

const LUCKY = track('deezer:1001', 'Harbour Lamps', {
  artist: 'Lantern Choir feat. Ada Moss',
  artists: ['Lantern Choir', 'Ada Moss'],
  sources: [src('deezer', '1001', { previewUrl: 'https://cdnt-preview.dzcdn.net/1001.mp3' })],
});
/** The same song a second service found: the next chunk carries it under the same id, now merged. */
const LUCKY_MERGED = { ...LUCKY, sources: [...(LUCKY['sources'] as unknown[]), src('apple-music', '7001'), src('youtube-music', 'ym1')] };

const PENDING = status([
  { provider: 'itunes', state: 'pending' },
  { provider: 'deezer', state: 'pending' },
  { provider: 'musicbrainz', state: 'cooling-down', error: 'musicbrainz.org asked to slow down', retryAt: '2026-10-06T12:05:00.000Z' },
  { provider: 'youtube', state: 'pending' },
  { provider: 'soundcloud', state: 'skipped', error: 'yt-dlp is not available here, so this service cannot be searched' },
]);
const FINAL = status([
  { provider: 'itunes', state: 'ok', count: 1 },
  { provider: 'deezer', state: 'ok', count: 2 },
  { provider: 'musicbrainz', state: 'cooling-down', error: 'musicbrainz.org asked to slow down', retryAt: '2026-10-06T12:05:00.000Z' },
  { provider: 'youtube', state: 'failed', error: 'yt-dlp could not reach YouTube' },
  { provider: 'soundcloud', state: 'skipped', error: 'yt-dlp is not available here, so this service cannot be searched' },
]);

/** A companion that answers every catalog route the suite needs; returns what it was asked. */
async function companion(page: Page, answer: (path: string, route: Route) => Promise<void> | void): Promise<string[]> {
  const asked: string[] = [];
  await page.route(`${COMPANION}/helper/v1/catalog/**`, async (route) => {
    const u = new URL(route.request().url());
    asked.push(u.pathname + u.search);
    await answer(u.pathname.replace('/helper/v1/catalog/', ''), route);
  });
  await boot(page);
  await useCompanion(page);
  return asked;
}

test('a search streams songs, artists and albums in sections; rows upsert by id and name their platforms', async ({ page }) => {
  const asked = await companion(page, (path, route) => {
    if (path !== 'search') return route.fulfill(json({ error: 'not_found', message: 'no' }, 404));
    return fulfillStream(route, [
      results(0, null, 'harbour', {}, PENDING),
      results(1, 'deezer', 'harbour', { tracks: [LUCKY, track('deezer:1002', 'Harbour Wall')], artists: [artist('deezer:20', 'Lantern Choir')], albums: [album('deezer:30', 'Night Ferries')] }, PENDING),
      results(2, 'itunes', 'harbour', { tracks: [LUCKY_MERGED] }, PENDING),
      results(3, null, 'harbour', { tracks: [track('spotify:sp1', 'Ferry Lights', { sources: [src('spotify', 'sp1', { matchedBy: 'link' }), src('youtube-music', 'ym9', { matchedBy: 'spotdl' })], rank: 10 })] }, PENDING),
      done(4, 'harbour', FINAL, { tracks: false, artists: false, albums: false }),
    ]);
  });
  await searchFor(page, 'harbour');
  const songs = page.locator('#srchList .srch__sec[aria-label="Songs"] .srch__row');
  await expect(songs).toHaveCount(3);
  // The merged copy replaced the first in place: one row, three platforms (UX-CAT-002/003).
  const first = songs.first();
  await expect(first.locator('.srch__title')).toHaveText('Harbour Lamps');
  await expect(first.locator('.srch__badge')).toHaveText(['Deezer', 'Apple Music', 'YouTube Music']);
  await expect(first.locator('.srch__sub')).toHaveText('Lantern Choir feat. Ada Moss — Night Ferries · 2019');
  // A Spotify song plays from YouTube Music, through spotDL, and says so.
  const spotify = songs.filter({ hasText: 'Ferry Lights' });
  await expect(spotify.locator('.srch__badge')).toHaveText(['Spotify']);
  await expect(spotify.locator('.srch__via')).toHaveText('plays from YouTube Music');
  await expect(page.locator('#srchList .srch__sec[aria-label="Artists"] .srch__title')).toHaveText(['Lantern Choir']);
  await expect(page.locator('#srchList .srch__sec[aria-label="Albums"] .srch__title')).toHaveText(['Night Ferries']);
  await expect(page.locator('#srchCount')).toHaveText('Results: 3 songs · 1 artist · 1 album');
  // The quiet line: every service in the engine's own states, resting included.
  const line = page.locator('#srchStatus');
  await expect(line).toContainText('Apple Music 1');
  await expect(line).toContainText('Deezer 2');
  await expect(line).toContainText('MusicBrainz cooling down until');
  await expect(line).toContainText('YouTube failed');
  await expect(line).toContainText('SoundCloud needs yt-dlp');
  await expect(line).toContainText('through the companion on this PC');
  await expect(line.locator('[data-state="failed"]')).toHaveAttribute('title', 'yt-dlp could not reach YouTube');
  // Search is about music: nothing on the page offers to search another site.
  await expect(page.locator('#srch a')).toHaveCount(0);
  await expect(page.locator('#srch')).not.toContainText(/Search (YouTube|SoundCloud|Bandcamp)|on a platform instead/);
  expect(asked[0]).toContain('sections=tracks%2Cartists%2Calbums');
});

test('keys move through every section; Enter opens what it is on, Escape goes back, Ctrl+Enter adds', async ({ page }) => {
  await companion(page, (path, route) => {
    if (path === 'search') {
      return fulfillStream(route, [results(0, 'deezer', 'harbour', { tracks: [track('deezer:1', 'One'), track('deezer:2', 'Two')], artists: [artist('deezer:20', 'Lantern Choir')], albums: [] }, FINAL), done(1, 'harbour', FINAL, { tracks: false, artists: false })]);
    }
    if (path === 'artist') return route.fulfill(json({ artist: artist('deezer:20', 'Lantern Choir'), topTracks: [track('deezer:1', 'One')], albums: [album('deezer:30', 'Night Ferries')], albumsPage: { offset: 0, limit: 25, hasMore: false } }));
    return route.fulfill(json({ message: 'no' }, 404));
  });
  await searchFor(page, 'harbour');
  await expect(page.locator('.srch__row[data-i]')).toHaveCount(3);
  await page.press('#q', 'ArrowDown');
  await page.press('#q', 'ArrowDown');
  await page.press('#q', 'ArrowDown');
  await expect(page.locator('#q')).toHaveAttribute('aria-activedescendant', 'srchOpt2');
  await expect(page.locator('#srchOpt2')).toHaveAttribute('aria-selected', 'true');
  await page.press('#q', 'Enter');
  await expect(page.locator('#srchCount')).toHaveText('Artist: Lantern Choir');
  await expect(page.locator('#srchBack')).toBeVisible();
  await page.press('#q', 'Escape');
  await expect(page.locator('#srchCount')).toHaveText('Results: 2 songs · 1 artist · 0 albums');
  await page.press('#q', 'PageUp');
  await expect(page.locator('#q')).toHaveAttribute('aria-activedescendant', 'srchOpt0');
  await page.press('#q', 'Control+Enter');
  await expect(page.locator('#srchOpt0 .srch__add')).toHaveText('✓');
  await expect.poll(() => page.evaluate(() => (window as unknown as { LIBRARY: Array<{ title: string }> }).LIBRARY.some((s) => s.title === 'One'))).toBe(true);
  await page.press('#q', 'Escape');
  await expect(page.locator('#srch')).toBeHidden();
});

test('see all opens one section that scrolls on, page after page, until it is all there', async ({ page }) => {
  const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => track(`deezer:${from + i}`, `Song ${from + i}`, { rank: 1000 - from - i }));
  const asked = await companion(page, (path, route) => {
    const p = params(route);
    if (path !== 'search') return route.fulfill(json({ message: 'no' }, 404));
    const offset = Number(p.get('offset') ?? 0);
    if (offset === 0) return fulfillStream(route, [results(0, 'deezer', 'song', { tracks: many(0, 25) }, FINAL), done(1, 'song', FINAL, { tracks: true }, 0)]);
    if (offset === 25) return fulfillStream(route, [results(0, 'deezer', 'song', { tracks: many(25, 25) }, FINAL), done(1, 'song', FINAL, { tracks: true }, 25)]);
    return fulfillStream(route, [results(0, 'deezer', 'song', { tracks: many(50, 7) }, FINAL), done(1, 'song', FINAL, { tracks: false }, 50)]);
  });
  await searchFor(page, 'song');
  const more = page.locator('.srch__row.srch__more');
  await expect(more).toContainText('See all songs');
  await more.click();
  await expect(page.locator('#srchCount')).toContainText('Songs:');
  // The overview's first page, then the next one as soon as the view opens.
  await expect(page.locator('#srchList .srch__row')).toHaveCount(50);
  await page.locator('#srchBody').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator('#srchList .srch__row')).toHaveCount(57);
  await expect(page.locator('.srch__end')).toHaveText('That’s all 57 songs.');
  const pages = asked.filter((a) => a.startsWith('/helper/v1/catalog/search')).map((a) => new URL(`http://x${a}`).searchParams);
  expect(pages.map((p) => p.get('offset'))).toEqual(['0', '25', '50']);
  expect(pages.slice(1).every((p) => p.get('sections') === 'tracks')).toBe(true);
  await page.click('#srchBack');
  await expect(page.locator('#srchCount')).toContainText('Results: 25 songs');
});

test('the filter keeps its sections and services in the settings store, and the search asks only those', async ({ page }) => {
  const asked = await companion(page, (path, route) => fulfillStream(route, [results(0, 'deezer', 'x', { tracks: [track('deezer:1', 'One')] }, FINAL), done(1, 'x', FINAL, { tracks: false })]));
  await searchFor(page, 'one');
  await expect(page.locator('.srch__row[data-i]')).toHaveCount(1);
  await page.click('#srchFilterBtn');
  await expect(page.locator('#srchFilter')).toBeVisible();
  await page.uncheck('#srchFilter input[name="sec"][value="artists"]');
  await page.uncheck('#srchFilter input[name="pf"][value="youtube"]');
  await page.click('#srchFilter button[type="submit"]');
  await expect(page.locator('#srchFilter')).toBeHidden();
  await expect(page.locator('#srchFilterBtn')).toHaveClass(/is-on/);
  // The search on screen was asked again with the new filter.
  await expect.poll(() => asked.length).toBe(2);
  const p = new URL(`http://x${asked[1]}`).searchParams;
  expect(p.get('sections')).toBe('tracks,albums');
  expect(p.get('providers')).toBe('itunes,deezer,musicbrainz,soundcloud');
  const saved = await page.evaluate(() => (window as unknown as { kv: { get(k: string): Promise<unknown> } }).kv.get('player:search'));
  expect(saved).toMatchObject({ sections: { tracks: true, artists: false, albums: true }, providers: { youtube: false } });
  // Nothing switched off entirely: at least one section and one service stay.
  await page.click('#srchFilterBtn');
  for (const s of ['tracks', 'albums']) await page.uncheck(`#srchFilter input[name="sec"][value="${s}"]`);
  await page.click('#srchFilter button[type="submit"]');
  await expect(page.locator('#srchFilterMsg')).toHaveText('Keep at least one section.');
  await page.click('#srchFilterCancel');
});

test('track, artist and album fields fold out of the pill and back into it; an ISRC is searched as one', async ({ page }) => {
  const asked = await companion(page, (path, route) => fulfillStream(route, [results(0, 'deezer', 'x', { tracks: [track('deezer:1', 'Harbour Lamps', { isrc: 'GBAYE1900001' })] }, FINAL), done(1, 'x', FINAL, { tracks: false })]));
  await page.fill('#q', 'harbour lamps');
  await page.click('#qMore');
  await expect(page.locator('#srchAdv')).toBeVisible();
  await expect(page.locator('#srchAdv input[name="track"]')).toHaveValue('harbour lamps');
  await page.fill('#srchAdv input[name="artist"]', 'Lantern Choir');
  await expect(page.locator('#q')).toHaveValue('harbour lamps Lantern Choir');
  await page.press('#srchAdv input[name="artist"]', 'Enter');
  await expect(page.locator('.srch__row[data-i]')).toHaveCount(1);
  const p = new URL(`http://x${asked[0]}`).searchParams;
  expect([p.get('track'), p.get('artist'), p.get('q')]).toEqual(['harbour lamps', 'Lantern Choir', null]);
  // Folded away, the fields are merged back into the one line.
  await page.click('#qMore');
  await expect(page.locator('#srchAdv')).toBeHidden();
  await expect(page.locator('#q')).toHaveValue('harbour lamps Lantern Choir');
  // An ISRC typed in the pill is searched as an ISRC.
  await searchFor(page, 'GBAYE1900001');
  await expect.poll(() => asked.length).toBe(2);
  expect(new URL(`http://x${asked[1]}`).searchParams.get('q')).toBe('GBAYE1900001');
  // And from the ISRC field, a malformed one is explained before anything is asked.
  await page.click('#qMore');
  await page.fill('#srchAdv input[name="track"]', '');
  await page.fill('#srchAdv input[name="artist"]', '');
  await page.fill('#srchAdv input[name="isrc"]', 'NOT-AN-ISRC');
  await page.press('#srchAdv input[name="isrc"]', 'Enter');
  await expect(page.locator('#srchBody')).toContainText('An ISRC is two letters');
  expect(asked.length).toBe(2);
});

test('an artist drills into an album; details stack, and Back walks them back', async ({ page }) => {
  const songs = [track('deezer:501', 'Quay Song', { trackNumber: 1 }), track('deezer:502', 'Lamp Song', { trackNumber: 2 })];
  await companion(page, (path, route) => {
    if (path === 'search') return fulfillStream(route, [results(0, 'deezer', 'lantern', { artists: [artist('deezer:20', 'Lantern Choir')] }, FINAL), done(1, 'lantern', FINAL, { tracks: false, artists: false, albums: false })]);
    if (path === 'artist') {
      expect(params(route).get('id')).toBe('deezer:20');
      return route.fulfill(json({ artist: artist('deezer:20', 'Lantern Choir', { pictureUrl: 'https://cdn-images.dzcdn.net/images/artist/x/500x500.jpg' }), topTracks: songs, albums: [album('deezer:30', 'Night Ferries')], albumsPage: { offset: 0, limit: 25, hasMore: false } }));
    }
    if (path === 'album') {
      expect(params(route).get('id')).toBe('deezer:30');
      return route.fulfill(json({ album: album('deezer:30', 'Night Ferries'), page: { tracks: songs, offset: 0, limit: 100, total: 2, hasMore: false, capped: false }, collection: { platform: 'deezer', kind: 'album', id: '30', url: 'https://www.deezer.com/album/30', title: 'Night Ferries', owner: 'Lantern Choir' } }));
    }
    return route.fulfill(json({ message: 'no' }, 404));
  });
  await page.route('https://cdn-images.dzcdn.net/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
  await searchFor(page, 'lantern');
  await page.locator('.srch__row--artist').click();
  await expect(page.locator('.srch__dtitle')).toHaveText('Lantern Choir');
  await expect(page.locator('.srch__dfacts')).toContainText('Folk');
  await expect(page.locator('#srchList .srch__sec[aria-label="Top songs"] .srch__title')).toHaveText(['Quay Song', 'Lamp Song']);
  await page.locator('#srchList .srch__sec[aria-label="Albums"] .srch__row').click();
  await expect(page.locator('#srchCount')).toHaveText('Album: Night Ferries');
  await expect(page.locator('.srch__dfacts')).toHaveText('2019 · Quay Records · Folk · 2 songs');
  await expect(page.locator('.srch__dpfs .srch__badge')).toHaveText(['Deezer']);
  await expect(page.locator('#srchList .srch__title')).toHaveText(['Quay Song', 'Lamp Song']);
  await page.click('#srchBack');
  await expect(page.locator('#srchCount')).toHaveText('Artist: Lantern Choir');
  await page.click('#srchBack');
  await expect(page.locator('#srchCount')).toHaveText('Results: 0 songs · 1 artist · 0 albums');
  await expect(page.locator('#srchBack')).toBeHidden();
});

test('a song’s details: genre, label and year from enrichment, and its lyrics, synced', async ({ page }) => {
  const song = track('deezer:1001', 'Harbour Lamps', { isrc: 'GBAYE1900001', genre: null, label: null });
  const asked = await companion(page, (path, route) => {
    if (path === 'search') return fulfillStream(route, [results(0, 'deezer', 'harbour', { tracks: [song] }, FINAL), done(1, 'harbour', FINAL, { tracks: false })]);
    if (path === 'enrich') return route.fulfill(json({ isrc: 'GBAYE1900001', musicbrainzRecordingId: 'mb-1', genre: 'Indie Folk', genres: ['indie folk'], label: 'Quay Records', releaseDate: '2019-05-03', year: 2019, sources: [src('spotify', 'sp1', { matchedBy: 'musicbrainz' })] }));
    if (path === 'lyrics') return route.fulfill(json({ found: true, source: 'lrclib', id: 9, instrumental: false, synced: '[00:12.30] Lamps along the quay\n[00:16.80] Ferries in the rain', plain: 'Lamps along the quay\nFerries in the rain', trackName: 'Harbour Lamps', artistName: 'Lantern Choir', durationSec: 214 }));
    return route.fulfill(json({ message: 'no' }, 404));
  });
  await searchFor(page, 'harbour');
  await page.locator('.srch__row[data-i="0"] .srch__title').click();
  await expect(page.locator('#srchCount')).toHaveText('Song: Harbour Lamps');
  const facts = page.locator('.srch__dfacts');
  await expect(facts).toContainText('Genre Indie Folk');
  await expect(facts).toContainText('Label Quay Records');
  await expect(facts).toContainText('Year 2019');
  await expect(facts).toContainText('ISRC GBAYE1900001');
  // MusicBrainz linked it on Spotify too: the details name every home.
  await expect(page.locator('.srch__dpfs .srch__badge')).toHaveText(['Deezer', 'Spotify']);
  await expect(page.locator('.srch__lyrics[data-kind="synced"] .srch__lyr')).toHaveText(['0:12 Lamps along the quay', '0:16 Ferries in the rain']);
  expect(asked.find((a) => a.startsWith('/helper/v1/catalog/enrich'))).toContain('isrc=GBAYE1900001');
  expect(asked.find((a) => a.startsWith('/helper/v1/catalog/lyrics'))).toContain('title=Harbour+Lamps');
});

test('a failure says plainly what happened', async ({ page }) => {
  await companion(page, (path, route) =>
    fulfillStream(route, [
      results(0, null, 'x', {}, status([{ provider: 'itunes', state: 'pending' }, { provider: 'deezer', state: 'pending' }])),
      done(1, 'x', status([{ provider: 'itunes', state: 'timeout', error: 'itunes.apple.com did not answer in time' }, { provider: 'deezer', state: 'failed', error: 'api.deezer.com could not be reached' }]), { tracks: false }),
    ]),
  );
  await searchFor(page, 'anything');
  await expect(page.locator('#srchBody')).toHaveText('Couldn’t search just now — Apple Music: itunes.apple.com did not answer in time. Deezer: api.deezer.com could not be reached.');
});

test('paired, the hub’s catalog answers first, with the device credential', async ({ page }) => {
  const auth: string[] = [];
  await page.route(`${HUB}/api/v1/catalog/**`, (route) => {
    auth.push(route.request().headers()['authorization'] ?? '');
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    return fulfillStream(route, [results(0, 'deezer', 'x', { tracks: [track('deezer:1', 'From The Hub')] }, FINAL), done(1, 'x', FINAL, { tracks: false })]);
  });
  const helperAsked: string[] = [];
  await page.route(`${COMPANION}/**`, (r) => {
    helperAsked.push(r.request().url());
    return r.abort();
  });
  await boot(page);
  await page.evaluate(async (a) => {
    await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', a);
  }, ACCT);
  await useCompanion(page);
  await searchFor(page, 'hub');
  await expect(page.locator('.srch__row .srch__title')).toHaveText(['From The Hub']);
  await expect(page.locator('#srchStatus')).toContainText('through the hub TOWER');
  expect(auth.filter(Boolean)[0]).toBe(`Bearer ${ACCT.credentialId}.${ACCT.secret}`);
  expect(helperAsked).toEqual([]);
});

test('with no hub and no companion, this browser searches the keyless services itself and says what it cannot', async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const itunes = (entity: string | null) =>
    entity === 'song'
      ? { results: [{ wrapperType: 'track', kind: 'song', trackId: 61, trackName: 'Browser Song', artistName: 'Lantern Choir', collectionName: 'Night Ferries', trackViewUrl: 'https://music.apple.com/us/album/x/60?i=61', previewUrl: 'https://audio-ssl.itunes.apple.com/61.m4a', trackTimeMillis: 200_000 }] }
      : { results: [] };
  await page.route('**/itunes.apple.com/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(itunes(new URL(r.request().url()).searchParams.get('entity'))) }));
  // Deezer has no CORS for a page: it is asked over JSONP.
  const deezer: string[] = [];
  await page.route('**/api.deezer.com/**', (r) => {
    const u = new URL(r.request().url());
    deezer.push(u.pathname);
    const cb = u.searchParams.get('callback') ?? 'cb';
    return r.fulfill({ status: 200, contentType: 'text/javascript', body: `${cb}(${JSON.stringify({ data: [], total: 0 })})` });
  });
  for (const u of ['**/musicbrainz.org/**', '**/lrclib.net/**', '**/coverartarchive.org/**']) await page.route(u, (r) => r.abort());
  await boot(page);
  await searchFor(page, 'browser song');
  await expect(page.locator('.srch__row .srch__title').first()).toHaveText('Browser Song');
  await expect(page.locator('.srch__row').first().locator('.srch__badge')).toHaveText(['Apple Music']);
  await expect(page.locator('.srch__row button.srch__art').first()).toHaveAttribute('aria-label', /30 seconds/);
  const line = page.locator('#srchStatus');
  await expect(line).toContainText('through this browser');
  await expect(line).toContainText('YouTube needs yt-dlp');
  expect(deezer.length).toBeGreaterThan(0);
});

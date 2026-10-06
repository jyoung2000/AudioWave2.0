/**
 * Pasted links (NP-FIND-002), read through the catalog's resolve (DEC-039).
 *
 * A link of any platform pasted into the header search is not searched: it is resolved — by the
 * paired hub (`/api/v1/catalog/resolve`), else the companion on this PC (`/helper/v1/catalog/resolve`,
 * its yt-dlp or spotDL reading the link keylessly), else this browser (Deezer and Apple links through
 * their public APIs; a YouTube or SoundCloud link named by its oEmbed). A song becomes one row; an
 * album or playlist a listing that opens in the music list (collections.spec.ts); a link nobody can
 * read says why. The servers are stubbed with what their tools said about these links on 2026-10-04.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, CORS, HUB, watchErrors } from './_shell';
import { ACCT, collection, COMPANION, json, params, resolved, src, stubServices, track, useCompanion } from './_catalog';

const RICK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SET = 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep';

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await stubServices(page);
});
test.afterEach(() => {
  expect(errors, 'JS errors').toEqual([]);
});

async function paste(page: Page, link: string): Promise<void> {
  await page.fill('#q', link);
  await page.press('#q', 'Enter');
}

const rick = track(`youtube:dQw4w9WgXcQ`, 'Never Gonna Give You Up', {
  artist: 'Rick Astley',
  artists: ['Rick Astley'],
  album: null,
  durationMs: 213_000,
  releaseDate: '2009-10-25',
  year: 2009,
  bpm: null,
  artworkUrl: 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp',
  sources: [src('youtube', 'dQw4w9WgXcQ', { url: RICK, matchedBy: 'link' })],
});

test('a pasted YouTube link: the companion reads it, and the date is on the details line', async ({ page }) => {
  const links: string[] = [];
  await page.route(`${COMPANION}/helper/v1/catalog/resolve?**`, async (r) => {
    links.push(params(r).get('url') ?? '');
    await new Promise((done) => setTimeout(done, 400));
    await r.fulfill(json(resolved(RICK, 'youtube', 'track', { track: rick })));
  });
  await boot(page);
  await useCompanion(page);
  await paste(page, RICK);
  // Said at once, while the companion reads it.
  await expect(page.locator('#srchCount')).toHaveText('Reading the link…');
  const row = page.locator('.srch__row').first();
  await expect(row.locator('.srch__title')).toHaveText('Never Gonna Give You Up');
  await expect(row.locator('.srch__sub')).toHaveText('Rick Astley — 2009-10-25');
  await expect(row.locator('.srch__time')).toHaveText('3:33');
  await expect(row.locator('.srch__badge')).toHaveText(['YouTube']);
  await expect(page.locator('#srchCount')).toHaveText('Results: 1 song');
  expect(links).toEqual([RICK]);

  // Added to the library, the row keeps its link and its date: the fetch sheet says both.
  await row.locator('.srch__add').click();
  const added = await page.evaluate(() => (window as unknown as { LIBRARY: Array<{ title: string; url: string; date?: string | null }> }).LIBRARY.find((s) => s.title === 'Never Gonna Give You Up'));
  expect(added).toMatchObject({ url: RICK, date: '2009-10-25' });
});

test('with no companion, a pasted link still resolves through oEmbed and nothing asks a local port', async ({ page }) => {
  await page.unroute('**/www.youtube.com/oembed**');
  await page.route('**/www.youtube.com/oembed**', (r) => r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Some Video', author_name: 'Someone' }) }));
  const local: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(COMPANION) || /127\.0\.0\.1:8642/.test(r.url())) local.push(r.url());
  });
  await boot(page);
  await paste(page, RICK);
  await expect(page.locator('.srch__row .srch__title').first()).toHaveText('Some Video');
  await expect(page.locator('.srch__row .srch__badge').first()).toHaveText('YouTube');
  expect(local).toEqual([]);
});

test('a pasted playlist becomes one listing that names its platform, not a page of rows', async ({ page }) => {
  const entries = Array.from({ length: 100 }, (_, i) => track(`youtube:video${i}`, `Part ${i + 1}`, { artist: 'Wickman Wish', album: null, sources: [src('youtube', `video${i}`, { url: `https://www.youtube.com/watch?v=video${i}` })] }));
  const PLAYLIST = 'https://www.youtube.com/playlist?list=PLBB231211A4F62143';
  await page.route(`${COMPANION}/helper/v1/catalog/resolve?**`, (r) =>
    r.fulfill(json(resolved(PLAYLIST, 'youtube', 'playlist', { collection: collection('youtube', 'playlist', 'PLBB231211A4F62143', 'Team Fortress 2 [2010 Version]', entries, { total: 250, hasMore: true, capped: true, owner: 'Wickman Wish' }) }))),
  );
  await boot(page);
  await useCompanion(page);
  await paste(page, PLAYLIST);
  const listing = page.locator('.srch__row--coll');
  await expect(listing).toHaveCount(1);
  await expect(listing.locator('.srch__title')).toHaveText('Team Fortress 2 [2010 Version]');
  await expect(listing.locator('.srch__badge')).toHaveText('YouTube');
  await expect(listing.locator('.srch__sub')).toHaveText('Playlist on YouTube · Wickman Wish · 250 songs');
  await expect(page.locator('#srchCount')).toHaveText('Playlist: YouTube');
});

test('a set whose entries the server looked up shows their covers as a mosaic', async ({ page }) => {
  const covers = ['a', 'b', 'c', 'd'].map((x) => `https://i1.sndcdn.com/artworks-${x}-t500x500.jpg`);
  const entries = ['World On Fire', 'Gimme Twice', 'Goldrushed', 'Cover Girl', 'Damn', 'In The End'].map((t, i) => track(`soundcloud:${i}`, t, { artist: 'The Royal Concept', artworkUrl: covers[i] ?? null, sources: [src('soundcloud', String(i))] }));
  await page.route('https://i1.sndcdn.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.route(`${COMPANION}/helper/v1/catalog/resolve?**`, (r) => r.fulfill(json(resolved(SET, 'soundcloud', 'playlist', { collection: collection('soundcloud', 'playlist', 'the-royal-concept-ep', 'The Royal Concept EP', entries, { covers, owner: 'The Royal Concept' }) }))));
  await boot(page);
  await useCompanion(page);
  await paste(page, SET);
  const art = page.locator('.srch__row--coll .srch__mosaic img');
  await expect(art).toHaveCount(4);
  expect(await art.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).getAttribute('src')))).toEqual(covers);
  await expect(page.locator('.srch__row--coll .srch__sub')).toHaveText('Playlist on SoundCloud · The Royal Concept · 6 songs');
});

test('a link nobody can read says why, in words', async ({ page }) => {
  const PRIVATE = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
  await page.route(`${COMPANION}/helper/v1/catalog/resolve?**`, (r) =>
    r.fulfill(json(resolved(PRIVATE, 'spotify', 'unavailable', { reason: 'Spotify would not list this playlist. It is private, or one Spotify made itself (Spotify’s API does not share those with other apps).' }))),
  );
  await boot(page);
  await useCompanion(page);
  await paste(page, PRIVATE);
  await expect(page.locator('#srchBody')).toHaveText('Spotify would not list this playlist. It is private, or one Spotify made itself (Spotify’s API does not share those with other apps).');
  await expect(page.locator('#srchCount')).toHaveText('Spotify: unavailable');
});

test('a paired hub that reads a Spotify link slowly still lands its answer: Spotify, playing from YouTube Music', async ({ page }) => {
  // spotDL takes 20-50 s on the hub; the player waits for it rather than giving up at eight.
  const SPOTIFY = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
  const song = track('spotify:4cOdK2wGLETKBW3PvgPWqT', 'Never Gonna Give You Up', {
    artist: 'Rick Astley',
    album: 'Whenever You Need Somebody',
    durationMs: 213_000,
    sources: [src('spotify', '4cOdK2wGLETKBW3PvgPWqT', { url: SPOTIFY, matchedBy: 'link' }), src('youtube-music', 'lYBUbBu4W08', { url: 'https://music.youtube.com/watch?v=lYBUbBu4W08', matchedBy: 'spotdl' })],
  });
  let hubAsked = 0;
  await page.route(`${HUB}/api/v1/catalog/resolve?**`, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    hubAsked += 1;
    await new Promise((done) => setTimeout(done, 9_000));
    await r.fulfill(json(resolved(SPOTIFY, 'spotify', 'track', { track: song })));
  });
  await boot(page);
  await page.evaluate(async (a) => {
    await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', a);
  }, ACCT);
  await paste(page, SPOTIFY);
  await expect(page.locator('#srchBody')).toContainText('Spotify links are read by spotDL');
  const row = page.locator('.srch__row').first();
  await expect(row.locator('.srch__time')).toHaveText('3:33', { timeout: 20_000 });
  await expect(row.locator('.srch__badge')).toHaveText(['Spotify']);
  await expect(row.locator('.srch__via')).toHaveText('plays from YouTube Music');
  expect(hubAsked).toBe(1);
  // Added, the song keeps the link it plays from: spotDL's YouTube Music match.
  await row.locator('.srch__add').click();
  const added = await page.evaluate(() => (window as unknown as { LIBRARY: Array<{ title: string; url: string; platform: string }> }).LIBRARY.find((s) => s.title === 'Never Gonna Give You Up'));
  expect(added).toMatchObject({ url: 'https://music.youtube.com/watch?v=lYBUbBu4W08', platform: 'YouTube Music' });
});

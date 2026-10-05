/**
 * Pasted links read by the companion (NP-FIND-002).
 *
 * A companion on this PC answers `GET /helper/v1/resolve?url=` with what its tools read from the
 * link — keylessly. The player asks it beside the hub/oEmbed chain and lets its answer land over
 * oEmbed's: duration, the whole date, album and art fill the row, and a playlist becomes its songs,
 * each a row of its own under a count that names the list and the cap. The companion is stubbed on
 * 127.0.0.1:17999, answering the contract (`HelperResolved`) with what the real tools said about
 * these links on 2026-10-04.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { boot, CORS, watchErrors } from './_shell';

const COMPANION = 'http://127.0.0.1:17999';
const RICK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLBB231211A4F62143';
const SET = 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep';

const json = (body: unknown) => ({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const entry = (over: Record<string, unknown>) => ({ url: null, title: null, artist: null, featured: [], album: null, genre: null, durationSec: null, date: null, year: null, artworkUrl: null, trackNumber: null, ...over });
const resolvedAt = '2026-10-04T12:00:00.000Z';

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  // Nothing here may reach the internet: tempo lookups and the keyless fallbacks are stubbed out.
  await page.route('**/api.deezer.com/**', (r) => r.abort());
  await page.route('**/noembed.com/**', (r) => r.abort());
  await page.route('**/soundcloud.com/oembed**', (r) => r.abort());
});
test.afterEach(() => {
  expect(errors, 'JS errors').toEqual([]);
});

async function withCompanion(page: Page): Promise<void> {
  await boot(page);
  await page.evaluate((c) => {
    (window as unknown as { COMPANION: string }).COMPANION = c;
  }, COMPANION);
}

async function paste(page: Page, link: string): Promise<void> {
  await page.fill('#q', link);
  await page.press('#q', 'Enter');
}

/** The link a resolve request asked about. */
const asked = (route: Route): string => new URL(route.request().url()).searchParams.get('url') ?? '';

test('a pasted YouTube link: the companion’s answer lands over oEmbed’s, with the date on the details line', async ({ page }) => {
  // oEmbed answers at once with the video's own title; the companion takes a moment, then cleans it.
  await page.route('https://www.youtube.com/oembed**', (r) => r.fulfill(json({ title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', author_name: 'Rick Astley', thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' })));
  const links: string[] = [];
  await page.route(`${COMPANION}/helper/v1/resolve?**`, async (r) => {
    links.push(asked(r));
    await new Promise((done) => setTimeout(done, 600));
    await r.fulfill(
      json({
        source: 'youtube',
        kind: 'track',
        url: RICK,
        track: entry({ url: RICK, title: 'Never Gonna Give You Up', artist: 'Rick Astley', durationSec: 213, date: '2009-10-25', year: 2009, artworkUrl: 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp' }),
        collection: null,
        resolvedAt,
      }),
    );
  });
  await withCompanion(page);
  await paste(page, RICK);

  const row = page.locator('.srch__row').first();
  await expect(row.locator('.srch__title')).toHaveText('Never Gonna Give You Up');
  await expect(row.locator('.srch__sub')).toHaveText('Rick Astley — YouTube · 2009-10-25');
  await expect(row.locator('.srch__time')).toHaveText('3:33');
  await expect(page.locator('#srchCount')).toHaveText('Results: 1 song');
  expect(links).toEqual([RICK]);

  // Added to the library, the row keeps its link and its date: the fetch sheet says both.
  await row.locator('.srch__add').click();
  const added = await page.evaluate(() => (window as unknown as { LIBRARY: Array<{ title: string; url: string; date?: string | null }> }).LIBRARY.find((s) => s.title === 'Never Gonna Give You Up'));
  expect(added).toMatchObject({ url: RICK, date: '2009-10-25' });
});

test('with no companion, a pasted link still resolves through oEmbed and nothing asks a local port', async ({ page }) => {
  await page.route('https://www.youtube.com/oembed**', (r) => r.fulfill(json({ title: 'Some Video', author_name: 'Someone' })));
  const local: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(COMPANION)) local.push(r.url());
  });
  await boot(page);
  await paste(page, RICK);
  await expect(page.locator('.srch__row .srch__title').first()).toHaveText('Some Video');
  expect(local).toEqual([]);
});

test('a pasted playlist becomes its songs, each its own row, under a count that names the list and the cap', async ({ page }) => {
  const entries = Array.from({ length: 200 }, (_, i) =>
    entry({ url: `https://www.youtube.com/watch?v=video${String(i).padStart(3, '0')}`, title: `Part ${i + 1}`, artist: 'Wickman Wish', durationSec: 600 + i }),
  );
  await page.route('https://www.youtube.com/oembed**', (r) => r.abort());
  await page.route(`${COMPANION}/helper/v1/resolve?**`, (r) =>
    r.fulfill(json({ source: 'youtube', kind: 'collection', url: PLAYLIST, track: null, collection: { title: 'Team Fortress 2 [2010 Version]', artist: 'Wickman Wish', artworkUrl: null, date: null, entries, total: 250, cap: 200, capped: true }, resolvedAt })),
  );
  await withCompanion(page);
  await paste(page, PLAYLIST);

  await expect(page.locator('#srchCount')).toHaveText('Team Fortress 2 [2010 Version]: 200 songs (the first 200 of 250)');
  const rows = page.locator('.srch__row');
  await expect(rows).toHaveCount(5);
  await expect(rows.first().locator('.srch__title')).toHaveText('Part 1');
  await expect(rows.first().locator('.srch__time')).toHaveText('10:00');

  // Each row is its own song with its own address: adding the second keeps that address, so it
  // can be fetched on its own.
  await rows.nth(1).locator('.srch__add').click();
  const added = await page.evaluate(() => (window as unknown as { LIBRARY: Array<{ title: string; url: string }> }).LIBRARY.find((s) => s.title === 'Part 2'));
  expect(added?.url).toBe('https://www.youtube.com/watch?v=video001');
});

test('a set listed by address alone shows each entry’s own words once its page is on screen', async ({ page }) => {
  const urls = ['world-on-fire-1', 'gimme-twice-mastered', 'goldrushed-mastered', 'cover-girl', 'damn-new-years', 'in-the-end'].map((s) => `https://soundcloud.com/the-concept-band/${s}`);
  const looked: string[] = [];
  await page.route(`${COMPANION}/helper/v1/resolve?**`, async (r) => {
    const link = asked(r);
    looked.push(link);
    if (link === SET) {
      return r.fulfill(
        json({ source: 'soundcloud', kind: 'collection', url: SET, track: null, collection: { title: 'The Royal Concept EP', artist: 'The Royal Concept', artworkUrl: null, date: '2012-07-28', entries: urls.map((u) => entry({ url: u, album: 'The Royal Concept EP' })), total: 6, cap: 200, capped: false }, resolvedAt }),
      );
    }
    const name = link.split('/').pop()!;
    return r.fulfill(json({ source: 'soundcloud', kind: 'track', url: link, track: entry({ url: link, title: `Title of ${name}`, artist: 'The Royal Concept', album: 'The Royal Concept EP', durationSec: 200, date: '2012-07-28', year: 2012 }), collection: null, resolvedAt }));
  });
  await withCompanion(page);
  await paste(page, SET);

  await expect(page.locator('#srchCount')).toHaveText('The Royal Concept EP: 6 songs');
  const first = page.locator('.srch__row').first();
  await expect(first.locator('.srch__title')).toHaveText('Title of world-on-fire-1');
  await expect(first.locator('.srch__sub')).toHaveText('The Royal Concept — The Royal Concept EP · 2012-07-28');
  // Only the page on screen was looked up: the set, then its first five entries.
  await expect.poll(() => looked.slice(1).sort()).toEqual(urls.slice(0, 5).sort());
});

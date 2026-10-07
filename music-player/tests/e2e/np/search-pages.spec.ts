/**
 * The search redrawn (owner, 2026-10-07): one type per page with the one pager (NP-FIND-004), the
 * type's own field and the segmented control (NP-FIND-005), the card centred under the field
 * (NP-FIND-006), Playlists as a type with the person's starred lists above (NP-FIND-009, UX-CAT-005),
 * and a song row's menu — Up Next, a playlist, the library (NP-FIND-010, NP-MENU-003).
 *
 * The companion's helper answers every route from fixtures with `page.route`; the browser engine's
 * services are stubbed, so nothing here reaches the network.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { boot, watchErrors } from './_shell';
import {
  COMPANION,
  done,
  fulfillStream,
  hud,
  json,
  params,
  playlist,
  results,
  searchFor,
  src,
  status,
  stubServices,
  track,
  useCompanion,
} from './_catalog';

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await stubServices(page);
});
test.afterEach(() => {
  expect(errors, 'JS errors').toEqual([]);
});

const FINAL = status([
  { provider: 'itunes', state: 'ok', count: 1 },
  { provider: 'deezer', state: 'ok', count: 2 },
  { provider: 'musicbrainz', state: 'empty' },
  { provider: 'youtube', state: 'skipped', error: 'It has nothing in the sections asked for' },
  { provider: 'soundcloud', state: 'skipped', error: 'It has nothing in the sections asked for' },
]);

async function companion(
  page: Page,
  answer: (path: string, route: Route) => Promise<void> | void,
): Promise<string[]> {
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

const songs = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) =>
    track(`deezer:${from + i}`, `Song ${String(from + i).padStart(2, '0')}`, {
      rank: 1000 - from - i,
    }),
  );
const lists = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) =>
    playlist(`deezer:${5000 + from + i}`, `Mix ${String(from + i).padStart(2, '0')}`, {
      rank: 500 - from - i,
    }),
  );

/** A catalog with many songs and many playlists, paged as the engine pages them. */
function bigCatalog(path: string, route: Route): Promise<void> {
  if (path !== 'search') return route.fulfill(json({ message: 'no' }, 404));
  const p = params(route);
  const offset = Number(p.get('offset') ?? 0);
  const limit = Number(p.get('limit') ?? 25);
  const sections = (p.get('sections') ?? '').split(',');
  const q = p.get('q') ?? '';
  const TOTAL = { tracks: 60, playlists: 30 };
  const rows: Record<string, unknown[]> = {};
  const more: Record<string, boolean> = {};
  if (sections.includes('tracks')) {
    rows['tracks'] = songs(offset + 1, Math.max(0, Math.min(limit, TOTAL.tracks - offset)));
    more['tracks'] = offset + limit < TOTAL.tracks;
  }
  if (sections.includes('playlists')) {
    rows['playlists'] = lists(offset + 1, Math.max(0, Math.min(limit, TOTAL.playlists - offset)));
    more['playlists'] = offset + limit < TOTAL.playlists;
  }
  if (sections.includes('artists')) more['artists'] = false;
  if (sections.includes('albums')) more['albums'] = false;
  return fulfillStream(route, [
    results(0, 'deezer', q, rows, FINAL),
    done(1, q, FINAL, more, offset, limit),
  ]);
}

const pageOf = (page: Page) => page.locator('#srchPageOf');
const rowsOf = (page: Page) => page.locator('#srchList .srch__row[data-page]');
const hot = (page: Page) => page.locator('.srch__row.is-hot .srch__title');

test('See all opens the type’s page: a scoped field, the segmented control, and a search of that type alone', async ({
  page,
}) => {
  const asked = await companion(page, bigCatalog);
  await searchFor(page, 'harbour');
  await expect(
    page.locator('#srchList .srch__sec[aria-label="Songs"] .srch__row:not(.srch__more)'),
  ).toHaveCount(5);
  await expect(
    page.locator('#srchList .srch__sec[aria-label="Playlists"] .srch__row:not(.srch__more)'),
  ).toHaveCount(3);
  await expect(page.locator('#srchFoot')).toBeHidden();
  await page.locator('.srch__sec[aria-label="Songs"] .srch__more').click();
  // The page: its heading, the type's field prefilled, Songs chosen in the control, the pager.
  await expect(page.locator('#srchCount')).toContainText('Songs:');
  await expect(page.locator('#srchTypeQ')).toHaveValue('harbour');
  await expect(page.locator('#srchTypeQ')).toHaveAttribute('aria-label', 'Search songs');
  await expect(page.locator('.srch__segbtn[aria-selected="true"]')).toHaveText('Songs');
  await expect(page.locator('#srchFoot')).toBeVisible();
  // Searching in the type's field asks the catalog for that type only, a page of 25 from offset 0.
  await page.fill('#srchTypeQ', 'lantern');
  await page.press('#srchTypeQ', 'Enter');
  await expect(page.locator('#srchCount')).toContainText('for “lantern”');
  await expect.poll(() => asked.filter((a) => a.includes('q=lantern')).length).toBeGreaterThan(0);
  const scoped = new URL(`http://x${asked.find((a) => a.includes('q=lantern'))}`).searchParams;
  expect([scoped.get('sections'), scoped.get('offset'), scoped.get('limit')]).toEqual([
    'tracks',
    '0',
    '25',
  ]);
  await expect(rowsOf(page)).toHaveCount(25);
  // The control switches type: a fresh search of that type, with the page's own words.
  await page.click('.srch__segbtn[data-type="playlists"]');
  await expect(page.locator('#srchCount')).toContainText('Playlists:');
  await expect(page.locator('#srchTypeQ')).toHaveAttribute('aria-label', 'Search playlists');
  await expect
    .poll(() => asked.some((a) => a.includes('sections=playlists') && a.includes('q=lantern')))
    .toBe(true);
  const switched = new URL(
    `http://x${asked.find((a) => a.includes('sections=playlists') && a.includes('q=lantern'))}`,
  ).searchParams;
  expect([switched.get('offset'), switched.get('limit')]).toEqual(['0', '12']);
  await expect(rowsOf(page)).toHaveCount(12);
  await expect(pageOf(page)).toHaveText('Page 1 of 1+');
  // Back returns to the overview, which still has no pager.
  await page.click('#srchBack');
  await expect(page.locator('#srchCount')).toContainText('Results:');
  await expect(page.locator('#srchFoot')).toBeHidden();
  await expect(page.locator('#srchType')).toBeHidden();
});

test('on a type page the list scrolls on by itself and ‹ › move a page at a time, fetching first when needed', async ({
  page,
}) => {
  const asked = await companion(page, bigCatalog);
  await searchFor(page, 'harbour');
  await page.locator('.srch__sec[aria-label="Songs"] .srch__more').click();
  // Seeded with the overview's 25, the next page is asked at once: 50 rows, "of 2+".
  await expect(rowsOf(page)).toHaveCount(50);
  await expect(pageOf(page)).toHaveText('Page 1 of 2+');
  // Scrolling near the end fetches the rest; the end says so.
  await page.locator('#srchBody').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(rowsOf(page)).toHaveCount(60);
  await expect(page.locator('.srch__end')).toHaveText('That’s all 60 songs.');
  // The pager follows the scroll: at the bottom, the last page is the one on show.
  await page.locator('#srchBody').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(pageOf(page)).toHaveText('Page 3 of 3');
  // ‹ moves to the previous page's first row and puts the keys on it.
  await page.click('#srchPrev');
  await expect(pageOf(page)).toHaveText('Page 2 of 3');
  await expect(hot(page)).toHaveText('Song 26');
  await page.click('#srchPrev');
  await expect(pageOf(page)).toHaveText('Page 1 of 3');
  await expect(hot(page)).toHaveText('Song 01');
  await expect(page.locator('#srchPrev')).toBeDisabled();
  // Page Down from the field does the same as ›.
  await page.press('#q', 'PageDown');
  await expect(pageOf(page)).toHaveText('Page 2 of 3');
  await expect(hot(page)).toHaveText('Song 26');
  await page.press('#q', 'PageDown');
  await expect(pageOf(page)).toHaveText('Page 3 of 3');
  await expect(hot(page)).toHaveText('Song 51');
  await expect(page.locator('#srchNext')).toBeDisabled();
  const offsets = asked
    .filter((a) => a.includes('sections=tracks&'))
    .map((a) => new URL(`http://x${a}`).searchParams.get('offset'));
  expect(offsets).toEqual(['25', '50']);
});

test('› past what has arrived fetches the next page first, then lands on its first row', async ({
  page,
}) => {
  await companion(page, (path, route) => {
    if (path !== 'search') return route.fulfill(json({ message: 'no' }, 404));
    const p = params(route);
    const offset = Number(p.get('offset') ?? 0);
    const limit = Number(p.get('limit') ?? 25);
    const sections = (p.get('sections') ?? '').split(',');
    if (!sections.includes('albums'))
      return fulfillStream(route, [
        results(0, 'deezer', 'x', {}, FINAL),
        done(1, 'x', FINAL, { tracks: false, artists: false, playlists: false }, offset, limit),
      ]);
    // Albums come 12 a page, 40 in all, each page a moment late so the fetch is seen. The page
    // from offset 25 is one short (eleven), so page 4 is not there until › asks for it.
    const n = Math.max(0, Math.min(offset === 25 ? 11 : limit, 40 - offset));
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `deezer:${900 + offset + i}`,
      title: `Album ${String(offset + i + 1).padStart(2, '0')}`,
      artist: 'Lantern Choir',
      artworkUrl: null,
      releaseDate: '2019-05-03',
      year: 2019,
      trackCount: 11,
      label: null,
      genre: null,
      explicit: null,
      upc: null,
      sources: [src('deezer', String(900 + offset + i))],
      rank: 400 - offset - i,
    }));
    return new Promise<void>((resolveLater) => {
      setTimeout(
        () => {
          void fulfillStream(route, [
            results(0, 'deezer', 'x', { albums: rows }, FINAL),
            done(
              1,
              'x',
              FINAL,
              { albums: offset + limit < 40, tracks: false, artists: false, playlists: false },
              offset,
              limit,
            ),
          ]).then(resolveLater);
        },
        offset ? 250 : 0,
      );
    });
  });
  await searchFor(page, 'x');
  await page.locator('.srch__sec[aria-label="Albums"] .srch__more').click();
  // The overview's page of 25 arrived; the type page reads on in twelves (one short, so three pages).
  await expect(rowsOf(page)).toHaveCount(36);
  await expect(pageOf(page)).toHaveText('Page 1 of 3+');
  await page.click('#srchNext');
  await expect(hot(page)).toHaveText('Album 13');
  await page.click('#srchNext');
  await expect(hot(page)).toHaveText('Album 25');
  await expect(pageOf(page)).toHaveText('Page 3 of 3+');
  // Page 4 is not there yet: › fetches it from the next offset first, then lands on its first row.
  await page.click('#srchNext');
  await expect(hot(page)).toHaveText('Album 38');
  await expect(pageOf(page)).toHaveText('Page 4 of 4');
  await expect(rowsOf(page)).toHaveCount(39);
  await expect(page.locator('#srchNext')).toBeDisabled();
});

test('Playlists is a type: Deezer’s public playlists, the starred ones above them, and one opens like an album', async ({
  page,
}) => {
  const asked = await companion(page, (path, route) => {
    if (path === 'search') return bigCatalog(path, route);
    if (path === 'resolve') {
      const url = params(route).get('url') ?? '';
      const id = /playlist\/(\d+)/.exec(url)?.[1] ?? '0';
      return route.fulfill(
        json({
          url,
          platform: 'deezer',
          kind: 'playlist',
          track: null,
          artist: null,
          reason: null,
          resolvedAt: '2026-10-07T12:00:00.000Z',
          collection: {
            ref: {
              platform: 'deezer',
              kind: 'playlist',
              id,
              url,
              title: `Mix ${id.slice(-2)}`,
              owner: 'Playlist Editor',
            },
            artworkUrl: null,
            covers: [],
            releaseDate: null,
            page: {
              tracks: songs(1, 3),
              offset: 0,
              limit: 200,
              total: 3,
              hasMore: false,
              capped: false,
            },
          },
        }),
      );
    }
    return route.fulfill(json({ message: 'no' }, 404));
  });
  // A playlist already starred (NP-FIND-008): the Playlists page lists it first, under "In your library".
  await page.evaluate(async () => {
    const kv = (
      window as unknown as {
        kv: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
      }
    ).kv;
    const state = ((await kv.get('library:state')) as Record<string, unknown> | null) ?? {};
    await kv.set('library:state', {
      ...state,
      collections: [
        {
          ref: {
            platform: 'spotify',
            kind: 'playlist',
            id: 'kept1',
            url: 'https://open.spotify.com/playlist/kept1',
            title: 'Kept Lanterns',
            owner: 'Ada',
          },
          savedAt: '2026-10-06T12:00:00.000Z',
          artworkUrl: null,
          covers: [],
          trackCount: 9,
        },
      ],
    });
  });
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { NP_READY?: unknown }).NP_READY);
  await page.evaluate(() => (window as unknown as { NP_READY: Promise<void> }).NP_READY);
  await useCompanion(page);
  await searchFor(page, 'harbour');
  const overview = page.locator('#srchList .srch__sec[aria-label="Playlists"]');
  await expect(overview.locator('.srch__row--pl .srch__title')).toHaveText([
    'Mix 01',
    'Mix 02',
    'Mix 03',
  ]);
  await expect(overview.locator('.srch__row--pl').first().locator('.srch__sub')).toHaveText(
    'Playlist on Deezer · Playlist Editor · 40 songs',
  );
  await expect(overview.locator('.srch__row--pl').first().locator('.srch__badge')).toHaveText([
    'Deezer',
  ]);
  await expect(overview.locator('.srch__morelabel')).toHaveText('See all 25+ playlists');
  await overview.locator('.srch__more').click();
  await expect(page.locator('#srchCount')).toContainText('Playlists:');
  const mine = page.locator('#srchList .srch__sec[aria-label="In your library"] .srch__row--saved');
  await expect(mine).toHaveCount(1);
  await expect(mine.locator('.srch__title')).toHaveText('Kept Lanterns');
  await expect(mine.locator('.srch__sub')).toHaveText('Playlist on Spotify · Ada · 9 songs');
  await expect(
    page.locator('#srchList .srch__sec[aria-label="From the catalog"] .srch__row--pl'),
  ).toHaveCount(30);
  await expect(pageOf(page)).toHaveText('Page 1 of 3');
  // Opening a catalog playlist resolves its link and shows it in the music list (NP-FIND-007), with the star.
  await page.locator('.srch__row--pl').first().click();
  await expect(page.locator('#srch')).toBeHidden();
  await expect(page.locator('#libScopeLabel')).toHaveText('Mix 01');
  await expect(page.locator('#libColStar')).toBeVisible();
  await expect(page.locator('#libraryRows tr[data-id]')).toHaveCount(3);
  expect(
    asked.some(
      (a) =>
        a.startsWith('/helper/v1/catalog/resolve') && a.includes('deezer.com%2Fplaylist%2F5001'),
    ),
  ).toBe(true);
});

test('with only this browser, the Playlists type still answers: Deezer’s playlist search over JSONP', async ({
  page,
}) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/itunes.apple.com/**', (r) =>
    r.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ results: [] }),
    }),
  );
  const deezer: string[] = [];
  await page.route('**/api.deezer.com/**', (r) => {
    const u = new URL(r.request().url());
    deezer.push(u.pathname);
    const cb = u.searchParams.get('callback') ?? 'cb';
    const body =
      u.pathname === '/search/playlist'
        ? {
            data: [
              {
                id: 14632517341,
                title: 'Relaxing Classical Music',
                public: true,
                nb_tracks: 101,
                link: 'https://www.deezer.com/playlist/14632517341',
                picture_xl:
                  'https://cdn-images.dzcdn.net/images/playlist/ca698c69567ce9f8d4fc19dab12867d3/1000x1000-000000-80-0-0.jpg',
                md5_image: 'ca698c69567ce9f8d4fc19dab12867d3',
                picture_type: 'playlist',
                user: { id: 1, name: 'Playlist Editor', type: 'user' },
                type: 'playlist',
              },
            ],
            total: 1,
          }
        : { data: [], total: 0 };
    return r.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `${cb}(${JSON.stringify(body)})`,
    });
  });
  for (const u of [
    '**/musicbrainz.org/**',
    '**/lrclib.net/**',
    '**/coverartarchive.org/**',
    '**/cdn-images.dzcdn.net/**',
  ])
    await page.route(u, (r) => r.abort());
  await boot(page);
  await searchFor(page, 'relaxing');
  const row = page.locator('#srchList .srch__sec[aria-label="Playlists"] .srch__row--pl');
  await expect(row.locator('.srch__title')).toHaveText(['Relaxing Classical Music']);
  await expect(row.locator('.srch__sub')).toHaveText(
    'Playlist on Deezer · Playlist Editor · 101 songs',
  );
  await expect(page.locator('#srchStatus')).toContainText('through this browser');
  expect(deezer).toContain('/search/playlist');
});

test('a song row’s menu: “…”, right-click and long-press open it; it queues to Up Next, files into a playlist and adds to the library', async ({
  page,
}) => {
  await companion(page, (path, route) => {
    if (path !== 'search') return route.fulfill(json({ message: 'no' }, 404));
    return fulfillStream(route, [
      results(
        0,
        'deezer',
        'harbour',
        {
          tracks: [
            track('deezer:1', 'One', {
              sources: [
                src('deezer', '1', { previewUrl: 'https://cdnt-preview.dzcdn.net/1.mp3' }),
                src('youtube', 'y1'),
              ],
            }),
            track('deezer:2', 'Two', { artist: 'Birch Ensemble', artists: ['Birch Ensemble'] }),
          ],
        },
        FINAL,
      ),
      done(1, 'harbour', FINAL, { tracks: false, artists: false, albums: false, playlists: false }),
    ]);
  });
  await searchFor(page, 'harbour');
  const row = (title: string) => page.locator('#srchList .srch__row', { hasText: title });
  // The "…" at the row's end opens the shell's contextual menu with exactly these commands.
  await row('One').locator('.srch__menu').click();
  const ctx = page.locator('#ctx');
  await expect(ctx).toBeVisible();
  await expect(ctx.locator('.ctx__head')).toHaveText('One');
  expect(
    await ctx
      .locator('> .ctx__item')
      .evaluateAll((els) => els.map((el) => el.firstChild?.textContent ?? '')),
  ).toEqual(['Add to Up Next', 'Add to Playlist', 'Add to Library', 'Download…', 'Audition']);
  expect(
    await ctx
      .locator('> [data-act]')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset['act'])),
  ).toEqual(['cat-next', 'parent', 'cat-lib', 'cat-download', 'cat-audition']);
  await expect(ctx.locator('[data-act="cat-download"]')).toBeEnabled();
  await expect(ctx.locator('[data-act="cat-audition"]')).toBeEnabled();
  // Add to Up Next: the song joins the library quietly (nothing plays) and the queue; the HUD says so.
  await ctx.locator('[data-act="cat-next"]').click();
  await expect(hud(page)).toContainText('Up Next: “One”');
  await expect(page.locator('#srch'), 'the popover stays open for the next command').toBeVisible();
  const state = async () =>
    (await page.evaluate(() =>
      (window as unknown as { kv: { get(k: string): Promise<unknown> } }).kv.get('library:state'),
    )) as {
      queue: string[];
      playlists: Array<{ name: string; songs: string[] }>;
      kept: Array<{ id: string; title: string }>;
    };
  await expect.poll(async () => (await state()).queue.length).toBe(1);
  const kept = (await state()).kept.find((s) => s.title === 'One');
  expect(kept, 'kept in library:state, so the queue finds it after a reload').toBeDefined();
  expect((await state()).queue).toEqual([kept!.id]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { NP_PLAYER?: { playing?(): boolean } }).NP_PLAYER?.playing?.() ??
        false,
    ),
  ).toBe(false);
  await expect(row('One').locator('.srch__add')).toHaveText('✓');
  // Right-click opens the same menu; Add to Playlist ▸ New Playlist… files the song, answered in the sheet.
  await row('Two').click({ button: 'right', position: { x: 200, y: 10 } });
  await expect(ctx).toBeVisible();
  await expect(ctx.locator('[data-act="cat-next"]')).toHaveText('Add to Up Next');
  await ctx.locator('[data-act="parent"]').click();
  await ctx.locator('.ctx__sub [data-act="cat-new-add"]').click();
  await page.waitForSelector('#sheet[open]');
  await page.fill('#sheetInput', 'Harbour Nights');
  await page.click('#sheetCreate');
  await expect(hud(page)).toContainText('Added to “Harbour Nights”');
  await expect
    .poll(async () => (await state()).playlists.map((p) => p.name))
    .toEqual(['Harbour Nights']);
  const two = (await state()).kept.find((s) => s.title === 'Two')!;
  expect((await state()).playlists[0]!.songs).toEqual([two.id]);
  // The playlist is ticked for that song now, and the other song can be ticked in as well.
  await row('Two').locator('.srch__menu').click();
  await ctx.locator('[data-act="parent"]').click();
  await expect(ctx.locator('.ctx__sub [data-act="cat-toggle"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(ctx).toBeHidden();
  await row('One').locator('.srch__menu').click();
  await ctx.locator('[data-act="parent"]').click();
  await expect(ctx.locator('.ctx__sub [data-act="cat-toggle"]')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await ctx.locator('.ctx__sub [data-act="cat-toggle"]').click();
  await expect(hud(page)).toContainText('Added to “Harbour Nights”');
  await expect.poll(async () => (await state()).playlists[0]!.songs.length).toBe(2);
  // A long press (touch) opens it too; Add to Library is the row's + (so it is "In your library" for One).
  await row('One').locator('.srch__menu').click();
  await expect(ctx.locator('[data-act="cat-lib"]')).toHaveText('In your library');
  await expect(ctx.locator('[data-act="cat-lib"]')).toBeDisabled();
  await page.keyboard.press('Escape');
  const box = (await row('Two').boundingBox())!;
  await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y)!;
      const down = new PointerEvent('pointerdown', {
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        button: 0,
        bubbles: true,
        isPrimary: true,
      });
      el.dispatchEvent(down);
    },
    { x: box.x + 120, y: box.y + box.height / 2 },
  );
  await expect(ctx).toBeVisible({ timeout: 3000 });
  await expect(ctx).toHaveClass(/ctx--touch/);
  await page.evaluate(() =>
    document.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true })),
  );
  // Shift+Enter queues the hot row without the menu.
  await page.keyboard.press('Escape');
  await expect(ctx).toBeHidden();
  await page.focus('#q');
  await page.press('#q', 'ArrowDown');
  await page.press('#q', 'ArrowDown');
  await expect(hot(page)).toHaveText('Two');
  await page.press('#q', 'Shift+Enter');
  await expect(hud(page)).toContainText('Up Next: “Two”');
  await expect.poll(async () => (await state()).queue.length).toBe(2);
});

test('the card is centred under the field at 390, 820 and 1280 px, and never off screen', async ({
  page,
}) => {
  await companion(page, bigCatalog);
  for (const width of [1280, 820, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(150);
    await searchFor(page, 'harbour');
    await expect(page.locator('#srchList .srch__row').first()).toBeVisible();
    const m = await page.evaluate(() => {
      const card = document.getElementById('srch')!.getBoundingClientRect();
      const field = document.getElementById('q')!.getBoundingClientRect();
      return {
        cardLeft: card.left,
        cardRight: card.right,
        cardWidth: card.width,
        cardCx: card.left + card.width / 2,
        fieldCx: field.left + field.width / 2,
        vw: document.documentElement.clientWidth,
      };
    });
    expect(m.vw, 'the viewport took').toBe(width);
    expect(
      Math.abs(m.cardCx - m.fieldCx),
      `centred under the field at ${width}`,
    ).toBeLessThanOrEqual(1.5);
    expect(Math.round(m.cardWidth), `width at ${width}`).toBe(Math.min(560, width - 20));
    expect(m.cardLeft, `on screen (left) at ${width}`).toBeGreaterThanOrEqual(9.5);
    expect(m.cardRight, `on screen (right) at ${width}`).toBeLessThanOrEqual(width - 9.5);
    // Details open inside the same centred card, with Back.
    await page.locator('.srch__sec[aria-label="Songs"] .srch__more').click();
    await expect(page.locator('#srchBack')).toBeVisible();
    const again = await page.evaluate(() => {
      const card = document.getElementById('srch')!.getBoundingClientRect();
      const field = document.getElementById('q')!.getBoundingClientRect();
      return Math.abs(card.left + card.width / 2 - (field.left + field.width / 2));
    });
    expect(again).toBeLessThanOrEqual(1.5);
    await page.press('#q', 'Escape');
    await page.press('#q', 'Escape');
    await expect(page.locator('#srch')).toBeHidden();
  }
});

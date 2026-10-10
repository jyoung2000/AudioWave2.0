/**
 * Discover's "From the catalog" set (NP-DISC-006) and its look-ahead (NP-DISC-007); a visitor's
 * Play (NP-FIND-011) and the player's Download… through the hub (NP-FIND-012).
 *
 * The library is the e2e seed with genres (Alder Quartet is Jazz, Birch Ensemble is Folk) and a play
 * log that leans on Alder Quartet, so the algorithm asks the catalog for "alder quartet" and "jazz".
 * The catalog answers through the companion on this PC (its /helper/v1/catalog/search), through the
 * paired hub, or — with neither — through this browser's own engine against stubbed Apple and Deezer
 * services. Nothing reaches the internet: every service and every preview is answered here.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { boot, CORS, HUB, reload, seed, SEED, silentWav, stubOffline, watchErrors, type SeedTrack } from './_shell';
import { ACCT, COMPANION, done, fulfillStream, hud, json, params, results, src, status, stubServices, track, useCompanion } from './_catalog';

type Row = { id: string; title: string; artist: string; platforms: string[]; why: string; preview: string | null; explored: boolean };
type Online = { state: string; said: string; via: string | null; lookahead: { held: string; reason: string | null; bytes: number; entries: number } | null; rows: Row[] };
type Win = {
  NP_DISCOVER: { ids(): string[] | null; online(): Online };
  NP_PLAYER: { playing(): boolean; trackId(): string | null };
  LIBRARY: Array<{ id: string; title: string; local?: boolean }>;
  kv: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> | void };
};

const GENRED: SeedTrack[] = SEED.map((t) => ({ ...t, seconds: 3, genre: t.artist === 'Alder Quartet' ? 'Jazz' : 'Folk' }));
const OK = status([{ provider: 'deezer', state: 'ok', count: 2 }]);
const clip = (n: string): string => `https://clips.example/${n}.wav`;

/** An Alder Quartet song the device does not have, and a Jazz song by an artist never played. */
const HARBOUR = track('deezer:101', 'Night Harbour', {
  artist: 'Alder Quartet',
  artists: ['Alder Quartet'],
  album: 'Second Light',
  genre: 'Jazz',
  sources: [src('deezer', '101', { previewUrl: clip('101') }), src('youtube', 'yt101', { url: 'https://www.youtube.com/watch?v=yt101' })],
});
const SIGNAL = track('deezer:102', 'Far Signal', {
  artist: 'Cedar Trio',
  artists: ['Cedar Trio'],
  album: 'Open Water',
  genre: 'Jazz',
  sources: [src('deezer', '102', { previewUrl: clip('102') }), src('soundcloud', 'sc102', { url: 'https://soundcloud.com/cedar/far-signal' })],
});
/** A song this device already has (Gantry): the catalog offers it, Discover must not. */
const OWNED = track('deezer:103', 'Gantry', { artist: 'Alder Quartet', artists: ['Alder Quartet'], sources: [src('deezer', '103')] });

let errors: string[];
test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await stubOffline(page);
  await stubServices(page);
});
test.afterEach(() => {
  expect(errors, 'JS errors').toEqual([]);
});

const online = (p: Page) => p.evaluate(() => (window as unknown as Win).NP_DISCOVER.online());
const onlineTitles = (p: Page) => p.$$eval('#libraryRows tr[data-online] .lib-title', (n) => n.map((x) => (x.querySelector('.lib-tname') ?? x).textContent?.trim() ?? ''));
const heading = (p: Page) => p.locator('#libraryRows tr.lib-group');

async function openDiscover(p: Page): Promise<void> {
  await p.click('#libMenuBtn');
  await p.waitForTimeout(250);
  await p.click('#ipodMenu .ipod__item:has-text("Discover")');
  await p.waitForTimeout(300);
}

/** The catalog, answered by query; `asked` records every query in order. */
function catalog(answer: (q: string) => unknown[], asked: string[], delayMs = 0) {
  return async (route: Route): Promise<void> => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const q = params(route).get('q') ?? '';
    asked.push(q);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const tracks = answer(q);
    return fulfillStream(route, [results(0, 'deezer', q, { tracks }, OK), done(1, q, OK, { tracks: false })]);
  };
}

/** Clips answered with decodable audio, readable by the page (CORS), counted. */
async function clips(page: Page): Promise<string[]> {
  const got: string[] = [];
  await page.route('https://clips.example/**', (r) => {
    got.push(r.request().url());
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'audio/wav' }, body: silentWav(30) });
  });
  return got;
}

/** Seed the library, lean the play log on Alder Quartet (well outside the repeat window), reload. */
async function library(page: Page): Promise<void> {
  await boot(page);
  const rows = await seed(page, GENRED);
  const alder = rows.filter((r) => r.artist === 'Alder Quartet').map((r) => r.id);
  await page.evaluate(async (ids) => {
    const now = Date.now();
    const plays = [0, 1, 2, 3, 4].map((i) => ({ id: ids[i % ids.length]!, at: now - (12 + i) * 864e5, via: 'library', secs: 120, dur: 120, end: true }));
    const w = window as unknown as Win;
    const cur = ((await w.kv.get('library:state')) as Record<string, unknown>) ?? {};
    await w.kv.set('library:state', { ...cur, plays });
    await new Promise((r) => setTimeout(r, 300));
  }, alder);
  await reload(page);
}

test.describe('From the catalog (NP-DISC-006)', () => {
  test('an online pick appears under the library’s songs, ranked by the current algorithm, with its platforms and why', async ({ page }) => {
    const asked: string[] = [];
    await page.route(`${COMPANION}/helper/v1/catalog/search?**`, catalog(() => [OWNED, SIGNAL, HARBOUR], asked));
    await clips(page);
    await library(page);
    await useCompanion(page);
    await openDiscover(page);
    await expect(heading(page)).toContainText('From the catalog');
    await expect(heading(page)).toContainText('2 songs ranked by “Airwave default” · For you, through the companion on this PC — not on this device yet: choosing one plays its preview');
    expect([...asked].sort(), 'the queries come from the play log: the artist played and the genre played').toEqual(['alder quartet', 'jazz']);
    expect(await onlineTitles(page), 'the artist you play leads; what the device already has is not offered').toEqual(['Night Harbour', 'Far Signal']);
    expect((await page.evaluate(() => (window as unknown as Win).NP_DISCOVER.ids()))!.length, 'the library’s eight songs are still the ranked list above').toBe(8);
    const first = page.locator('#libraryRows tr[data-online]').first();
    await expect(first.locator('.lib-badge'), 'every platform it is on, as badges').toHaveText(['DZ', 'YT']);
    await expect(first.locator('.lib-pfs'), 'named in full').toHaveAttribute('title', 'On Deezer, YouTube');
    await expect(first.locator('.lib-col-artist'), 'the credit line').toHaveText('Alder Quartet');
    const rows = (await online(page)).rows;
    expect(rows[0]!.why, 'why: the factor that put it there, and where it was found').toMatch(/^Because of (an artist|the tempo and genre|a genre) you play · found on YouTube — not on this device yet$/);
    expect(await first.getAttribute('title')).toBe(rows[0]!.why);
    // The same algorithm, another mode: Crate digger (Deep cuts) leaves out every artist you know, so it asks genres only.
    asked.length = 0;
    await page.click('#libAlgoChip');
    await page.waitForTimeout(300);
    await page.click('#ctx [data-act="algo-pick"][data-id="crate-digger"]');
    await expect(heading(page)).toContainText('1 song ranked by “Crate digger” · Deep cuts');
    expect(asked, 'Deep cuts asks for genres, not for the artists it would cut').toEqual(['jazz']);
    expect(await onlineTitles(page)).toEqual(['Far Signal']);
  });

  test('its row menu adds it to the library, Up Next or a playlist; Download… opens the fetch sheet', async ({ page }) => {
    await page.route(`${COMPANION}/helper/v1/catalog/search?**`, catalog(() => [HARBOUR, SIGNAL], []));
    await clips(page);
    await library(page);
    await useCompanion(page);
    await openDiscover(page);
    const pick = page.locator('#libraryRows tr[data-online]:has-text("Far Signal")');
    await expect(pick).toBeVisible();
    await pick.click({ button: 'right', position: { x: 200, y: 8 } });
    const items = await page.$$eval('#ctx > .ctx__item', (n) => n.map((x) => (x.childNodes[0]?.textContent ?? '').trim()));
    expect(items).toEqual(['Add to Up Next', 'Add to Playlist', 'Add to Library', 'Download…', 'Audition']);
    await page.click('#ctx [data-act="cat-lib"]');
    await expect(hud(page)).toContainText('Added “Far Signal” to your library');
    expect(await page.evaluate(() => (window as unknown as Win).LIBRARY.some((r) => r.title === 'Far Signal'))).toBe(true);
    await pick.click({ button: 'right', position: { x: 200, y: 8 } });
    await expect(page.locator('#ctx [data-act="cat-lib"]')).toHaveText('In your library');
    await page.click('#ctx [data-act="cat-next"]');
    await expect(hud(page)).toContainText('Up Next: “Far Signal”');
    const queued = await page.evaluate(async () => {
      const w = window as unknown as Win;
      const st = (await w.kv.get('library:state')) as { queue?: string[] };
      return (st.queue ?? []).map((id) => w.LIBRARY.find((r) => r.id === id)?.title);
    });
    expect(queued).toContain('Far Signal');
    await pick.click({ button: 'right', position: { x: 200, y: 8 } });
    await page.click('#ctx [data-act="cat-download"]');
    await expect(page.locator('#npFetch')).toBeVisible();
    await expect(page.locator('#npFetchMsg')).toContainText('“Far Signal” by Cedar Trio');
    await page.click('#npFetchCancel');
  });

  test('Refresh asks the catalog again and shows what this session has not shown', async ({ page }) => {
    const asked: string[] = [];
    const many = Array.from({ length: 14 }, (_, i) =>
      track(`deezer:2${i}`, `Tide ${String(i + 1).padStart(2, '0')}`, { artist: 'Alder Quartet', artists: ['Alder Quartet'], genre: 'Jazz', sources: [src('deezer', `2${i}`)] }),
    );
    await page.route(`${COMPANION}/helper/v1/catalog/search?**`, catalog(() => many, asked));
    await library(page);
    await useCompanion(page);
    await openDiscover(page);
    await expect(heading(page)).toContainText('12 songs ranked by');
    const first = await onlineTitles(page);
    expect(first).toHaveLength(12);
    const before = asked.length;
    await page.click('#libDiscRefresh');
    await expect(heading(page)).toContainText('2 songs ranked by');
    expect(asked.length, 'Refresh re-asks').toBeGreaterThan(before);
    const second = await onlineTitles(page);
    expect(second.some((t) => first.includes(t)), 'none of the twelve already shown').toBe(false);
  });

  test('offline it says so plainly, and so it does when nothing answers', async ({ page, context }) => {
    await library(page);
    // No companion, no hub, and every service this browser could ask refuses: said, in a sentence.
    await openDiscover(page);
    await expect(heading(page)).toContainText('Couldn’t reach the catalog:');
    await expect(heading(page)).toContainText('Check the connection and refresh.');
    expect((await online(page)).state).toBe('failed');
    await context.setOffline(true);
    await page.click('#libDiscRefresh');
    await expect(heading(page)).toContainText('This device is offline, so the catalog was not asked. Your library’s songs are above.');
    await context.setOffline(false);
    // Switched off in the chip's menu: no heading, no asking.
    await page.click('#libAlgoChip');
    await page.waitForTimeout(300);
    await expect(page.locator('#ctx [data-act="algo-online"]')).toHaveAttribute('aria-checked', 'true');
    await page.click('#ctx [data-act="algo-online"]');
    await expect(heading(page)).toHaveCount(0);
    await expect(hud(page)).toContainText('Discover shows only your library');
  });

  test('with no hub and no companion, this browser’s own engine answers, keylessly', async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubOffline(page);
    await page.route('**/itunes.apple.com/**', (r) => {
      const u = new URL(r.request().url());
      const term = u.searchParams.get('term') ?? '';
      const body =
        u.searchParams.get('entity') === 'song' && term === 'jazz'
          ? { results: [{ wrapperType: 'track', kind: 'song', trackId: 71, trackName: 'Blue Lantern', artistName: 'Cedar Trio', collectionName: 'Open Water', primaryGenreName: 'Jazz', trackViewUrl: 'https://music.apple.com/us/album/x/70?i=71', previewUrl: clip('71'), trackTimeMillis: 200_000 }] }
          : { results: [] };
      return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    });
    await page.route('**/api.deezer.com/**', (r) => {
      const cb = new URL(r.request().url()).searchParams.get('callback') ?? 'cb';
      return r.fulfill({ status: 200, contentType: 'text/javascript', body: `${cb}(${JSON.stringify({ data: [], total: 0 })})` });
    });
    for (const u of ['**/musicbrainz.org/**', '**/lrclib.net/**', '**/coverartarchive.org/**']) await page.route(u, (r) => r.abort());
    await clips(page);
    await library(page);
    await openDiscover(page);
    await expect(heading(page)).toContainText('1 song ranked by “Airwave default” · For you, through this browser');
    expect(await onlineTitles(page)).toEqual(['Blue Lantern']);
    await expect(page.locator('#libraryRows tr[data-online] .lib-badge')).toHaveText(['AM']);
    await expect(page.locator('#libraryRows tr[data-online] .lib-pfs')).toHaveAttribute('title', 'On Apple Music');
  });
});

test.describe('the look-ahead (NP-DISC-007)', () => {
  test('asks for the next picks’ previews within its budget, one at a time, and the UI never waits on it', async ({ page }) => {
    const picks = Array.from({ length: 5 }, (_, i) =>
      track(`deezer:3${i}`, `Lamp ${i + 1}`, { artist: 'Alder Quartet', artists: ['Alder Quartet'], genre: 'Jazz', sources: [src('deezer', `3${i}`, { previewUrl: clip(`3${i}`) })] }),
    );
    // The catalog is slow: Discover's own rows and its controls answer meanwhile.
    await page.route(`${COMPANION}/helper/v1/catalog/search?**`, catalog(() => picks, [], 2500));
    const got = await clips(page);
    await library(page);
    await useCompanion(page);
    await openDiscover(page);
    await expect(heading(page)).toContainText('Asking the catalog');
    const t0 = Date.now();
    await page.click('#libAlgoChip');
    await expect(page.locator('#ctx')).toBeVisible();
    expect(Date.now() - t0, 'the chip’s menu opens while the catalog is still being asked').toBeLessThan(1500);
    await page.keyboard.press('Escape');
    await expect(heading(page)).toContainText('5 songs ranked by', { timeout: 15_000 });
    await expect.poll(async () => (await online(page)).lookahead?.entries, { message: 'two previews held ahead' }).toBe(2);
    await page.waitForTimeout(1500);
    const now = await online(page);
    const la = now.lookahead!;
    expect([...got].sort(), 'exactly the two best picks’ clips were asked for, and no more').toEqual(now.rows.slice(0, 2).map((r) => r.preview).sort());
    expect(la.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(la.held).toMatch(/^2 previews are ready ahead \(\d\.\d MB of 4\.0 MB\)\.$/);
    expect(la.reason).toBe('2 previews are ready ahead');
    // Played, the first leaves the ring and the next one is asked for.
    await page.locator('#libraryRows tr[data-online]').first().click();
    await expect.poll(() => got.length).toBe(3);
  });
});

test.describe('a visitor plays (NP-FIND-011)', () => {
  // Real audio, a fetch that lands and a file indexed: more than the default minute on a busy machine.
  test.describe.configure({ timeout: 120_000 });
  test('with nothing to fetch it, its preview plays, said as one, and nothing is logged as a play', async ({ page }) => {
    await page.route(`${COMPANION}/helper/v1/catalog/search?**`, catalog(() => [HARBOUR], []));
    await clips(page);
    await library(page);
    await useCompanion(page);
    await openDiscover(page);
    const pick = page.locator('#libraryRows tr[data-online]').first();
    await expect(pick).toBeVisible();
    const playsBefore = await page.evaluate(async () => (((await (window as unknown as Win).kv.get('library:state')) as { plays?: unknown[] }).plays ?? []).length);
    await pick.click();
    await expect(page.locator('#playerPreview')).toBeVisible();
    await expect(page.locator('#playerPreview')).toHaveText('Preview · 30 seconds — not the whole song');
    await expect(hud(page)).toContainText('Preview — 30 seconds of “Night Harbour”. The whole song needs fetching, and fetching it needs the hub');
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).NP_PLAYER.playing())).toBe(true);
    await expect(page.locator('#npFetch')).toHaveCount(0);
    const playsAfter = await page.evaluate(async () => (((await (window as unknown as Win).kv.get('library:state')) as { plays?: unknown[] }).plays ?? []).length);
    expect(playsAfter, 'a preview is not a play of the song').toBe(playsBefore);
  });

  test('with no preview and nothing to fetch it, it says what is needed instead of pretending', async ({ page }) => {
    const bare = track('deezer:104', 'Quiet Pier', { artist: 'Alder Quartet', artists: ['Alder Quartet'], genre: 'Jazz', sources: [src('deezer', '104')] });
    await page.route(`${COMPANION}/helper/v1/catalog/search?**`, catalog(() => [bare], []));
    await library(page);
    await useCompanion(page);
    await openDiscover(page);
    await page.locator('#libraryRows tr[data-online]').first().click();
    await expect(hud(page)).toContainText('Nothing can play “Quiet Pier” here: it has no preview, and fetching it needs the hub (paired, with downloads allowed for this device) or the companion app on this PC.');
    await expect(page.locator('#playerPreview')).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).NP_PLAYER.playing())).toBe(false);
  });

  test('with a hub, Play asks the hub to fetch it: the preview meanwhile, “Fetching… N%” on the row, then the song itself (NP-FIND-012)', async ({ page }) => {
    const JOB = '00000000-0000-4000-8000-000000000123';
    const HASH = 'a'.repeat(64);
    const posted: Array<Record<string, unknown>> = [];
    // The job runs at 40% until the test has seen the row say so; then it completes.
    let landed = false;
    await page.route(`${HUB}/api/v1/**`, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/catalog/search') return catalog(() => [HARBOUR], [])(route);
      if (path === '/api/v1/catalog/download') {
        posted.push(route.request().postDataJSON() as Record<string, unknown>);
        return route.fulfill(json({ job: { id: JOB, state: 'queued', progress: { percent: 0 } }, source: { platform: 'youtube-music', matchedBy: 'search' }, embedded: { isrc: true, genre: true, label: false, year: false, lyrics: true } }, 201));
      }
      if (path === '/api/v1/downloads') {
        const job = !landed ? { id: JOB, state: 'running', progress: { percent: 40 } } : { id: JOB, state: 'completed', checksumSha256: HASH, progress: { percent: 100 } };
        return route.fulfill(json({ items: [job] }));
      }
      if (path === `/api/v1/files/${HASH}`) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: silentWav(20) });
      return route.fulfill(json({ title: 'Not here' }, 404));
    });
    await clips(page);
    await library(page);
    await page.evaluate(async (a) => {
      await (window as unknown as Win).kv.set('player:hub', a);
    }, { ...ACCT, scopes: ['search:use', 'downloads:request', 'transfers:receive'] });
    await openDiscover(page);
    await expect(heading(page)).toContainText('through the hub TOWER');
    const pick = page.locator('#libraryRows tr[data-online]').first();
    await pick.click();
    await expect(page.locator('#playerPreview')).toBeVisible();
    await expect(page.locator('#npFetch')).toBeVisible();
    await expect(page.locator('#npFetchMsg')).toContainText('“Night Harbour” by Alder Quartet (2019-05-03) — fetched by the hub TOWER from the best source it has for it');
    await expect(page.locator('#npFetchMsg')).toContainText('Its 30-second preview plays meanwhile.');
    await page.click('#npFetchGo');
    await expect(page.locator('#npFetchState')).toHaveText('Say why you may have this file first.');
    await page.check('input[name="npBasis"][value="purchased-export"]');
    await page.click('#npFetchGo');
    await expect(page.locator('#npFetchState')).toContainText('Queued from YouTube Music. Tagged with ISRC, genre and lyrics.');
    expect((posted[0]!['track'] as { title: string }).title).toBe('Night Harbour');
    expect(posted[0]!['authorization']).toEqual({ basis: 'purchased-export', acknowledged: true });
    expect(posted[0]!['target']).toEqual({ destination: 'player', format: 'original' });
    await expect(page.locator('#npFetchCancel')).toHaveText('Close');
    await page.click('#npFetchCancel');
    await expect(pick.locator('.lib-state')).toHaveText('Fetching… 40%');
    await expect(page.locator('#playerPreview')).toContainText('Fetching… 40%');
    landed = true;
    // Landed: a real track in the library, playing, and no longer a preview.
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).LIBRARY.some((r) => r.local && /Night Harbour/.test(r.title))), { timeout: 20_000 }).toBe(true);
    await expect(hud(page)).toContainText('Fetched — “Night Harbour” is in your library');
    await expect(page.locator('#playerPreview')).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => { const w = window as unknown as Win; const id = w.NP_PLAYER.trackId(); return !!w.LIBRARY.find((r) => r.id === id && r.local); }))
      .toBe(true);
  });

  test('paired without downloads allowed, Download… says why and claims nothing', async ({ page }) => {
    await page.route(`${HUB}/api/v1/**`, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (new URL(route.request().url()).pathname === '/api/v1/catalog/search') return catalog(() => [SIGNAL], [])(route);
      return route.fulfill(json({ title: 'Not here' }, 404));
    });
    await library(page);
    await page.evaluate(async (a) => {
      await (window as unknown as Win).kv.set('player:hub', a);
    }, ACCT);
    await openDiscover(page);
    const pick = page.locator('#libraryRows tr[data-online]').first();
    await expect(pick).toBeVisible();
    await pick.locator('.lib-dl').click();
    await expect(page.locator('#npFetch')).toBeVisible();
    await expect(page.locator('#npFetchState')).toHaveText('Nothing can fetch it here: the hub TOWER has not allowed this device to ask for downloads, and no companion app is answering on this PC — fetching it needs the hub (paired, with downloads allowed for this device) or the companion app on this PC.');
    await page.check('input[name="npBasis"][value="user-owned"]');
    await page.click('#npFetchGo');
    await expect(page.locator('#npFetchState')).toContainText('Nothing can fetch it here:');
    await page.click('#npFetchCancel');
  });
});

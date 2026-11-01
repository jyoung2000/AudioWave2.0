/**
 * The song on the air (NP-RADIO-001) and keeping it (NP-RADIO-002).
 *
 * The title comes from whoever can read it, in a fixed order: a station's own published feed, then
 * whoever is paired (the companion's helper here, stubbed on 127.0.0.1:17999, or the container),
 * then the stream's own in-band ICY metadata where the station's CORS admits this page, then the
 * Icecast status page. The station used, WFMT, publishes no feed of its own, so nothing but those
 * later routes can name its song. Streams answer with decodable silence, and the directory is
 * unreachable, so the bundled shelf answers.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, CORS, HUB, silentWav, watchErrors } from './_shell';
import { done, fulfillStream, results, src, status, track } from './_catalog';

const COMPANION = 'http://127.0.0.1:17999';
const ON_AIR = { raw: 'Air Artist - Air Song', artist: 'Air Artist', title: 'Air Song', station: 'WFMT', reason: null };
const ACCT = { base: HUB, credentialId: '00000000-0000-4000-8000-0000000000aa', secret: 'x'.repeat(40), scopes: ['search:use', 'group:member'], hubName: 'TOWER', deviceId: 'd1' };
let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await page.route((u) => /^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1' && !/radio-browser\.info/i.test(u.href),
    (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }));
  await page.route(/radio-browser\.info/i, (r) => r.abort());
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

async function companionReads(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route(`${COMPANION}/helper/v1/radio/now-playing**`, (r) => {
    asked.push(new URL(r.request().url()).searchParams.get('url') ?? '');
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(ON_AIR) });
  });
  return asked;
}

async function tuneWfmt(page: Page): Promise<void> {
  await page.click('.tb__btn[data-view="radio"]');
  await expect(page.locator('#libScopeLabel')).toHaveText('Chicago', { timeout: 15_000 });
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WFMT' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  // One click, on the row itself rather than on a point of the screen: a station tunes on a single
  // click, and on a slow machine the list re-sorts while its now-playing feeds land, so a
  // double-click's second click (and any click at a stale position) tuned a neighbouring station.
  await row.dispatchEvent('click');
  await expect(row).toHaveClass(/is-playing/, { timeout: 10_000 });
}

const stationRow = (page: Page) => page.locator('#radioMenu .rlist tbody tr', { hasText: 'WFMT' });
const menuItems = (page: Page) => page.$$eval('#ctx > .ctx__item', (n) => n.map((x) => { const sub = x.querySelector('.ctx__sub'); return (sub ? x.textContent!.replace(sub.textContent!, '') : x.textContent!).trim(); }));
const state = (page: Page) => page.evaluate(() => (window as unknown as { kv: { get(k: string): Promise<unknown> } }).kv.get('library:state')) as Promise<{ queue: string[]; kept: Array<{ id: string; title: string; artist: string }>; playlists: Array<{ name: string; songs: string[] }> }>;

test('a station with no feed shows the song its stream carries, read by the companion', async ({ page }) => {
  const asked = await companionReads(page);
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await tuneWfmt(page);
  await expect(page.locator('.player__title')).toHaveText('Air Song', { timeout: 10_000 });
  await expect(stationRow(page).locator('.rlist-song')).toHaveText('Air Song');
  await expect(stationRow(page).locator('.rlist-artist')).toHaveText('Air Artist');
  expect(asked.some((u) => /wfmt\.streamguys1\.com/.test(u)), JSON.stringify(asked)).toBe(true);
});

/* The stream names the song in band to anyone whose CORS it admits, and the page can read it with
   no PC in the path at all. Measured against the Illinois shelf the directory lists: 43 of 109
   stations answer `Access-Control-Allow-Origin: *`, expose `icy-metaint` and carry a real
   `StreamTitle`. Nexus Radio is the first row of the Chicago shelf, publishes
   `Kungs x Boys Noize - Get Away` in band, and read "Song not available" for a whole watched
   quarter hour because nobody had asked the stream.

   The reader is last and conditional on purpose, so the two drills that matter are: it answers when
   nothing else did, and it never displaces something that did. */
/** A stream that carries ICY metadata: `step` audio bytes, a length in sixteens, then the block. */
function icyStream(step: number, block: string): Buffer {
  const body = Buffer.from(block, 'utf8');
  const sixteens = Math.ceil(body.length / 16);
  const out = Buffer.alloc(step + 1 + sixteens * 16, 0x55);
  out[step] = sixteens;
  body.copy(out, step + 1);
  out.fill(0, step + 1 + body.length);
  return out;
}

test('with nothing paired, the station names its own song straight to the page', async ({ page }) => {
  const stations = [{ stationuuid: 'icy-1', name: 'In Band FM', url_resolved: 'https://radio.example/inband', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 }];
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stations) }));
  /* No Companion and no Hub: this is the unpaired listener, who had been shown nothing. */
  let icyReads = 0;
  await page.route(/radio\.example\/inband/, (r) => {
    icyReads += 1;
    return r.fulfill({
      status: 200,
      headers: { ...CORS, 'access-control-expose-headers': 'icy-metaint,icy-br,icy-genre,icy-name',
                 'content-type': 'audio/mpeg', 'icy-metaint': '4096', 'icy-genre': 'Electronic Dance', 'icy-br': '128' },
      body: icyStream(4096, "StreamTitle='Kungs x Boys Noize - Get Away ';StreamUrl='';"),
    });
  });
  await boot(page);
  await page.click('.tb__btn[data-view="radio"]');
  await expect(page.locator('#libScopeLabel')).toHaveText('Chicago', { timeout: 15_000 });
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'In Band FM' });
  await expect(row.locator('.rlist-song')).toHaveText('Get Away', { timeout: 25_000 });
  await expect(row.locator('.rlist-artist')).toHaveText('Kungs x Boys Noize');
  // The stream also states its own genre and bitrate, which the directory left empty.
  await expect(row.locator('.rlist-genre')).toHaveText('Electronic Dance');
  expect(icyReads, 'the stream was actually asked').toBeGreaterThan(0);
});

test('a paired reader still wins: the stream is only asked when nobody else answered', async ({ page }) => {
  /* The in-band read is a fallback, not a replacement. A Companion that names the song must be
     what the listener sees, and the station must not be opened a second time to contradict it. */
  const stations = [
    { stationuuid: 'ord-1', name: 'Answered FM', url_resolved: 'https://radio.example/answered', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 },
    { stationuuid: 'ord-2', name: 'Silent FM', url_resolved: 'https://radio.example/silent', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 },
  ];
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stations) }));
  await page.route(`${COMPANION}/helper/v1/radio/now-playing**`, (r) => {
    const u = new URL(r.request().url()).searchParams.get('url') ?? '';
    const body = /answered/.test(u)
      ? { raw: 'Companion Artist - Companion Song', artist: 'Companion Artist', title: 'Companion Song', station: 'Answered FM', reason: null }
      : { raw: null, artist: null, title: null, station: null, programme: null, programmeSource: null, reason: 'The station sent no song title' };
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  /* Both streams would gladly name a different song if asked. Only the one the Companion could
     not read should ever be opened. */
  const opened: string[] = [];
  for (const [path, song] of [['answered', 'In Band Song'], ['silent', 'Rescued Song']] as const) {
    await page.route(new RegExp(`radio\\.example/${path}`), (r) => {
      opened.push(path);
      return r.fulfill({
        status: 200,
        headers: { ...CORS, 'access-control-expose-headers': 'icy-metaint', 'content-type': 'audio/mpeg', 'icy-metaint': '4096' },
        body: icyStream(4096, `StreamTitle='In Band Artist - ${song}';`),
      });
    });
  }
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await page.click('.tb__btn[data-view="radio"]');
  await expect(page.locator('#libScopeLabel')).toHaveText('Chicago', { timeout: 15_000 });

  const answered = page.locator('#radioMenu .rlist tbody tr', { hasText: 'Answered FM' });
  const silent = page.locator('#radioMenu .rlist tbody tr', { hasText: 'Silent FM' });
  // The station the Companion could not read is rescued by its own stream.
  await expect(silent.locator('.rlist-song')).toHaveText('Rescued Song', { timeout: 25_000 });
  // The station it could read keeps the Companion's answer, unchanged.
  await expect(answered.locator('.rlist-song')).toHaveText('Companion Song');
  await expect(answered.locator('.rlist-artist')).toHaveText('Companion Artist');
  expect(opened.includes('silent'), 'the unread station was asked itself').toBe(true);
  expect(opened.includes('answered'), 'the answered station was not opened to second-guess the Companion').toBe(false);
});

test('every station in the list shows what is on the air, never its genre', async ({ page }) => {
  // The Companion names a song for WFMT only; every other stream it reads has none right now.
  const asked: string[] = [];
  await page.route(`${COMPANION}/helper/v1/radio/now-playing**`, (r) => {
    const u = new URL(r.request().url()).searchParams.get('url') ?? '';
    asked.push(u);
    const body = /wfmt/.test(u) ? ON_AIR : { raw: null, artist: null, title: null, station: null, programme: null, programmeSource: null, reason: 'The station sent no song title' };
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await page.click('.tb__btn[data-view="radio"]');
  await expect(page.locator('#libScopeLabel')).toHaveText('Chicago', { timeout: 15_000 });
  // Nothing tuned: the list itself asks, and the song lands in the WFMT row.
  await expect(stationRow(page).first().locator('.rlist-song')).toHaveText('Air Song', { timeout: 20_000 });
  await expect(stationRow(page).first().locator('.rlist-artist')).toHaveText('Air Artist');
  await expect(stationRow(page).first().locator('.rlist-song')).toHaveAttribute('title', 'Air Song');
  // A genre is useful context, but must have its own column rather than masquerade as a song.
  await expect(page.locator('#radioMenu .rlist thead th')).toContainText(['On air', 'Station', 'Song', 'Artist', 'Genre', 'Kbps', 'Where']);
  const wgci = page.locator('#radioMenu .rlist tbody tr', { hasText: '107.5 WGCI' });
  await expect(wgci.locator('.rlist-genre')).toHaveText('Urban contemporary');
  await expect(stationRow(page).first().locator('.rlist-genre')).toHaveText('Classical');
  expect(new Set(asked).size, 'stations without a feed of their own are read too').toBeGreaterThan(3);
  await expect.poll(async () => {
    const rows = await page.$$eval('#radioMenu .rlist tbody tr', (rs) => rs.map((r) => ({ tags: '', song: (r.querySelector('.rlist-song')?.textContent ?? '').trim() })));
    return rows.filter((r) => /^(Jazz|Classical|Gospel|Pop|Rock|Oldies|Charts|Audio drama|Live broadcast|Urban contemporary|Classic hits)$/i.test(r.song)).map((r) => r.song);
  }, { timeout: 10_000, message: 'a genre is never shown as the song' }).toEqual([]);
});

test('Genre remains reachable on narrow screens without collapsing Song', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await page.click('.tb__btn[data-view="radio"]');
  await expect(page.locator('#radioMenu .rlist tbody tr').first()).toBeVisible({ timeout: 15_000 });
  const size = await page.locator('#radioMenu .ipod__list').evaluate((list) => ({ client: list.clientWidth, scroll: list.scrollWidth }));
  expect(size.scroll, 'radio table scrolls horizontally at phone width').toBeGreaterThan(size.client);
  await page.locator('#radioMenu .ipod__list').evaluate((list) => { list.scrollLeft = list.scrollWidth; });
  const genre = page.locator('#radioMenu .rlist thead th.rlist-genre');
  await expect(genre).toBeVisible();
  const box = await genre.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(page.locator('#radioMenu .rlist tbody tr', { hasText: '107.5 WGCI' }).locator('.rlist-genre')).toHaveText('Urban contemporary');
});

test('station lists longer than forty read the last station with bounded concurrency', async ({ page }) => {
  const stations = Array.from({ length: 45 }, (_, i) => ({
    stationuuid: `radio-${String(i).padStart(3, '0')}`,
    name: `Station ${String(i).padStart(3, '0')}`,
    url_resolved: `https://radio.example/live/${String(i).padStart(3, '0')}`,
    state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: i === 0 ? 'chicago,jazz' : 'jazz',
  }));
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stations) }));
  const asked: string[] = [];
  let active = 0, maxActive = 0;
  await page.route(`${COMPANION}/helper/v1/radio/now-playing**`, async (r) => {
    const url = new URL(r.request().url()).searchParams.get('url') ?? '';
    asked.push(url);
    active++; maxActive = Math.max(active, maxActive);
    await new Promise((resolve) => setTimeout(resolve, 80));
    active--;
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({
      title: `Live ${url.slice(-3)}`, artist: 'Test Artist', programme: null, programmeSource: null,
    }) });
  });
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await page.click('.tb__btn[data-view="radio"]');
  await expect(page.locator('#radioMenu .rlist tbody tr')).toHaveCount(45, { timeout: 15_000 });
  const last = page.locator('#radioMenu .rlist tbody tr', { hasText: 'Station 044' });
  await expect(last.locator('.rlist-song')).toHaveText('Live 044', { timeout: 25_000 });
  expect(asked).toContain('https://radio.example/live/044');
  /* Bounded, and the bound is eight. Forty-five rows four abreast is a pass a listener watches
     crawl; the reads are waiting on other people's servers, not on the page, so the limit exists to
     stop the list queueing behind itself and starving everything else the page asks the Hub for --
     not because eight is too many. Measured through the real paired path: eight concurrent reads of
     live iHeart stations returned 8/8 in 1.97s with no slow read, no error and no Hub fault. What
     this test is really for is the last station still being reached (Station 044 above), which is
     what broke when a silent station could hold a slot open for ever. */
  expect(maxActive).toBeLessThanOrEqual(8);
  expect(maxActive).toBeGreaterThan(1);
  await expect(page.locator('#radioMenu .rlist tbody tr', { hasText: 'Station 000' }).locator('.rlist-song')).toHaveText('Live 000');
  await expect(page.locator('#radioMenu .rlist tbody tr', { hasText: 'Station 000' }).locator('.rlist-genre')).toHaveText('Jazz');
});

test('a station the directory describes thinly fills Genre and Kbps from its stream', async ({ page }) => {
  // radio-browser often carries no tags and bitrate 0 (every iHeart station, for one). The stream
  // itself announces icy-genre/icy-br, which only the Hub or Companion can read for the page.
  const stations = [
    { stationuuid: 'thin-1', name: 'Thin Station', url_resolved: 'https://radio.example/thin', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 },
    { stationuuid: 'vague-1', name: 'Vague Station', url_resolved: 'https://radio.example/vague', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 },
  ];
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stations) }));
  await page.route(`${COMPANION}/helper/v1/radio/now-playing**`, (r) => {
    const url = new URL(r.request().url()).searchParams.get('url') ?? '';
    // "Various" is what a stream says when it is saying nothing; it is not a genre.
    const body = /vague/.test(url)
      ? { raw: null, artist: null, title: null, station: 'Vague', genre: 'Various', bitrate: null, reason: 'The station sent no song title' }
      : { raw: null, artist: null, title: null, station: 'Thin', genre: 'College', bitrate: 56, reason: 'The station sent no song title' };
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await page.click('.tb__btn[data-view="radio"]');
  const thin = page.locator('#radioMenu .rlist tbody tr', { hasText: 'Thin Station' });
  await expect(thin.locator('.rlist-genre')).toHaveText('College', { timeout: 20_000 });
  await expect(thin.locator('.lib-col-bpm')).toHaveText('56');
  const vague = page.locator('#radioMenu .rlist tbody tr', { hasText: 'Vague Station' });
  await expect(vague.locator('.rlist-genre')).toHaveText('—');
  await expect(vague.locator('.lib-col-bpm')).toHaveText('—');
});

/* The Song and Artist columns are a live reading, not a one-time fill: a station changes song every
   few minutes, so a list left open must keep up with it. Two ways the refresh used to die for good
   are pinned here, because both left the columns frozen with no sign anything was wrong. */
test('a paired AWSP companion keeps the stream Genre and Kbps in separate columns', async ({ page }) => {
  const stations = [{ stationuuid: 'awsp-1', name: 'College Station', url_resolved: 'https://radio.example/college', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 }];
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stations) }));
  await boot(page);
  await page.evaluate(() => {
    (window as unknown as { NP_AWSP_READY: Promise<unknown> }).NP_AWSP_READY = Promise.resolve({
      status: async () => ({ paired: true, status: 'connected' }),
      companion: async () => ({ title: null, artist: null, genre: 'College', bitrate: 56, reason: 'The station sent no song title' }),
    });
  });
  await page.click('.tb__btn[data-view="radio"]');
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'College Station' });
  await expect(row.locator('.rlist-genre')).toHaveText('College', { timeout: 20_000 });
  await expect(row.locator('.lib-col-bpm')).toHaveText('56');
  await expect(row.locator('.rlist-song')).toBeEmpty();
});

test('a station with its own song feed still fills Genre from the stream', async ({ page }) => {
  // WMBI publishes songs through Triton, so the page never needed the Hub for its Song column —
  // but the directory carries no tags for it, and only the Hub can read the stream's icy-genre.
  const stations = [
    { stationuuid: 'feed-1', name: 'Feed Station', url_resolved: 'https://14123.live.streamtheworld.com/FEEDFM.mp3', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 },
  ];
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stations) }));
  await page.route(/np\.tritondigital\.com\/public\/nowplaying\?.*/i, (r) => r.fulfill({
    status: 200, headers: { ...CORS, 'content-type': 'text/xml' },
    body: '<?xml version="1.0" encoding="UTF-8"?><nowplaying-info-list><nowplaying-info mountName="FEEDFM" type="track"><property name="cue_title"><![CDATA[Feed Song]]></property><property name="track_artist_name"><![CDATA[Feed Artist]]></property></nowplaying-info></nowplaying-info-list>',
  }));
  let askedAbout = 0;
  await page.route(`${COMPANION}/helper/v1/radio/now-playing**`, (r) => {
    askedAbout++;
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({
      raw: null, artist: null, title: null, station: 'Feed', genre: 'Christian', bitrate: 96, reason: 'The station sent no song title',
    }) });
  });
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await page.click('.tb__btn[data-view="radio"]');
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'Feed Station' });
  await expect(row.locator('.rlist-song')).toHaveText('Feed Song', { timeout: 20_000 });
  await expect(row.locator('.rlist-genre')).toHaveText('Christian', { timeout: 20_000 });
  await expect(row.locator('.lib-col-bpm')).toHaveText('96');
  expect(askedAbout, 'the stream is asked about itself, not polled for it').toBeLessThanOrEqual(2);
});

test('with no companion and no container, a station without a feed invents nothing', async ({ page }) => {
  await boot(page);
  await tuneWfmt(page);
  await page.waitForTimeout(1500);
  await expect(page.locator('.player__title')).toHaveText('Song not available');
  await expect(page.locator('.player__title')).not.toHaveText('Classical');
  await stationRow(page).click({ button: 'right', position: { x: 120, y: 8 } });
  expect(await menuItems(page), 'no song, so nothing to keep').not.toContain('Add Song to Up Next');
});

test('right-click keeps the song: Up Next, a new playlist, and it survives a reload', async ({ page }) => {
  await companionReads(page);
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await tuneWfmt(page);
  await expect(page.locator('.player__title')).toHaveText('Air Song', { timeout: 10_000 });
  // One connected platform found the exact recording with a fetchable source, not merely a
  // same-titled store listing. Its URL and provenance must survive queueing and reload.
  await page.evaluate(() => { (window as unknown as { NP_FIND: (q: string) => Promise<unknown[]> }).NP_FIND = async () => [
    { t: 'Air Song', a: 'Air Artist', al: 'Air Album', p: 'Apple Music', u: 'https://music.apple.com/song/42', fetchable: false },
    { t: 'Air Song', a: 'Air Artist', al: 'Air Album', d: 212, p: 'YouTube Music',
      u: 'https://music.youtube.com/watch?v=air-song-123', fetchable: true },
  ]; });

  await stationRow(page).click({ button: 'right', position: { x: 120, y: 8 } });
  await expect(page.locator('#ctx .ctx__head')).toHaveText('On air: Air Artist — Air Song');
  const items = await menuItems(page);
  expect(items, JSON.stringify(items)).toEqual(expect.arrayContaining(['Add Song to Up Next', 'Add Song to Group Queue', 'Add Song to Playlist', 'Add to Favourites']));
  await expect(page.locator('#ctx button', { hasText: 'Add Song to Group Queue' })).toBeDisabled();
  await page.click('#ctx [data-act="ls-air-next"]');
  await expect(page.locator('#toast')).toContainText('Up Next: “Air Song”');
  let s = await state(page);
  const kept = s.kept.find((k) => k.title === 'Air Song');
  expect(kept?.artist).toBe('Air Artist');
  expect(kept).toMatchObject({ album: 'Air Album', platform: 'YouTube Music', url: 'https://music.youtube.com/watch?v=air-song-123' });
  expect(s.queue).toContain(kept!.id);

  await stationRow(page).click({ button: 'right', position: { x: 120, y: 8 } });
  await page.locator('#ctx .ctx__item--parent', { hasText: 'Add Song to Playlist' }).click();
  await page.click('#ctx [data-act="ls-air-new"]');
  await page.waitForSelector('#sheet[open]', { timeout: 3000 });
  await page.fill('#sheetInput', 'Heard on WFMT');
  await page.click('#sheetCreate');
  await expect(page.locator('#toast')).toContainText('Added to “Heard on WFMT”');
  s = await state(page);
  expect(s.playlists.find((p) => p.name === 'Heard on WFMT')?.songs).toEqual([kept!.id]);
  expect(s.kept.filter((k) => k.title === 'Air Song'), 'the same song, not a second copy').toHaveLength(1);

  await page.goto('about:blank');
  await boot(page);
  s = await state(page);
  expect(s.kept.map((k) => k.id), 'kept across a reload').toContain(kept!.id);
});

test('the paired companion catalog supplies a fetchable recording to the radio queue', async ({ page }) => {
  const asked: string[] = [];
  await companionReads(page);
  await page.route(`${COMPANION}/helper/v1/catalog/search?**`, async (r) => {
    const q = new URL(r.request().url()).searchParams.get('q') ?? '';
    asked.push(q);
    const song = track('deezer:901', 'Air Song', { artist: 'Air Artist', artists: ['Air Artist'], album: 'Air Album',
      sources: [src('deezer', '901', { url: 'https://www.deezer.com/track/901' }),
        src('soundcloud', 'air-song', { url: 'https://soundcloud.com/air-artist/air-song' })],
    });
    const st = status([{ provider: 'deezer', state: 'ok', count: 1 }]);
    await fulfillStream(r, [results(0, 'deezer', q, { tracks: [song] }, st), done(1, q, st, { tracks: false })]);
  });
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await tuneWfmt(page);
  await expect(page.locator('.player__title')).toHaveText('Air Song', { timeout: 10_000 });
  await stationRow(page).click({ button: 'right', position: { x: 120, y: 8 } });
  await page.click('#ctx [data-act="ls-air-next"]');
  await expect(page.locator('#toast')).toContainText('Up Next: “Air Song”', { timeout: 15_000 });
  expect(asked.some((q) => /air artist air song/i.test(q))).toBe(true);
  const s = await state(page);
  const kept = s.kept.find((k) => k.title === 'Air Song');
  expect(kept).toMatchObject({ artist: 'Air Artist', platform: 'SoundCloud', url: 'https://soundcloud.com/air-artist/air-song' });
  expect(s.queue).toContain(kept!.id);
});

test('the paired Hub catalog supplies a fetchable recording to the radio playlist', async ({ page }) => {
  const asked: string[] = [];
  await boot(page);
  await page.evaluate(async (a) => { await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', a); }, ACCT);
  await page.route(`${HUB}/**`, async (r) => {
    const u = new URL(r.request().url());
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    if (u.pathname === '/api/v1/radio/now-playing') return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(ON_AIR) });
    if (u.pathname === '/api/v1/catalog/search') {
      const q = u.searchParams.get('q') ?? '';
      asked.push(q);
      const song = track('deezer:902', 'Air Song', { artist: 'Air Artist', artists: ['Air Artist'], album: 'Air Album',
        sources: [src('deezer', '902'), src('youtube', 'air-902', { url: 'https://www.youtube.com/watch?v=air902' })],
      });
      const st = status([{ provider: 'deezer', state: 'ok', count: 1 }]);
      return fulfillStream(r, [results(0, 'deezer', q, { tracks: [song] }, st), done(1, q, st, { tracks: false })]);
    }
    return r.fulfill({ status: 404, headers: { ...CORS, 'content-type': 'application/json' }, body: '{}' });
  });
  await page.goto('about:blank');
  await boot(page);
  await tuneWfmt(page);
  await expect(page.locator('.player__title')).toHaveText('Air Song', { timeout: 10_000 });
  await stationRow(page).click({ button: 'right', position: { x: 120, y: 8 } });
  await page.locator('#ctx .ctx__item--parent', { hasText: 'Add Song to Playlist' }).click();
  await page.click('#ctx [data-act="ls-air-new"]');
  await page.waitForSelector('#sheet[open]', { timeout: 15_000 });
  await page.fill('#sheetInput', 'From Hub Radio');
  await page.click('#sheetCreate');
  await expect(page.locator('#toast')).toContainText('Added to “From Hub Radio”');
  expect(asked.some((q) => /air artist air song/i.test(q))).toBe(true);
  const s = await state(page);
  const kept = s.kept.find((k) => k.title === 'Air Song');
  expect(kept).toMatchObject({ platform: 'YouTube', url: 'https://www.youtube.com/watch?v=air902' });
  expect(s.playlists.find((p) => p.name === 'From Hub Radio')?.songs).toContain(kept!.id);
});

test('a local copy already on this player can be queued without a catalog answer', async ({ page }) => {
  await companionReads(page);
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await tuneWfmt(page);
  await expect(page.locator('.player__title')).toHaveText('Air Song', { timeout: 10_000 });
  await page.evaluate(() => {
    const w = window as unknown as { LIBRARY: unknown[]; NP_FIND: (q: string) => Promise<unknown[]> };
    w.LIBRARY.push({ id: 'local-air-song', kind: 'music', title: 'Air Song', artist: 'Air Artist', local: true, platform: 'Local' });
    w.NP_FIND = async () => [];
  });
  await stationRow(page).click({ button: 'right', position: { x: 120, y: 8 } });
  await page.click('#ctx [data-act="ls-air-next"]');
  await expect(page.locator('#toast')).toContainText('Up Next: “Air Song”');
  expect((await state(page)).queue).toContain('local-air-song');
});

test('radio menu refuses to queue a song no connected catalog can fetch', async ({ page }) => {
  await companionReads(page);
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await tuneWfmt(page);
  await expect(page.locator('.player__title')).toHaveText('Air Song', { timeout: 10_000 });
  // A plausible title in the broadcast does not prove any connected platform can fetch that track.
  await page.evaluate(() => { (window as unknown as { NP_FIND: (q: string) => Promise<unknown[]> }).NP_FIND = async () => []; });
  const before = await state(page);
  await stationRow(page).click({ button: 'right', position: { x: 120, y: 8 } });
  await page.click('#ctx [data-act="ls-air-next"]');
  await expect(page.locator('#toast')).toContainText('could not find', { timeout: 10_000 });
  const after = await state(page);
  expect(after).toEqual(before);
});

test('a store-only or different-artist match cannot be filed as the radio song', async ({ page }) => {
  await companionReads(page);
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await tuneWfmt(page);
  await expect(page.locator('.player__title')).toHaveText('Air Song', { timeout: 10_000 });
  // A store-only row may already be in the listener's library; it still cannot become a
  // fetchable recording just because a station happens to announce the same title.
  await page.evaluate(() => { (window as unknown as { LIBRARY: unknown[] }).LIBRARY.push({
    id: 'store-only-air-song', kind: 'music', title: 'Air Song', artist: 'Air Artist',
    platform: 'Apple Music', url: 'https://music.apple.com/song/42', duration: 212,
  }); });
  const before = await state(page);
  for (const rows of [
    [{ t: 'Air Song', a: 'Air Artist', p: 'Apple Music', u: 'https://music.apple.com/song/42', fetchable: false }],
    [{ t: 'Air Song', a: 'Air Artist Cover', p: 'YouTube Music', u: 'https://music.youtube.com/watch?v=cover', fetchable: true }],
  ]) {
    await page.evaluate((result) => { (window as unknown as { NP_FIND: (q: string) => Promise<unknown[]> }).NP_FIND = async () => result; }, rows);
    await stationRow(page).click({ button: 'right', position: { x: 120, y: 8 } });
    await page.locator('#ctx .ctx__item--parent', { hasText: 'Add Song to Playlist' }).click();
    await page.click('#ctx [data-act="ls-air-new"]');
    await expect(page.locator('#toast')).toContainText('could not find', { timeout: 10_000 });
    const s = await state(page);
    expect(s).toEqual(before);
    await expect(page.locator('#sheet[open]')).toHaveCount(0);
  }
});

test('paired: the container reads the title, and the song goes to the group’s queue by name', async ({ page }) => {
  const requests: Array<{ path: string; body: unknown }> = [];
  await boot(page);
  await page.evaluate(async (a) => { await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', a); }, ACCT);
  await page.route(`${HUB}/**`, async (r) => {
    const u = new URL(r.request().url());
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    const json = (body: unknown) => r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (u.pathname === '/api/v1/radio/now-playing') return json(ON_AIR);
    if (u.pathname === '/api/v1/groups' && r.request().method() === 'GET') return json({ items: [{ id: 'g-1', name: 'Kitchen', status: 'active', myRole: 'member', members: [] }] });
    if (u.pathname === '/api/v1/groups/g-1/requests') {
      requests.push({ path: u.pathname, body: r.request().postDataJSON() });
      return json({ queued: true, title: 'Air Song', artistName: 'Air Artist', position: 2, reason: null });
    }
    return r.fulfill({ status: 404, headers: { ...CORS, 'content-type': 'application/json' }, body: '{}' });
  });
  await page.goto('about:blank');
  await boot(page);
  await tuneWfmt(page);
  await expect(page.locator('.player__title')).toHaveText('Air Song', { timeout: 10_000 });
  await stationRow(page).click({ button: 'right', position: { x: 120, y: 8 } });
  const group = page.locator('#ctx [data-act="ls-air-group"]');
  await expect(group).toHaveText('Add Song to “Kitchen” Queue');
  // Checked above that it is there and says the right thing; clicked as an element, because on a slow
  // runner Playwright's 'not moving' check on an open menu did not settle within the test's minute.
  await group.dispatchEvent('click');
  await expect(page.locator('#toast')).toContainText('Queued “Air Song” — number 2 in the group queue');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.body).toMatchObject({ query: 'Air Artist - Air Song' });
});

test('the paired Hub shows a scheduled programme when there is no song, without offering to save it as one', async ({ page }) => {
  await boot(page);
  await page.evaluate(async (a) => { await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', a); }, ACCT);
  await page.route(`${HUB}/**`, (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    if (new URL(r.request().url()).pathname === '/api/v1/radio/now-playing')
      return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ raw: null, artist: null, title: null, station: 'WFMT', programme: 'The Morning Programme', programmeSource: 'schedule', reason: 'No song metadata' }) });
    return r.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
  await page.goto('about:blank');
  await boot(page);
  await tuneWfmt(page);
  await expect(page.locator('.player__title')).toHaveText('The Morning Programme', { timeout: 10_000 });
  await stationRow(page).click({ button: 'right', position: { x: 120, y: 8 } });
  expect(await menuItems(page)).not.toContain('Add Song to Up Next');
});

test('the Companion shows its guide programme separately from its ICY song', async ({ page }) => {
  await page.route(`${COMPANION}/helper/v1/radio/now-playing**`, (r) => r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ ...ON_AIR, programme: 'Morning Music Hour', programmeSource: 'schedule' }) }));
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await tuneWfmt(page);
  await expect(page.locator('.player__title')).toHaveText('Air Song', { timeout: 10_000 });
  await expect(page.locator('.player__where')).toContainText('Scheduled programme: Morning Music Hour');
});

/* 107.5 WGCI: an iHeart station. Its song comes from iHeart's live track feed; its show from the Hub. */
/* Title and artist are fixed; the airtime window is not. The player drops an iHeart track whose
   window closed more than a minute ago — correctly, because such a track is no longer on the air.
   Freezing `endTime` at module load made this fixture expire partway through a slow run, so the
   drill failed for having taken too long rather than for anything it was testing. The window is
   therefore computed per request, which is also how iHeart actually answers. */
const WGCI_TRACK = { title: 'WTF GOIN (Clean) (feat. 21 Savage)', artist: 'Belly Gang Kushington & 21 Savage' };
const wgciOnAir = () => ({ ...WGCI_TRACK, startTime: Date.now() - 30_000, endTime: Date.now() + 150_000 });
const wgciRow = (page: Page) => page.locator('#radioMenu .rlist tbody tr', { hasText: '107.5 WGCI' });

async function iheartFeed(page: Page, answer: () => { status: number; body: string }): Promise<string[]> {
  const asked: string[] = [];
  await page.route(/us\.api\.iheart\.com\/api\/v3\/live-meta\/stream\/\d+\/currentTrackMeta/, (r) => {
    asked.push(r.request().url());
    const a = answer();
    return r.fulfill({ status: a.status, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: a.body });
  });
  return asked;
}

async function tuneWgci(page: Page): Promise<void> {
  await page.click('.tb__btn[data-view="radio"]');
  await expect(page.locator('#libScopeLabel')).toHaveText('Chicago', { timeout: 15_000 });
  await expect(wgciRow(page)).toBeVisible({ timeout: 15_000 });
  await wgciRow(page).dispatchEvent('click');
  await expect(wgciRow(page)).toHaveClass(/is-playing/, { timeout: 10_000 });
}

test('107.5 WGCI: the station list and the player show the song iHeart says is on the air', async ({ page }) => {
  const asked = await iheartFeed(page, () => ({ status: 200, body: JSON.stringify(wgciOnAir()) }));
  await boot(page);
  await page.click('.tb__btn[data-view="radio"]');
  await expect(page.locator('#libScopeLabel')).toHaveText('Chicago', { timeout: 15_000 });
  await expect(wgciRow(page).locator('.rlist-song')).toHaveText(WGCI_TRACK.title, { timeout: 15_000 });
  await expect(wgciRow(page).locator('.rlist-artist')).toHaveText(WGCI_TRACK.artist);
  expect(asked.some((u) => /\/stream\/841\/currentTrackMeta/.test(u)), JSON.stringify(asked)).toBe(true);
  await tuneWgci(page);
  await expect(page.locator('.player__title')).toHaveText(WGCI_TRACK.title, { timeout: 10_000 });
});

test('107.5 WGCI paired with the Hub: the song from iHeart, the show on the air from the Hub', async ({ page }) => {
  await iheartFeed(page, () => ({ status: 200, body: JSON.stringify(wgciOnAir()) }));
  const hubAsked: string[] = [];
  await boot(page);
  await page.evaluate(async (a) => { await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', a); }, ACCT);
  await page.route(`${HUB}/**`, (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    const u = new URL(r.request().url());
    if (u.pathname === '/api/v1/radio/now-playing') {
      hubAsked.push(u.searchParams.get('url') ?? '');
      return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ raw: 'x', artist: 'Belly Gang Kushington / 21 Savage', title: 'Wtf Goin', station: 'WGCI-FM', programme: 'Jamal Smallz', programmeSource: 'schedule', reason: null }) });
    }
    return r.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
  await page.goto('about:blank');
  await boot(page);
  await tuneWgci(page);
  await expect(page.locator('.player__title')).toHaveText(WGCI_TRACK.title, { timeout: 10_000 });
  await expect(page.locator('.player__where')).toContainText('Scheduled programme: Jamal Smallz', { timeout: 10_000 });
  expect(hubAsked).toContain('https://stream.revma.ihrhls.com/zc841');
});

test('107.5 WGCI in an ad break: no feed song, so the paired Hub names the show instead of a song', async ({ page }) => {
  await iheartFeed(page, () => ({ status: 204, body: '' }));
  await boot(page);
  await page.evaluate(async (a) => { await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', a); }, ACCT);
  await page.route(`${HUB}/**`, (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    if (new URL(r.request().url()).pathname === '/api/v1/radio/now-playing')
      return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ raw: null, artist: null, title: null, station: 'WGCI-FM', programme: 'Jamal Smallz', programmeSource: 'schedule', reason: 'The station sent no song title' }) });
    return r.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
  await page.goto('about:blank');
  await boot(page);
  await page.evaluate(() => { (window as unknown as { __radioClear: number }).__radioClear = 0;
    document.addEventListener('radio:clear-track', () => { (window as unknown as { __radioClear: number }).__radioClear++; }); });
  await tuneWgci(page);
  await expect(page.locator('.player__title')).toHaveText('Jamal Smallz', { timeout: 10_000 });
  await expect(wgciRow(page).locator('.rlist-song')).toHaveText('Jamal Smallz');
  expect(await page.evaluate(() => (window as unknown as { __radioClear: number }).__radioClear), 'a programme should remain in the tuned station row').toBe(0);
  await wgciRow(page).click({ button: 'right', position: { x: 120, y: 8 } });
  expect(await menuItems(page), 'a show is not a song to keep').not.toContain('Add Song to Up Next');
});

test('touch: a long press on a station opens the same menu, and the lift does not retune', async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, baseURL: 'http://127.0.0.1:4173' });
  const page = await ctx.newPage();
  errors = watchErrors(page);
  try {
    await page.route((u) => /^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1' && !/radio-browser\.info/i.test(u.href),
      (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }));
    await page.route(/radio-browser\.info/i, (r) => r.abort());
    await boot(page);
    await page.click('.tb__btn[data-view="radio"]');
    await expect(page.locator('#radioMenu .rlist tbody tr').first()).toBeVisible({ timeout: 15_000 });
    const row = page.locator('#radioMenu .rlist tbody tr').first();
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.dispatchEvent('#radioMenu .rlist tbody tr >> nth=0', 'pointerdown', { clientX: box.x + 40, clientY: box.y + box.height / 2, pointerType: 'touch', isPrimary: true });
    await page.waitForTimeout(700);
    await expect(page.locator('#ctx')).toBeVisible();
    expect(await menuItems(page)).toEqual(expect.arrayContaining(['Add to Favourites', 'Add to Playlist']));
    await page.dispatchEvent('#radioMenu .rlist tbody tr >> nth=0', 'pointerup', { pointerType: 'touch' });
    await page.dispatchEvent('#radioMenu .rlist tbody tr >> nth=0', 'click');
    await expect(row, 'the lift that ended the press did not start the station').not.toHaveClass(/is-playing/);
  } finally {
    await ctx.close();
  }
});

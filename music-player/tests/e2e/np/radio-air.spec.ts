/**
 * The song on the air (NP-RADIO-001) and keeping it (NP-RADIO-002).
 *
 * A browser never sees a stream's ICY metadata, so the title comes from whoever can read it: the
 * companion's helper here (stubbed on 127.0.0.1:17999), or the paired container. The station used,
 * WFMT, publishes no feed of its own, so nothing but the ICY route can name its song. Streams answer
 * with decodable silence, and the directory is unreachable, so the bundled shelf answers.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, CORS, HUB, silentWav, watchErrors } from './_shell';

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
  expect(maxActive).toBeLessThanOrEqual(4);
  await expect(page.locator('#radioMenu .rlist tbody tr', { hasText: 'Station 000' }).locator('.rlist-song')).toHaveText('Live 000');
  await expect(page.locator('#radioMenu .rlist tbody tr', { hasText: 'Station 000' }).locator('.rlist-genre')).toHaveText('Jazz');
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
const WGCI_TRACK = { title: 'WTF GOIN (Clean) (feat. 21 Savage)', artist: 'Belly Gang Kushington & 21 Savage', startTime: Date.now() - 30_000, endTime: Date.now() + 150_000 };
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
  const asked = await iheartFeed(page, () => ({ status: 200, body: JSON.stringify(WGCI_TRACK) }));
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
  await iheartFeed(page, () => ({ status: 200, body: JSON.stringify(WGCI_TRACK) }));
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

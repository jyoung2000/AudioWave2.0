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
  await row.dblclick();
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
  expect(asked.length, 'the helper was asked').toBeGreaterThan(0);
  expect(asked.every((u) => /wfmt\.streamguys1\.com/.test(u)), `only the tuned stream is read, never the list: ${JSON.stringify(asked)}`).toBe(true);
});

test('with no companion and no container, a station without a feed invents nothing', async ({ page }) => {
  await boot(page);
  await tuneWfmt(page);
  await page.waitForTimeout(1500);
  await expect(page.locator('.player__title')).not.toHaveText('Air Song');
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
  await group.click();
  await expect(page.locator('#toast')).toContainText('Queued “Air Song” — number 2 in the group queue');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.body).toMatchObject({ query: 'Air Artist - Air Song' });
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

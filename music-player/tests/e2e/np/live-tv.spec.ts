/**
 * Live TV from the companion (NP-TV-001).
 *
 * The companion keeps the playlists and guides pasted into its Live TV tab and serves them on the
 * local helper. A player that can see a companion takes its channels from there: nothing to load by
 * hand in the player. The helper is stubbed on 127.0.0.1:17999.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, CORS, watchErrors } from './_shell';

const COMPANION = 'http://127.0.0.1:17999';
const soon = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();
const CHANNELS = {
  channels: [
    { id: 'c-one', name: 'Channel One', number: 1, group: 'News', logo: null, url: 'https://tv.example/one.m3u8', tvgId: 'one.example' },
    { id: 'c-two', name: 'Channel Two', number: 7, group: null, logo: null, url: 'https://tv.example/two.m3u8', tvgId: null },
  ],
};
const guide = (now: string) => ({
  generatedAt: new Date().toISOString(),
  guide: [{ tvgId: 'one.example', now: { title: now, start: soon(-10), stop: soon(20), description: null }, next: { title: 'The Late Review', start: soon(20), stop: soon(50), description: null } }],
});

let errors: string[];
test.beforeEach(({ page }) => {
  errors = watchErrors(page);
});
test.afterEach(() => {
  expect(errors, 'JS errors').toEqual([]);
});

const json = (body: unknown) => ({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const guideRows = (page: Page) => page.$$eval('#mediaMenu .rlist tbody tr', (n) => n.map((r) => [...r.querySelectorAll('td')].slice(1, 5).map((c) => c.textContent!.trim())));

async function connect(page: Page): Promise<number> {
  return page.evaluate((c) => {
    const w = window as unknown as { COMPANION: string; companionTv: () => Promise<number> };
    w.COMPANION = c;
    return w.companionTv();
  }, COMPANION);
}

test('the companion’s channels fill the guide, with what is on and what follows', async ({ page }) => {
  let title = 'Morning Report';
  await page.route(`${COMPANION}/helper/v1/tv/channels`, (r) => r.fulfill(json(CHANNELS)));
  await page.route(`${COMPANION}/helper/v1/tv/guide`, (r) => r.fulfill(json(guide(title))));
  await boot(page);
  expect(await connect(page), 'two channels arrived').toBe(2);

  await page.click('.tb__btn[data-view="live-tv"]');
  await expect(page.locator('#mediaMenu .rlist tbody tr')).toHaveCount(2);
  expect(await guideRows(page)).toEqual([
    ['1', 'Channel One', 'Morning Report', 'The Late Review'],
    // No guide entry: the channel is on, and nothing is invented about what it shows.
    ['7', 'Channel Two', 'Live', 'Live'],
  ]);

  // A guide refresh changes the words and leaves the list — and your place in it — alone.
  title = 'Midday Report';
  expect(await connect(page)).toBe(2);
  await expect(page.locator('#mediaMenu .rlist tbody tr').first()).toContainText('Midday Report');
});

test('a companion with no playlists leaves the guide as it was, and one that is gone breaks nothing', async ({ page }) => {
  await page.route(`${COMPANION}/helper/v1/tv/channels`, (r) => r.fulfill(json({ channels: [] })));
  await boot(page);
  expect(await connect(page)).toBe(0);
  await page.unroute(`${COMPANION}/helper/v1/tv/channels`);
  await page.route(`${COMPANION}/helper/v1/tv/channels`, (r) => r.abort());
  expect(await connect(page)).toBe(0);
  await page.click('.tb__btn[data-view="live-tv"]');
  await expect(page.locator('#mediaMenu')).toBeVisible();
  await expect(page.locator('#mediaMenu .rlist tbody tr')).toHaveCount(0);
});

test('with no companion on this machine, a paired hub’s copy of the companion’s Live TV fills the guide', async ({ page }) => {
  const HUB = 'http://192.168.1.20:4546';
  const ACCT = { base: HUB, credentialId: '00000000-0000-4000-8000-0000000000aa', secret: 'x'.repeat(40), scopes: ['library:read'], hubName: 'TOWER', deviceId: 'd1' };
  let auth = '';
  await page.route(`${HUB}/api/v1/live-tv`, (r) => {
    auth = r.request().headers()['authorization'] ?? '';
    return r.fulfill(json({ ...CHANNELS, ...guide('Hub Report'), updatedAt: new Date().toISOString(), sourceDevice: { deviceId: 'c1', name: 'Living room PC' } }));
  });
  await boot(page);
  const n = await page.evaluate(async (a) => {
    const w = window as unknown as { kv: { set(k: string, v: unknown): Promise<void> }; COMPANION?: string; companionTv: () => Promise<number> };
    await w.kv.set('player:hub', a);
    w.COMPANION = '';
    return w.companionTv();
  }, ACCT);
  expect(n, 'the hub’s two channels arrived').toBe(2);
  expect(auth, 'asked as this paired device').toBe(`Bearer ${ACCT.credentialId}.${ACCT.secret}`);
  await page.click('.tb__btn[data-view="live-tv"]');
  await expect(page.locator('#mediaMenu .rlist tbody tr').first()).toContainText('Hub Report');
});

/**
 * The Radio list's Song and Artist columns are a live reading, and these two drills prove the
 * reading keeps going. They are kept out of `radio-air.spec.ts` on purpose: each one waits out a
 * real 60-second refresh cycle, and adding minutes of wall time to that suite made a timing-marginal
 * neighbour (the WGCI feed drill, 15s budget) flake even though nothing about it had changed.
 */
import { expect, test, type Page } from '@playwright/test';
import { CORS, boot } from './_shell';

const COMPANION = 'http://127.0.0.1:17999';
let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  await page.route((u) => /^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1' && !/radio-browser\.info/i.test(u.href),
    (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }));
  await page.route(/radio-browser\.info/i, (r) => r.abort());
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

/** A tiny silent WAV, so a station that is "tuned" has something to play. */
function silentWav(): Buffer {
  const data = Buffer.alloc(16000);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8000, 24); head.writeUInt32LE(8000, 28); head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

test('a refresh pass armed while the Radio view is hidden is deferred, not abandoned', async ({ page }) => {
  const stations = [{ stationuuid: 'tick-1', name: 'Tick Station', url_resolved: 'https://radio.example/tick', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 }];
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stations) }));
  let plays = 0;
  await page.route(`${COMPANION}/helper/v1/radio/now-playing**`, (r) => {
    plays += 1;
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ title: `Song ${plays}`, artist: `Artist ${plays}`, programme: null, programmeSource: null, genre: 'Jazz', bitrate: 128 }) });
  });
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await page.click('.tb__btn[data-view="radio"]');
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'Tick Station' });
  await expect(row.locator('.rlist-song')).toHaveText('Song 1', { timeout: 20_000 });
  const readsWhenHidden = plays;
  // A list nobody is looking at should not be polled: the pass waits rather than spending requests.
  await page.click('.tb__btn[data-view="music"]');
  await page.waitForTimeout(8000);
  expect(plays).toBe(readsWhenHidden);
  // ...but the timer must still be alive, so the view serves fresh readings again once it is shown.
  await page.click('.tb__btn[data-view="radio"]');
  await expect(row.locator('.rlist-song')).not.toHaveText('Song 1', { timeout: 100_000 });
});

test('one station that never answers does not freeze the other rows', async ({ page }) => {
  const stations = [
    { stationuuid: 'hang-1', name: 'Hang Station', url_resolved: 'https://radio.example/hang', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 },
    { stationuuid: 'live-1', name: 'Live Station', url_resolved: 'https://radio.example/live', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 },
  ];
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stations) }));
  let plays = 0;
  let release = () => {};
  const hung = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${COMPANION}/helper/v1/radio/now-playing**`, async (r) => {
    const url = new URL(r.request().url()).searchParams.get('url') ?? '';
    /* A read that never settles while the list is watched: the pass used to wait on it forever, so no
       row was ever re-read. It is released at the end of the test rather than left pending, because a
       route handler that never returns outlives the test and breaks whatever runs next in the worker. */
    if (/hang/.test(url)) { await hung; await r.abort('timedout').catch(() => {}); return; }
    plays += 1;
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ title: `Song ${plays}`, artist: 'A', programme: null, programmeSource: null, genre: 'Jazz', bitrate: 128 }) });
  });
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await page.click('.tb__btn[data-view="radio"]');
  const live = page.locator('#radioMenu .rlist tbody tr', { hasText: 'Live Station' });
  await expect(live.locator('.rlist-song')).toHaveText('Song 1', { timeout: 25_000 });
  // One read hangs; the other row must still move on to its next song.
  await expect(live.locator('.rlist-song')).toHaveText('Song 2', { timeout: 110_000 });
  release();
  await page.unroute(`${COMPANION}/helper/v1/radio/now-playing**`);
});


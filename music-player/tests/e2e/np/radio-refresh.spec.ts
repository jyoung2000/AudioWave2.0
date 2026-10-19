/**
 * The Radio list's Song and Artist columns are a live reading, and these two drills prove the
 * reading keeps going. They are kept out of `radio-air.spec.ts` on purpose: each one waits out a
 * real 60-second refresh cycle, and adding minutes of wall time to that suite made a timing-marginal
 * neighbour (the WGCI feed drill, 15s budget) flake even though nothing about it had changed.
 */
import { expect, test, type Page } from '@playwright/test';
import { CORS, boot } from './_shell';

const COMPANION = 'http://127.0.0.1:17999';

/* Every drill in this file waits out a real 60-second refresh cycle, and two of them wait for a
   second one. The suite's 60s per-test budget cannot contain that -- the assertions here ask for up
   to 110s, so the test was killed before the behaviour it describes could happen. Three minutes is
   one cycle, the pass that follows it, and room for a slow read's 20s deadline. */
test.describe.configure({ timeout: 180_000 });
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

test('the refresh glyph turns on its own, not only when it is clicked', async ({ page }) => {
  const stations = [{ stationuuid: 'spin-1', name: 'Spin Station', url_resolved: 'https://radio.example/spin', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 }];
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stations) }));
  let plays = 0;
  await page.route(`${COMPANION}/helper/v1/radio/now-playing**`, (r) => {
    plays += 1;
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ title: `Song ${plays}`, artist: 'A', programme: null, programmeSource: null, genre: 'Jazz', bitrate: 128 }) });
  });
  await boot(page);
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  await page.click('.tb__btn[data-view="radio"]');

  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'Spin Station' });
  await expect(row.locator('.rlist-song')).toHaveText('Song 1', { timeout: 25_000 });

  /* Count the turns rather than sampling the class: a pass can be shorter than a poll interval, so
     a snapshot would walk straight past it. A MutationObserver latches every start. */
  const spins = () => page.evaluate(() => (window as unknown as { __spun: number }).__spun);
  await page.evaluate(() => {
    const btn = document.getElementById('libRadioRefresh');
    const w = window as unknown as { __spun: number };
    w.__spun = 0;
    if (!btn) throw new Error('no refresh button');
    new MutationObserver(() => { if (btn.classList.contains('is-spinning')) w.__spun += 1; })
      .observe(btn, { attributes: true, attributeFilter: ['class'] });
  });

  // The pass that is already running must stop, so what follows is unambiguously a new one.
  await expect(page.locator('#libRadioRefresh')).not.toHaveClass(/is-spinning/, { timeout: 30_000 });

  /* The point of the whole drill: nobody touches the button, the minute comes round, and the glyph
     turns because a reading pass is running. Before the fix this stayed at zero forever. */
  const beforeCycle = await spins();
  await expect.poll(spins, { timeout: 115_000, intervals: [1000] }).toBeGreaterThan(beforeCycle);
  await expect(row.locator('.rlist-song')).not.toHaveText('Song 1');

  // And a click still turns it, which is the behaviour that already worked.
  await expect(page.locator('#libRadioRefresh')).not.toHaveClass(/is-spinning/, { timeout: 40_000 });
  const beforeClick = await spins();
  await page.click('#libRadioRefresh');
  await expect.poll(spins, { timeout: 10_000, intervals: [250] }).toBeGreaterThan(beforeClick);
});

test('the refresh interval is a setting, and Off means only the button refreshes', async ({ page }) => {
  const stations = [{ stationuuid: 'pref-1', name: 'Pref Station', url_resolved: 'https://radio.example/pref', state: 'Chicago, IL', country: 'United States', countrycode: 'US', tags: '', bitrate: 0 }];
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stations) }));
  let plays = 0;
  await page.route(`${COMPANION}/helper/v1/radio/now-playing**`, (r) => {
    plays += 1;
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ title: `Song ${plays}`, artist: 'A', programme: null, programmeSource: null, genre: 'Jazz', bitrate: 128 }) });
  });

  /* The control lives with the other source settings, reached by the same hash route the rest of
     the suite uses rather than by clicking through the index. */
  await boot(page, '#settings/src');
  await page.evaluate((c) => { (window as unknown as { COMPANION: string }).COMPANION = c; }, COMPANION);
  const sel = page.locator('#cfgRadioRefresh');
  await expect(sel).toBeVisible();
  await expect(sel, 'a minute unless it is changed').toHaveValue('60');
  expect(await sel.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value)))
    .toEqual(['30', '60', '120', '300', 'off']);

  // Off: the pass that is already running finishes, and no further pass is armed.
  await sel.selectOption('off');
  /* Leave Settings the way the rest of the suite does: the pane covers the toolbar, so the Radio
     tab is not clickable until it is closed. */
  await page.click('#prefsBack');
  await page.waitForTimeout(600);
  await page.click('.tb__btn[data-view="radio"]');
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'Pref Station' });
  await expect(row.locator('.rlist-song')).toHaveText(/Song \d+/, { timeout: 25_000 });
  await expect(page.locator('#libRadioRefresh')).not.toHaveClass(/is-spinning/, { timeout: 30_000 });

  const settled = plays;
  await page.waitForTimeout(75_000);
  expect(plays, 'Off must not arm another pass').toBe(settled);

  // ...but the button still works, because Off turns off the clock, not the feature.
  await page.click('#libRadioRefresh');
  await expect.poll(() => plays, { timeout: 25_000, intervals: [500] }).toBeGreaterThan(settled);

  // And the choice is kept on the device, like every other setting in this pane.
  await boot(page, '#settings/src');
  await expect(page.locator('#cfgRadioRefresh')).toHaveValue('off');
});

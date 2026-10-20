/**
 * A station is already mid-song when it is tuned in, so "0:00" described how long we had been
 * listening rather than where the broadcast actually was. iHeart times its cues (start plus length)
 * and SomaFM publishes a start with no length, so one gets a real progress bar and the other gets
 * an elapsed figure alone -- nothing is estimated for stations that publish no timing.
 *
 * WGCI is used because it is on the bundled shelf and reads from iHeart, which is the station in
 * the report that prompted this.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, CORS, silentWav, watchErrors } from './_shell';

test.describe.configure({ timeout: 180_000 });
let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  // Streams answer with decodable silence; the directory is unreachable so the bundled shelf answers.
  await page.route((u) => /^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1'
      && !/radio-browser\.info|iheart\.com|somafm\.com/i.test(u.href),
    (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }));
  await page.route(/radio-browser\.info/i, (r) => r.abort());
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

async function tune(page: Page, name: string): Promise<void> {
  await page.click('.tb__btn[data-view="radio"]');
  await expect(page.locator('#libScopeLabel')).toHaveText('Chicago', { timeout: 20_000 });
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.dispatchEvent('click');
  await expect(row).toHaveClass(/is-playing/, { timeout: 15_000 });
}

test('tuning in mid-song shows where the broadcast is, not 0:00', async ({ page }) => {
  // The shape iHeart really returns: started 58s ago, runs 221s.
  await page.route(/us\.api\.iheart\.com\/.*currentTrackMeta/i, (r) => {
    const now = Date.now();
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({
      title: 'Raindance', artist: 'Dave & Tems', trackDuration: 221,
      startTime: now - 58_000, endTime: now + 163_000,
    }) });
  });

  await boot(page);
  await tune(page, '107.5 WGCI');

  // Roughly a minute in, from the station's clock rather than ours.
  await expect.poll(async () => page.locator('#elapsed').textContent(), { timeout: 30_000 })
    .toMatch(/0?[01]:[0-9]{2}/);
  const shown = await page.locator('#elapsed').textContent();
  const secs = Number(shown?.split(':')[0]) * 60 + Number(shown?.split(':')[1]);
  expect(secs, `"${shown}" should be about 58s in, not 0`).toBeGreaterThan(40);
  expect(secs, 'and inside the song').toBeLessThan(140);

  /* Filled to that point: a normal-looking progress bar, while the stream stays live and
     unseekable. Before the fix this sat at 100% from the first second. */
  const pct = await page.locator('#fill').evaluate((n) => parseFloat((n as HTMLElement).style.width));
  expect(pct, 'about a quarter through 221s').toBeGreaterThan(15);
  expect(pct, 'not pinned at the live edge').toBeLessThan(70);

  /* Still live: the radio bar keeps its own LIVE marker (#vp_live belongs to the video player and
     stays hidden here), and the broadcast position must not have made the track seekable. */
  await expect(page.locator('.player__live-dot')).toBeVisible();

  // The clock runs on its own, between feed reads.
  await page.waitForTimeout(3500);
  const later = await page.locator('#elapsed').textContent();
  expect(later, 'the broadcast clock keeps running').not.toBe(shown);
});

test('a feed with a start but no length shows elapsed and invents no total', async ({ page }) => {
  await page.route(/somafm\.com\/songs\//i, (r) => r.fulfill({
    status: 200, headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify({ songs: [{ title: 'Pyramid Point', artist: 'Kava Kon', date: String(Math.floor(Date.now() / 1000) - 92) }] }),
  }));
  await page.route(/us\.api\.iheart\.com\//i, (r) => r.abort());

  await boot(page);
  // Groove Salad is on the shelf under SomaFM and reads the songs feed.
  await page.click('.tb__btn[data-view="radio"]');
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'Groove Salad' });
  if (await row.count() === 0) test.skip(true, 'no SomaFM station on this shelf');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.dispatchEvent('click');

  await expect.poll(async () => page.locator('#elapsed').textContent(), { timeout: 30_000 }).toMatch(/0?1:3[0-9]/);
  /* No length is published, so none is shown and none is guessed: the bar stays at the live edge
     rather than filling toward a total nobody stated. */
  const pct = await page.locator('#fill').evaluate((n) => parseFloat((n as HTMLElement).style.width));
  expect(pct, 'no total means no fraction to fill').toBe(100);
});

/* Three reports arrived together: the song kept playing after the bar finished, a new song never
   replaced it, and the bar never reset. They are one failure with three faces -- the poll ignored a
   feed that had stopped naming a song, and only ran every twenty seconds, so a finished cue stayed
   on screen with its clock still running.

   The fixtures below switch on elapsed wall-clock, not on a call count: the station list reads the
   same feed before anything is tuned, so counting calls attributes the first answer to the wrong
   reader. */
test('a finished song gives way to the next one, and the bar starts over', async ({ page }) => {
  const openedAt = Date.now();
  await page.route(/us\.api\.iheart\.com\/.*currentTrackMeta/i, (r) => {
    const now = Date.now();
    // Until the station is tuned and seen: a song with 3 seconds left. After that: the next song.
    const body = now - openedAt < 12_000
      ? { title: 'Joy.', artist: 'Ariana Grande', trackDuration: 60, startTime: now - 57_000, endTime: now + 3_000 }
      : { title: 'Risk It All', artist: 'Leon Thomas', trackDuration: 204, startTime: now - 4_000, endTime: now + 200_000 };
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });

  await boot(page);
  await tune(page, '107.5 WGCI');

  await expect(page.locator('.player__title')).toHaveText('Joy.', { timeout: 10_000 });
  const nearEnd = await page.locator('#fill').evaluate((n) => parseFloat((n as HTMLElement).style.width));
  expect(nearEnd, 'almost finished').toBeGreaterThan(85);

  /* The cue ends in 3s. Without the end-of-cue re-poll this waits out the 20s interval, so the
     finished song sits on screen with a full bar -- exactly what was reported. */
  await expect(page.locator('.player__title')).toHaveText('Risk It All', { timeout: 30_000 });
  const restarted = await page.locator('#fill').evaluate((n) => parseFloat((n as HTMLElement).style.width));
  expect(restarted, 'the bar starts the new song over, it does not stay full').toBeLessThan(40);
  const el = await page.locator('#elapsed').textContent();
  expect(el, 'and the clock starts over too').toMatch(/0?0:[0-3][0-9]/);
});

/* A station that stops naming a song -- an ad break, a talk segment, a 204 -- used to keep the last
   song on screen forever with its clock still climbing. WGCI was doing exactly this when the report
   came in: it had moved to a talk programme while the player still showed the previous track. */
test('a station that stops naming a song stops claiming one', async ({ page }) => {
  const openedAt = Date.now();
  await page.route(/us\.api\.iheart\.com\/.*currentTrackMeta/i, (r) => {
    const now = Date.now();
    if (now - openedAt < 12_000) {
      return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({
        title: 'Friend Do Remix', artist: 'Belly Gang Kushington', trackDuration: 171, startTime: now - 60_000, endTime: now + 111_000,
      }) });
    }
    return r.fulfill({ status: 204, headers: CORS, body: '' });   // the break begins
  });

  await boot(page);
  await tune(page, '107.5 WGCI');
  await expect(page.locator('.player__title')).toHaveText('Friend Do Remix', { timeout: 10_000 });

  // Once the feed goes quiet the song must go with it, rather than ticking on for minutes.
  await expect(page.locator('.player__title')).not.toHaveText('Friend Do Remix', { timeout: 45_000 });
});

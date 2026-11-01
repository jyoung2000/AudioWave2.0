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

test('radio fill tracks the published cue clock without pausing a second behind it', async ({ page }) => {
  /* The old 1s paint timer and rounded radioAir() clock were on different phases. In a real
     paired watch, the feed said 16s while the rendered fill still said 15s; 36 of 48 samples
     were a whole second behind. The bar must follow the published start, not the timer phase. */
  const cueStart = Date.now() - 60_000;
  const duration = 240;
  await page.route(/us\.api\.iheart\.com\/.*currentTrackMeta/i, (r) => r.fulfill({
    status: 200, headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Precise Cue', artist: 'Radio Test', trackDuration: duration,
      startTime: cueStart, endTime: cueStart + duration * 1000 }),
  }));
  await boot(page);
  await tune(page, '107.5 WGCI');
  await expect(page.locator('.player__title')).toHaveText('Precise Cue', { timeout: 15_000 });
  await expect(page.locator('#fill')).toHaveAttribute('style', /width:/);
  const samples = await page.evaluate(async ({ cueStart, duration }) => {
    const out: Array<{ lag: number; percent: number; elapsed: string }> = [];
    for (let i = 0; i < 25; i++) {
      const width = Number.parseFloat(document.getElementById('fill')!.style.width);
      const percent = width * duration / 100;
      out.push({ lag: (Date.now() - cueStart) / 1000 - percent, percent,
        elapsed: document.getElementById('elapsed')!.textContent || '' });
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return out;
  }, { cueStart, duration });
  const largestLag = Math.max(...samples.map((s) => s.lag));
  expect(largestLag, `the rendered bar must be within 0.65s of the published cue: ${JSON.stringify(samples)}`)
    .toBeLessThan(0.65);
  expect(new Set(samples.map((s) => s.percent)).size, 'fill advances more often than once per second')
    .toBeGreaterThan(5);
  const last = samples.at(-1)!;
  const shown = last.elapsed.split(':').map(Number);
  expect(Math.abs(shown[0]! * 60 + shown[1]! - last.percent), 'elapsed label agrees with the fill')
    .toBeLessThanOrEqual(1);
  const afterResume = await page.evaluate(() => {
    /* Simulate a delayed paint after returning from another tab: the visibility callback must
       recompute from the cue start synchronously, rather than wait for a timer or count ticks. */
    const fill = document.getElementById('fill')!;
    fill.style.width = '0%';
    document.dispatchEvent(new Event('visibilitychange'));
    return Number.parseFloat(fill.style.width);
  });
  expect(afterResume, 'the bar catches up immediately on tab return').toBeGreaterThan(10);
});

test('conflicting same-song re-cues stop claiming a broadcast position until a new song', async ({ page }) => {
  /* WLSFM's Triton feed was observed publishing Come On Eileen with duration 257s, then moving
     its start forward 24s, 18s, 12s, and 12s while the TITLE DID NOT CHANGE. The old code accepted
     every re-cue and the bar ran backward repeatedly -- that is neither elapsed time nor progress.
     A station may replay a song, so this only rejects a recued start inside the old song's length;
     a new start after the previous song has ended remains valid. */
  let phase = 0;
  let secondConflictReads = 0;
  const start = Date.now() - 40_000;
  await page.route(/us\.api\.iheart\.com\/.*currentTrackMeta/i, (r) => {
    if (phase === 3) secondConflictReads++;
    const title = phase === 2 ? 'Next Broadcast Song' : 'Repeated Cue';
    const started = phase === 0 ? start : phase === 1 ? start + 20_000
      : phase === 3 ? start + 40_000 : Date.now() - 12_000;
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ title, artist: 'Radio Test', trackDuration: 240,
        startTime: started, endTime: started + 240_000 }) });
  });
  await boot(page);
  await tune(page, '107.5 WGCI');
  await expect(page.locator('.player__title')).toHaveText('Repeated Cue');
  await expect.poll(async () => Number.parseFloat(await page.locator('#fill').evaluate((n) => (n as HTMLElement).style.width)))
    .toBeGreaterThan(10);
  phase = 1;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.player__title')).toHaveText('Repeated Cue');
  await expect(page.locator('#track')).toHaveAttribute('aria-label', 'Live broadcast, position not published', { timeout: 10_000 });
  await expect(page.locator('#fill')).toHaveAttribute('style', /width: 0%/);
  await expect(page.locator('#elapsed')).toHaveText('—:—');
  await expect(page.locator('#remaining')).toHaveText('Length 04:00');
  phase = 3;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => secondConflictReads).toBeGreaterThan(0);
  await page.waitForTimeout(100);
  await expect(page.locator('#elapsed')).toHaveText('—:—');
  await expect(page.locator('#fill')).toHaveAttribute('style', /width: 0%/);
  phase = 2;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.player__title')).toHaveText('Next Broadcast Song', { timeout: 10_000 });
  await expect.poll(async () => Number.parseFloat(await page.locator('#fill').evaluate((n) => (n as HTMLElement).style.width)))
    .toBeGreaterThan(1);
});

test('a genuine same-name re-cue after the old cue ends restores a timed bar', async ({ page }) => {
  let phase = 0;
  const previousStart = Date.now() - 244_000;
  await page.route(/us\.api\.iheart\.com\/.*currentTrackMeta/i, (r) => {
    const started = phase === 0 ? previousStart : Date.now() - 12_000;
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Repeated Legitimately', artist: 'Radio Test',
        trackDuration: 240, startTime: started, endTime: started + 240_000 }) });
  });
  await boot(page);
  await tune(page, '107.5 WGCI');
  await expect(page.locator('.player__title')).toHaveText('Repeated Legitimately');
  phase = 1;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(async () => Number.parseFloat(await page.locator('#fill').evaluate((n) => (n as HTMLElement).style.width)))
    .toBeGreaterThan(2);
  await expect(page.locator('#track')).toHaveAttribute('aria-label', /Live broadcast, 00:1[0-9] of 04:00/);
});

test('a timed cue with no published length advances elapsed but never shows a permanently full bar', async ({ page }) => {
  /* Triton can publish a start but no duration; the old live-edge rendering hard-coded 100%
     forever, which looked exactly like a stuck progress bar. */
  const start = Date.now() - 75_000;
  await page.route(/np\.tritondigital\.com\/public\/nowplaying/i, (r) => r.fulfill({
    status: 200, headers: { ...CORS, 'content-type': 'text/xml' },
    body: '<nowplaying-info-list><nowplaying-info type="track">' +
      '<property name="cue_title"><![CDATA[Only A Start]]></property>' +
      '<property name="track_artist_name"><![CDATA[Radio Test]]></property>' +
      `<property name="cue_time_start"><![CDATA[${start}]]></property>` +
      '</nowplaying-info></nowplaying-info-list>',
  }));
  await boot(page);
  await tune(page, 'WLS 94.7');
  await expect(page.locator('.player__title')).toHaveText('Only A Start', { timeout: 15_000 });
  await expect(page.locator('#fill')).toHaveAttribute('style', /width: 0%/);
  const before = await page.locator('#elapsed').textContent();
  const seconds = Number(before?.split(':')[0]) * 60 + Number(before?.split(':')[1]);
  expect(seconds).toBeGreaterThan(70);
  expect(seconds).toBeLessThan(115);
  await expect.poll(async () => page.locator('#elapsed').textContent(), { timeout: 5_000 })
    .not.toBe(before);
  await expect(page.locator('#fill')).toHaveAttribute('style', /width: 0%/);
});

/* The reported bug, measured on the live WLSFM feed: Triton re-stamps the cue that is on the air
   roughly every twelve seconds, moving cue_time_start forward while the title, artist, programme and
   length stay the same. "Take Me Home Tonight" (205.6s) carried 14 such stamps spanning 198.1s. A
   reader that trusts only the newest entry therefore believes every song started seconds ago: the
   bar sits near the beginning and jerks backwards on each poll, which is what a listener sees as a
   stuck and lagging progress bar. The oldest stamp of an unbroken run is the real start. */
test('a Triton heartbeat does not reset the song: the oldest stamp of the run is its start', async ({ page }) => {
  const trueStart = Date.now() - 150_000;              // 2:30 into a 3:45 song
  const beats: string[] = [];
  for (let at = trueStart; at <= Date.now() - 2_000; at += 12_000) {
    beats.unshift('<nowplaying-info mountName="WLSFM" type="track">' +
      '<property name="cue_time_duration"><![CDATA[225723]]></property>' +
      `<property name="cue_time_start"><![CDATA[${at}]]></property>` +
      '<property name="cue_title"><![CDATA[Fantasy]]></property>' +
      '<property name="program_id"><![CDATA[436894]]></property>' +
      '<property name="track_artist_name"><![CDATA[Mariah Carey]]></property>' +
      '</nowplaying-info>');
  }
  expect(beats.length, 'the live feed republishes the same cue many times').toBeGreaterThan(10);
  // The song that played before, so the run has a real boundary to stop at.
  const previous = '<nowplaying-info mountName="WLSFM" type="track">' +
    '<property name="cue_time_duration"><![CDATA[205631]]></property>' +
    `<property name="cue_time_start"><![CDATA[${trueStart - 205_631}]]></property>` +
    '<property name="cue_title"><![CDATA[Take Me Home Tonight]]></property>' +
    '<property name="program_id"><![CDATA[274053]]></property>' +
    '<property name="track_artist_name"><![CDATA[Eddie Money]]></property>' +
    '</nowplaying-info>';
  await page.route(/np\.tritondigital\.com\/public\/nowplaying/i, (r) => r.fulfill({
    status: 200, headers: { ...CORS, 'content-type': 'text/xml' },
    body: `<nowplaying-info-list>${beats.join('')}${previous}</nowplaying-info-list>`,
  }));

  await boot(page);
  await tune(page, 'WLS 94.7');
  await expect(page.locator('.player__title')).toHaveText('Fantasy', { timeout: 15_000 });

  const air = await page.evaluate(() => (window as unknown as
    { radioAir: () => { elapsed: number | null; duration: number | null } | null }).radioAir());
  expect(air?.duration).toBe(226);
  expect(air?.elapsed, 'the song is 2:30 in, not a few seconds in').toBeGreaterThan(140);
  expect(air?.elapsed).toBeLessThan(165);
  const fill = await page.locator('#fill').evaluate((n) => parseFloat((n as HTMLElement).style.width));
  expect(fill, 'and the bar is two thirds along').toBeGreaterThan(55);
  expect(fill).toBeLessThan(80);

  /* A further poll sees a newer heartbeat; the position must keep climbing, never restart. */
  const before = air!.elapsed!;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => (window as unknown as
    { radioAir: () => { elapsed: number | null } | null }).radioAir()?.elapsed ?? null);
  expect(after, 'a heartbeat is not a new song').toBeGreaterThan(before);
});

/* Measured on a live ten-minute WGCI watch: the player correctly let `MUTT` go 17s past the end of
   its own 193s cue, but the station's list row went on showing it for 626 consecutive one-second
   samples -- because iHeart keeps serving a finished cue (observed up to 47s past its end) and the
   list, unlike the player, had no notion of a cue expiring. */
test('the list row does not name a song whose cue has plainly finished', async ({ page }) => {
  let started = Date.now() - 20_000;
  await page.route(/us\.api\.iheart\.com\/.*currentTrackMeta/i, (r) => r.fulfill({
    status: 200, headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Finished Cue', artist: 'Radio Test', startTime: started,
      endTime: started + 30_000, trackDuration: 30 }),
  }));

  await boot(page);
  await tune(page, '107.5 WGCI');
  const row = page.locator('tr[aria-selected="true"] .rlist-song');
  await expect(page.locator('.player__title')).toHaveText('Finished Cue', { timeout: 15_000 });
  await expect(row).toHaveText('Finished Cue', { timeout: 20_000 });

  /* The feed keeps serving that same cue well past its own 30s length -- exactly what iHeart does
     at a real boundary. The player stops claiming it; so must the row. */
  started = Date.now() - 90_000;
  await expect(page.locator('.player__title')).not.toHaveText('Finished Cue', { timeout: 30_000 });
  await expect(row, 'a finished cue names no song in the list either')
    .not.toHaveText('Finished Cue', { timeout: 30_000 });
  await expect(row).toHaveAttribute('title', /already finished|not naming a song/);
});

test('a late old feed reply cannot replace the new song on the same station', async ({ page }) => {
  await page.route(/us\.api\.iheart\.com\/.*currentTrackMeta/i, (r) => {
    const start = Date.now() - 30_000;
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'First Song', artist: 'Radio Test', startTime: start,
        endTime: start + 200_000, trackDuration: 200 }) });
  });
  await boot(page);
  await tune(page, '107.5 WGCI');
  await expect(page.locator('.player__title')).toHaveText('First Song');
  const result = await page.evaluate(async () => {
    type Cue = { title: string; artist: string; startedAt: number; duration: number };
    const w = window as unknown as { radioMeta: (url: string, tuned?: boolean) => Promise<Cue | null> };
    const real = w.radioMeta;
    let answerOld!: (cue: Cue) => void;
    let calls = 0;
    w.radioMeta = (url, tuned) => {
      if (!tuned) return real(url, tuned);
      calls++;
      if (calls === 1) return new Promise<Cue>((resolve) => { answerOld = resolve; });
      if (calls === 2) return Promise.resolve({ title: 'New Song', artist: 'Radio Test',
        startedAt: Date.now() - 3000, duration: 200 });
      return real(url, tuned);
    };
    try {
      /* A background/resume poll and a regular poll can overlap; latest STARTED request owns the
         screen, even if the older network response arrives last. */
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const afterNew = document.querySelector('.player__title')?.textContent;
      answerOld({ title: 'Old Reply', artist: 'Radio Test', startedAt: Date.now() - 100_000, duration: 200 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { calls, afterNew, afterOld: document.querySelector('.player__title')?.textContent };
    } finally { w.radioMeta = real; }
  });
  expect(result.calls).toBeGreaterThanOrEqual(2);
  expect(result.afterNew).toBe('New Song');
  expect(result.afterOld).toBe('New Song');
});

test('restoring from bfcache re-reads the current song instead of trusting the frozen page', async ({ page }) => {
  await page.route(/us\.api\.iheart\.com\/.*currentTrackMeta/i, (r) => {
    const start = Date.now() - 30_000;
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Before Leaving', artist: 'Radio Test', startTime: start,
        endTime: start + 200_000, trackDuration: 200 }) });
  });
  await boot(page);
  await tune(page, '107.5 WGCI');
  await expect(page.locator('.player__title')).toHaveText('Before Leaving');
  await page.evaluate(() => {
    const w = window as unknown as { radioMeta: (url: string, tuned?: boolean) => Promise<unknown> };
    const real = w.radioMeta;
    w.radioMeta = (url, tuned) => tuned
      ? Promise.resolve({ title: 'After Returning', artist: 'Radio Test',
        startedAt: Date.now() - 5000, duration: 200 })
      : real(url, tuned);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.locator('.player__title')).toHaveText('After Returning', { timeout: 10_000 });
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
  /* No length is published, so none is shown or guessed: the elapsed stamp advances, but without
     a total there is no honest fraction to fill. A full bar looked frozen forever. */
  const pct = await page.locator('#fill').evaluate((n) => parseFloat((n as HTMLElement).style.width));
  expect(pct, 'no total means no fraction to fill').toBe(0);
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

  /* And the station's own list row must let go of it too. Measured live on WLS: the player read
     "Song not available" for 197 consecutive one-second samples while that station's row still
     showed the finished song, because only a renamed song refreshed the row. */
  await expect(page.locator('tr[aria-selected="true"] .rlist-song'))
    .not.toHaveText('Friend Do Remix', { timeout: 30_000 });
});

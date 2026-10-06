/**
 * The listing that can be heard (NP-FIND-001) and, when paired, the hub's enriched rows.
 *
 * The hub here is a stub answering the contract — the journey owns the real one. What this file
 * proves is the player's half: the paired chain leads with the hub, a row shows what enrichment
 * found (and only when the match was confident), and the unpaired/keyless path stays whole when
 * the hub never answers.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, CORS, HUB } from './_shell';

/** The same origin the suite's own config serves; a second context does not inherit baseURL. */
const PREVIEW_ORIGIN = 'http://127.0.0.1:4173';

/** A real, decodable clip: two seconds of silent 8 kHz PCM WAV. play() must resolve, not race. */
function silentWav(seconds = 2): Buffer {
  const rate = 8000;
  const n = rate * seconds * 2;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}

const ACCT = { base: HUB, credentialId: '00000000-0000-4000-8000-0000000000aa', secret: 'x'.repeat(40), scopes: ['search:use'], hubName: 'TOWER', deviceId: 'd1' };

function hubRow(over: Record<string, unknown> = {}) {
  return {
    id: 'spotify:track:abc', kind: 'track', provider: 'spotify', providerId: 'abc', title: 'Golden Hour', artistName: 'Artist',
    albumName: 'Album', durationMs: 200_000, artworkUrl: null, canonicalUrl: 'https://open.spotify.com/track/abc', year: 2017,
    genre: 'hip hop', genres: ['hip hop', 'trap'], genreProfile: { 'hip hop': 0.7, trap: 0.3 }, featuredArtists: ['Guest'],
    bpm: 98, bpmSource: 'deezer', capabilities: {}, identity: { matchConfidence: 0.95 }, attribution: null, cachedAt: null,
    stale: false, accessState: 'available', previewUrl: 'https://p.scdn.co/mp3-preview/abc', trackId: null, variants: [],
    ...over,
  };
}

const ITUNES_EMPTY = { results: [] };

async function wireHub(page: Page, rows: unknown[]): Promise<string[]> {
  const asked: string[] = [];
  await page.route(`${HUB}/**`, (r) => {
    const u = new URL(r.request().url());
    asked.push(u.pathname + u.search);
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    if (u.pathname === '/api/v1/search') {
      return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ query: u.searchParams.get('q'), scope: 'songs', results: rows, partialFailures: [], sources: [], nextCursor: null, tookMs: 3 }) });
    }
    return r.fulfill({ status: 404, headers: { ...CORS, 'content-type': 'application/json' }, body: '{}' });
  });
  return asked;
}

async function pairAndOpen(page: Page, rows: unknown[]): Promise<string[]> {
  await page.route('**/itunes.apple.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ITUNES_EMPTY) }));
  const asked = await wireHub(page, rows);
  await boot(page);
  await page.evaluate(async (a) => {
    await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', a);
  }, ACCT);
  await page.goto('about:blank');
  await boot(page); // Music is the boot tab, where the header field lives (NP-CHROME-001)
  return asked;
}

/**
 * Type a query and wait for result rows. If none come, the failure says what the dropdown showed
 * instead, whether this player was still paired, and which lookups the page actually made — one run
 * in five of Hermes's pass-2 sweep saw no rows for 60 s and left nothing to explain it.
 */
async function searchFor(page: Page, q: string, timeout = 15_000): Promise<void> {
  await page.fill('#q', q);
  await page.press('#q', 'Enter');
  try {
    await expect(page.locator('.srch__row').first()).toBeVisible({ timeout });
  } catch (err) {
    const why = await page.evaluate(async () => {
      const pop = document.getElementById('srch');
      const kv = (window as unknown as { kv: { get(k: string): Promise<unknown> } }).kv;
      const paired = await kv.get('player:hub').then((v) => !!(v && (v as { secret?: string }).secret), () => 'unreadable');
      const asked = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /api\/v1|itunes|:8642|deezer/.test(n));
      return { popover: pop ? (pop.hidden ? '(closed)' : pop.innerText.slice(0, 300)) : '(missing)', paired, asked, typed: (document.getElementById('q') as HTMLInputElement | null)?.value ?? null };
    });
    throw new Error(`no search rows for "${q}": ${JSON.stringify(why)}`, { cause: err });
  }
}

test('a pairing that kv.set has finished saving survives an immediate reload, every time', async ({ page }) => {
  // Five full boots: a minute on a desktop, more on a CI runner.
  test.setTimeout(180_000);
  // Pass 3's diagnostic caught the flaky search with "paired": false — kv.set returned nothing, so
  // `await kv.set(...)` waited for nothing and a reload could beat the database write. The pairing
  // has no localStorage journal (its secret is kept out of it), so nothing else rescued it.
  // The stub hub answers, so a paired boot is not left waiting on an address that does not exist.
  await wireHub(page, []);
  await boot(page);
  for (let i = 0; i < 5; i++) {
    const acct = { ...ACCT, hubName: `TOWER-${i}` };
    await page.evaluate(async (a) => {
      await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', a);
    }, acct);
    await page.goto('about:blank');
    await boot(page);
    const saved = await page.evaluate(() => (window as unknown as { kv: { get(k: string): Promise<{ hubName?: string } | null> } }).kv.get('player:hub'));
    expect(saved?.hubName, `round ${i}`).toBe(`TOWER-${i}`);
  }
});

test('a search and a pasted link never go to a hard-coded local port (docs/DEVIATIONS.md)', async ({ page }) => {
  const local: string[] = [];
  page.on('request', (r) => { if (/127\.0\.0\.1:8642|localhost:8642/.test(r.url())) local.push(r.url()); });
  await pairAndOpen(page, [hubRow()]);
  await searchFor(page, 'Golden Hour');
  await page.fill('#q', 'https://soundcloud.com/someone/some-song');
  await page.press('#q', 'Enter');
  await page.waitForTimeout(1500);
  expect(local, 'whatever happens to listen on 8642 is not the companion, and is not told what you search for').toEqual([]);
});

test('paired, the hub answers first: album, features, genre chip and bpm on the row', async ({ page }) => {
  const asked = await pairAndOpen(page, [hubRow()]);
  await searchFor(page, 'Golden Hour');
  const row = page.locator('.srch__row').first();
  await expect(row.locator('.srch__title')).toHaveText('Golden Hour');
  await expect(row.locator('.srch__sub')).toContainText('Artist feat. Guest — Album');
  await expect(row.locator('.srch__genre')).toHaveText('hip hop');
  await expect(row.locator('.srch__bpm')).toHaveText('98 bpm');
  expect(asked.some((u) => u.startsWith('/api/v1/search'))).toBe(true);
});

test('a low-confidence row keeps the platform’s own words: no album, no chip', async ({ page }) => {
  await pairAndOpen(page, [hubRow({ albumName: 'Guessed Album', identity: { matchConfidence: 0.3 }, genres: [], genreProfile: {}, genre: null, featuredArtists: [] })]);
  await searchFor(page, 'Golden Hour');
  const row = page.locator('.srch__row').first();
  await expect(row.locator('.srch__title')).toHaveText('Golden Hour');
  await expect(row.locator('.srch__sub')).not.toContainText('Guessed Album');
  await expect(row.locator('.srch__genre')).toHaveCount(0);
});

test('a hub that never answers leaves the chain to iTunes inside the deadline', async ({ page }) => {
  // With no hub answering and no companion, this browser asks iTunes itself, in iTunes's own shape.
  await page.route('**/itunes.apple.com/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(new URL(r.request().url()).searchParams.get('entity') !== 'song' ? { results: [] } : { results: [{ wrapperType: 'track', kind: 'song', trackId: 81, trackName: 'Fallback Song', artistName: 'Someone', collectionName: 'LP', trackViewUrl: 'https://music.apple.com/us/album/lp/80?i=81', trackTimeMillis: 180000, previewUrl: 'https://audio-ssl.itunes.apple.com/x.m4a' }] }),
  }));
  for (const u of ['**/api.deezer.com/**', '**/musicbrainz.org/**', '**/lrclib.net/**']) await page.route(u, (r) => r.abort());
  await page.route(`${HUB}/**`, () => { /* black hole: the hub never answers */ });
  await boot(page);
  await page.evaluate(async (a) => {
    await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', a);
  }, ACCT);
  await page.goto('about:blank');
  await boot(page);
  await searchFor(page, 'Fallback');
  await expect(page.locator('.srch__row .srch__title').first()).toHaveText('Fallback Song', { timeout: 12_000 });
});

test('a click plays up to thirty seconds, and the main track waits its turn', async ({ page }) => {
  await pairAndOpen(page, [hubRow()]);
  await page.route('https://p.scdn.co/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' }, body: silentWav() }));
  await searchFor(page, 'Golden Hour');
  expect(await page.evaluate(() => (window as unknown as { NP_SRCH_CLIP?: number }).NP_SRCH_CLIP ?? null), 'the clip length the module exposes').toBe(30);
  const art = page.locator('.srch__row button.srch__art').first();
  await expect(art).toHaveAttribute('aria-label', /30 seconds/);
  await art.click();
  await expect(page.locator('.srch__art.is-preview')).toHaveCount(1);
  await art.click();
  await expect(page.locator('.srch__art.is-preview')).toHaveCount(0);
});

test('a row with no clip says so instead of pretending', async ({ page }) => {
  await pairAndOpen(page, [hubRow({ provider: 'youtube', providerId: 'v1', id: 'youtube:track:v1', previewUrl: null, canonicalUrl: 'https://youtu.be/v1' })]);
  await searchFor(page, 'Golden Hour');
  await expect(page.locator('.srch__row button.srch__art')).toHaveCount(0);
  await expect(page.locator('.srch__row .srch__art').first()).toHaveAttribute('title', /No preview/);
});

/**
 * Counts every time a hold starts (is-arming added) and every time an audition starts (is-preview
 * added). Checking the classes at one instant raced the timer on a loaded machine: a short hold could
 * arm and play between two checks, and a short clip could end before the next one looked.
 */
async function watchHold(page: Page): Promise<() => Promise<{ arms: number; plays: number }>> {
  await page.evaluate(() => {
    const w = window as unknown as { __hold: { arms: number; plays: number } };
    w.__hold = { arms: 0, plays: 0 };
    // One batch can hold several changes to one element; each record's value after is the next
    // record's value before (the last one's is the element's class now). Comparing every record
    // with the final class counted "arming → preview" as two starts.
    new MutationObserver((ms) => {
      ms.forEach((m, i) => {
        const el = m.target as Element;
        const next = ms.slice(i + 1).find((n) => n.target === el);
        const before = m.oldValue ?? '';
        const after = next ? (next.oldValue ?? '') : el.className;
        const gained = (c: string): boolean => after.split(/\s+/).includes(c) && !before.split(/\s+/).includes(c);
        if (gained('is-arming')) w.__hold.arms += 1;
        if (gained('is-preview')) w.__hold.plays += 1;
      });
    }).observe(document.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { __hold: { arms: number; plays: number } }).__hold);
}

test('resting the pointer on a row arms it, fills the ring, and then plays', async ({ page }) => {
  await pairAndOpen(page, [hubRow()]);
  await page.route('https://p.scdn.co/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' }, body: silentWav(20) }));
  await searchFor(page, 'Golden Hour');
  await page.evaluate(() => ((window as unknown as { NP_SRCH_ARM_MS: number }).NP_SRCH_ARM_MS = 300));
  const hold = await watchHold(page);
  await page.locator('.srch__row').first().hover();
  await expect.poll(async () => (await hold()).plays, { timeout: 8000 }).toBe(1);
  expect((await hold()).arms, 'it armed first, once').toBe(1);
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(0);
});

test('leaving the row mid-hold cancels; nothing plays', async ({ page }) => {
  await pairAndOpen(page, [hubRow()]);
  await searchFor(page, 'Golden Hour');
  // Long enough that leaving always lands inside the hold, however slow the machine.
  await page.evaluate(() => ((window as unknown as { NP_SRCH_ARM_MS: number }).NP_SRCH_ARM_MS = 4000));
  const hold = await watchHold(page);
  await page.locator('.srch__row').first().hover();
  await expect.poll(async () => (await hold()).arms, { timeout: 3000 }).toBe(1);
  await page.mouse.move(10, 10);
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(0);
  await page.waitForTimeout(4500);
  expect((await hold()).plays, 'the cancelled hold never played').toBe(0);
});

test('a key press cancels the hold too', async ({ page }) => {
  await pairAndOpen(page, [hubRow()]);
  await searchFor(page, 'Golden Hour');
  await page.evaluate(() => ((window as unknown as { NP_SRCH_ARM_MS: number }).NP_SRCH_ARM_MS = 800));
  await page.locator('.srch__row').first().hover();
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(0);
});

test('reduced motion never arms; the click still works', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', baseURL: PREVIEW_ORIGIN });
  const p2 = await ctx.newPage();
  try {
    await pairAndOpen(p2, [hubRow()]);
    await p2.route('https://p.scdn.co/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' }, body: silentWav() }));
    await searchFor(p2, 'Golden Hour');
    await p2.locator('.srch__row').first().hover();
    await p2.waitForTimeout(500);
    await expect(p2.locator('.srch__art.is-arming')).toHaveCount(0);
    await p2.locator('.srch__row button.srch__art').first().click();
    await expect(p2.locator('.srch__art.is-preview')).toHaveCount(1);
  } finally {
    await ctx.close();
  }
});

test('switching auditions keeps the main track aside until the last one ends', async ({ page }) => {
  const second = hubRow({ id: 'spotify:track:def', providerId: 'def', title: 'Silver Hour', previewUrl: 'https://p.scdn.co/mp3-preview/def', canonicalUrl: 'https://open.spotify.com/track/def' });
  await pairAndOpen(page, [hubRow(), second]);
  await page.route('https://p.scdn.co/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' }, body: silentWav() }));
  await searchFor(page, 'Hour');
  await page.waitForSelector('.srch__row[data-i="1"]');
  // A stand-in engine with the real one's timing: playing() answers false until a resume lands.
  await page.evaluate(() => {
    (window as unknown as { NP_PLAYER: unknown }).NP_PLAYER = {
      _p: true, _resumed: 0,
      playing() { return (this as { _p: boolean })._p; },
      pause() { (this as { _p: boolean })._p = false; },
      resume() { const s = this as { _p: boolean; _resumed: number }; s._resumed += 1; setTimeout(() => { s._p = true; }, 150); },
    };
  });
  await page.click('.srch__row[data-i="0"] button.srch__art');
  await expect(page.locator('.srch__row[data-i="0"] .srch__art.is-preview')).toHaveCount(1);
  await page.click('.srch__row[data-i="1"] button.srch__art');
  await expect(page.locator('.srch__row[data-i="1"] .srch__art.is-preview')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { NP_PLAYER: { _resumed: number } }).NP_PLAYER._resumed), 'the main track must not resume under the second audition').toBe(0);
  await page.click('.srch__row[data-i="1"] button.srch__art');
  await expect(page.locator('.srch__art.is-preview')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { NP_PLAYER: { _resumed: number } }).NP_PLAYER._resumed), 'stopping the last audition hands the stage back').toBe(1);
});

test('a pointer wandering inside the row still completes the hold', async ({ page }) => {
  await pairAndOpen(page, [hubRow()]);
  await searchFor(page, 'Golden Hour');
  // The clip must outlive the test's own moves, and the hold must be long enough that the first
  // check sees it arming. After that, a loaded machine may let the hold complete mid-drift — so
  // each check accepts "still arming" or "already playing"; only a cancel (neither) fails.
  await page.route('https://p.scdn.co/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' }, body: silentWav(20) }));
  await page.evaluate(() => ((window as unknown as { NP_SRCH_ARM_MS: number }).NP_SRCH_ARM_MS = 2500));
  // Every time the hold starts, the art gains is-arming; a cancel-and-re-arm shows up as a second
  // start even when the row looks armed at each check. Counting starts is timing-free.
  await page.evaluate(() => {
    const w = window as unknown as { __armStarts: number };
    w.__armStarts = 0;
    // Each record compared with the element's class right after it (see watchHold).
    new MutationObserver((ms) => {
      ms.forEach((m, i) => {
        const el = m.target as Element;
        const next = ms.slice(i + 1).find((n) => n.target === el);
        const after = next ? (next.oldValue ?? '') : el.className;
        if (after.split(/\s+/).includes('is-arming') && !(m.oldValue ?? '').split(/\s+/).includes('is-arming')) w.__armStarts += 1;
      });
    }).observe(document.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true });
  });
  const holding = page.locator('.srch__art.is-arming, .srch__art.is-preview');
  const row = page.locator('.srch__row').first();
  await row.locator('.srch__title').hover();
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(1);
  // Crossing child boundaries inside the row must neither cancel nor restart the hold.
  await row.locator('button.srch__art').hover();
  await expect(holding).toHaveCount(1);
  await row.locator('.srch__sub').hover();
  await expect(holding).toHaveCount(1);
  await expect(page.locator('.srch__art.is-preview')).toHaveCount(1, { timeout: 8000 });
  expect(await page.evaluate(() => (window as unknown as { __armStarts: number }).__armStarts), 'the hold started once, not again at each child boundary').toBe(1);
});

test('a link that is not a web link never reaches the page from the hub', async ({ page }) => {
  const evil = 'javascript' + ':alert(1)'; // the attack string under test, split past the lint rule
  await pairAndOpen(page, [hubRow({ previewUrl: evil, canonicalUrl: evil, artworkUrl: evil })]);
  await searchFor(page, 'Golden Hour');
  // With every URL refused, the row has no playable clip and nothing to open.
  await expect(page.locator('.srch__row button.srch__art')).toHaveCount(0);
  await expect(page.locator('.srch__row .srch__art').first()).toHaveAttribute('title', /No preview/);
  expect(await page.content()).not.toContain(evil);
});

test('a song added before its tempo arrives is filled in where it now lives', async ({ page }) => {
  await pairAndOpen(page, [hubRow({ bpm: null, bpmSource: null, previewUrl: null })]);
  // Deezer answers late, over JSONP, after the add has already happened.
  await page.route('**/api.deezer.com/**', async (r) => {
    const u = new URL(r.request().url());
    const cb = u.searchParams.get('callback') ?? 'cb';
    const payload = u.pathname.includes('/track/')
      ? { id: 7, bpm: 120, duration: 200 }
      : { data: [{ id: 7, duration: 200, title: 'Golden Hour', artist: { name: 'Artist' } }] };
    await new Promise((res) => setTimeout(res, 700));
    await r.fulfill({ status: 200, contentType: 'text/javascript', body: `${cb}(${JSON.stringify(payload)})` });
  });
  await searchFor(page, 'Golden Hour');
  await page.click('.srch__row[data-i="0"] .srch__add');
  const cell = page.locator('#libraryRows tr', { hasText: 'Golden Hour' }).first().locator('.lib-col-bpm');
  await expect(cell).toHaveText('—');
  await expect(cell).toHaveText('120', { timeout: 10_000 });
});

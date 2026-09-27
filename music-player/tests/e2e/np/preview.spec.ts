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

test('paired, the hub answers first: album, features, genre chip and bpm on the row', async ({ page }) => {
  const asked = await pairAndOpen(page, [hubRow()]);
  await page.fill('#q', 'Golden Hour');
  await page.press('#q', 'Enter');
  const row = page.locator('.srch__row').first();
  await expect(row.locator('.srch__title')).toHaveText('Golden Hour');
  await expect(row.locator('.srch__sub')).toContainText('Artist feat. Guest — Album');
  await expect(row.locator('.srch__genre')).toHaveText('hip hop');
  await expect(row.locator('.srch__bpm')).toHaveText('98 bpm');
  expect(asked.some((u) => u.startsWith('/api/v1/search'))).toBe(true);
});

test('a low-confidence row keeps the platform’s own words: no album, no chip', async ({ page }) => {
  await pairAndOpen(page, [hubRow({ albumName: 'Guessed Album', identity: { matchConfidence: 0.3 }, genres: [], genreProfile: {}, genre: null, featuredArtists: [] })]);
  await page.fill('#q', 'Golden Hour');
  await page.press('#q', 'Enter');
  const row = page.locator('.srch__row').first();
  await expect(row.locator('.srch__title')).toHaveText('Golden Hour');
  await expect(row.locator('.srch__sub')).not.toContainText('Guessed Album');
  await expect(row.locator('.srch__genre')).toHaveCount(0);
});

test('a hub that never answers leaves the chain to iTunes inside the deadline', async ({ page }) => {
  await page.route('**/itunes.apple.com/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ results: [{ trackName: 'Fallback Song', artistName: 'Someone', collectionName: 'LP', trackTimeMillis: 180000, previewUrl: 'https://audio-ssl.itunes.apple.com/x.m4a' }] }),
  }));
  await page.route(`${HUB}/**`, () => { /* black hole: the hub never answers */ });
  await boot(page);
  await page.evaluate(async (a) => {
    await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', a);
  }, ACCT);
  await page.goto('about:blank');
  await boot(page);
  await page.fill('#q', 'Fallback');
  await page.press('#q', 'Enter');
  await expect(page.locator('.srch__row .srch__title').first()).toHaveText('Fallback Song', { timeout: 12_000 });
});

test('a click plays up to thirty seconds, and the main track waits its turn', async ({ page }) => {
  await pairAndOpen(page, [hubRow()]);
  await page.route('https://p.scdn.co/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' }, body: silentWav() }));
  await page.fill('#q', 'Golden Hour');
  await page.press('#q', 'Enter');
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
  await page.fill('#q', 'Golden Hour');
  await page.press('#q', 'Enter');
  await expect(page.locator('.srch__row button.srch__art')).toHaveCount(0);
  await expect(page.locator('.srch__row .srch__art').first()).toHaveAttribute('title', /No preview/);
});

test('resting the pointer on a row arms it, fills the ring, and then plays', async ({ page }) => {
  await pairAndOpen(page, [hubRow()]);
  await page.route('https://p.scdn.co/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' }, body: silentWav() }));
  await page.fill('#q', 'Golden Hour');
  await page.press('#q', 'Enter');
  await page.waitForSelector('.srch__row');
  await page.evaluate(() => ((window as unknown as { NP_SRCH_ARM_MS: number }).NP_SRCH_ARM_MS = 300));
  await page.locator('.srch__row').first().hover();
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(1);
  await expect(page.locator('.srch__art.is-preview')).toHaveCount(1, { timeout: 3000 });
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(0);
});

test('leaving the row mid-hold cancels; nothing plays', async ({ page }) => {
  await pairAndOpen(page, [hubRow()]);
  await page.fill('#q', 'Golden Hour');
  await page.press('#q', 'Enter');
  await page.waitForSelector('.srch__row');
  await page.evaluate(() => ((window as unknown as { NP_SRCH_ARM_MS: number }).NP_SRCH_ARM_MS = 800));
  await page.locator('.srch__row').first().hover();
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(1);
  await page.mouse.move(10, 10);
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(0);
  await page.waitForTimeout(900);
  await expect(page.locator('.srch__art.is-preview')).toHaveCount(0);
});

test('a key press cancels the hold too', async ({ page }) => {
  await pairAndOpen(page, [hubRow()]);
  await page.fill('#q', 'Golden Hour');
  await page.press('#q', 'Enter');
  await page.waitForSelector('.srch__row');
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
    await p2.fill('#q', 'Golden Hour');
    await p2.press('#q', 'Enter');
    await p2.waitForSelector('.srch__row');
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
  await page.fill('#q', 'Hour');
  await page.press('#q', 'Enter');
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
  await page.route('https://p.scdn.co/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' }, body: silentWav() }));
  await page.fill('#q', 'Golden Hour');
  await page.press('#q', 'Enter');
  await page.waitForSelector('.srch__row');
  await page.evaluate(() => ((window as unknown as { NP_SRCH_ARM_MS: number }).NP_SRCH_ARM_MS = 700));
  const row = page.locator('.srch__row').first();
  await row.locator('.srch__title').hover();
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(1);
  // Crossing child boundaries inside the row must neither cancel nor restart the five seconds.
  await row.locator('button.srch__art').hover();
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(1);
  await row.locator('.srch__sub').hover();
  await expect(page.locator('.srch__art.is-arming')).toHaveCount(1);
  await expect(page.locator('.srch__art.is-preview')).toHaveCount(1, { timeout: 3000 });
});

test('a link that is not a web link never reaches the page from the hub', async ({ page }) => {
  const evil = 'javascript' + ':alert(1)'; // the attack string under test, split past the lint rule
  await pairAndOpen(page, [hubRow({ previewUrl: evil, canonicalUrl: evil, artworkUrl: evil })]);
  await page.fill('#q', 'Golden Hour');
  await page.press('#q', 'Enter');
  await page.waitForSelector('.srch__row');
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
  await page.fill('#q', 'Golden Hour');
  await page.press('#q', 'Enter');
  await page.waitForSelector('.srch__row');
  await page.click('.srch__row[data-i="0"] .srch__add');
  const cell = page.locator('#libraryRows tr', { hasText: 'Golden Hour' }).first().locator('.lib-col-bpm');
  await expect(cell).toHaveText('—');
  await expect(cell).toHaveText('120', { timeout: 10_000 });
});

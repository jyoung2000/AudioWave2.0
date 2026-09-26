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

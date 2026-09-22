/**
 * Profiles on the Docker container (NPD-025): pairing with the hub's own routes, then your name,
 * picture and shared playlists saved there; unique names; other people found from search and opened
 * in a sheet; your picture in place of the jewel case on Music. Ported from airwave-np
 * tests/profile.mjs.
 *
 * What changed: the profile routes the original simulated as a proposal are real contracts in this
 * repo (packages/contracts/src/api/routes.ts: /profiles/me, /profiles/available, /profiles?q=, the
 * avatar and the playlists CSV), so the stub answers them as the contract does. The original wrote a
 * “Late Night” playlist naming demo ids into `library:state`; here the eight WAVs are seeded and the
 * playlist is made from two real rows through the row menu. Mara's shared playlist names a seeded
 * song (Blue Hour by Alder Quartet), so “playable where you have them” is checked against the real
 * library.
 */
import { expect, test } from '@playwright/test';
import { addToPlaylist, boot, CORS, HUB, newPlaylistWith, resetToLibrary, seed, stubOffline, watchErrors } from './_shell';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
type List = { name: string; csv: string };
type User = { id: string; displayName: string; avatar: Buffer | null; lists: Record<string, List> };

let errors: string[];
test.use({ viewport: { width: 1280, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ page }) => { errors = watchErrors(page); await stubOffline(page); });
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('pair, edit the profile on the container, find someone, open their profile', async ({ page }) => {
  test.setTimeout(120_000); // seeding, a playlist, pairing's polling and a save: one long journey
  const hub = {
    status: 'claimed', auth: null as string | null, calls: [] as string[],
    users: {
      me: { id: 'u-me', displayName: 'jalon', avatar: null, lists: {} } as User,
      // ported: the shared playlist names a seeded song, so one of its rows is playable here
      mara: { id: 'u-mara', displayName: 'Mara', avatar: PNG, lists: { l1: { name: 'Sunday Records', csv: 'title,artist,album,seconds\nBlue Hour,Alder Quartet,,236\nSomething Else,Nobody,,200\n' } } } as User,
    },
  };
  const view = (u: User) => ({ id: u.id, displayName: u.displayName, avatarUrl: u.avatar ? '/api/v1/profiles/' + u.id + '/avatar' : null,
    playlists: Object.entries(u.lists).map(([id, l]) => ({ id, name: l.name, tracks: l.csv.trim().split('\n').length - 1 })) });
  const byId = (id: string) => Object.values(hub.users).find((u) => u.id === id);

  await page.route(HUB + '/**', async (r) => {
    const q = r.request(), u = new URL(q.url()), path = u.pathname, m = q.method();
    const json = (o: unknown, s = 200) => r.fulfill({ status: s, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    hub.calls.push(m + ' ' + path);
    if (path === '/healthz') return json({ status: 'ok', version: '2.3.0' });
    if (path === '/readyz') return json({ status: 'ok', checks: { database: 'ok' } });
    if (path === '/api/v1/hub') return json({ hubId: 'h1', name: 'TOWER', fingerprint: 'AB12' });
    if (path === '/api/v1/pairing/claim') {
      const body = q.postDataJSON() as { code: string };
      return body.code === '12345678'
        ? json({ sessionId: '00000000-0000-4000-8000-000000000001', claimSecret: 'cs', verificationFingerprint: 'K7 Q2 M4', hubFingerprint: 'AB12', hubId: 'h1', hubName: 'TOWER', expiresAt: new Date(Date.now() + 6e5).toISOString() })
        : json({ error: 'bad code' }, 400);
    }
    if (path === '/api/v1/pairing/status') { const s = hub.status; hub.status = 'confirmed'; return json({ state: s }); }
    if (path === '/api/v1/pairing/complete') return json({ credentialId: '00000000-0000-4000-8000-0000000000aa', deviceId: 'd1', hubId: 'h1', hubName: 'TOWER', hubFingerprint: 'AB12', endpoint: HUB, secret: 'x'.repeat(40), scopes: ['library:read'], issuedAt: new Date().toISOString() });
    hub.auth = q.headers()['authorization'] ?? null;
    if (!hub.auth || !hub.auth.startsWith('Bearer 00000000-0000-4000-8000-0000000000aa.')) return json({ error: 'auth' }, 401);
    const me = hub.users.me;
    if (path === '/api/v1/profiles/me' && m === 'GET') return json(view(me));
    if (path === '/api/v1/profiles/me' && m === 'PATCH') {
      const n = (q.postDataJSON() as { displayName: string }).displayName;
      if (Object.values(hub.users).some((x) => x !== me && x.displayName.toLowerCase() === n.toLowerCase())) return json({ error: 'taken' }, 409);
      me.displayName = n; return json(view(me));
    }
    if (path === '/api/v1/profiles/available') { const n = (u.searchParams.get('name') ?? '').toLowerCase(); return json({ available: !Object.values(hub.users).some((x) => x !== me && x.displayName.toLowerCase() === n) }); }
    if (path === '/api/v1/profiles/me/avatar' && m === 'PUT') { me.avatar = q.postDataBuffer(); return json({ ok: true }); }
    let mm: RegExpMatchArray | null;
    if ((mm = path.match(/^\/api\/v1\/profiles\/me\/playlists\/([^/]+)$/))) {
      if (m === 'PUT') { me.lists[decodeURIComponent(mm[1]!)] = { name: u.searchParams.get('name') ?? '', csv: q.postData() ?? '' }; return json({ ok: true }); }
      delete me.lists[decodeURIComponent(mm[1]!)]; return json({ ok: true });
    }
    if (path === '/api/v1/profiles') { const s = (u.searchParams.get('q') ?? '').toLowerCase(); return json({ items: Object.values(hub.users).filter((x) => x !== me && x.displayName.toLowerCase().includes(s)).map((x) => ({ ...view(x), playlistCount: Object.keys(x.lists).length })) }); }
    if ((mm = path.match(/^\/api\/v1\/profiles\/([^/]+)\/avatar$/))) { const x = byId(mm[1]!); return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/png' }, body: x?.avatar ?? Buffer.alloc(0) }); }
    if ((mm = path.match(/^\/api\/v1\/profiles\/([^/]+)\/playlists\/([^/]+)\.csv$/))) { const x = byId(mm[1]!); return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/csv' }, body: x?.lists[mm[2]!]?.csv ?? '' }); }
    if ((mm = path.match(/^\/api\/v1\/profiles\/([^/]+)$/))) { const x = byId(mm[1]!); return x ? json(view(x)) : json({}, 404); }
    return json({ error: 'nope' }, 404);
  });

  await boot(page);
  // ported: a real playlist from two seeded rows, in place of one naming demo ids written to kv
  await seed(page);
  await page.click('#mode [data-mode="solo"]'); await page.waitForTimeout(200);
  await resetToLibrary(page);
  await newPlaylistWith(page, 'Harbour Morning', 'Late Night');
  await addToPlaylist(page, 'Gantry', 'Late Night');
  const plId = await page.evaluate(async () => {
    const s = (await (window as unknown as { kv: { get(k: string): Promise<unknown> } }).kv.get('library:state')) as { playlists?: Array<{ id: string; name: string; songs: string[] }> } | null;
    const pl = s?.playlists?.find((x) => x.name === 'Late Night');
    return pl && pl.songs.length === 2 ? pl.id : null;
  });
  expect(plId, 'the “Late Night” playlist holds two real songs').toBeTruthy();

  await boot(page, '#settings/src');
  expect(await page.$eval('#pt-profile', (t) => (t as HTMLElement).hidden), 'no Profile tab before the container is paired').toBe(true);
  await page.fill('#cfgHub', '192.168.1.20:4546'); await page.click('#hubTest');
  await expect(page.locator('#hubPair'), 'once the container answers, it offers to pair').toBeVisible();
  await page.fill('#hubCode', '1234'); await page.click('#hubPairBtn');
  await expect(page.locator('#hubPairMsg'), 'a short code is refused before asking').toContainText(/8 or more characters/);
  await page.fill('#hubCode', '1234 5678'); await page.click('#hubPairBtn');
  await expect(page.locator('#hubPairMsg'), 'pairing shows the fingerprint to confirm on the container').toContainText('K7 Q2 M4');
  await expect(page.locator('#pt-profile'), 'once confirmed, the Profile tab appears').toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#hubPairMsg'), 'and Connections says it is paired').toContainText(/paired with TOWER/);

  await page.click('#pt-profile'); await page.waitForTimeout(700);
  await expect(page.locator('#pfName'), 'the profile loads from the container').toHaveValue('jalon');
  expect(hub.auth?.startsWith('Bearer 00000000-0000-4000-8000-0000000000aa.'), 'with the device credential the container issued').toBe(true);
  await page.fill('#pfName', 'mara'); await page.waitForTimeout(700);
  await expect(page.locator('#pfMsg'), 'a name someone else has is caught as you type, whatever its case').toContainText(/is taken on TOWER/);
  await page.click('#pfSave'); await page.waitForTimeout(200);
  await expect(page.locator('#pfMsg'), 'and cannot be saved').toContainText(/is taken/);
  expect(hub.calls, 'no PATCH was sent').not.toContain('PATCH /api/v1/profiles/me');
  await page.fill('#pfName', 'Jalon Y'); await page.waitForTimeout(700);
  await expect(page.locator('#pfMsg'), 'a free name says so').toContainText(/is free/);
  await page.setInputFiles('#pfFile', { name: 'me.png', mimeType: 'image/png', buffer: PNG }); await page.waitForTimeout(500);
  expect(await page.$eval('#pfImg', (i) => (i as HTMLElement).hidden), 'a chosen picture previews at once').toBe(false);
  await page.check(`#pfLists [data-pl="${plId}"]`);
  await page.setInputFiles('#pfCsvFile', { name: 'Road Trip.csv', mimeType: 'text/csv', buffer: Buffer.from('Title,Artist\nBlue Hour,Alder Quartet\n"Comma, Song",Band\n') }); await page.waitForTimeout(300);
  await expect(page.locator('#pfLists'), 'a CSV can be added as a playlist').toContainText('Road Trip');
  await page.click('#pfSave');
  await expect(page.locator('#pfMsg'), 'save reports where it saved').toContainText(/Saved to TOWER/, { timeout: 5000 });
  const me = hub.users.me;
  expect(me.displayName === 'Jalon Y' && !!me.avatar && me.avatar.length > 100, 'the name and a 256 px picture are on the container').toBe(true);
  const late = me.lists[plId!];
  expect(!!late && late.name === 'Late Night' && /^title,artist,album,seconds\n/.test(late.csv) && late.csv.trim().split('\n').length === 3, 'the shared playlist is on the container as CSV: ' + JSON.stringify(late)).toBe(true);
  expect(late!.csv, 'naming the two real songs').toContain('Harbour Morning,Alder Quartet');
  const road = Object.values(me.lists).find((l) => l.name === 'Road Trip');
  expect(road?.csv, 'and so is the CSV, with its quoting kept').toContain('"Comma, Song",Band');

  await page.click('#prefsBack'); await page.waitForTimeout(500);
  expect(await page.$eval('#stage', (s) => s.classList.contains('has-me') && !!s.querySelector('.player__me img')), 'your picture takes the jewel case’s place on the Music page').toBe(true);
  await page.click('.tb__btn[data-view="radio"]'); await page.waitForTimeout(400);
  expect(await page.$eval('#stage', (s) => s.classList.contains('has-me')), 'and only there').toBe(false);
  await page.click('.tb__btn[data-view="music"]'); await page.waitForTimeout(400);

  await page.fill('#q', 'mar'); await page.keyboard.press('Enter');
  await expect(page.locator('#srchPeople [data-person="u-mara"]'), 'search lists people on the container').toBeVisible();
  await expect(page.locator('#srchPeople'), 'with how much they share').toContainText('1 shared playlist');
  await expect.poll(() => page.$eval('#srchPeople img', (i) => (i as HTMLImageElement).naturalWidth > 0).catch(() => false), { message: 'and their picture' }).toBe(true);
  await page.click('#srchPeople [data-person="u-mara"]'); await page.waitForTimeout(700);
  expect(await page.isVisible('#pfv') && (await page.textContent('#pfvName')) === 'Mara', 'a profile opens in a sheet').toBe(true);
  await expect(page.locator('#pfvTracks'), 'their playlist lists its songs').toContainText('Blue Hour');
  expect(await page.$$('#pfvTracks [data-play]'), 'playable where you have them').toHaveLength(1);
  await expect(page.locator('#pfvTracks'), 'and says which are not in your library').toContainText('Not in your library');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  expect(await page.$eval('#pfv', (x) => (x as HTMLElement).hidden), 'Escape closes it').toBe(true);
});

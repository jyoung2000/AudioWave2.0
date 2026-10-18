/**
 * Sources ▸ Connections: the companion app and the Docker container, tested against the endpoints
 * this repo defines, with every request logged and a table of what goes where; then Backup, and a
 * phone. Ported from airwave-np tests/connect.mjs.
 *
 * What changed: Back Up Now no longer claims to have requested anything. The original asserted
 * `#bkMsg` read “Requested: Music to the docker container”; the shell measures only, so the message
 * is asserted to name what the backup would hold and to say nothing was sent, and the connection
 * log entry to carry the result “measured only”. Everything else is the original's.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, reload, watchErrors } from './_shell';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'content-type': 'application/json' };
const HELPER = {
  helper: 'now-playing-local-helper', protocol: 1, version: '0.9.2', servesApp: false,
  tools: [{ id: 'yt-dlp', present: true, version: '2026.09.14', origin: 'installed', installHint: null, installable: true },
    { id: 'spotdl', present: true, version: '4.2.11', origin: 'path', installHint: null, installable: false },
    { id: 'ffmpeg', present: false, version: null, origin: 'missing', installHint: 'Install FFmpeg from the companion.', installable: true }],
  allowedHosts: ['youtube.com', 'soundcloud.com'], formats: ['original'], startedAt: new Date(Date.now() - 36e5).toISOString(),
};
const EST = { parts: { music: { bytes: 42.5e9, files: 8120 } }, destination: { path: 'D:\\Airwave\\Backups', freeBytes: 120e9, totalBytes: 500e9 } };
type Prefs = { hub?: string; backup?: { to?: string } } | null;
const prefs = (p: Page) => p.evaluate(async () => ((await (window as unknown as { kv: { get(k: string): Promise<unknown> } }).kv.get('player:prefs')) as Prefs) ?? {});
const passed = (p: Page) => p.$$eval('#connPassed tbody tr', (rs) => rs.map((r) => [...(r as HTMLTableRowElement).cells].map((c) => c.textContent ?? '')));

let errors: string[];
test.beforeEach(async ({ page }) => { errors = watchErrors(page); });
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test.describe('desktop', () => {
  test.use({ viewport: { width: 1100, height: 1000 }, contextOptions: { reducedMotion: 'reduce' } });

  test('the companion, the container and backup', async ({ page }) => {
    // 17342 is taken by something else; the helper answers on the next port up
    await page.route('http://127.0.0.1:17342/**', (r) => r.fulfill({ status: 404, headers: CORS, body: '{"error":"nope"}' }));
    await page.route('http://127.0.0.1:17343/helper/v1/**', async (r) => {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/health')) return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(HELPER) });
      if (path.includes('/jobs/')) {
        const accepted = r.request().headers()['x-helper-token'] === 'test-token';
        return r.fulfill({ status: accepted ? 404 : 401, headers: CORS, body: JSON.stringify({ error: accepted ? 'not-found' : 'auth' }) });
      }
      if (path.endsWith('/backup/estimate')) return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(EST) });
      return r.fulfill({ status: 404, headers: CORS, body: '{"error":"no route"}' });
    });
    await page.route(/^http:\/\/127\.0\.0\.1:1734[45]\//, (r) => r.abort('connectionrefused'));
    await page.route('http://192.168.1.20:4546/healthz', (r) => r.fulfill({ status: 200, headers: CORS, body: '{"status":"ok","version":"2.3.0"}' }));
    await page.route('http://192.168.1.20:4546/readyz', (r) => r.fulfill({ status: 200, headers: CORS, body: '{"status":"ok","checks":{"database":"ok","migrations":"ok","identity":"ok","setup":"skipped"}}' }));
    await page.route('http://192.168.1.20:4546/api/v1/hub', (r) => r.fulfill({ status: 200, headers: CORS, body: '{"hubId":"h1","name":"TOWER","fingerprint":"AB12 CD34 EF56"}' }));
    await page.route('http://192.168.1.99:4546/**', (r) => r.fulfill({ status: 200, headers: CORS, body: '<html>router</html>' }));

    await boot(page, '#settings/src');
    expect(await page.isVisible('#connGroup') && await page.isVisible('#pcTicket') && await page.isVisible('#pcCode') && await page.isVisible('#cfgLegacyHelper') && !(await page.isVisible('#cfgCompanionToken')) && await page.isVisible('#cfgHub'), 'Sources presents one Companion address+code flow and keeps legacy helper credentials advanced').toBe(true);
    expect(await page.$('#pp-player #cfgCompanion'), 'and the legacy helper address no longer sits under Player').toBeNull();
    await page.locator('#cfgLegacyHelper summary').click();
    await expect(page.locator('#cfgCompanionToken')).toBeVisible();
    const before = await passed(page);
    expect(before.length >= 8 && before.every((r) => r[3] === '—' || /Waiting/.test(r[3]!)), 'before any test nothing claims to be connected: ' + JSON.stringify(before)).toBe(true);

    // public health locates it; the protected request pairs it only with the supplied token
    await page.fill('#cfgCompanionToken', 'test-token');
    await page.click('#cfgConnect');
    await expect(page.locator('#cfgConnMsg'), 'it authenticates the helper before reporting its tools').toContainText(/Connected, but 1 downloader is missing/);
    const facts = (await page.textContent('#connAppFacts')) ?? '';
    expect(facts.includes('v0.9.2') && facts.includes('yt-dlp 2026.09.14') && facts.includes('ffmpeg missing') && facts.includes('youtube.com'), 'and shows what it answered: ' + facts).toBe(true);
    expect(await page.getAttribute('#connAppDot', 'data-state'), 'a missing downloader turns its light amber').toBe('warn');
    const log1 = await page.$$eval('#connLog li', (ls) => ls.map((l) => l.textContent ?? ''));
    expect(log1.some((l) => l.includes('127.0.0.1:17342/helper/v1/health') && l.includes('404')) && log1.some((l) => l.includes(':17343/') && l.includes('200')), 'the log shows each request and what came back').toBe(true);
    expect(await page.evaluate(() => (window as unknown as { COMPANION?: string }).COMPANION), 'and the player uses the address it found').toBe('http://127.0.0.1:17343');
    await expect(page.locator('#cfgCompanionToken')).toHaveValue('test-token');
    await expect(page.locator('#cfgForgetToken')).toBeVisible();
    await expect(page.locator('#cfgTokenSaved')).toBeVisible();
    expect(await page.evaluate(async () => await window.NP_TOOLS?.hasSaved()), 'the accepted token is saved for this browser').toBe(true);
    expect(await page.evaluate(() => Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i) ?? '')).some((value) => value?.includes('test-token'))), 'the token is not stored in localStorage').toBe(false);

    // A stale address hint must not make startup retry the saved token at the
    // wrong port: the authenticated saved origin is authoritative on reload.
    await page.evaluate(async () => {
      const stored = await window.storage!.get('player:prefs');
      const next = { ...JSON.parse(stored?.value ?? '{}'), companion: 'http://127.0.0.1:17342' };
      await window.storage!.set('player:prefs', JSON.stringify(next));
    });
    await reload(page);
    await expect(page.locator('#cfgConnMsg'), 'the accepted token reconnects automatically after reload').toContainText('Connected, but 1 downloader is missing.');
    await page.locator('#cfgLegacyHelper summary').click();
    await expect(page.locator('#cfgTokenSaved'), 'the UI confirms the token remains saved after reload').toBeVisible();
    await expect(page.locator('#cfgCompanionToken'), 'the masked field is restored from persistent storage').toHaveValue('test-token');
    const reconnected = await page.evaluate(async () => await window.NP_TOOLS?.detect());
    expect(reconnected?.kind === 'helper' && reconnected.saved && reconnected.origin === 'http://127.0.0.1:17343').toBe(true);

    // fill a folder and see where it goes
    await page.fill('#srcMusic', 'C:\\Users\\jalon\\Music'); await page.dispatchEvent('#srcMusic', 'change');
    const music = (await passed(page))[0]!;
    expect(music[1]!.includes('C:\\Users\\jalon\\Music') && music[2] === 'Companion app' && music[3] === 'Ready', 'a folder shows up as passed to the companion, ready: ' + JSON.stringify(music)).toBe(true);

    // A local browser now defaults to the loopback Hub; clear it to test the empty-address error.
    await page.fill('#cfgHub', '');
    await page.click('#hubTest'); await page.waitForTimeout(200);
    await expect(page.locator('#hubMsg'), 'the container needs an address to test').toContainText(/address first/);
    await page.fill('#cfgHub', '192.168.1.99:4546'); await page.click('#hubTest');
    await expect(page.locator('#hubMsg'), 'a web page that is not the hub is called out').toContainText(/not the Airwave container/);
    await page.fill('#cfgHub', '192.168.1.20:4546'); await page.click('#hubTest');
    await expect(page.locator('#hubMsg'), 'a bare host:port is read as http and connects').toContainText('Connected to TOWER');
    const hf = (await page.textContent('#connHubFacts')) ?? '';
    expect(hf.includes('v2.3.0') && hf.includes('database ok') && hf.includes('AB12 CD34 EF56') && hf.includes('your own network'), 'and shows its name, version, readiness checks, fingerprint and encryption: ' + hf).toBe(true);
    expect(await page.getAttribute('#connHubDot', 'data-state'), 'with a green light').toBe('ok');
    const m3u = (await passed(page)).find((r) => r[0] === 'Channel playlists');
    expect(m3u?.[2] === 'Docker container' && m3u?.[3] === '—', 'an unset playlist is not shown as ready: ' + JSON.stringify(m3u)).toBe(true);
    await expect.poll(async () => (await prefs(page))!.hub, { message: 'the container address is kept' }).toBe('http://192.168.1.20:4546');

    // backup
    expect(await page.isVisible('#bkGroup'), 'Sources has a Backup section').toBe(true);
    expect(await page.$$eval('#bkTo option', (o) => o.map((x) => x.textContent)), 'backups go to the container, the companion app, or both').toEqual(['Docker container', 'Windows companion app', 'Both']);
    await page.uncheck('#bkMusic'); await page.uncheck('#bkLists'); await page.uncheck('#bkAlgo'); await page.waitForTimeout(100);
    expect(await page.$eval('#bkNow', (b) => (b as HTMLButtonElement).disabled), 'nothing ticked, nothing to back up').toBe(true);
    await expect(page.locator('#bkMsg')).toContainText(/Tick something/);
    await page.check('#bkTv'); await page.waitForTimeout(100);
    await expect(page.locator('#bkMsg'), 'TV needs its folder set first').toContainText(/Set a Saved TV folder/);
    await page.uncheck('#bkTv'); await page.check('#bkMusic'); await page.selectOption('#bkWhen', 'daily'); await page.waitForTimeout(100);
    expect(await page.$eval('#bkNow', (b) => (b as HTMLButtonElement).disabled), 'with the music folder set and both connected, Back Up Now is ready').toBe(false);
    const bkRow = (await passed(page)).find((r) => r[0] === 'Backup');
    expect(bkRow?.slice(1), 'what’s passed shows the backup and where it goes').toEqual(['Music · every night', 'Docker container', 'Ready']);
    await page.click('#bkNow'); await page.waitForTimeout(150);
    // ported: was “Requested: Music to the docker container”; the shell measures, it sends nothing
    await expect(page.locator('#bkMsg'), 'Back Up Now says what the backup would hold').toContainText('This backup would hold Music');
    await expect(page.locator('#bkMsg'), 'and that nothing was sent').toContainText('Nothing was sent');
    await expect(page.locator('#connLog'), 'and the connection log records it').toContainText('Music → Docker container');
    // ported: new — the log entry's result is “measured only”, not a claim of a request
    await expect(page.locator('#connLog'), 'as measured only').toContainText('measured only');
    await page.selectOption('#bkTo', 'both'); await page.waitForTimeout(100);
    expect((await passed(page)).filter((r) => r[0] === 'Backup'), 'both: one backup row for each destination').toHaveLength(2);
    await expect.poll(async () => (await prefs(page))!.backup?.to, { message: 'the choice is kept' }).toBe('both');
    await expect(page.locator('#bkSize'), 'Backup gives an expected size, from the companion’s measure of the folder').toHaveText(/^About 42\.5 GB$/);
    await expect(page.locator('#bkParts'), 'and says what makes it up').toContainText('Music');
    const space = (await page.textContent('#bkSpace')) ?? '';
    expect(/120 GB free of 500 GB/.test(space) && /D:\\Airwave\\Backups/.test(space), 'and how much space the backup location has: ' + space.slice(0, 120)).toBe(true);
    expect(space, 'the container’s free space waits for pairing, and says so').toMatch(/Pair this player/);
    expect(await page.isVisible('#bkAlgo'), 'algorithms are on the list of things to back up').toBe(true);

    // nothing there
    await page.route('http://10.9.9.9:4546/**', (r) => r.abort('connectionrefused'));
    await page.fill('#cfgHub', 'http://10.9.9.9:4546'); await page.click('#hubTest');
    await expect(page.locator('#hubMsg'), 'a container that is not there says so').toContainText(/No answer from http:\/\/10\.9\.9\.9:4546/);
    expect(await page.getAttribute('#connHubDot', 'data-state'), 'with a red light').toBe('bad');

    await page.click('#cfgForgetToken');
    await expect(page.locator('#cfgConnMsg')).toContainText('Saved token forgotten.');
    await expect(page.locator('#cfgForgetToken')).toBeHidden();
    await expect(page.locator('#cfgTokenSaved')).toBeHidden();
    await expect(page.locator('#cfgCompanionToken')).toHaveValue('');
    expect(await page.evaluate(async () => await window.NP_TOOLS?.hasSaved())).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { COMPANION?: string }).COMPANION)).toBeUndefined();
  });

  test('a saved Companion pairing ignores an outdated address hint after a reload', async ({ page }) => {
    const wrongPort: string[] = [];
    let helperOnline = true;
    await page.route('http://127.0.0.1:17342/helper/v1/**', (route) => {
      wrongPort.push(new URL(route.request().url()).pathname);
      const health = route.request().url().endsWith('/health');
      return route.fulfill({ status: health ? 200 : 401, headers: CORS, body: JSON.stringify(health ? HELPER : { error: 'auth' }) });
    });
    await page.route('http://127.0.0.1:17343/helper/v1/**', (route) => {
      const health = route.request().url().endsWith('/health');
      return route.fulfill({ status: !helperOnline ? 503 : health ? 200 : 404, headers: CORS, body: JSON.stringify(health && helperOnline ? HELPER : { error: 'not-found' }) });
    });
    await boot(page, '#settings/src');
    expect(await page.evaluate(() => window.NP_TOOLS!.connect('http://127.0.0.1:17343', 'test-token'))).toMatchObject({ saved: true });
    await page.evaluate(async () => {
      const stored = await window.storage!.get('player:prefs');
      await window.storage!.set('player:prefs', JSON.stringify({ ...JSON.parse(stored?.value ?? '{}'), companion: 'http://127.0.0.1:17342' }));
    });
    await reload(page);
    await expect(page.locator('#cfgConnMsg')).toContainText('Connected, but 1 downloader is missing.');
    expect((await page.evaluate(() => window.NP_TOOLS!.detect()))?.origin).toBe('http://127.0.0.1:17343');
    expect(wrongPort.filter((path) => path.includes('/jobs/')), 'the saved token must not be retried at a stale port').toEqual([]);

    helperOnline = false;
    await reload(page);
    await expect(page.locator('#cfgConnMsg')).toContainText('Saved Companion pairing is offline.');
    await expect(page.locator('#cfgCompanion')).toHaveValue('http://127.0.0.1:17343');
    expect(await page.evaluate(() => window.NP_TOOLS!.hasSaved())).toBe(true);
    helperOnline = true;
    await page.locator('#cfgLegacyHelper summary').click();
    await page.locator('#cfgConnect').click();
    await expect(page.locator('#cfgConnMsg')).toContainText('Connected, but 1 downloader is missing.');
    expect(wrongPort.filter((path) => path.includes('/jobs/'))).toEqual([]);
  });

  test('a saved Player pairing checks the live Hub connection on every load', async ({ page }) => {
    let publicChecks = 0;
    let protectedChecks = 0;
    let hubOnline = true;
    let liveScopes = ['search:use', 'downloads:request', 'transfers:receive'];
    await page.route('http://127.0.0.1:4546/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (path === '/healthz') { publicChecks++; if (!hubOnline) return route.abort('connectionrefused'); return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ status: 'ok', version: '2.3.0' }) }); }
      if (path === '/readyz') return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ status: 'ok', checks: { database: 'ok' } }) });
      if (path === '/api/v1/hub') return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ name: 'TOWER', fingerprint: 'AB12' }) });
      if (route.request().headers().authorization === 'Bearer synthetic-device.synthetic-secret') protectedChecks++;
      if (path === '/api/v1/devices/me') return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ scopes: liveScopes }) });
      if (path === '/api/v1/profiles/me') return route.fulfill({ status: 403, headers: CORS, body: '{}' });
      if (path === '/api/v1/providers') return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ items: [], health: [] }) });
      if (path === '/api/v1/tools/status') return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ tools: Object.fromEntries(['yt-dlp', 'spotdl', 'ffmpeg'].map((id) => [id, { present: true, state: 'ready', version: 'test', reason: null }])), musicsearch: { configured: false, state: 'disabled', reason: null } }) });
      return route.fulfill({ status: 404, headers: CORS, body: '{}' });
    });
    await boot(page, '#settings/src');
    await page.fill('#cfgHub', 'http://127.0.0.1:4546');
    await page.dispatchEvent('#cfgHub', 'change');
    await expect.poll(async () => (await prefs(page))!.hub).toBe('http://127.0.0.1:4546');
    await page.evaluate(async () => { await (window as unknown as { kv: { set(k: string, v: unknown): Promise<void> } }).kv.set('player:hub', { base: 'http://127.0.0.1:4546', credentialId: 'synthetic-device', secret: 'synthetic-secret', hubName: 'TOWER', scopes: ['search:use', 'downloads:request', 'transfers:receive'] }); });
    await reload(page);
    await expect(page.locator('#cfgHub')).toHaveValue('http://127.0.0.1:4546');
    await expect(page.locator('#hubPairMsg')).toContainText('paired with TOWER');
    await expect(page.locator('#hubPairMsg')).toContainText('Profile access was not granted');
    await expect(page.locator('#hubMsg')).toHaveText(/^Connected to (TOWER|the container)\.$/);
    await expect(page.locator('#connHubDot')).toHaveAttribute('data-state', 'ok');
    expect(publicChecks).toBeGreaterThan(0);
    expect(protectedChecks).toBeGreaterThan(0);
    await page.click('#pt-profile');
    await expect(page.locator('#pfGate')).toContainText('profile:read');
    liveScopes = [...liveScopes, 'profile:read', 'profile:write'];
    await reload(page);
    await expect(page.locator('#hubMsg')).toHaveText(/^Connected to (TOWER|the container)\.$/);
    await expect(page.locator('#hubPairMsg')).not.toContainText('Profile access was not granted');
    await expect.poll(async () => (await page.evaluate(async () => (await (window as unknown as { kv: { get(k: string): Promise<{ scopes: string[] }> } }).kv.get('player:hub')).scopes))).toContain('profile:read');
    expect(publicChecks).toBeGreaterThan(1);
    hubOnline = false;
    await reload(page);
    await expect(page.locator('#hubMsg')).toContainText('No answer from http://127.0.0.1:4546');
    await expect(page.locator('#connHubDot')).toHaveAttribute('data-state', 'bad');
  });

  test('public health is not pairing, a wrong token is refused, and remote token targets are blocked', async ({ page }) => {
    const probeTokens: string[] = [];
    const externalRequests: string[] = [];
    page.on('request', (request) => { if (request.url().includes('attacker.example')) externalRequests.push(request.url()); });
    await page.route('https://attacker.example/**', (r) => r.abort());
    await page.route('http://127.0.0.1:17343/helper/v1/**', async (r) => {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
      const path = new URL(r.request().url()).pathname;
      if (path.endsWith('/health')) return r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(HELPER) });
      if (path.includes('/jobs/')) { probeTokens.push(r.request().headers()['x-helper-token'] ?? ''); return r.fulfill({ status: 401, headers: CORS, body: '{"error":"auth"}' }); }
      return r.fulfill({ status: 404, headers: CORS, body: '{"error":"no route"}' });
    });
    await boot(page, '#settings/src');
    await page.locator('#cfgLegacyHelper summary').click();
    await page.fill('#cfgCompanion', '127.0.0.1:17343');
    await page.fill('#cfgCompanionToken', 'wrong-token');
    await page.click('#cfgConnect');
    await expect(page.locator('#cfgConnMsg')).toContainText('did not accept that token');
    expect(probeTokens).toEqual(['wrong-token']);
    expect(await page.evaluate(async () => await window.NP_TOOLS?.hasSaved())).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { COMPANION?: string }).COMPANION)).toBeUndefined();

    await page.fill('#cfgCompanion', 'https://attacker.example');
    await page.fill('#cfgCompanionToken', 'never-send-this');
    await page.click('#cfgConnect');
    await expect(page.locator('#cfgConnMsg')).toContainText('Use localhost');
    expect(externalRequests).toEqual([]);
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('the connections fit the width', async ({ page }) => {
    await boot(page, '#settings/src');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), 'on a phone the connections fit the width').toBe(false);
  });
});

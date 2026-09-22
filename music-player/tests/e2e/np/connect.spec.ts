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
import { boot, watchErrors } from './_shell';

const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
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
    await page.route('http://127.0.0.1:17343/helper/v1/health', (r) => r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(HELPER) }));
    await page.route('http://127.0.0.1:17343/helper/v1/backup/estimate**', (r) => r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(EST) }));
    await page.route(/^http:\/\/127\.0\.0\.1:1734[45]\//, (r) => r.abort('connectionrefused'));
    await page.route('http://192.168.1.20:4546/healthz', (r) => r.fulfill({ status: 200, headers: CORS, body: '{"status":"ok","version":"2.3.0"}' }));
    await page.route('http://192.168.1.20:4546/readyz', (r) => r.fulfill({ status: 200, headers: CORS, body: '{"status":"ok","checks":{"database":"ok","migrations":"ok","identity":"ok","setup":"skipped"}}' }));
    await page.route('http://192.168.1.20:4546/api/v1/hub', (r) => r.fulfill({ status: 200, headers: CORS, body: '{"hubId":"h1","name":"TOWER","fingerprint":"AB12 CD34 EF56"}' }));
    await page.route('http://192.168.1.99:4546/**', (r) => r.fulfill({ status: 200, headers: CORS, body: '<html>router</html>' }));

    await boot(page, '#settings/src');
    expect(await page.isVisible('#connGroup') && await page.isVisible('#cfgCompanion') && await page.isVisible('#cfgHub'), 'Sources has both connections: the companion app and the Docker container').toBe(true);
    expect(await page.$('#pp-player #cfgCompanion'), 'and the companion address no longer sits under Player').toBeNull();
    const before = await passed(page);
    expect(before.length >= 8 && before.every((r) => r[3] === '—' || /Waiting/.test(r[3]!)), 'before any test nothing claims to be connected: ' + JSON.stringify(before)).toBe(true);

    // the companion app, found by scanning its ports
    await page.click('#cfgConnect');
    await expect(page.locator('#cfgConnMsg'), 'an empty address scans the helper ports and finds the app').toContainText(/Connected, but 1 downloader is missing/);
    const facts = (await page.textContent('#connAppFacts')) ?? '';
    expect(facts.includes('v0.9.2') && facts.includes('yt-dlp 2026.09.14') && facts.includes('ffmpeg missing') && facts.includes('youtube.com'), 'and shows what it answered: ' + facts).toBe(true);
    expect(await page.getAttribute('#connAppDot', 'data-state'), 'a missing downloader turns its light amber').toBe('warn');
    const log1 = await page.$$eval('#connLog li', (ls) => ls.map((l) => l.textContent ?? ''));
    expect(log1.some((l) => l.includes('127.0.0.1:17342/helper/v1/health') && l.includes('404')) && log1.some((l) => l.includes(':17343/') && l.includes('200')), 'the log shows each request and what came back').toBe(true);
    expect(await page.evaluate(() => (window as unknown as { COMPANION?: string }).COMPANION), 'and the player uses the address it found').toBe('http://127.0.0.1:17343');

    // fill a folder and see where it goes
    await page.fill('#srcMusic', 'C:\\Users\\jalon\\Music'); await page.dispatchEvent('#srcMusic', 'change');
    const music = (await passed(page))[0]!;
    expect(music[1]!.includes('C:\\Users\\jalon\\Music') && music[2] === 'Companion app' && music[3] === 'Ready', 'a folder shows up as passed to the companion, ready: ' + JSON.stringify(music)).toBe(true);

    // the container
    await page.click('#hubTest'); await page.waitForTimeout(200);
    await expect(page.locator('#hubMsg'), 'the container needs an address to test').toContainText(/address first/);
    await page.fill('#cfgHub', '192.168.1.99:4546'); await page.click('#hubTest');
    await expect(page.locator('#hubMsg'), 'a web page that is not the hub is called out').toContainText(/not the Now Playing container/);
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
    await page.waitForTimeout(400);
    expect(await page.textContent('#bkSize'), 'Backup gives an expected size, from the companion’s measure of the folder').toMatch(/^About 42\.5 GB$/);
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
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('the connections fit the width', async ({ page }) => {
    await boot(page, '#settings/src');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), 'on a phone the connections fit the width').toBe(false);
  });
});

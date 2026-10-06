/**
 * Records what a real hub tells its admin window, for the hub's living mockup
 * (scripts/mockups/fixtures/hub.json, replayed by scripts/mockups/apps/hub.mjs).
 *
 * It starts the built hub (`pnpm build:hub` first) on a scratch data folder and a port of its own,
 * opens the hub's own admin window in Chrome, and keeps every answer the window is given while a
 * person's first afternoon is walked through: the sign-in screen, the first-run gate, a real
 * password, then — seeded through the API the way an administrator would — two library folders
 * with six tagged songs, two paired devices, two groups and an invite, a shared album, a backup
 * on a schedule; then every tab is opened, a pairing is started and a group is opened. The server
 * is stopped by its PID and the scratch folder removed. Paths are written as the container's
 * `/data`, the port as 4546, and the session's CSRF token as a placeholder.
 *
 *   pnpm build:hub && pnpm mockups:record-hub          (NP_RECORD_PORT, default 4571)
 *
 * Re-record when the admin window starts reading a route the recording does not have:
 * `pnpm mockups:build hub` names it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, ROOT, sleep } from './lib/browser.mjs';
import { routePath, routes } from '../../packages/contracts/src/index.ts';

const OUT = join(ROOT, 'scripts/mockups/fixtures/hub.json');
const PORT = Number(process.env.NP_RECORD_PORT ?? 4571);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'seven-copper-lantern-moth';

/** A short tagged WAV: RIFF INFO carries title, artist and album, which the hub's reader picks up. */
function wav(seconds, tags) {
  const rate = 8000;
  const samples = seconds * rate;
  const info = Object.entries(tags).map(([key, value]) => {
    const text = Buffer.from(`${value}\0`);
    return { key, text: text.length % 2 ? Buffer.concat([text, Buffer.alloc(1)]) : text };
  });
  const listLength = 4 + info.reduce((sum, item) => sum + 8 + item.text.length, 0);
  const header = Buffer.alloc(36);
  const total = 36 + 8 + listLength + 8 + samples * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(total - 8, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  const list = Buffer.alloc(12);
  list.write('LIST', 0);
  list.writeUInt32LE(listLength, 4);
  list.write('INFO', 8);
  const chunks = info.map((item) => {
    const head = Buffer.alloc(8);
    head.write(item.key, 0);
    head.writeUInt32LE(item.text.length, 4);
    return Buffer.concat([head, item.text]);
  });
  const data = Buffer.alloc(8 + samples * 2);
  data.write('data', 0);
  data.writeUInt32LE(samples * 2, 4);
  return Buffer.concat([header, list, ...chunks, data]);
}

/** The style guide's songs (packages/aqua-ui/styleguide/fixtures/record-hub-api.mts). */
const SONGS = [
  ['albums', '01 Harbour Morning.wav', 'Harbour Morning', 'Alder Quartet', 'First Light', 3],
  ['albums', '02 Gantry.wav', 'Gantry', 'Alder Quartet', 'First Light', 4],
  ['albums', '03 Blue Hour.wav', 'Blue Hour', 'Alder Quartet', 'First Light', 3],
  ['albums', '04 Paper Harbour.wav', 'Paper Harbour', 'Birch Ensemble', 'Late Shift', 5],
  ['albums', '05 Closing Hour.wav', 'Closing Hour', 'Birch Ensemble', 'Late Shift', 4],
  ['live', 'Pier 9 encore.wav', 'Signal Fade (live)', 'Cassette Bloom', 'Live from Pier 9', 6],
];

/** The hub's API, as an administrator's script would call it. */
function client() {
  let cookie = '';
  let csrf = '';
  const call = async (name, options = {}) => {
    const route = routes[name];
    const url = new URL(routePath(route, options.params ?? {}), BASE);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
    const res = await fetch(url, {
      method: route.method,
      headers: { accept: 'application/json', cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    if (!res.ok) throw new Error(`${name} ${res.status} ${text.slice(0, 300)}`);
    const body = text && (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;
    if (body && typeof body === 'object' && typeof body.csrfToken === 'string') csrf = body.csrfToken;
    return body;
  };
  return { call };
}

/** Pair a device the way a device does: the admin starts it, the device claims, the admin confirms. */
async function pair(call, deviceName, deviceKind, scopes) {
  const session = await call('pairingCreate', { body: { deviceKind, scopes, ttlSeconds: 600 } });
  const claim = await fetch(new URL('/api/v1/pairing/claim', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: session.code, deviceName, deviceKind, publicKey: `${deviceName.replace(/\W/g, '').toLowerCase()}-device-key-0000000000`, appVersion: '0.1.0', protocolVersion: 1 }),
  }).then((r) => r.json());
  await call('pairingConfirm', { params: { sessionId: session.sessionId }, body: { verificationFingerprint: claim.verificationFingerprint } });
  await fetch(new URL('/api/v1/pairing/complete', BASE), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.sessionId, claimSecret: claim.claimSecret }) });
}

async function main() {
  if (!existsSync(join(ROOT, 'docker-container/dist/server.js'))) throw new Error('no hub build: run pnpm build:hub first');
  const dataDir = mkdtempSync(join(tmpdir(), 'np-hub-mockup-'));
  for (const [folder, file, title, artist, album, seconds] of SONGS) {
    mkdirSync(join(dataDir, 'library', folder), { recursive: true });
    writeFileSync(join(dataDir, 'library', folder, file), wav(seconds, { INAM: title, IART: artist, IPRD: album }));
  }
  const server = spawn(process.execPath, ['dist/server.js'], {
    cwd: join(ROOT, 'docker-container'),
    env: { ...process.env, NP_DATA_DIR: dataDir, NP_PORT: String(PORT), NP_BIND_MODE: 'localhost', NP_LOG_LEVEL: 'warn', NP_DEMO_MODE: 'false', NP_AUTO_TOOLS: '0', NP_PUBLIC_DOMAIN_DIR: join(dataDir, 'no-fixtures') },
    stdio: 'ignore',
  });
  console.info(`hub pid ${server.pid} on ${BASE}`);
  const browser = await launch();
  const phases = {};
  let phase = 'signed-out';
  const keep = async (response) => {
    const url = new URL(response.url());
    if (url.origin !== BASE || !url.pathname.startsWith('/api/')) return;
    let body;
    try {
      const text = await response.text();
      body = (response.headers()['content-type'] ?? '').includes('json') && text ? JSON.parse(text) : text;
    } catch {
      return;
    }
    const key = `${response.request().method()} ${url.pathname}${url.search}`;
    (phases[phase] ??= {})[key] = { status: response.status(), contentType: response.headers()['content-type'] ?? 'application/json', body };
  };
  try {
    for (let i = 0; i < 80; i += 1) {
      try {
        if ((await fetch(`${BASE}/healthz`)).ok) break;
      } catch {
        // not yet
      }
      await sleep(250);
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-GB', timezoneId: 'UTC' });
    const page = await context.newPage();
    page.on('response', (response) => void keep(response));
    const settle = (ms = 1500) => sleep(ms);

    // Signed out: the window with its tabs locked and the sign-in form.
    await page.goto(`${BASE}/`);
    await page.waitForSelector('#signin-pass');
    await settle();

    // The first-run gate: signed in with the bootstrap password.
    phase = 'first-run';
    await page.fill('#signin-pass', 'admin');
    await page.click('button[type="submit"]');
    await page.waitForSelector('#gateH');
    await settle(2500);

    // A real password, through the gate's own form.
    phase = 'setting-up';
    await page.fill('input[aria-label="New password"]', PASSWORD);
    await page.fill('input[aria-label="New password again"]', PASSWORD);
    await page.click('.gate button[type="submit"]');
    await page.waitForSelector('#gateH', { state: 'detached' });
    await settle();

    // An administrator's first afternoon, through the API.
    const { call } = client();
    await call('authLogin', { body: { username: 'admin', password: PASSWORD } });
    await call('libraryRootAdd', { body: { relativePath: 'albums', displayName: 'Albums' } });
    await call('libraryRootAdd', { body: { relativePath: 'live', displayName: 'Live recordings' } });
    await call('libraryScan').catch((error) => console.info('scan', String(error)));
    for (let i = 0; i < 40; i += 1) {
      const tracks = await call('libraryTracks', { query: { limit: 100 } });
      if (tracks.items.length >= SONGS.length) break;
      await sleep(250);
    }
    await pair(call, 'Kitchen speaker', 'player', ['library:read', 'group:member', 'search:use']).catch((error) => console.info('pair player', String(error).slice(0, 200)));
    await pair(call, 'Studio PC', 'companion', ['library:read', 'library:share', 'files:serve']).catch((error) => console.info('pair companion', String(error).slice(0, 200)));
    const kitchen = await call('groupsCreate', { body: { name: 'Kitchen' } });
    await call('groupsCreate', { body: { name: 'Friday night' } });
    await call('groupsInvite', { params: { groupId: kitchen.id }, body: { ttlSeconds: 3600, role: 'member' } });
    const sources = await call('sharesSources');
    const album = sources.albums?.find((item) => item.title === 'First Light') ?? sources.albums?.[0];
    if (album) await call('sharesCreate', { body: { kind: 'album', targetId: album.id, allowStream: true, allowDownload: false, expiresInSeconds: 7 * 86_400 } }).catch((error) => console.info('share', String(error)));
    await call('backupSettingsPut', { body: { schedule: { frequency: 'daily', time: '03:00', weekday: 0 }, keep: 7 } }).catch((error) => console.info('backup settings', String(error)));
    await call('backupCreate').catch((error) => console.info('backup', String(error)));
    await sleep(1500);

    // Signed in and set up: every tab, a pairing started, a group opened.
    phase = 'signed-in';
    await page.goto(`${BASE}/#overview`);
    await page.waitForSelector('#tab-overview');
    await settle(2500);
    for (const tab of ['devices', 'music', 'groups', 'sharing', 'system', 'overview']) {
      await page.click(`#tab-${tab}`);
      await settle(2500);
    }
    await page.click('#tab-groups');
    await settle();
    await page.locator('button[aria-label="Open Kitchen"]').click().catch((error) => console.info('open group', String(error).slice(0, 160)));
    await settle(2500);
    await page.click('#tab-devices');
    await settle();
    phase = 'pairing';
    await page.locator('#devices button:has-text("Start Pairing")').first().click().catch((error) => console.info('start pairing', String(error).slice(0, 160)));
    await settle(2500);
    await context.close();

    // The scratch folder becomes the container's data volume, the scratch port the hub's own.
    let text = JSON.stringify({ recordedAt: new Date().toISOString(), base: 'http://127.0.0.1:4546', phases }, null, 2);
    for (const path of [dataDir, dataDir.replace(/\\/g, '/'), dataDir.replace(/\\/g, '\\\\')]) text = text.split(path).join('/data');
    text = text.replace(/\/data(?:\\\\[^"\\]*)+/g, (match) => match.replace(/\\\\/g, '/'));
    text = text.split(`127.0.0.1:${PORT}`).join('127.0.0.1:4546').split(`"port": ${PORT}`).join('"port": 4546').split(`:${PORT}`).join(':4546');
    text = text.replace(/"csrfToken": "[^"]*"/g, '"csrfToken": "mockup-csrf-token"');
    if (/[A-Z]:\\\\Users|\/Users\/|AppData|np-hub-mockup-/.test(text)) throw new Error('a machine path survived sanitising');
    for (const name of [process.env.USERNAME, process.env.USER, process.env.COMPUTERNAME].filter((v) => v && v.length > 2)) {
      if (text.toLowerCase().includes(name.toLowerCase())) throw new Error('this machine’s user or computer name survived sanitising');
    }
    // Written the way `pnpm format` would, so the recording passes `pnpm format:check` as it is.
    const prettier = await import('prettier');
    const options = (await prettier.resolveConfig(OUT)) ?? {};
    writeFileSync(OUT, await prettier.format(text, { ...options, parser: 'json' }));
    console.info(`wrote ${Object.values(phases).reduce((n, p) => n + Object.keys(p).length, 0)} answers in ${Object.keys(phases).length} phases to ${OUT}`);
  } finally {
    await browser.close();
    if (server.pid) {
      try {
        process.kill(server.pid);
      } catch {
        // already gone
      }
    }
    console.info(`stopped ${server.pid}`);
    await sleep(800);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the database for a moment; the scratch folder is in the temp dir.
    }
  }
}

await main();

/**
 * Records what a real hub answers to the routes the admin window's sections read, for the style
 * guide's hub specimens (`hub-api.json`, served to the real views by `fake-hub-api.ts`).
 *
 * It starts the built hub (`pnpm build:hub` first) on a scratch data folder and a port of its own,
 * seeds it through the API the way an administrator would — two library folders with a few songs,
 * two groups and an invite, a shared link, a backup on a schedule — asks every route the sections
 * read, and stops the server by its PID. Paths inside the scratch folder are written as `/data`,
 * the data volume a container mounts, so no machine path reaches the repository.
 *
 *   pnpm exec tsx packages/aqua-ui/styleguide/fixtures/record-hub-api.mts
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routePath, routes, type RouteName } from '../../../contracts/src/index.js';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = fileURLToPath(new URL('./hub-api.json', import.meta.url));
const PORT = Number(process.env['NP_RECORD_PORT'] ?? 4564);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'seven-copper-lantern-moth';
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A short tagged WAV: RIFF INFO carries title, artist and album, which the hub's reader picks up. */
function wav(seconds: number, tags: Record<string, string>): Buffer {
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

const SONGS: ReadonlyArray<{
  folder: string;
  file: string;
  title: string;
  artist: string;
  album: string;
  seconds: number;
}> = [
  {
    folder: 'albums',
    file: '01 Harbour Morning.wav',
    title: 'Harbour Morning',
    artist: 'Alder Quartet',
    album: 'First Light',
    seconds: 3,
  },
  {
    folder: 'albums',
    file: '02 Gantry.wav',
    title: 'Gantry',
    artist: 'Alder Quartet',
    album: 'First Light',
    seconds: 4,
  },
  {
    folder: 'albums',
    file: '03 Blue Hour.wav',
    title: 'Blue Hour',
    artist: 'Alder Quartet',
    album: 'First Light',
    seconds: 3,
  },
  {
    folder: 'albums',
    file: '04 Paper Harbour.wav',
    title: 'Paper Harbour',
    artist: 'Birch Ensemble',
    album: 'Late Shift',
    seconds: 5,
  },
  {
    folder: 'albums',
    file: '05 Closing Hour.wav',
    title: 'Closing Hour',
    artist: 'Birch Ensemble',
    album: 'Late Shift',
    seconds: 4,
  },
  {
    folder: 'live',
    file: 'Pier 9 encore.wav',
    title: 'Signal Fade (live)',
    artist: 'Cassette Bloom',
    album: 'Live from Pier 9',
    seconds: 6,
  },
];

interface Recorded {
  name: RouteName;
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean>;
  body: unknown;
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'np-hub-guide-'));
  for (const song of SONGS) {
    mkdirSync(join(dataDir, 'library', song.folder), { recursive: true });
    writeFileSync(
      join(dataDir, 'library', song.folder, song.file),
      wav(song.seconds, { INAM: song.title, IART: song.artist, IPRD: song.album }),
    );
  }
  const server = spawn(process.execPath, ['dist/server.js'], {
    cwd: join(repo, 'docker-container'),
    env: {
      ...process.env,
      NP_DATA_DIR: dataDir,
      NP_PORT: String(PORT),
      NP_BIND_MODE: 'localhost',
      NP_LOG_LEVEL: 'info',
      NP_DEMO_MODE: 'false',
      NP_AUTO_TOOLS: '0',
      NP_PUBLIC_DOMAIN_DIR: join(dataDir, 'no-fixtures'),
    },
    stdio: 'ignore',
  });
  console.info(`hub pid ${server.pid} on ${BASE}`);
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i += 1) {
      try {
        up = (await fetch(`${BASE}/healthz`)).ok;
      } catch {
        await sleep(250);
      }
    }
    if (!up) throw new Error('the hub did not start; run pnpm build:hub first');

    let cookie = '';
    let csrf = '';
    const call = async (
      name: RouteName,
      options: {
        params?: Record<string, string | number>;
        query?: Record<string, string | number | boolean>;
        body?: unknown;
      } = {},
    ): Promise<unknown> => {
      const route = routes[name] as { method: string; path: string; absolute?: boolean };
      const url = new URL(routePath(route as never, (options.params ?? {}) as never), BASE);
      for (const [key, value] of Object.entries(options.query ?? {}))
        url.searchParams.set(key, String(value));
      const res = await fetch(url, {
        method: route.method,
        headers: {
          accept: 'application/json',
          cookie,
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      const text = await res.text();
      if (!res.ok) throw new Error(`${name} ${res.status} ${text.slice(0, 300)}`);
      return text && (res.headers.get('content-type') ?? '').includes('json')
        ? JSON.parse(text)
        : text;
    };

    csrf = (
      (await call('authLogin', { body: { username: 'admin', password: 'admin' } })) as {
        csrfToken: string;
      }
    ).csrfToken;
    csrf = (
      (await call('authChangePassword', {
        body: { currentPassword: 'admin', newPassword: PASSWORD },
      })) as { csrfToken: string }
    ).csrfToken;

    // An administrator's first afternoon.
    await call('libraryRootAdd', { body: { relativePath: 'albums', displayName: 'Albums' } });
    await call('libraryRootAdd', {
      body: { relativePath: 'live', displayName: 'Live recordings' },
    });
    await call('libraryScan').catch((error: unknown) => console.info('scan', String(error)));
    for (let i = 0; i < 40; i += 1) {
      const tracks = (await call('libraryTracks', { query: { limit: 100 } })) as {
        items: unknown[];
      };
      if (tracks.items.length >= SONGS.length) break;
      await sleep(250);
    }
    const kitchen = (await call('groupsCreate', { body: { name: 'Kitchen' } })) as { id: string };
    await call('groupsCreate', { body: { name: 'Friday night' } });
    await call('groupsInvite', {
      params: { groupId: kitchen.id },
      body: { ttlSeconds: 3600, role: 'member' },
    });
    const sources = (await call('sharesSources')) as {
      albums?: Array<{ id: string; title?: string; name?: string }>;
      playlists?: Array<{ id: string }>;
    };
    const album =
      sources.albums?.find((item) => item.title === 'First Light') ?? sources.albums?.[0];
    if (album)
      await call('sharesCreate', {
        body: {
          kind: 'album',
          targetId: album.id,
          allowStream: true,
          allowDownload: false,
          expiresInSeconds: 7 * 86_400,
        },
      }).catch((error: unknown) => console.info('share', String(error)));
    await call('backupSettingsPut', {
      body: { schedule: { frequency: 'daily', time: '03:00', weekday: 0 }, keep: 7 },
    }).catch((error: unknown) => console.info('backup settings', String(error)));
    await call('backupCreate').catch((error: unknown) => console.info('backup', String(error)));
    await sleep(1500);

    // Everything the sections read, asked the way the views ask it.
    const asks: Array<Omit<Recorded, 'body'>> = [
      { name: 'groupsList' },
      { name: 'hubIdentity' },
      { name: 'groupsInvitesList', params: { groupId: kitchen.id } },
      { name: 'groupsGet', params: { groupId: kitchen.id } },
      { name: 'groupsSync', params: { groupId: kitchen.id } },
      { name: 'groupsQueueGet', params: { groupId: kitchen.id } },
      { name: 'groupNowPlayingAdmin', params: { groupId: kitchen.id } },
      { name: 'groupsHistoryList', params: { groupId: kitchen.id }, query: { limit: 25 } },
      { name: 'libraryRoots' },
      { name: 'libraryTracks', query: { limit: 100 } },
      { name: 'downloadsStorage' },
      { name: 'liveTvSummary' },
      { name: 'profilesAdminList' },
      { name: 'sharesList' },
      { name: 'sharesSources' },
      { name: 'recommendationsConfigGet' },
      { name: 'discordConfigGet' },
      { name: 'discordStatus' },
      { name: 'discordInviteUrl' },
      { name: 'networkGet' },
      { name: 'backupList' },
      { name: 'backupSpace' },
      { name: 'backupSettingsGet' },
      { name: 'logsList', query: { level: 'info', limit: 300 } },
      { name: 'diagnosticsBundle' },
    ];
    const recorded: Recorded[] = [];
    for (const ask of asks) {
      try {
        recorded.push({ ...ask, body: await call(ask.name, ask) });
      } catch (error) {
        console.info(`skipped ${ask.name}: ${String(error).slice(0, 160)}`);
      }
    }

    // The scratch folder becomes the container's data volume, the scratch port the hub's own.
    const scratch = [dataDir, dataDir.replace(/\\/g, '/'), dataDir.replace(/\\/g, '\\\\')];
    let text = JSON.stringify({ recordedAt: new Date().toISOString(), routes: recorded }, null, 2);
    for (const path of scratch) text = text.split(path).join('/data');
    text = text.replace(/\/data(?:\\\\[^"\\]*)+/g, (match) => match.replace(/\\\\/g, '/'));
    text = text.split(`"port": ${PORT}`).join('"port": 4546');
    text = text.split(`127.0.0.1:${PORT}`).join('127.0.0.1:4546').split(`:${PORT}`).join(':4546');
    if (/[A-Z]:\\\\Users|\/Users\/|AppData|np-hub-guide-/.test(text))
      throw new Error('a machine path survived sanitising');
    writeFileSync(OUT, `${text}\n`);
    console.info(`wrote ${recorded.length} answers to ${OUT}`);
  } finally {
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

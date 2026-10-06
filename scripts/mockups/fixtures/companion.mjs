/**
 * What the companion's main process answers its window, for the companion's living mockup.
 *
 * The Settings channels start from what a packaged companion really answered
 * (packages/aqua-ui/styleguide/fixtures/companion-ipc.json); the rest is a believable afternoon on
 * a PC that has been set up — music, TV and movie folders, a paired hub, streaming on with two
 * devices, a channel playlist and a guide, a backup folder with two archives. Every answer is
 * checked against the IPC contract (windows-companion/src/shared/ipc.ts) before the window sees it,
 * and the window is given the parsed result, defaults filled in, as the real bridge gives it.
 * No real person's data: the user folder is `you`, the names are the e2e suites' invented ones.
 */
import recorded from '../../../packages/aqua-ui/styleguide/fixtures/companion-ipc.json' with { type: 'json' };

export const now = '2026-10-04T19:42:00.000Z';
const at = (minutesAgo) => new Date(Date.parse(now) - minutesAgo * 60_000).toISOString();
const DATA = 'C:\\Users\\you\\AppData\\Roaming\\now-playing-companion';

const MUSIC = '0f6b2c1e-5d3a-4b7e-9a10-1c2d3e4f5a01';
const LIVE = '0f6b2c1e-5d3a-4b7e-9a10-1c2d3e4f5a02';
const TV = '0f6b2c1e-5d3a-4b7e-9a10-1c2d3e4f5a03';
const MOVIES = '0f6b2c1e-5d3a-4b7e-9a10-1c2d3e4f5a04';

const SONGS = [
  ['Harbour Morning', 'Alder Quartet', 'First Light', 1, 212, 92],
  ['Gantry', 'Alder Quartet', 'First Light', 2, 197, 118],
  ['Blue Hour', 'Alder Quartet', 'First Light', 3, 244, null],
  ['Tideline', 'Alder Quartet', 'First Light', 4, 231, 104],
  ['Paper Harbour', 'Birch Ensemble', 'Late Shift', 1, 186, 126],
  ['Closing Hour', 'Birch Ensemble', 'Late Shift', 2, 263, 84],
  ['Ember Line', 'Birch Ensemble', 'Late Shift', 3, 205, null],
  ['Slow Carousel', 'Birch Ensemble', 'Late Shift', 4, 278, 72],
  ['Signal Fade (live)', 'Cassette Bloom', 'Live from Pier 9', 1, 301, 110],
  ['Low Tide Radio (live)', 'Cassette Bloom', 'Live from Pier 9', 2, 254, 96],
];
const tracks = SONGS.map(([title, artist, album, number, seconds, bpm], i) => ({
  id: `5b1f7c2a-8e4d-4c3b-9f21-${String(i + 1).padStart(12, '0')}`,
  schemaVersion: 1,
  createdAt: at(9000 - i * 30),
  updatedAt: at(3000 - i * 30),
  deletedAt: null,
  title,
  artistName: artist,
  albumName: album,
  trackNumber: number,
  genre: album.startsWith('Live') ? 'Indie' : 'Chamber pop',
  year: album.startsWith('Live') ? 2026 : 2024,
  durationMs: seconds * 1000,
  bpm,
  bpmSource: bpm ? (i % 2 ? 'analysis' : 'tag') : null,
  rootId: album.startsWith('Live') ? LIVE : MUSIC,
  format: { container: 'flac', codec: 'flac', bitrateKbps: 920, sampleRateHz: 44100, bitDepth: 16, channels: 2, lossless: true },
}));

const prefs = { ...recorded.channels['app:preferences:get'], downloadDir: 'D:\\Music\\Downloads', downloadFormat: 'flac', autoSync: true };

/** Every channel the window reads, by name. */
export const answers = {
  ...recorded.channels,
  'app:preferences:get': prefs,
  'app:update-status': { current: '0.1.0', latest: '0.1.0', available: false, checkedAt: at(95), reason: null, enabled: true },
  'app:storage': { cache: { app: 48_234_496, liveTv: 3_145_728, downloads: 412_090_368, total: 463_470_592 }, logsDir: `${DATA}\\logs` },
  'helper:status': {
    ...recorded.channels['helper:status'],
    checkedAt: at(12),
    tools: [
      { ...recorded.channels['helper:status'].tools[0], latest: { version: '2026.09.18', updateAvailable: true, reason: null, checkedAt: at(12) } },
      { id: 'spotdl', present: true, version: '4.4.2', path: `${DATA}\\helper\\tools\\spotdl.exe`, advice: null, origin: 'installed', setup: { state: 'ready' } },
      recorded.channels['helper:status'].tools[2],
    ],
  },
  'helper:token': { token: null },
  'library:folders': {
    items: [
      { id: MUSIC, path: 'C:\\Users\\you\\Music', displayName: 'Music', watch: true, kind: 'music', trackCount: 3812, sizeBytes: 41_205_678_080, lastScanAt: at(42), lastScanError: null, available: true },
      { id: LIVE, path: 'D:\\Music\\Live', displayName: 'Live', watch: true, kind: 'music', trackCount: 212, sizeBytes: 6_408_765_440, lastScanAt: at(42), lastScanError: null, available: true },
      { id: TV, path: 'D:\\TV', displayName: 'TV', watch: true, kind: 'tv', trackCount: 0, sizeBytes: 18_253_611_008, lastScanAt: at(42), lastScanError: null, available: true },
      { id: MOVIES, path: 'E:\\Movies', displayName: 'Movies', watch: false, kind: 'movies', trackCount: 0, sizeBytes: 52_613_349_376, lastScanAt: at(1440), lastScanError: null, available: false },
    ],
  },
  'library:tracks': { items: tracks, total: 4024 },
  'library:track-ids': { ids: tracks.map((t) => t.id), total: 4024 },
  'library:playlists': { items: [] },
  'hub:status': {
    endpoint: 'http://192.168.1.20:4546',
    hubId: '01a1040a-7a8d-7095-9b6f-0b1ce4d534e3',
    hubName: 'Airwave Hub',
    hubFingerprint: '0E3B-A5CF-B84B-00D1-6248-DE87-59BD-297B',
    connected: true,
    reason: null,
    scopes: ['library:read', 'library:share', 'files:serve'],
    lastSyncAt: at(6),
  },
  'hub:sharing': { enabled: true },
  'tv:links': {
    m3u: [{ id: 'm3u-harbour', kind: 'm3u', url: 'https://tv.example/harbour/channels.m3u8', state: 'ok', summary: '3 channels', error: null, checkedAt: at(18) }],
    epg: [
      { id: 'epg-harbour', kind: 'epg', url: 'https://tv.example/harbour/guide.xml', state: 'ok', summary: '7-day guide', error: null, checkedAt: at(18) },
      { id: 'epg-coast', kind: 'epg', url: 'https://guide.example/coast.xml.gz', state: 'failed', summary: 'unreachable', error: 'The guide did not answer the last time it was looked at; what it last held is still used.', checkedAt: at(18) },
    ],
  },
  'awsp:status': {
    enabled: true,
    running: true,
    reason: null,
    endpointId: 'b3c9e1f04a7d2e68c1f5a9b0d3e7c2a4f6e8d0b1a3c5e7f9a2b4c6d8e0f1a3b5',
    ticket: 'awsp1:b3c9e1f04a7d2e68c1f5a9b0d3e7c2a4f6e8d0b1a3c5e7f9a2b4c6d8e0f1a3b5@relay.example',
    ticketQrSvg: null,
    relayUrl: 'https://relay.example/',
    pairingCode: { code: '482-913', expiresAt: new Date(Date.parse(now) + 8 * 60_000).toISOString() },
    devices: [
      { id: 'awsp-dev-1', name: 'Phone (Airwave)', clientKind: 'android', tierCap: 'high', pairedAt: at(20_160), lastSeenAt: at(3) },
      { id: 'awsp-dev-2', name: 'Work laptop (Airwave)', clientKind: 'pwa', tierCap: 'saver', pairedAt: at(7200), lastSeenAt: at(2880) },
    ],
    connections: [{ peer: 'awsp-dev-1', name: 'Phone (Airwave)', type: 'direct', rttMs: 34 }],
    port: 47_310,
    network: { unmetered: true, metered: true, connection: 'unmetered', blocked: null },
  },
  'transfers:list': {
    items: [
      { id: 'tr-1', kind: 'upload', trackTitle: 'Signal Fade (live)', bytesDone: 18_874_368, bytesTotal: 41_943_040, state: 'running', error: null },
      { id: 'tr-2', kind: 'upload', trackTitle: 'Low Tide Radio (live)', bytesDone: 0, bytesTotal: 35_651_584, state: 'queued', error: null },
      { id: 'tr-3', kind: 'upload', trackTitle: 'Harbour Morning', bytesDone: 29_360_128, bytesTotal: 29_360_128, state: 'completed', error: null },
    ],
  },
  'backup:settings:get': {
    ...recorded.channels['backup:settings:get'],
    dir: 'D:\\Backups\\Airwave',
    include: { music: true, tv: false, movies: false, playlists: true, presets: true, algorithms: true, settings: true },
    lastRunAt: at(1500),
  },
  'backup:estimate': {
    parts: { music: { bytes: 47_614_443_520, files: 4024, measuredAt: at(30) } },
    dataBytes: 18_432,
    expectedBytes: 47_614_461_952,
    complete: true,
    destination: { path: 'D:\\Backups\\Airwave', freeBytes: 612_032_839_680, totalBytes: 1_000_068_870_144 },
    blocked: null,
  },
  'backup:list': {
    items: [
      { id: 'airwave-2026-10-03', path: 'D:\\Backups\\Airwave\\airwave-2026-10-03', createdAt: at(1500), sizeBytes: 47_530_557_440, parts: ['music', 'playlists', 'presets', 'algorithms', 'settings'], contents: { tracks: 4019, playlists: 6, presets: 3, events: 1288 }, restorable: true },
      { id: 'airwave-2026-09-26', path: 'D:\\Backups\\Airwave\\airwave-2026-09-26', createdAt: at(11_580), sizeBytes: 47_102_738_432, parts: ['music', 'playlists', 'presets', 'settings'], contents: { tracks: 3988, playlists: 5, presets: 3, events: 1102 }, restorable: true },
    ],
  },
  'backup:algorithms': { available: true, hubName: 'Airwave Hub', reason: null },
};

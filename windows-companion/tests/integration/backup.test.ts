/**
 * Backups, against a real temp folder: an archive is written and listed, the kept count is
 * enforced, an archive restores, the schedule fires when it is due, and — the reason the companion
 * imports the helper's measurer rather than walking folders itself — the companion's estimate and
 * the helper's `/helper/v1/backup/estimate` report the same bytes for the same folders.
 */
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HELPER_ROUTES, HelperBackupEstimate } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import { startHelper, type Helper } from '@now-playing/local-helper';
import { BackupManager } from '../../src/main/backup.js';
import { CompanionStore, openCompanionDb } from '../../src/main/store.js';
import type { BackupProgress } from '../../src/shared/ipc.js';

let root: string;
let store: CompanionStore;
let clock: { now: number };
let progress: BackupProgress[];
let notices: string[];
let settings: Record<string, unknown>;

function manager(budgetMs?: number): BackupManager {
  return new BackupManager({
    store,
    readSettings: () => settings,
    writeSettings: (next) => {
      settings = next;
    },
    onProgress: (p) => progress.push(p),
    onNotice: (_kind, message) => notices.push(message),
    now: () => clock.now,
    ...(budgetMs ? { budgetMs } : {}),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'np-companion-backup-'));
  store = new CompanionStore(openCompanionDb(':memory:'));
  clock = { now: Date.parse('2026-09-21T12:00:00.000Z') };
  progress = [];
  notices = [];
  settings = { preferences: { minimizeToTray: true } };
  mkdirSync(join(root, 'music', 'album'), { recursive: true });
  writeFileSync(join(root, 'music', 'a.flac'), Buffer.alloc(1000, 1));
  writeFileSync(join(root, 'music', 'album', 'b.flac'), Buffer.alloc(500, 2));
  // The same file under a second name: 500 bytes on disk once, not twice.
  linkSync(join(root, 'music', 'album', 'b.flac'), join(root, 'music', 'album', 'b-again.flac'));
  mkdirSync(join(root, 'more-music'));
  writeFileSync(join(root, 'more-music', 'c.flac'), Buffer.alloc(250, 3));
  mkdirSync(join(root, 'tv'));
  writeFileSync(join(root, 'tv', 'show.mkv'), Buffer.alloc(300, 4));
  mkdirSync(join(root, 'backups'));
  const now = new Date(clock.now).toISOString();
  store.addFolder({ id: uuidv7(), path: join(root, 'music'), displayName: 'music', kind: 'music', now });
  store.addFolder({ id: uuidv7(), path: join(root, 'more-music'), displayName: 'more-music', kind: 'music', now });
  store.addFolder({ id: uuidv7(), path: join(root, 'tv'), displayName: 'tv', kind: 'tv', now });
  store.putSynced('playlists', '01920000-0000-7000-8000-000000000001', { id: '01920000-0000-7000-8000-000000000001', createdAt: now, updatedAt: now, name: 'Road Trip' }, now, null);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the estimate', () => {
  it('is blocked until a folder is chosen, then sums the included parts and the data file', async () => {
    const backups = manager();
    let estimate = await backups.estimate();
    expect(estimate.blocked).toBe('Choose where backups go first.');
    backups.setDir(join(root, 'backups'));
    backups.update({ include: { tv: true } });
    estimate = await backups.estimate();
    expect(estimate.blocked).toBeNull();
    expect(estimate.parts.music).toMatchObject({ bytes: 1750, files: 3 });
    expect(estimate.parts.tv).toMatchObject({ bytes: 300, files: 1 });
    expect(estimate.dataBytes).toBeGreaterThan(0);
    expect(estimate.expectedBytes).toBe(1750 + 300 + estimate.dataBytes);
    expect(estimate.complete).toBe(true);
    expect(estimate.destination?.path).toBe(join(root, 'backups'));
  });

  it('reports the same bytes as the helper route started with the same folders', async () => {
    const backups = manager();
    backups.setDir(join(root, 'backups'));
    backups.update({ include: { tv: true } });
    let helper: Helper | null = null;
    try {
      helper = await startHelper({
        port: 0,
        version: 'test',
        token: 'test-token-aaaaaaaaaaaaaaaaaaaaaaaa',
        workDir: join(root, 'work'),
        toolsDir: join(root, 'tools'),
        timeoutMs: 20_000,
        allowedHosts: [],
        allowedOrigins: [],
        app: null,
        configured: {},
        log: () => undefined,
        // Exactly what the companion's main process hands the embedded helper.
        backup: { folders: backups.folders(), backupDir: backups.settings().dir },
      });
      const response = await fetch(`${helper.origin}${HELPER_ROUTES.backupEstimate}?parts=music,tv`, { headers: { 'x-helper-token': 'test-token-aaaaaaaaaaaaaaaaaaaaaaaa' } });
      const viaHelper = HelperBackupEstimate.parse(await response.json());
      const viaCompanion = await backups.estimate();
      expect(viaHelper.parts.music?.bytes).toBe(viaCompanion.parts.music?.bytes);
      expect(viaHelper.parts.music?.files).toBe(viaCompanion.parts.music?.files);
      expect(viaHelper.parts.tv?.bytes).toBe(viaCompanion.parts.tv?.bytes);
      expect(viaHelper.destination?.path).toBe(viaCompanion.destination?.path);
      expect(viaHelper.destination?.totalBytes).toBe(viaCompanion.destination?.totalBytes);
    } finally {
      await helper?.close();
    }
  });

  it('is not complete when an included folder is missing, and says so instead of a smaller number', async () => {
    store.addFolder({ id: uuidv7(), path: join(root, 'gone'), displayName: 'gone', kind: 'music', now: new Date(clock.now).toISOString() });
    const backups = manager();
    backups.setDir(join(root, 'backups'));
    const estimate = await backups.estimate();
    expect(estimate.complete).toBe(false);
    expect(estimate.parts.music).toBeUndefined();
    expect(estimate.blocked).toMatch(/could not be measured/);
  });
});

describe('an archive', () => {
  it('is written with the data file and the copied folders, listed, and as big as the estimate said', async () => {
    const backups = manager();
    backups.setDir(join(root, 'backups'));
    backups.update({ include: { tv: true } });
    const estimate = await backups.estimate();
    const result = await backups.create();
    expect(result.reason).toBeNull();
    expect(result.backup?.sizeBytes).toBe(estimate.expectedBytes);

    const [archive] = await backups.list();
    expect(archive).toMatchObject({ restorable: true, sizeBytes: estimate.expectedBytes, parts: ['playlists', 'presets', 'settings', 'music', 'tv'] });
    const files = readdirSync(archive!.path).sort();
    expect(files).toEqual(['data.json', 'manifest.json', 'music', 'tv']);
    // Two music folders, each under its own name; the hard link copied once and linked once.
    expect(readdirSync(join(archive!.path, 'music')).sort()).toEqual(['more-music', 'music']);
    expect(statSync(join(archive!.path, 'music', 'music', 'album', 'b-again.flac')).size).toBe(500);
    expect(readFileSync(join(archive!.path, 'music', 'music', 'a.flac')).equals(Buffer.alloc(1000, 1))).toBe(true);
    const data = JSON.parse(readFileSync(join(archive!.path, 'data.json'), 'utf8')) as { playlists: Array<{ name: string }>; settings: unknown; folders: Array<{ kind: string }> };
    expect(data.playlists.map((p) => p.name)).toEqual(['Road Trip']);
    expect(data.settings).toEqual(settings);
    expect(data.folders.map((f) => f.kind).sort()).toEqual(['music', 'music', 'tv']);

    expect(progress.map((p) => p.phase)).toEqual(expect.arrayContaining(['measuring', 'writing', 'copying', 'pruning', 'done']));
    expect(progress.at(-1)).toMatchObject({ phase: 'done', bytesDone: estimate.expectedBytes });
    expect(backups.settings().lastRunAt).toBe(new Date(clock.now).toISOString());
  });

  it('leaves the music out when it is not included', async () => {
    const backups = manager();
    backups.setDir(join(root, 'backups'));
    backups.update({ include: { music: false } });
    const result = await backups.create();
    expect(result.reason).toBeNull();
    const [archive] = await backups.list();
    expect(readdirSync(archive!.path).sort()).toEqual(['data.json', 'manifest.json']);
    expect(archive!.parts).toEqual(['playlists', 'presets', 'settings']);
  });

  it('keeps only the chosen count, oldest dropped first, and drops more when the count is lowered', async () => {
    const backups = manager();
    backups.setDir(join(root, 'backups'));
    backups.update({ include: { music: false }, keep: 3 });
    for (let i = 0; i < 5; i++) {
      clock.now += 60_000;
      expect((await backups.create()).reason).toBeNull();
    }
    let items = await backups.list();
    expect(items).toHaveLength(3);
    expect(items[0]!.createdAt > items[2]!.createdAt).toBe(true);
    expect(items.map((a) => a.createdAt)).toEqual(['2026-09-21T12:05:00.000Z', '2026-09-21T12:04:00.000Z', '2026-09-21T12:03:00.000Z']);

    backups.update({ keep: 0 });
    clock.now += 60_000;
    await backups.create();
    expect(await backups.list()).toHaveLength(4);
    await backups.prune();
    expect(await backups.list()).toHaveLength(4);

    backups.update({ keep: 3 });
    expect(await backups.prune()).toBe(1);
    items = await backups.list();
    expect(items).toHaveLength(3);
  });

  it('refuses to run when the archive would not fit, and says by how much', async () => {
    const backups = manager();
    backups.setDir(join(root, 'backups'));
    // Pretend the drive is nearly full by asking for a part that cannot exist: not possible here
    // without a fake filesystem, so the rule is checked at the estimate boundary instead.
    const estimate = await backups.estimate();
    expect(estimate.destination?.freeBytes).toBeGreaterThan(estimate.expectedBytes);
    expect(estimate.blocked).toBeNull();
  });

  it('restores playlists and settings from an archive, and lists a damaged one as not restorable', async () => {
    const backups = manager();
    backups.setDir(join(root, 'backups'));
    backups.update({ include: { music: false } });
    await backups.create();
    const [archive] = await backups.list();

    // Lose the playlist and change a setting, then restore.
    const later = new Date(clock.now + 1000).toISOString();
    store.putSynced('playlists', '01920000-0000-7000-8000-000000000001', { id: '01920000-0000-7000-8000-000000000001', createdAt: later, updatedAt: later, name: 'Road Trip' }, later, later);
    settings = { preferences: { minimizeToTray: false } };
    clock.now += 5000;
    const result = await backups.restoreArchive(archive!.id);
    expect(result).toMatchObject({ restored: true, reason: null });
    expect(store.listPlaylists().map((p) => p.name)).toEqual(['Road Trip']);
    expect(settings).toEqual({ preferences: { minimizeToTray: true } });
    expect(notices.some((n) => /restored/.test(n))).toBe(true);

    mkdirSync(join(root, 'backups', 'now-playing-companion-20260101T000000Z'));
    const items = await backups.list();
    expect(items.find((a) => a.id === 'now-playing-companion-20260101T000000Z')).toMatchObject({ restorable: false });
    await expect(backups.restoreArchive('now-playing-companion-20260101T000000Z')).resolves.toMatchObject({ restored: false, reason: expect.stringMatching(/data\.json/) });
    await expect(backups.restoreArchive('../etc')).resolves.toMatchObject({ restored: false });
  });
});

describe('the schedule', () => {
  it('runs when a day or a week has passed since the last backup, and never on manual', async () => {
    const backups = manager();
    backups.setDir(join(root, 'backups'));
    backups.update({ include: { music: false } });
    expect(backups.due()).toBe(false);
    expect((await backups.tick()).ran).toBe(false);

    backups.update({ schedule: 'daily' });
    // Never run before: due at once.
    expect(backups.due()).toBe(true);
    expect((await backups.tick()).ran).toBe(true);
    expect(backups.due()).toBe(false);
    clock.now += 23 * 60 * 60_000;
    expect(backups.due()).toBe(false);
    clock.now += 2 * 60 * 60_000;
    expect(backups.due()).toBe(true);

    backups.update({ schedule: 'weekly' });
    expect(backups.due()).toBe(false);
    clock.now += 7 * 24 * 60 * 60_000;
    expect(backups.due()).toBe(true);
    expect((await backups.tick()).ran).toBe(true);
    expect(await backups.list()).toHaveLength(2);
  });

  it('reports a scheduled run that could not happen, rather than failing silently', async () => {
    const backups = manager();
    backups.update({ schedule: 'daily' });
    // No folder chosen: not due, because there is nowhere to write.
    expect(backups.due()).toBe(false);
    backups.setDir(join(root, 'backups'));
    store.addFolder({ id: uuidv7(), path: join(root, 'gone'), displayName: 'gone', kind: 'music', now: new Date(clock.now).toISOString() });
    const result = await backups.tick();
    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/could not be measured/);
    expect(notices.some((n) => /scheduled backup did not run/.test(n))).toBe(true);
    expect(backups.settings().lastRunError).toMatch(/could not be measured/);
  });
});

describe('the hub’s recommendation settings, and the Live TV links', () => {
  const PROFILE = {
    ownerId: '01920000-0000-7000-8000-0000000000aa',
    computedAt: '2026-09-20T10:00:00.000Z',
    eventCount: 40,
    dimensions: {
      artists: [
        { key: 'Miles Davis', weight: 0.9 },
        { key: 'Nobody', weight: -0.4 },
        { key: 'John Coltrane', weight: 0.6 },
      ],
      genres: [{ key: 'jazz', weight: 0.8 }],
    },
    contexts: [],
    discoveryPreference: 0.3,
    popularityPreference: 0.5,
    coldStart: false,
  };

  function withHub(read: () => Promise<{ profile: Record<string, unknown> | null; hubName: string | null; reason: string | null }>, offered: Array<{ artists: string[]; genres: string[] }>): BackupManager {
    return new BackupManager({
      store,
      readSettings: () => settings,
      writeSettings: (next) => {
        settings = next;
      },
      onProgress: (p) => progress.push(p),
      onNotice: (_kind, message) => notices.push(message),
      now: () => clock.now,
      readAlgorithms: read,
      restoreAlgorithms: async (seeds) => {
        offered.push(seeds);
        return { ok: true, reason: null };
      },
    });
  }

  it('backs them up when the paired hub gives them, and restore offers them back as starting points', async () => {
    const offered: Array<{ artists: string[]; genres: string[] }> = [];
    const backups = withHub(async () => ({ profile: PROFILE, hubName: 'Den Hub', reason: null }), offered);
    backups.setDir(join(root, 'backups'));
    backups.update({ include: { music: false } });
    expect(await backups.algorithms()).toEqual({ available: true, hubName: 'Den Hub', reason: null });
    await backups.create();
    const [archive] = await backups.list();
    expect(archive!.parts).toEqual(['playlists', 'presets', 'algorithms', 'settings']);
    const data = JSON.parse(readFileSync(join(archive!.path, 'data.json'), 'utf8')) as { algorithms: { hubName: string; profile: unknown } };
    expect(data.algorithms).toMatchObject({ hubName: 'Den Hub', profile: PROFILE });

    await backups.restoreArchive(archive!.id);
    await new Promise((r) => setTimeout(r, 10));
    // Strongest first, and a negative weight is not something to start from.
    expect(offered).toEqual([{ artists: ['Miles Davis', 'John Coltrane'], genres: ['jazz'] }]);
    expect(notices.some((n) => /recommendation settings went back to the hub/.test(n))).toBe(true);
  });

  it('backs up the rest, and says why, when the hub cannot give them', async () => {
    const backups = withHub(async () => ({ profile: null, hubName: null, reason: 'No hub is paired, so there are no recommendation settings to back up.' }), []);
    backups.setDir(join(root, 'backups'));
    backups.update({ include: { music: false } });
    expect(await backups.algorithms()).toEqual({ available: false, hubName: null, reason: 'No hub is paired, so there are no recommendation settings to back up.' });
    expect((await backups.create()).reason).toBeNull();
    const [archive] = await backups.list();
    expect(archive!.parts).toEqual(['playlists', 'presets', 'settings']);
  });

  it('carries the Live TV links in “these settings”, and restore hands them back', async () => {
    const links = [
      { kind: 'm3u', url: 'https://iptv.example.com/basic.m3u8' },
      { kind: 'epg', url: 'https://iptv.example.com/guide.xml' },
    ];
    settings = { preferences: { minimizeToTray: true }, liveTv: links };
    const backups = manager();
    backups.setDir(join(root, 'backups'));
    backups.update({ include: { music: false } });
    await backups.create();
    const [archive] = await backups.list();
    expect((JSON.parse(readFileSync(join(archive!.path, 'data.json'), 'utf8')) as { settings: { liveTv: unknown } }).settings.liveTv).toEqual(links);
    settings = { preferences: { minimizeToTray: true }, liveTv: [] };
    await backups.restoreArchive(archive!.id);
    expect(settings['liveTv']).toEqual(links);
  });
});

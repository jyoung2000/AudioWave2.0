/**
 * `GET /helper/v1/backup/estimate`: how big the next backup's folders are, and how much room the
 * backup drive has. The rule the tests hold it to: a number is measured or it is absent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELPER_ROUTES, HelperBackupEstimate } from '@now-playing/contracts';
import { startHelper, type Helper } from '../../src/server.js';

const TOKEN = 'test-token-bbbbbbbbbbbbbbbbbbbbbbbb';

let root: string;
let helper: Helper;
let clock: { now: number; stepPerRead: number };

async function start(backup: { folders: Record<string, string | string[]>; backupDir: string | null; budgetMs?: number }): Promise<void> {
  helper = await startHelper({
    port: 0,
    version: '1.0.0-test',
    token: TOKEN,
    workDir: join(root, 'work'),
    toolsDir: join(root, 'tools'),
    timeoutMs: 20_000,
    allowedHosts: [],
    allowedOrigins: [],
    app: null,
    configured: {},
    log: () => undefined,
    // Every look at the clock moves it, so "time passes while walking" needs no real waiting.
    backup: { ...backup, now: () => (clock.now += clock.stepPerRead) },
  });
}

const ask = (query = '', token: string | null = TOKEN): Promise<Response> => fetch(`${helper.origin}${HELPER_ROUTES.backupEstimate}${query}`, token ? { headers: { 'x-helper-token': token } } : {});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'np-helper-estimate-'));
  clock = { now: Date.parse('2026-09-21T12:00:00.000Z'), stepPerRead: 0 };
  mkdirSync(join(root, 'music', 'album'), { recursive: true });
  writeFileSync(join(root, 'music', 'a.flac'), Buffer.alloc(1000));
  writeFileSync(join(root, 'music', 'album', 'b.flac'), Buffer.alloc(500));
  // The same file under a second name: 500 bytes on disk once, not twice.
  linkSync(join(root, 'music', 'album', 'b.flac'), join(root, 'music', 'album', 'b-again.flac'));
  mkdirSync(join(root, 'tv'));
  writeFileSync(join(root, 'tv', 'show.mkv'), Buffer.alloc(300));
  mkdirSync(join(root, 'backups'));
});

afterEach(async () => {
  await helper.close();
  rmSync(root, { recursive: true, force: true });
});

describe('backup estimate', () => {
  it('measures two parts, counts a hard link once, and reports the backup drive', async () => {
    await start({ folders: { music: join(root, 'music'), tv: join(root, 'tv') }, backupDir: join(root, 'backups') });
    const response = await ask('?parts=music,tv');
    expect(response.status).toBe(200);
    const body = HelperBackupEstimate.parse(await response.json());
    expect(body.parts.music).toMatchObject({ bytes: 1500, files: 2, measuredAt: '2026-09-21T12:00:00.000Z' });
    expect(body.parts.tv).toMatchObject({ bytes: 300, files: 1 });
    expect(body.destination?.path).toBe(join(root, 'backups'));
    expect(body.destination?.freeBytes).toBeGreaterThan(0);
    expect(body.destination?.totalBytes).toBeGreaterThanOrEqual(body.destination!.freeBytes!);
  });

  it('sums a part kept in several folders, and leaves the part out if any one of them could not be finished', async () => {
    await start({ folders: { music: [join(root, 'music'), join(root, 'tv')] }, backupDir: null });
    let body = HelperBackupEstimate.parse(await (await ask('?parts=music')).json());
    expect(body.parts.music).toMatchObject({ bytes: 1800, files: 3 });
    await helper.close();

    await start({ folders: { music: [join(root, 'music'), join(root, 'not-there')] }, backupDir: null });
    body = HelperBackupEstimate.parse(await (await ask('?parts=music')).json());
    // 1500 would be a number for "music" that is smaller than the music; the honest answer is none.
    expect(body.parts.music).toBeUndefined();
  });

  it('skips symbolic links', async () => {
    try {
      symlinkSync(join(root, 'tv'), join(root, 'music', 'linked-tv'), 'junction');
    } catch {
      return; // no permission to make links here; the hard-link case above still ran
    }
    await start({ folders: { music: join(root, 'music') }, backupDir: null });
    const body = HelperBackupEstimate.parse(await (await ask('?parts=music')).json());
    expect(body.parts.music).toMatchObject({ bytes: 1500, files: 2 });
  });

  it('leaves out a folder that is missing or not set, and has no destination without a backup folder', async () => {
    await start({ folders: { music: join(root, 'music'), movies: join(root, 'nowhere') }, backupDir: null });
    const body = HelperBackupEstimate.parse(await (await ask()).json());
    expect(Object.keys(body.parts)).toEqual(['music']);
    expect(body.destination).toBeNull();
  });

  it('returns what it has when time runs out, never a zero for the rest', async () => {
    clock.stepPerRead = 40;
    await start({ folders: { tv: join(root, 'tv'), music: join(root, 'music') }, backupDir: null, budgetMs: 100 });
    const body = HelperBackupEstimate.parse(await (await ask('?parts=tv,music')).json());
    expect(body.parts.tv).toMatchObject({ bytes: 300 });
    expect(body.parts).not.toHaveProperty('music');
  });

  it('reuses a measurement for ten minutes, then measures again', async () => {
    await start({ folders: { tv: join(root, 'tv') }, backupDir: null });
    expect(HelperBackupEstimate.parse(await (await ask('?parts=tv')).json()).parts.tv?.bytes).toBe(300);
    writeFileSync(join(root, 'tv', 'second.mkv'), Buffer.alloc(200));
    clock.now += 9 * 60_000;
    expect(HelperBackupEstimate.parse(await (await ask('?parts=tv')).json()).parts.tv?.bytes).toBe(300);
    clock.now += 2 * 60_000;
    expect(HelperBackupEstimate.parse(await (await ask('?parts=tv')).json()).parts.tv?.bytes).toBe(500);
  });

  it('answers 400 for any other part and 401 without the token', async () => {
    await start({ folders: {}, backupDir: null });
    expect((await ask('?parts=music,photos')).status).toBe(400);
    expect((await ask('?parts=')).status).toBe(400);
    expect((await ask('?parts=music', null)).status).toBe(401);
    expect((await ask('?parts=music', 'wrong-token-cccccccccccccccccccc')).status).toBe(401);
  });
});

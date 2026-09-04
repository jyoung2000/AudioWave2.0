/**
 * Library scanning and path handling.
 *
 * The tests that matter here are about *files*, so they use real ones in a temporary directory
 * rather than a mocked filesystem: the bugs this code can have — a path that escapes its folder, a
 * rescan that re-reads unchanged files, a deleted file that never gets a tombstone — are all bugs
 * about what is actually on disk.
 */
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeToneWav } from '@now-playing/test-fixtures';
import { absolutePathOf, isInside, quickHash, scanFolder, walk } from '../../src/main/library.js';
import { CompanionStore, openCompanionDb } from '../../src/main/store.js';

let root: string;
let store: CompanionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'np-companion-'));
  store = new CompanionStore(openCompanionDb(':memory:'));
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

async function writeSong(relativePath: string, options: { seconds?: number; hz?: number; title?: string } = {}): Promise<string> {
  const seconds = options.seconds ?? 0.3;
  const absolute = join(root, relativePath);
  await mkdir(join(absolute, '..'), { recursive: true });
  const title = options.title ?? relativePath.split('/').pop()!.replace(/\.[^.]+$/, '');
  await writeFile(absolute, Buffer.from(makeToneWav({ seconds, notes: [[options.hz ?? 440, seconds]] }, { title, artist: 'Fixture Artist', album: 'Fixture Album' })));
  return absolute;
}

describe('walk', () => {
  it('finds audio files at any depth and reports paths with forward slashes', async () => {
    await writeSong('a.wav');
    await writeSong('Album/b.wav');
    await writeSong('Album/Disc 2/c.wav');
    await writeFile(join(root, 'notes.txt'), 'not audio');

    const found = [];
    for await (const file of walk(root)) found.push(file.relativePath);

    expect(found.sort()).toEqual(['Album/Disc 2/c.wav', 'Album/b.wav', 'a.wav']);
  });

  it('skips dot-directories and the Windows folders nobody wants indexed', async () => {
    await writeSong('.hidden/x.wav');
    await writeSong('$RECYCLE.BIN/y.wav');
    await writeSong('keep.wav');

    const found = [];
    for await (const file of walk(root)) found.push(file.relativePath);

    expect(found).toEqual(['keep.wav']);
  });
});

describe('quickHash', () => {
  it('is stable for identical contents and differs when a byte changes', async () => {
    const a = await writeSong('a.wav');
    const b = await writeSong('b.wav', { hz: 880 });
    const statA = await stat(a);
    expect(await quickHash(a, statA.size)).toBe(await quickHash(a, statA.size));

    const statB = await stat(b);
    expect(await quickHash(b, statB.size)).not.toBe(await quickHash(a, statA.size));
  });
});

describe('scanFolder', () => {
  it('indexes files, then skips unchanged ones on a rescan', async () => {
    await writeSong('one.wav');
    await writeSong('two.wav');
    store.addFolder({ id: 'f1', path: root, displayName: 'Music', now: new Date().toISOString() });

    const first = await scanFolder(store, { id: 'f1', path: root });
    expect(first.added).toBe(2);
    expect(first.skipped).toBe(0);

    const second = await scanFolder(store, { id: 'f1', path: root });
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it('re-reads a file whose modification time changed', async () => {
    const path = await writeSong('one.wav');
    store.addFolder({ id: 'f1', path: root, displayName: 'Music', now: new Date().toISOString() });
    await scanFolder(store, { id: 'f1', path: root });

    const later = new Date(Date.now() + 60_000);
    await utimes(path, later, later);

    const rescan = await scanFolder(store, { id: 'f1', path: root });
    expect(rescan.updated).toBe(1);
    expect(rescan.skipped).toBe(0);
  });

  it('tombstones a file that has been deleted rather than dropping the row', async () => {
    await writeSong('gone.wav');
    await writeSong('stays.wav');
    store.addFolder({ id: 'f1', path: root, displayName: 'Music', now: new Date().toISOString() });
    await scanFolder(store, { id: 'f1', path: root });

    await rm(join(root, 'gone.wav'));
    const rescan = await scanFolder(store, { id: 'f1', path: root });

    expect(rescan.removed).toBe(1);
    // The tombstone still exists, which is what lets a paired hub learn about the deletion.
    expect(store.searchTracks({ limit: 100, offset: 0 }).items).toHaveLength(1);
  });

  it('records an unreadable file without abandoning the scan', async () => {
    await writeSong('good.wav');
    // A zero-byte file with an audio extension: the tag reader fails, the scan continues.
    await writeFile(join(root, 'broken.flac'), Buffer.alloc(0));
    store.addFolder({ id: 'f1', path: root, displayName: 'Music', now: new Date().toISOString() });

    const result = await scanFolder(store, { id: 'f1', path: root });
    expect(result.added).toBeGreaterThanOrEqual(1);
    // Whether music-metadata throws on an empty file or produces a bare track, the good file is in.
    expect(store.searchTracks({ limit: 100, offset: 0 }).items.some((t) => t.title === 'good')).toBe(true);
  });

  it('stops when the scan is aborted and leaves earlier rows alone', async () => {
    for (let i = 0; i < 5; i += 1) await writeSong(`song-${i}.wav`);
    store.addFolder({ id: 'f1', path: root, displayName: 'Music', now: new Date().toISOString() });

    const controller = new AbortController();
    let seen = 0;
    const result = await scanFolder(store, { id: 'f1', path: root }, {
      signal: controller.signal,
      onProgress: () => {
        seen += 1;
        if (seen === 2) controller.abort();
      },
    });

    expect(result.added).toBeLessThan(5);
    // Nothing is tombstoned by an aborted scan: the files it never reached are not "missing".
    expect(result.removed).toBe(0);
  });
});

describe('containment', () => {
  it('treats a sibling directory with a shared prefix as outside', () => {
    expect(isInside(resolve('/music'), resolve('/music/album/a.mp3'))).toBe(true);
    expect(isInside(resolve('/music'), resolve('/music'))).toBe(true);
    // The bug a plain startsWith() check has: /musicsecret shares a prefix with /music.
    expect(isInside(resolve('/music'), resolve('/musicsecret/a.mp3'))).toBe(false);
  });

  it('refuses a stored relative path that climbs out of its folder', async () => {
    await writeSong('inside.wav');
    store.addFolder({ id: 'f1', path: root, displayName: 'Music', now: new Date().toISOString() });
    await scanFolder(store, { id: 'f1', path: root });
    const track = store.searchTracks({ limit: 1, offset: 0 }).items[0]!;

    expect(absolutePathOf(store, track.id)).toBe(join(root, 'inside.wav'));

    // A row whose relative path climbs out of the folder — how a tampered database, or a synced
    // record from a hostile peer, would look. The resolver refuses rather than handing back a path
    // outside the folder the person actually chose.
    const stored = store.findTrack(track.id)!;
    const escaping = { ...stored, id: '00000000-0000-7000-8000-00000000dead', relativePath: '../../../etc/passwd' };
    store.upsertTrack(escaping);
    expect(absolutePathOf(store, escaping.id)).toBeNull();
  });

  it('returns null for a track or folder that is not there', () => {
    expect(absolutePathOf(store, '00000000-0000-7000-8000-000000000000')).toBeNull();
  });
});

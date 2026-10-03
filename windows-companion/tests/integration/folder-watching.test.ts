/**
 * Watching library folders, against a real directory.
 *
 * The claim "keeps watching your folders" was not true: `chokidar` was a dependency imported
 * nowhere, the `watchFolders` preference was written and never read, and the `folders.watch` column
 * was set and never consulted. These tests use the real watcher on a real temp directory, because
 * the thing worth proving is that the filesystem actually reaches the scan — a mock of chokidar
 * would have passed against the broken version too.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FolderWatcher, WATCH_DEBOUNCE_MS } from '../../src/main/watcher.js';

/** A root the watcher cannot open: a drive letter nobody has, spelled without escapes. */
const UNREACHABLE = ['X:', 'gone'].join(String.fromCharCode(92));

/** Short, so the tests are not paced by the production debounce. */
// Longer than chokidar's write-finish poll (200 ms, see watcher.ts): a burst of files is reported
// over two or three polls on a busy machine, and a debounce shorter than one poll would split it
// into two scans here though it never does at the app's own two seconds.
const DEBOUNCE_MS = 500;

let root: string;
let watcher: FolderWatcher | null = null;
let scans: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'np-watch-'));
  scans = [];
});

afterEach(async () => {
  await watcher?.close();
  watcher = null;
  rmSync(root, { recursive: true, force: true });
});

function start(folders: Array<{ id: string; path: string; watch: boolean }>, enabled = true): FolderWatcher {
  watcher = new FolderWatcher({ onChanged: (id) => void scans.push(id), debounceMs: DEBOUNCE_MS });
  watcher.sync(folders, enabled);
  return watcher;
}

/** Wait until `check` holds, or give up. Filesystem events have no deadline worth guessing at. */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('folder watching', () => {
  it('scans a root after a file appears in it', async () => {
    start([{ id: 'f1', path: root, watch: true }]);
    // Chokidar needs a moment to finish its initial walk before new events are reported.
    await new Promise((resolve) => setTimeout(resolve, 300));

    writeFileSync(join(root, 'song.mp3'), 'not really audio');
    await until(() => scans.length > 0);
    expect(scans).toEqual(['f1']);
  });

  it('sees a file added deep inside the tree, because the watch has no depth limit', async () => {
    start([{ id: 'f1', path: root, watch: true }]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const deep = join(root, 'Artist', 'Album', 'Disc 2');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'track.flac'), 'not really audio');
    await until(() => scans.length > 0);
    expect(scans[0]).toBe('f1');
  });

  it('collects a burst of files into one scan rather than one scan per file', async () => {
    start([{ id: 'f1', path: root, watch: true }]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // An album copy is dozens of events; a scan per event would be unusable.
    for (let i = 0; i < 12; i += 1) writeFileSync(join(root, `track-${i}.mp3`), 'not really audio');
    await until(() => scans.length > 0);
    // Let the debounce window pass again to be sure nothing further is queued behind it.
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 3));
    expect(scans).toEqual(['f1']);
  });

  it('watches nothing while the preference is off', async () => {
    const w = start([{ id: 'f1', path: root, watch: true }], false);
    expect(w.watching).toEqual([]);
    writeFileSync(join(root, 'song.mp3'), 'not really audio');
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 4));
    expect(scans).toEqual([]);
  });

  it('watches only the folders whose own switch is on', () => {
    const other = mkdtempSync(join(tmpdir(), 'np-watch-off-'));
    try {
      const w = start([
        { id: 'on', path: root, watch: true },
        { id: 'off', path: other, watch: false },
      ]);
      expect(w.watching).toEqual(['on']);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('stops watching a folder that has been removed, and starts on one that is added', () => {
    const second = mkdtempSync(join(tmpdir(), 'np-watch-2-'));
    try {
      const w = start([{ id: 'f1', path: root, watch: true }]);
      expect(w.watching).toEqual(['f1']);

      w.sync([{ id: 'f2', path: second, watch: true }], true);
      expect(w.watching).toEqual(['f2']);

      w.sync([], true);
      expect(w.watching).toEqual([]);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('does not restart a watcher it already has', () => {
    const w = start([{ id: 'f1', path: root, watch: true }]);
    w.sync([{ id: 'f1', path: root, watch: true }], true);
    w.sync([{ id: 'f1', path: root, watch: true }], true);
    expect(w.watching).toEqual(['f1']);
  });

  it('reports a root it cannot watch without giving up on the others', () => {
    const errors: string[] = [];
    watcher = new FolderWatcher({
      onChanged: (id) => void scans.push(id),
      onError: (id) => errors.push(id),
      debounceMs: DEBOUNCE_MS,
      createWatcher: (path) => {
        if (path === UNREACHABLE) throw new Error('no such drive');
        return { on: () => undefined, close: async () => undefined } as never;
      },
    });
    watcher.sync(
      [
        { id: 'missing', path: UNREACHABLE, watch: true },
        { id: 'fine', path: root, watch: true },
      ],
      true,
    );
    expect(errors).toEqual(['missing']);
    expect(watcher.watching).toEqual(['fine']);
  });

  it('uses a two-second debounce by default', () => {
    expect(WATCH_DEBOUNCE_MS).toBe(2000);
  });
});

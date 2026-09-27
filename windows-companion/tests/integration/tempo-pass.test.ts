import { uuidv7 } from '@now-playing/domain';
import type { Track } from '@now-playing/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { CompanionStore, openCompanionDb, type StoredTrack } from '../../src/main/store.js';
import { runTempoPass } from '../../src/main/tempo-analysis.js';

/**
 * The after-scan pass: which files get measured, which are left alone, and how it steps aside.
 * The measurement itself is Task 1's; here the analyzer is injected so the pass's own rules are
 * what the assertions see.
 */

const NOW = new Date().toISOString();

function track(overrides: Partial<Track> & { title: string; artistName: string }): Track {
  return {
    id: uuidv7(),
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    artistId: null,
    albumId: null,
    albumName: null,
    albumArtistName: null,
    discNumber: null,
    trackNumber: null,
    genre: null,
    genres: [],
    tags: [],
    year: null,
    durationMs: 200_000,
    bpm: null,
    bpmSource: null,
    featuredArtists: [],
    genreProfile: {},
    identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} },
    locators: [],
    artworkId: null,
    format: null,
    rootId: null,
    unsupportedReason: null,
    liked: false,
    explicit: null,
    popularity: null,
    ...overrides,
  } as Track;
}

function record(t: Track, relativePath: string): StoredTrack {
  return { id: t.id, folderId: 'folder-1', relativePath, track: t, sizeBytes: 1000, mtimeMs: 1, contentHash: null, updatedAt: NOW, deletedAt: null };
}

describe('runTempoPass', () => {
  let store: CompanionStore;
  let tagged: Track;
  let silent: Track;
  let broken: Track;

  beforeEach(() => {
    store = new CompanionStore(openCompanionDb(':memory:'));
    store.addFolder({ id: 'folder-1', path: 'C:/music', displayName: 'Music', now: NOW });
    tagged = track({ title: 'Tagged', artistName: 'A', bpm: 128, bpmSource: 'tag' });
    silent = track({ title: 'Silent', artistName: 'A' });
    broken = track({ title: 'Broken', artistName: 'A' });
    store.upsertTrack(record(tagged, 'tagged.flac'));
    store.upsertTrack(record(silent, 'silent.flac'));
    store.upsertTrack(record(broken, 'broken.flac'));
  });

  it('measures only the silent rows, writes the answer as analysis, and survives a broken file', async () => {
    const asked: string[] = [];
    const result = await runTempoPass({
      store,
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      resolvePath: (r) => 'C:/music/' + r.relativePath,
      analyze: async (_deps, file) => {
        asked.push(file.absolutePath);
        if (file.absolutePath.endsWith('broken.flac')) throw new Error('undecodable');
        return { bpm: 120, confidence: 2 };
      },
    });
    expect(asked.some((p) => p.endsWith('tagged.flac')), 'a tagged tempo is never re-measured').toBe(false);
    expect(store.findTrack(tagged.id)!.track.bpm).toBe(128);
    expect(store.findTrack(tagged.id)!.track.bpmSource).toBe('tag');
    const measured = store.findTrack(silent.id)!.track;
    expect(measured.bpm).toBe(120);
    expect(measured.bpmSource).toBe('analysis');
    expect(store.findTrack(broken.id)!.track.bpm).toBeNull();
    expect(result).toEqual({ measured: 1, skipped: 1 });
  });

  it('no ffmpeg means no work and an honest count, and nothing is asked', async () => {
    let asked = 0;
    const result = await runTempoPass({ store, ffmpegPath: null, resolvePath: () => null, analyze: async () => { asked += 1; return null; } });
    expect(asked).toBe(0);
    expect(result.measured).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(store.findTrack(silent.id)!.track.bpm).toBeNull();
  });

  it('an abort mid-pass leaves the rest untouched for the next scan', async () => {
    const ctl = new AbortController();
    let calls = 0;
    const result = await runTempoPass({
      store,
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      signal: ctl.signal,
      resolvePath: (r) => 'C:/music/' + r.relativePath,
      analyze: async () => {
        calls += 1;
        ctl.abort();
        return { bpm: 99, confidence: 2 };
      },
    });
    expect(calls).toBe(1);
    expect(result.measured).toBe(1);
    const untouched = [silent, broken].filter((t) => store.findTrack(t.id)!.track.bpm === null);
    expect(untouched.length).toBe(1);
  });

  it('a path that cannot be resolved is skipped, not crashed on', async () => {
    const result = await runTempoPass({ store, ffmpegPath: 'C:/tools/ffmpeg.exe', resolvePath: () => null, analyze: async () => ({ bpm: 100, confidence: 2 }) });
    expect(result.measured).toBe(0);
  });

  it('an answer for a file that was retagged mid-pass is thrown away, never written over the tag', async () => {
    await runTempoPass({
      store,
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      resolvePath: (r) => 'C:/music/' + r.relativePath,
      analyze: async (_deps, file) => {
        if (file.absolutePath.endsWith('silent.flac')) {
          // While ffmpeg listens, a scan re-reads the retagged file: new mtime, a tempo from the tag.
          store.upsertTrack({ ...record({ ...silent, bpm: 140, bpmSource: 'tag' }, 'silent.flac'), mtimeMs: 2 });
        }
        return { bpm: 120, confidence: 2 };
      },
    });
    const after = store.findTrack(silent.id)!.track;
    expect(after.bpm).toBe(140);
    expect(after.bpmSource).toBe('tag');
  });

  it('a track deleted mid-pass stays deleted', async () => {
    await runTempoPass({
      store,
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      resolvePath: (r) => 'C:/music/' + r.relativePath,
      analyze: async (_deps, file) => {
        if (file.absolutePath.endsWith('silent.flac')) store.tombstone(silent.id, new Date().toISOString());
        return { bpm: 120, confidence: 2 };
      },
    });
    const after = store.findTrack(silent.id)!;
    expect(after.deletedAt).not.toBeNull();
    expect(after.track.bpm).toBeNull();
  });

  it('a file that cannot be measured is left alone until the file itself changes', async () => {
    const failEverything = { store, ffmpegPath: 'C:/tools/ffmpeg.exe', resolvePath: (r: StoredTrack) => 'C:/music/' + r.relativePath };
    await runTempoPass({ ...failEverything, analyze: async () => null });
    let asked = 0;
    await runTempoPass({ ...failEverything, analyze: async () => { asked += 1; return null; } });
    expect(asked, 'a failed file is not decoded again while unchanged').toBe(0);
    // The file changes on disk: a rescan writes a new mtime, and the backlog wants it again.
    store.upsertTrack({ ...record(silent, 'silent.flac'), mtimeMs: 2 });
    await runTempoPass({ ...failEverything, analyze: async () => { asked += 1; return null; } });
    expect(asked).toBe(1);
  });

  it('a store closed mid-pass ends the pass quietly', async () => {
    const result = await runTempoPass({
      store,
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      resolvePath: (r) => 'C:/music/' + r.relativePath,
      analyze: async () => {
        store.close();
        return { bpm: 120, confidence: 2 };
      },
    });
    expect(result.measured + result.skipped).toBeLessThanOrEqual(3);
  });
});

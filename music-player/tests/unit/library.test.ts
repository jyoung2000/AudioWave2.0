/**
 * Library indexing.
 *
 * These run against real files built by the fixture generator and a real `fake-indexeddb`, so the
 * tag reader, the change detection and the tombstoning are all exercised as they run in a browser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { encodeWav, synthesizePcm16 } from '@now-playing/test-fixtures';
import { extensionOf, indexPickedFiles, isAudioFile, probeSupport, resolveFile, trackFromFile } from '../../src/lib/library.js';
import { openPlayerDb, resetPlayerDbForTests } from '../../src/lib/db.js';

function wavFile(name: string, tags: { title?: string; artist?: string; album?: string; year?: string } = {}): File {
  const pcm = synthesizePcm16({ seconds: 0.25, sampleRate: 44100, channels: 2, notes: [[440, 0.25]] });
  const bytes = encodeWav(pcm, tags);
  return new File([bytes as unknown as BlobPart], name, { type: 'audio/wav', lastModified: 1_700_000_000_000 });
}

const SUPPORT_ALL = new Map(['.wav', '.mp3', '.flac', '.ogg'].map((e) => [e, true]));

/**
 * A uniquely named database per test. Deleting a shared one is not enough: an open handle in a
 * previous test blocks the delete, and the next `openDB` then waits for a version change that never
 * comes — which shows up as a timeout rather than a useful failure.
 */
let counter = 0;
function freshDb() {
  resetPlayerDbForTests();
  counter += 1;
  return openPlayerDb(`now-playing-test-${counter}`);
}

beforeEach(() => {
  resetPlayerDbForTests();
});

describe('file classification', () => {
  it('recognises audio extensions case-insensitively', () => {
    expect(isAudioFile('Song.MP3')).toBe(true);
    expect(isAudioFile('song.flac')).toBe(true);
    expect(isAudioFile('cover.jpg')).toBe(false);
    expect(isAudioFile('README')).toBe(false);
  });

  it('extracts extensions, including from names with dots', () => {
    expect(extensionOf('a.b.c.mp3')).toBe('.mp3');
    expect(extensionOf('noextension')).toBe('');
  });
});

describe('trackFromFile', () => {
  it('reads tags into a track', async () => {
    const { track } = await trackFromFile(wavFile('01 Ember Line.wav', { title: 'Ember Line', artist: 'Test Artist', album: 'Test Album', year: '2011' }), 'Album/01 Ember Line.wav', 'root-1', SUPPORT_ALL);
    expect(track.title).toBe('Ember Line');
    expect(track.artistName).toBe('Test Artist');
    expect(track.albumName).toBe('Test Album');
    expect(track.year).toBe(2011);
  });

  it('falls back to the filename when there are no tags, rather than hiding the file', async () => {
    const { track } = await trackFromFile(wavFile('Some Song.wav'), 'Some Song.wav', 'root-1', SUPPORT_ALL);
    expect(track.title).toBe('Some Song');
    expect(track.artistName).toBe('Unknown Artist');
    expect(track.unsupportedReason).toBeNull();
  });

  it('records why a format cannot play here instead of dropping it', async () => {
    const support = new Map([['.wav', false]]);
    const { track } = await trackFromFile(wavFile('Unplayable.wav'), 'Unplayable.wav', 'root-1', support);
    expect(track.unsupportedReason).toContain('cannot decode');
    // The track still exists: the file is real, only this browser cannot play it.
    expect(track.title).toBe('Unplayable');
  });

  it('stores a relative handle, never an absolute path', async () => {
    const { track } = await trackFromFile(wavFile('song.wav'), 'Artist/Album/song.wav', 'root-1', SUPPORT_ALL);
    const locator = track.locators[0];
    expect(locator).toMatchObject({ kind: 'browser-handle', handleId: 'Artist/Album/song.wav' });
    expect(JSON.stringify(track)).not.toMatch(/^[/\\]|[A-Z]:\\/);
  });

  it('keeps an existing id so a rescan does not create a duplicate track', async () => {
    const first = await trackFromFile(wavFile('song.wav'), 'song.wav', 'root-1', SUPPORT_ALL);
    const second = await trackFromFile(wavFile('song.wav'), 'song.wav', 'root-1', SUPPORT_ALL, first.track.id);
    expect(second.track.id).toBe(first.track.id);
  });
});

describe('indexing picked files', () => {
  it('indexes audio files and skips everything else', async () => {
    const db = await freshDb();
    const files = [wavFile('a.wav', { title: 'A' }), wavFile('b.wav', { title: 'B' }), new File(['not audio'], 'notes.txt', { type: 'text/plain' })];
    const result = await indexPickedFiles(db, 'root-1', files, { support: SUPPORT_ALL });
    expect(result.added).toBe(2);
    expect(await db.count('tracks')).toBe(2);
  });

  it('reports progress as it goes', async () => {
    const db = await freshDb();
    const seen: number[] = [];
    await indexPickedFiles(db, 'root-1', [wavFile('a.wav'), wavFile('b.wav')], { support: SUPPORT_ALL, onProgress: (p) => seen.push(p.indexed) });
    expect(seen).toEqual([1, 2]);
  });

  it('marks picked files as unreopenable, and says so when asked for one', async () => {
    const db = await freshDb();
    await indexPickedFiles(db, 'root-1', [wavFile('a.wav', { title: 'A' })], { support: SUPPORT_ALL });
    const track = (await db.getAll('tracks'))[0]!;
    const resolved = await resolveFile(db, track.id);
    expect(resolved.file).toBeNull();
    expect('reason' in resolved && resolved.reason).toContain('cannot reopen it');
  });

  it('stops when the caller aborts', async () => {
    const db = await freshDb();
    const controller = new AbortController();
    const files = [wavFile('a.wav'), wavFile('b.wav'), wavFile('c.wav')];
    const result = await indexPickedFiles(db, 'root-1', files, {
      support: SUPPORT_ALL,
      onProgress: (p) => {
        if (p.indexed >= 1) controller.abort();
      },
      signal: controller.signal,
    });
    expect(result.added).toBeLessThan(3);
  });
});

describe('format probing', () => {
  it('asks the browser rather than assuming', () => {
    const audio = { canPlayType: vi.fn((mime: string) => (mime.includes('mpeg') ? 'probably' : mime.includes('flac') ? 'maybe' : '')) } as unknown as HTMLAudioElement;
    const support = probeSupport(audio);
    expect(support.get('.mp3')).toBe(true);
    expect(support.get('.flac')).toBe(true);
    expect(support.get('.wma')).toBe(false);
    expect(audio.canPlayType).toHaveBeenCalled();
  });
});

describe('resolving a missing track', () => {
  it('explains rather than throwing when a track has no file', async () => {
    const db = await freshDb();
    const resolved = await resolveFile(db, '00000000-0000-7000-8000-000000000000');
    expect(resolved.file).toBeNull();
    expect('reason' in resolved && resolved.reason).toContain('not linked to a file');
  });
});

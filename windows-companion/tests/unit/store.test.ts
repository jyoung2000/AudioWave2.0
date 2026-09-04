/**
 * The companion's local database.
 *
 * The behaviour worth pinning down is search — it is the part with hand-written SQL and an index
 * that has to be kept in step with the rows — and the tombstone rule, which is what lets a deletion
 * on this computer reach a paired hub instead of silently reappearing on the next sync.
 */
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { Track } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import { CompanionStore, openCompanionDb, type StoredTrack } from '../../src/main/store.js';

let store: CompanionStore;

beforeEach(() => {
  store = new CompanionStore(openCompanionDb(':memory:'));
  store.addFolder({ id: 'folder-1', path: '/music', displayName: 'Music', now: new Date().toISOString() });
});

afterEach(() => store.close());

function track(overrides: Partial<Track> & { title: string; artistName: string }): Track {
  return {
    id: uuidv7(),
    schemaVersion: 1,
    albumName: null,
    albumArtistName: null,
    genre: null,
    genres: [],
    year: null,
    trackNumber: null,
    discNumber: null,
    durationMs: 180_000,
    bpm: null,
    artworkId: null,
    provider: 'local',
    identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} },
    locators: [],
    format: { sizeBytes: 1000 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Track;
}

function store1(t: Track, relativePath: string): StoredTrack {
  const record: StoredTrack = { id: t.id, folderId: 'folder-1', relativePath, track: t, sizeBytes: 1000, mtimeMs: 1, contentHash: null, updatedAt: t.updatedAt, deletedAt: null };
  store.upsertTrack(record);
  return record;
}

describe('search', () => {
  beforeEach(() => {
    store1(track({ title: 'Blue in Green', artistName: 'Miles Davis', albumName: 'Kind of Blue' }), 'a.flac');
    store1(track({ title: 'So What', artistName: 'Miles Davis', albumName: 'Kind of Blue' }), 'b.flac');
    store1(track({ title: 'Naima', artistName: 'John Coltrane', albumName: 'Giant Steps' }), 'c.flac');
  });

  it('matches on title, artist and album', () => {
    expect(store.searchTracks({ query: 'Naima', limit: 10, offset: 0 }).items.map((t) => t.title)).toEqual(['Naima']);
    expect(store.searchTracks({ query: 'Miles', limit: 10, offset: 0 }).items).toHaveLength(2);
    expect(store.searchTracks({ query: 'Giant', limit: 10, offset: 0 }).items.map((t) => t.title)).toEqual(['Naima']);
  });

  it('matches on a prefix, so results appear while someone is still typing', () => {
    expect(store.searchTracks({ query: 'Colt', limit: 10, offset: 0 }).items).toHaveLength(1);
  });

  it('treats punctuation as text rather than as query syntax', () => {
    // Bare FTS5 would read these as operators and throw a syntax error at the person mid-word.
    for (const query of ['"', 'blue OR', 'kind-of', 'a*b', 'NEAR(', ')']) {
      expect(() => store.searchTracks({ query, limit: 10, offset: 0 })).not.toThrow();
    }
  });

  it('reflects an edited tag rather than keeping the old text findable', () => {
    const original = track({ title: 'Untitled', artistName: 'Unknown Artist' });
    store1(original, 'd.flac');
    expect(store.searchTracks({ query: 'Untitled', limit: 10, offset: 0 }).items).toHaveLength(1);

    store1({ ...original, title: 'Ascension' }, 'd.flac');
    expect(store.searchTracks({ query: 'Untitled', limit: 10, offset: 0 }).items).toHaveLength(0);
    expect(store.searchTracks({ query: 'Ascension', limit: 10, offset: 0 }).items).toHaveLength(1);
  });

  it('hides a tombstoned track from both search and the plain listing', () => {
    const record = store1(track({ title: 'Deleted Song', artistName: 'Nobody' }), 'e.flac');
    store.tombstone(record.id, new Date().toISOString());

    expect(store.searchTracks({ query: 'Deleted', limit: 10, offset: 0 }).items).toHaveLength(0);
    expect(store.searchTracks({ limit: 100, offset: 0 }).items.some((t) => t.title === 'Deleted Song')).toBe(false);
    // The row itself survives, which is what a paired hub reads to learn about the deletion.
    expect(store.findTrack(record.id)?.deletedAt).not.toBeNull();
  });

  it('reports a total that is independent of the page size', () => {
    const page = store.searchTracks({ query: 'Miles', limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
  });
});

describe('folders', () => {
  it('tombstones a folder’s tracks when the folder is removed', () => {
    const record = store1(track({ title: 'One', artistName: 'A' }), 'one.flac');
    store.removeFolder('folder-1', new Date().toISOString());

    expect(store.findFolder('folder-1')).toBeUndefined();
    expect(store.findTrack(record.id)?.deletedAt).not.toBeNull();
  });

  it('reports availability through the caller’s own check, not a cached flag', () => {
    expect(store.listFolders(() => false)[0]?.available).toBe(false);
    expect(store.listFolders(() => true)[0]?.available).toBe(true);
  });
});

describe('rebuilding the search index', () => {
  it('repopulates from the track rows when an older index layout is on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'np-store-'));
    const file = join(dir, 'companion.sqlite');
    try {
      const first = new CompanionStore(openCompanionDb(file));
      first.addFolder({ id: 'f', path: '/m', displayName: 'M', now: new Date().toISOString() });
      const t = track({ title: 'Rebuilt', artistName: 'Someone' });
      first.upsertTrack({ id: t.id, folderId: 'f', relativePath: 'x.flac', track: t, sizeBytes: 1, mtimeMs: 1, contentHash: null, updatedAt: t.updatedAt, deletedAt: null });
      first.close();

      // The layout an earlier build wrote: a contentless index that could never be updated.
      const raw = new Database(file);
      raw.exec("DROP TABLE tracks_fts");
      raw.exec("CREATE VIRTUAL TABLE tracks_fts USING fts5(title, artist, album, content='')");
      raw.close();

      const reopened = new CompanionStore(openCompanionDb(file));
      // Opening rebuilt the index from the rows, so the track is findable again without a rescan.
      expect(reopened.searchTracks({ query: 'Rebuilt', limit: 10, offset: 0 }).items).toHaveLength(1);
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

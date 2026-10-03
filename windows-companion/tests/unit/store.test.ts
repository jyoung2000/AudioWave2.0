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
    bpmSource: null,
    featuredArtists: [],
    genreProfile: {},
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
    const stored = store.findTrack(record.id);
    expect(stored).toBeDefined();
    expect(stored?.deletedAt).toEqual(expect.any(String));
  });

  it('keeps a reappearing file under the id it already had, so it stays findable', () => {
    const original = store1(track({ title: 'Comeback', artistName: 'Returner' }), 'f.flac');
    store.tombstone(original.id, new Date().toISOString());

    // A rescan that no longer knows the old id offers a fresh one; the stored id wins.
    const again = track({ title: 'Comeback', artistName: 'Returner' });
    const storedId = store.upsertTrack({ id: again.id, folderId: 'folder-1', relativePath: 'f.flac', track: again, sizeBytes: 1000, mtimeMs: 2, contentHash: null, updatedAt: again.updatedAt, deletedAt: null });

    expect(storedId).toBe(original.id);
    const found = store.searchTracks({ query: 'Comeback', limit: 10, offset: 0 }).items;
    expect(found.map((t) => t.id)).toEqual([original.id]);
    expect(store.findTrack(original.id)?.deletedAt).toBeNull();
    expect(store.findTrack(again.id)).toBeUndefined();
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
    // The track must still exist — a cascade that deleted it would never reach a paired hub.
    const stored = store.findTrack(record.id);
    expect(stored).toBeDefined();
    expect(stored?.deletedAt).toEqual(expect.any(String));
    expect(stored?.updatedAt).toBe(stored?.deletedAt);
    // And the search index no longer holds it.
    const orphans = store.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM tracks_fts').get()?.n;
    expect(orphans).toBe(0);
  });

  it('reports availability through the caller’s own check, not a cached flag', () => {
    expect(store.listFolders(() => false)[0]?.available).toBe(false);
    expect(store.listFolders(() => true)[0]?.available).toBe(true);
  });
});

describe('migrating a database written by an earlier build', () => {
  it('drops the cascading delete, keeps every track and its search entry, and then tombstones on folder removal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'np-store-migrate-'));
    const file = join(dir, 'companion.sqlite');
    try {
      // The layout an earlier build wrote: tracks were cascade-deleted with their folder.
      const legacy = new Database(file);
      legacy.exec(`CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, watch INTEGER NOT NULL DEFAULT 1, track_count INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0, last_scan_at TEXT, last_scan_error TEXT, created_at TEXT NOT NULL);
        CREATE TABLE tracks (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, relative_path TEXT NOT NULL, track TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, content_hash TEXT, updated_at TEXT NOT NULL, deleted_at TEXT, UNIQUE(folder_id, relative_path));`);
      const now = new Date().toISOString();
      legacy.prepare('INSERT INTO folders (id, path, display_name, created_at) VALUES (?, ?, ?, ?)').run('f', '/m', 'M', now);
      const t = track({ title: 'Survivor', artistName: 'Legacy' });
      legacy.prepare('INSERT INTO tracks (id, folder_id, relative_path, track, size_bytes, mtime_ms, content_hash, updated_at, deleted_at) VALUES (?, ?, ?, ?, 1, 1, NULL, ?, NULL)').run(t.id, 'f', 'x.flac', JSON.stringify(t), now);
      legacy.close();

      const upgraded = new CompanionStore(openCompanionDb(file));
      try {
        // Version 2 added the folder kind, version 3 the tempo-attempt marker; a database from
        // before any migration lands on the current one with every column in place.
        expect(upgraded.raw.pragma('user_version', { simple: true })).toBe(3);
        const sql = upgraded.raw.prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tracks'").get()?.sql;
        expect(sql).not.toMatch(/CASCADE/i);
        const trackColumns = upgraded.raw.prepare<[], { name: string }>('PRAGMA table_info(tracks)').all().map((c) => c.name);
        expect(trackColumns).toContain('tempo_attempted_mtime');
        expect(upgraded.searchTracks({ query: 'Survivor', limit: 10, offset: 0 }).items).toHaveLength(1);

        upgraded.removeFolder('f', new Date().toISOString());
        expect(upgraded.findTrack(t.id)?.deletedAt).toEqual(expect.any(String));
      } finally {
        upgraded.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
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

describe('a library of 50,000 songs, a stretch at a time', () => {
  it('gives every song exactly one place, reads any stretch quickly, and lists the ids alone', () => {
    const total = 50_000;
    store.transaction(() => {
      for (let i = 0; i < total; i += 1) {
        // Few artists and albums, so most songs tie on them and the id has to settle their order.
        store1(track({ title: `Song ${i}`, artistName: `Artist ${i % 40}`, albumName: `Album ${i % 7}` }), `${i}.flac`);
      }
    });
    const ids = store.trackIds({ limit: 100_000, offset: 0 });
    expect(ids.total).toBe(total);
    expect(new Set(ids.ids).size).toBe(total);

    // A stretch near the end, as the window asks for it when scrolled there.
    const started = performance.now();
    const page = store.searchTracks({ limit: 200, offset: 49_800 });
    const took = performance.now() - started;
    expect(page.total).toBe(total);
    expect(page.items.map((t) => t.id)).toEqual(ids.ids.slice(49_800, 50_000));
    expect(took, `a stretch of 200 at the end took ${Math.round(took)} ms`).toBeLessThan(400);

    // Stretches of the ids line up with stretches of songs, so a range can be chosen without loading it.
    expect(store.trackIds({ limit: 300, offset: 12_345 }).ids).toEqual(ids.ids.slice(12_345, 12_645));
    // And a search pages the same way.
    const found = store.trackIds({ query: 'Artist', limit: 100_000, offset: 0 });
    expect(found.total).toBe(total);
    expect(store.searchTracks({ query: 'Artist', limit: 50, offset: 100 }).items.map((t) => t.id)).toEqual(found.ids.slice(100, 150));
  }, 120_000);
});

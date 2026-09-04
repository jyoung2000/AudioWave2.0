/**
 * The companion's local database.
 *
 * SQLite rather than a JSON file: a library of a hundred thousand tracks needs indexed queries, and
 * a partially written JSON file after a power cut is a lost library.
 *
 * The distinction that matters throughout: `folders.path` is an absolute Windows path and stays in
 * this process; `tracks.relative_path` is what identifies a file *within* a folder, and it is the
 * only half that ever appears in anything synced (docs/PRIVACY.md).
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EqPreset, Playlist, Track } from '@now-playing/contracts';
import type { LibraryFolder } from '../shared/ipc.js';

export type CompanionDb = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  watch INTEGER NOT NULL DEFAULT 1,
  track_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  last_scan_at TEXT,
  last_scan_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  track TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  content_hash TEXT,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(folder_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder_id);
CREATE INDEX IF NOT EXISTS idx_tracks_hash ON tracks(content_hash);
CREATE INDEX IF NOT EXISTS idx_tracks_updated ON tracks(updated_at);


CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS playlist_items (id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL, position INTEGER NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS eq_presets (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS eq_bindings (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL, occurred_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_cursors (collection TEXT PRIMARY KEY, cursor TEXT);
`;

/**
 * The full-text index over track titles, artists and albums.
 *
 * It stores its own copy of those three columns rather than using FTS5's `content=''` mode. A
 * contentless table cannot be updated — SQLite rejects `ON CONFLICT` on it outright — and keeping
 * a rescan correct with the `'delete'` command form means remembering a row's *previous* text to
 * remove it. Three short strings per track is a small price for a search index that can simply be
 * rewritten when a file's tags change.
 */
const SEARCH_INDEX_SQL = "CREATE VIRTUAL TABLE tracks_fts USING fts5(title, artist, album, tokenize='unicode61 remove_diacritics 2')";

/**
 * Create the search index, or rebuild it if an older layout is on disk.
 *
 * Virtual tables cannot be altered, so a changed definition means dropping and repopulating. The
 * index is derived data — every row can be recomputed from `tracks` — so rebuilding costs time and
 * loses nothing.
 */
function ensureSearchIndex(db: CompanionDb): void {
  const existing = db.prepare<[], { sql: string | null }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tracks_fts'").get();
  if (existing && existing.sql?.replace(/\s+/g, ' ').trim() === SEARCH_INDEX_SQL) return;
  db.exec('DROP TABLE IF EXISTS tracks_fts');
  db.exec(SEARCH_INDEX_SQL);
  db.exec("INSERT INTO tracks_fts (rowid, title, artist, album) SELECT rowid, COALESCE(json_extract(track, '$.title'), ''), COALESCE(json_extract(track, '$.artistName'), ''), COALESCE(json_extract(track, '$.albumName'), '') FROM tracks");
}

export function openCompanionDb(file: string): CompanionDb {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  ensureSearchIndex(db);
  return db;
}

interface FolderRow {
  id: string;
  path: string;
  display_name: string;
  watch: number;
  track_count: number;
  size_bytes: number;
  last_scan_at: string | null;
  last_scan_error: string | null;
}

export interface StoredTrack {
  id: string;
  folderId: string;
  relativePath: string;
  track: Track;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string | null;
  updatedAt: string;
  deletedAt: string | null;
}

export class CompanionStore {
  constructor(private readonly db: CompanionDb) {}

  /* --------------------------------------------------------------- folders */

  listFolders(available: (path: string) => boolean): LibraryFolder[] {
    return this.db
      .prepare<[], FolderRow>('SELECT * FROM folders ORDER BY display_name')
      .all()
      .map((row) => ({
        id: row.id,
        path: row.path,
        displayName: row.display_name,
        watch: row.watch === 1,
        trackCount: row.track_count,
        sizeBytes: row.size_bytes,
        lastScanAt: row.last_scan_at,
        lastScanError: row.last_scan_error,
        available: available(row.path),
      }));
  }

  findFolder(id: string): FolderRow | undefined {
    return this.db.prepare<[string], FolderRow>('SELECT * FROM folders WHERE id = ?').get(id);
  }

  findFolderByPath(path: string): FolderRow | undefined {
    return this.db.prepare<[string], FolderRow>('SELECT * FROM folders WHERE path = ?').get(path);
  }

  addFolder(folder: { id: string; path: string; displayName: string; now: string }): void {
    this.db.prepare('INSERT INTO folders (id, path, display_name, watch, track_count, size_bytes, last_scan_at, last_scan_error, created_at) VALUES (?, ?, ?, 1, 0, 0, NULL, NULL, ?)').run(folder.id, folder.path, folder.displayName, folder.now);
  }

  updateFolderStats(id: string, stats: { trackCount: number; sizeBytes: number; lastScanAt: string; error: string | null }): void {
    this.db.prepare('UPDATE folders SET track_count = ?, size_bytes = ?, last_scan_at = ?, last_scan_error = ? WHERE id = ?').run(stats.trackCount, stats.sizeBytes, stats.lastScanAt, stats.error, id);
  }

  removeFolder(id: string, now: string): void {
    // Tracks are tombstoned rather than deleted so the removal reaches a paired hub.
    this.db.transaction(() => {
      this.db.prepare('UPDATE tracks SET deleted_at = ?, updated_at = ? WHERE folder_id = ? AND deleted_at IS NULL').run(now, now, id);
      this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    })();
  }

  /* ---------------------------------------------------------------- tracks */

  upsertTrack(record: StoredTrack): void {
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO tracks (id, folder_id, relative_path, track, size_bytes, mtime_ms, content_hash, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(folder_id, relative_path) DO UPDATE SET track = excluded.track, size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms, content_hash = excluded.content_hash, updated_at = excluded.updated_at, deleted_at = NULL')
        .run(record.id, record.folderId, record.relativePath, JSON.stringify(record.track), record.sizeBytes, record.mtimeMs, record.contentHash, record.updatedAt, record.deletedAt);
      // Rewrite rather than update: an FTS5 row is replaced by deleting it and inserting again.
      const rowid = this.db.prepare<[string], { rowid: number }>('SELECT rowid FROM tracks WHERE id = ?').get(record.id)?.rowid;
      if (rowid !== undefined) {
        this.db.prepare('DELETE FROM tracks_fts WHERE rowid = ?').run(rowid);
        this.db.prepare('INSERT INTO tracks_fts (rowid, title, artist, album) VALUES (?, ?, ?, ?)').run(rowid, record.track.title, record.track.artistName, record.track.albumName ?? '');
      }
    })();
  }

  findTrackByPath(folderId: string, relativePath: string): StoredTrack | undefined {
    const row = this.db.prepare<[string, string], TrackRow>('SELECT * FROM tracks WHERE folder_id = ? AND relative_path = ?').get(folderId, relativePath);
    return row ? toStoredTrack(row) : undefined;
  }

  findTrack(id: string): StoredTrack | undefined {
    const row = this.db.prepare<[string], TrackRow>('SELECT * FROM tracks WHERE id = ?').get(id);
    return row ? toStoredTrack(row) : undefined;
  }

  pathsInFolder(folderId: string): Map<string, StoredTrack> {
    const rows = this.db.prepare<[string], TrackRow>('SELECT * FROM tracks WHERE folder_id = ? AND deleted_at IS NULL').all(folderId);
    return new Map(rows.map((row) => [row.relative_path, toStoredTrack(row)]));
  }

  tombstone(id: string, now: string): void {
    this.db.prepare('UPDATE tracks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  }

  searchTracks(options: { query?: string | undefined; limit: number; offset: number }): { items: Track[]; total: number } {
    if (options.query?.trim()) {
      // FTS5 needs its own escaping: a bare quote or hyphen in a search term is a syntax error, not
      // a match, so the query is turned into quoted prefix terms.
      const terms = options.query
        .trim()
        .split(/\s+/)
        .map((term) => `"${term.replace(/"/g, '""')}"*`)
        .join(' ');
      const rows = this.db.prepare<[string, number, number], TrackRow>('SELECT t.* FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid WHERE tracks_fts MATCH ? AND t.deleted_at IS NULL ORDER BY rank LIMIT ? OFFSET ?').all(terms, options.limit, options.offset);
      const total = this.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid WHERE tracks_fts MATCH ? AND t.deleted_at IS NULL').get(terms)?.n ?? rows.length;
      return { items: rows.map((row) => toStoredTrack(row).track), total };
    }
    const rows = this.db.prepare<[number, number], TrackRow>('SELECT * FROM tracks WHERE deleted_at IS NULL ORDER BY json_extract(track, \'$.artistName\'), json_extract(track, \'$.albumName\'), json_extract(track, \'$.trackNumber\') LIMIT ? OFFSET ?').all(options.limit, options.offset);
    const total = this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM tracks WHERE deleted_at IS NULL').get()?.n ?? 0;
    return { items: rows.map((row) => toStoredTrack(row).track), total };
  }

  countTracks(folderId?: string): number {
    if (folderId) return this.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM tracks WHERE folder_id = ? AND deleted_at IS NULL').get(folderId)?.n ?? 0;
    return this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM tracks WHERE deleted_at IS NULL').get()?.n ?? 0;
  }

  /* ------------------------------------------------------- synced entities */

  listPlaylists(): Playlist[] {
    return this.db.prepare<[], { body: string }>('SELECT body FROM playlists WHERE deleted_at IS NULL ORDER BY updated_at DESC').all().map((r) => JSON.parse(r.body) as Playlist);
  }

  listPresets(): EqPreset[] {
    return this.db.prepare<[], { body: string }>('SELECT body FROM eq_presets WHERE deleted_at IS NULL').all().map((r) => JSON.parse(r.body) as EqPreset);
  }

  putSynced(table: 'playlists' | 'playlist_items' | 'eq_presets' | 'eq_bindings', id: string, body: unknown, updatedAt: string, deletedAt: string | null): void {
    if (table === 'playlist_items') {
      const item = body as { playlistId: string; position: number };
      this.db.prepare('INSERT INTO playlist_items (id, playlist_id, position, body, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET playlist_id = excluded.playlist_id, position = excluded.position, body = excluded.body, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at').run(id, item.playlistId, item.position, JSON.stringify(body), updatedAt, deletedAt);
      return;
    }
    this.db.prepare(`INSERT INTO ${table} (id, body, updated_at, deleted_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`).run(id, JSON.stringify(body), updatedAt, deletedAt);
  }

  /* -------------------------------------------------------------- settings */

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown, now: string): void {
    this.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(value), now);
  }

  counts(): { tracks: number; playlists: number; presets: number; events: number } {
    const one = (sql: string): number => (this.db.prepare<[], { n: number }>(sql).get()?.n ?? 0);
    return {
      tracks: one('SELECT COUNT(*) AS n FROM tracks WHERE deleted_at IS NULL'),
      playlists: one('SELECT COUNT(*) AS n FROM playlists WHERE deleted_at IS NULL'),
      presets: one('SELECT COUNT(*) AS n FROM eq_presets WHERE deleted_at IS NULL'),
      events: one('SELECT COUNT(*) AS n FROM events'),
    };
  }

  close(): void {
    this.db.close();
  }

  get raw(): CompanionDb {
    return this.db;
  }
}

interface TrackRow {
  id: string;
  folder_id: string;
  relative_path: string;
  track: string;
  size_bytes: number;
  mtime_ms: number;
  content_hash: string | null;
  updated_at: string;
  deleted_at: string | null;
}

function toStoredTrack(row: TrackRow): StoredTrack {
  return {
    id: row.id,
    folderId: row.folder_id,
    relativePath: row.relative_path,
    track: JSON.parse(row.track) as Track,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

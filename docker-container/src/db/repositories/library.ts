import type { Artwork, LibraryRoot, Track } from '@now-playing/contracts';
import type { Db } from '../connection.js';

interface RootRow {
  id: string;
  device_id: string;
  kind: LibraryRoot['kind'];
  display_name: string;
  relative_path: string;
  status: LibraryRoot['status'];
  last_scan_at: string | null;
  last_scan_error: string | null;
  track_count: number;
  watch: number;
  scan_checkpoint: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface HubTrackRow {
  id: string;
  root_id: string;
  relative_path: string;
  track: string;
  content_hash: string | null;
  size_bytes: number;
  mtime_ms: number;
  mime: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface HubTrackRecord {
  id: string;
  rootId: string;
  relativePath: string;
  track: Track;
  contentHash: string | null;
  sizeBytes: number;
  mtimeMs: number;
  mime: string | null;
  deletedAt: string | null;
}

export interface BlobRow {
  sha256: string;
  size_bytes: number;
  relative_path: string;
  mime: string | null;
  track_id: string | null;
  owner_id: string | null;
  created_at: string;
}

export function toRoot(r: RootRow): LibraryRoot {
  return {
    id: r.id,
    schemaVersion: 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    deviceId: r.device_id,
    kind: r.kind,
    displayName: r.display_name,
    handleId: r.relative_path,
    status: r.status,
    lastScanAt: r.last_scan_at,
    lastScanError: r.last_scan_error,
    trackCount: r.track_count,
    watch: r.watch === 1,
    scanCheckpoint: r.scan_checkpoint,
  };
}

export function toHubTrack(r: HubTrackRow): HubTrackRecord {
  return { id: r.id, rootId: r.root_id, relativePath: r.relative_path, track: JSON.parse(r.track) as Track, contentHash: r.content_hash, sizeBytes: r.size_bytes, mtimeMs: r.mtime_ms, mime: r.mime, deletedAt: r.deleted_at };
}

export class LibraryRepository {
  constructor(private readonly db: Db) {}

  /* ---- roots ---- */
  createRoot(root: LibraryRoot): void {
    this.db
      .prepare('INSERT INTO library_roots (id, device_id, kind, display_name, relative_path, status, last_scan_at, last_scan_error, track_count, watch, scan_checkpoint, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(root.id, root.deviceId, root.kind, root.displayName, root.handleId, root.status, root.lastScanAt, root.lastScanError, root.trackCount, root.watch ? 1 : 0, root.scanCheckpoint, root.createdAt, root.updatedAt, root.deletedAt);
  }

  findRoot(id: string): LibraryRoot | undefined {
    const r = this.db.prepare<[string], RootRow>('SELECT * FROM library_roots WHERE id = ?').get(id);
    return r ? toRoot(r) : undefined;
  }

  findRootByPath(relativePath: string): LibraryRoot | undefined {
    const r = this.db.prepare<[string], RootRow>('SELECT * FROM library_roots WHERE relative_path = ?').get(relativePath);
    return r ? toRoot(r) : undefined;
  }

  listRoots(): LibraryRoot[] {
    return this.db.prepare<[], RootRow>('SELECT * FROM library_roots WHERE deleted_at IS NULL ORDER BY created_at').all().map(toRoot);
  }

  updateRoot(id: string, patch: Partial<Pick<LibraryRoot, 'status' | 'lastScanAt' | 'lastScanError' | 'trackCount' | 'scanCheckpoint' | 'displayName'>>, now: string): void {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    const map: Record<string, string> = { status: 'status', lastScanAt: 'last_scan_at', lastScanError: 'last_scan_error', trackCount: 'track_count', scanCheckpoint: 'scan_checkpoint', displayName: 'display_name' };
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        params.push(v);
      }
    }
    params.push(id);
    this.db.prepare(`UPDATE library_roots SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  removeRoot(id: string, now: string): boolean {
    return this.db.transaction(() => {
      const n = this.db.prepare('DELETE FROM library_roots WHERE id = ?').run(id).changes;
      void now;
      return n > 0;
    })();
  }

  /* ---- tracks ---- */
  upsertTrack(rec: HubTrackRecord, now: string): void {
    this.db
      .prepare(
        'INSERT INTO hub_tracks (id, root_id, relative_path, track, content_hash, size_bytes, mtime_ms, mime, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(root_id, relative_path) DO UPDATE SET track = excluded.track, content_hash = excluded.content_hash, size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms, mime = excluded.mime, updated_at = excluded.updated_at, deleted_at = NULL',
      )
      .run(rec.id, rec.rootId, rec.relativePath, JSON.stringify(rec.track), rec.contentHash, rec.sizeBytes, rec.mtimeMs, rec.mime, now, now);
  }

  findTrack(id: string): HubTrackRecord | undefined {
    const r = this.db.prepare<[string], HubTrackRow>('SELECT * FROM hub_tracks WHERE id = ?').get(id);
    return r ? toHubTrack(r) : undefined;
  }

  findTrackByPath(rootId: string, relativePath: string): HubTrackRecord | undefined {
    const r = this.db.prepare<[string, string], HubTrackRow>('SELECT * FROM hub_tracks WHERE root_id = ? AND relative_path = ?').get(rootId, relativePath);
    return r ? toHubTrack(r) : undefined;
  }

  findTracksByHash(contentHash: string): HubTrackRecord[] {
    return this.db.prepare<[string], HubTrackRow>('SELECT * FROM hub_tracks WHERE content_hash = ? AND deleted_at IS NULL').all(contentHash).map(toHubTrack);
  }

  listTracks(options: { rootId?: string; includeDeleted?: boolean }): HubTrackRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.rootId) {
      clauses.push('root_id = ?');
      params.push(options.rootId);
    }
    if (!options.includeDeleted) clauses.push('deleted_at IS NULL');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare<unknown[], HubTrackRow>(`SELECT * FROM hub_tracks ${where} ORDER BY relative_path`).all(...params).map(toHubTrack);
  }

  countTracks(rootId?: string): number {
    if (rootId) return this.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM hub_tracks WHERE root_id = ? AND deleted_at IS NULL').get(rootId)?.n ?? 0;
    return this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM hub_tracks WHERE deleted_at IS NULL').get()?.n ?? 0;
  }

  tombstoneMissing(rootId: string, presentPaths: ReadonlySet<string>, now: string): number {
    const rows = this.db.prepare<[string], { id: string; relative_path: string }>('SELECT id, relative_path FROM hub_tracks WHERE root_id = ? AND deleted_at IS NULL').all(rootId);
    let n = 0;
    const stmt = this.db.prepare('UPDATE hub_tracks SET deleted_at = ?, updated_at = ? WHERE id = ?');
    for (const r of rows) {
      if (!presentPaths.has(r.relative_path)) {
        stmt.run(now, now, r.id);
        n += 1;
      }
    }
    return n;
  }

  purgeTombstones(before: string): number {
    return this.db.prepare('DELETE FROM hub_tracks WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(before).changes;
  }

  /* ---- artwork ---- */
  putArtwork(a: Artwork & { relativePath: string }, now: string): void {
    this.db.prepare('INSERT OR IGNORE INTO artwork (id, mime, width, height, size_bytes, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(a.id, a.mime, a.width, a.height, a.sizeBytes, a.relativePath, now);
  }

  findArtwork(id: string): (Artwork & { relativePath: string }) | undefined {
    const r = this.db.prepare<[string], { id: string; mime: Artwork['mime']; width: number; height: number; size_bytes: number; relative_path: string }>('SELECT * FROM artwork WHERE id = ?').get(id);
    return r ? { id: r.id, mime: r.mime, width: r.width, height: r.height, sizeBytes: r.size_bytes, relativePath: r.relative_path } : undefined;
  }

  /* ---- blobs ---- */
  putBlob(b: BlobRow): void {
    this.db.prepare('INSERT INTO blobs (sha256, size_bytes, relative_path, mime, track_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO UPDATE SET track_id = COALESCE(excluded.track_id, blobs.track_id), mime = COALESCE(excluded.mime, blobs.mime)').run(b.sha256, b.size_bytes, b.relative_path, b.mime, b.track_id, b.owner_id, b.created_at);
  }

  findBlob(sha256: string): BlobRow | undefined {
    return this.db.prepare<[string], BlobRow>('SELECT * FROM blobs WHERE sha256 = ?').get(sha256);
  }

  findBlobByTrack(trackId: string): BlobRow | undefined {
    return this.db.prepare<[string], BlobRow>('SELECT * FROM blobs WHERE track_id = ? ORDER BY created_at DESC LIMIT 1').get(trackId);
  }

  listBlobs(): BlobRow[] {
    return this.db.prepare<[], BlobRow>('SELECT * FROM blobs ORDER BY created_at').all();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

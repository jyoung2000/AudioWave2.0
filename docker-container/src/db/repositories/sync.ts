import type { SyncCollection } from '@now-playing/contracts';
import type { SyncRecord } from '@now-playing/domain';
import type { Db } from '../connection.js';

interface RecordRow {
  collection: SyncCollection;
  id: string;
  updated_at: string;
  deleted_at: string | null;
  body: string | null;
  last_change_id: string;
  origin_device_id: string;
}

export interface StoredSyncRecord extends SyncRecord {
  lastChangeId: string;
  originDeviceId: string;
}

export interface SyncStateRow {
  device_id: string;
  paused: number;
  enabled_collections: string;
  last_success_at: string | null;
  last_error: string | null;
  conflicts: number;
  updated_at: string;
}

function toRecord(r: RecordRow): StoredSyncRecord {
  const body = r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
  return { ...body, id: r.id, updatedAt: r.updated_at, deletedAt: r.deleted_at, lastChangeId: r.last_change_id, originDeviceId: r.origin_device_id };
}

export class SyncRepository {
  constructor(private readonly db: Db) {}

  get(collection: SyncCollection, id: string): StoredSyncRecord | undefined {
    const r = this.db.prepare<[string, string], RecordRow>('SELECT * FROM synced_records WHERE collection = ? AND id = ?').get(collection, id);
    return r ? toRecord(r) : undefined;
  }

  all(collection: SyncCollection): StoredSyncRecord[] {
    return this.db.prepare<[string], RecordRow>('SELECT * FROM synced_records WHERE collection = ? ORDER BY updated_at, id').all(collection).map(toRecord);
  }

  count(collection: SyncCollection): number {
    return this.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM synced_records WHERE collection = ?').get(collection)?.n ?? 0;
  }

  put(collection: SyncCollection, record: SyncRecord, changeId: string, originDeviceId: string): void {
    const { id, updatedAt, deletedAt, lastChangeId: _l, originDeviceId: _o, ...body } = record as StoredSyncRecord;
    this.db
      .prepare('INSERT INTO synced_records (collection, id, updated_at, deleted_at, body, last_change_id, origin_device_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, body = excluded.body, last_change_id = excluded.last_change_id, origin_device_id = excluded.origin_device_id')
      .run(collection, id, updatedAt, deletedAt, deletedAt ? null : JSON.stringify(body), changeId, originDeviceId);
  }

  remove(collection: SyncCollection, ids: readonly string[]): number {
    const stmt = this.db.prepare('DELETE FROM synced_records WHERE collection = ? AND id = ?');
    let n = 0;
    for (const id of ids) n += stmt.run(collection, id).changes;
    return n;
  }

  appliedChangeIds(changeIds: readonly string[]): Set<string> {
    const out = new Set<string>();
    const stmt = this.db.prepare<[string], { change_id: string }>('SELECT change_id FROM applied_changes WHERE change_id = ?');
    for (const id of changeIds) if (stmt.get(id)) out.add(id);
    return out;
  }

  markApplied(changeId: string, collection: SyncCollection, recordId: string, deviceId: string, now: string): void {
    this.db.prepare('INSERT OR IGNORE INTO applied_changes (change_id, collection, record_id, device_id, applied_at) VALUES (?, ?, ?, ?, ?)').run(changeId, collection, recordId, deviceId, now);
  }

  purgeApplied(before: string): number {
    return this.db.prepare('DELETE FROM applied_changes WHERE applied_at < ?').run(before).changes;
  }

  cursor(deviceId: string, collection: SyncCollection): string | null {
    return this.db.prepare<[string, string], { cursor: string | null }>('SELECT cursor FROM sync_cursors WHERE device_id = ? AND collection = ?').get(deviceId, collection)?.cursor ?? null;
  }

  setCursor(deviceId: string, collection: SyncCollection, cursor: string | null): void {
    this.db.prepare('INSERT INTO sync_cursors (device_id, collection, cursor) VALUES (?, ?, ?) ON CONFLICT(device_id, collection) DO UPDATE SET cursor = excluded.cursor').run(deviceId, collection, cursor);
  }

  allCursors(collection: SyncCollection): Array<string | null> {
    return this.db.prepare<[string], { cursor: string | null }>('SELECT cursor FROM sync_cursors WHERE collection = ?').all(collection).map((r) => r.cursor);
  }

  state(deviceId: string): SyncStateRow | undefined {
    return this.db.prepare<[string], SyncStateRow>('SELECT * FROM sync_state WHERE device_id = ?').get(deviceId);
  }

  putState(row: SyncStateRow): void {
    this.db
      .prepare('INSERT INTO sync_state (device_id, paused, enabled_collections, last_success_at, last_error, conflicts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET paused = excluded.paused, enabled_collections = excluded.enabled_collections, last_success_at = excluded.last_success_at, last_error = excluded.last_error, conflicts = excluded.conflicts, updated_at = excluded.updated_at')
      .run(row.device_id, row.paused, row.enabled_collections, row.last_success_at, row.last_error, row.conflicts, row.updated_at);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

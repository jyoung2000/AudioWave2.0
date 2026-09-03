import type { SyncChange, SyncCollection, SyncCollectionSummary, SyncConflict } from '@now-playing/contracts';
import { sha256Hex } from './ids.js';

export interface SyncRecord {
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  [key: string]: unknown;
}

/** Deterministic digest over (id, updatedAt, deleted) sorted by id. */
export async function collectionDigest(records: readonly Pick<SyncRecord, 'id' | 'updatedAt' | 'deletedAt'>[]): Promise<string> {
  const text = records
    .map((r) => `${r.id}|${r.updatedAt}|${r.deletedAt ? 1 : 0}`)
    .sort()
    .join('\n');
  return sha256Hex(text);
}

export async function summarize(collection: SyncCollection, records: readonly SyncRecord[]): Promise<SyncCollectionSummary> {
  let max: string | null = null;
  for (const r of records) if (!max || r.updatedAt > max) max = r.updatedAt;
  return { collection, count: records.length, maxUpdatedAt: max, digest: await collectionDigest(records) };
}

/** Which collections differ between two manifests (by digest). */
export function collectionsNeedingSync(local: readonly SyncCollectionSummary[], remote: readonly SyncCollectionSummary[]): SyncCollection[] {
  const remoteBy = new Map(remote.map((r) => [r.collection, r]));
  const out: SyncCollection[] = [];
  for (const l of local) {
    const r = remoteBy.get(l.collection);
    if (!r || r.digest !== l.digest) out.push(l.collection);
  }
  for (const r of remote) if (!local.some((l) => l.collection === r.collection)) out.push(r.collection);
  return [...new Set(out)];
}

export type MergeDecision = { action: 'apply'; record: SyncRecord } | { action: 'skip'; reason: string } | { action: 'conflict'; record: SyncRecord; conflict: SyncConflict };

/**
 * Merge rule (documented in PAIRING_AND_SYNC.md):
 * 1. A tombstone wins over any older or equal update (tombstone-wins).
 * 2. Otherwise the newer updatedAt wins (last-writer-wins); ties break on the lexically larger changeId so both sides converge.
 * 3. A change whose changeId was already applied is a duplicate and skipped.
 */
export function mergeChange(local: SyncRecord | undefined, change: SyncChange, appliedChangeIds: ReadonlySet<string>): MergeDecision {
  if (appliedChangeIds.has(change.changeId)) return { action: 'skip', reason: 'duplicate changeId' };
  const incoming: SyncRecord = change.deleted
    ? { ...(local ?? {}), id: change.id, updatedAt: change.updatedAt, deletedAt: change.updatedAt }
    : { ...(change.body ?? {}), id: change.id, updatedAt: change.updatedAt, deletedAt: null };
  if (!local) return { action: 'apply', record: incoming };
  if (local.deletedAt && !change.deleted) {
    if (change.updatedAt > local.deletedAt) return { action: 'conflict', record: incoming, conflict: { collection: change.collection, id: change.id, resolution: 'kept-remote', reason: 'update newer than tombstone; resurrected' } };
    return { action: 'conflict', record: local, conflict: { collection: change.collection, id: change.id, resolution: 'tombstone-wins', reason: 'local tombstone is newer' } };
  }
  if (change.deleted && local.updatedAt > change.updatedAt) {
    return { action: 'conflict', record: local, conflict: { collection: change.collection, id: change.id, resolution: 'kept-local', reason: 'local update newer than remote tombstone' } };
  }
  if (change.updatedAt > local.updatedAt) return { action: 'apply', record: incoming };
  if (change.updatedAt < local.updatedAt) return { action: 'conflict', record: local, conflict: { collection: change.collection, id: change.id, resolution: 'kept-local', reason: 'local is newer' } };
  // exact tie: deterministic winner
  const localKey = String(local['lastChangeId'] ?? '');
  if (change.changeId > localKey) return { action: 'apply', record: incoming };
  return { action: 'conflict', record: local, conflict: { collection: change.collection, id: change.id, resolution: 'kept-local', reason: 'tie broken by changeId' } };
}

/** Tombstones older than `retentionDays` may be compacted once every known peer has acknowledged a cursor past them. */
export function tombstonesToCompact(records: readonly SyncRecord[], peerCursors: readonly (string | null)[], retentionDays: number, now: number): string[] {
  const cutoff = new Date(now - retentionDays * 86400000).toISOString();
  const minCursor = peerCursors.length ? peerCursors.reduce<string | null>((min, c) => (c === null ? null : min === null ? null : c < min ? c : min), peerCursors[0] ?? null) : null;
  return records.filter((r) => r.deletedAt && r.deletedAt < cutoff && (minCursor === null ? peerCursors.length === 0 : r.deletedAt < minCursor)).map((r) => r.id);
}

/** Changes since a cursor, oldest first, bounded. */
export function changesSince(collection: SyncCollection, records: readonly SyncRecord[], since: string | null, limit: number, changeIdFor: (r: SyncRecord) => string): { changes: SyncChange[]; more: boolean } {
  const sorted = records.filter((r) => since === null || r.updatedAt > since).sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id < b.id ? -1 : 1));
  const page = sorted.slice(0, limit);
  const changes = page.map((r) => {
    const { id, updatedAt, deletedAt, ...body } = r;
    return { collection, id, updatedAt: deletedAt ?? updatedAt, deleted: Boolean(deletedAt), body: deletedAt ? null : body, changeId: changeIdFor(r) };
  });
  return { changes, more: sorted.length > limit };
}

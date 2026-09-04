/**
 * Companion sync: a two-phase exchange between the hub and a paired device.
 *
 * Phase 1 (`manifest`) compares per-collection digests so a device that is already in step sends
 * nothing. Phase 2 (`delta`) pushes local changes and pulls remote ones in the same round trip.
 *
 * Everything here is idempotent. A change carries a `changeId`; replaying it is a no-op, which is
 * what makes a dropped connection safe to retry. Merge rules live in the domain package
 * (`mergeChange`) so the hub, the player and the companion resolve conflicts identically —
 * tombstone-wins, then last-writer-wins, ties broken deterministically by changeId.
 *
 * What the hub stores is deliberately narrow: library *metadata*, playlists, EQ presets and
 * bindings, listening events and availability. Filesystem paths never enter a synced record
 * (docs/PRIVACY.md); audio bytes move separately through the file store, only on request.
 */
import type { SyncChange, SyncCollection, SyncManifest, SyncStatus, SyncDeltaRequest, SyncDeltaResponse } from '@now-playing/contracts';
import { SCHEMA_VERSIONS, WS_PROTOCOL_VERSION } from '@now-playing/contracts';
import { changesSince, collectionsNeedingSync, DomainError, mergeChange, summarize, uuidv7, type SyncRecord } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { RequestMeta } from '../auth/service.js';
import type { SyncRepository, StoredSyncRecord } from '../db/repositories/sync.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';

/** Collections a device may sync unless it narrows the list itself. */
export const DEFAULT_COLLECTIONS: readonly SyncCollection[] = ['tracks', 'artists', 'albums', 'playlists', 'playlistItems', 'eqPresets', 'eqBindings', 'listeningEvents', 'availability'] as const;

const ALL_COLLECTIONS: readonly SyncCollection[] = ['tracks', 'artists', 'albums', 'playlists', 'playlistItems', 'eqPresets', 'eqBindings', 'listeningEvents', 'aggregateProfiles', 'transferJobs', 'availability'] as const;

/** Per-response cap. A device that has more keeps calling until `more` is false. */
const PAGE_LIMIT = 500;
/** Tombstones live at least this long so a device that was offline still learns about the delete. */
const TOMBSTONE_RETENTION_DAYS = 30;
/** applied_changes rows only exist to reject replays; a month is far beyond any retry window. */
const APPLIED_RETENTION_DAYS = 30;

/** Keys a device must never be able to write into a synced record. */
const FORBIDDEN_BODY_KEYS = new Set(['absolutePath', 'path', 'filePath', 'fsPath', 'localPath', 'directory', 'accessToken', 'refreshToken', 'password', 'passwordHash', 'token', 'secret']);

export interface SyncProgress {
  pendingLocal: number;
  pendingRemote: number;
}

export class SyncService {
  constructor(
    private readonly repo: SyncRepository,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
  ) {}

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private stateOf(deviceId: string): { paused: boolean; enabled: SyncCollection[]; lastSuccessAt: string | null; lastError: string | null; conflicts: number } {
    const row = this.repo.state(deviceId);
    if (!row) return { paused: false, enabled: [...DEFAULT_COLLECTIONS], lastSuccessAt: null, lastError: null, conflicts: 0 };
    const parsed = ((): SyncCollection[] => {
      try {
        const list = JSON.parse(row.enabled_collections) as unknown;
        if (!Array.isArray(list) || !list.length) return [...DEFAULT_COLLECTIONS];
        return list.filter((c): c is SyncCollection => typeof c === 'string' && (ALL_COLLECTIONS as readonly string[]).includes(c));
      } catch {
        return [...DEFAULT_COLLECTIONS];
      }
    })();
    return { paused: row.paused === 1, enabled: parsed, lastSuccessAt: row.last_success_at, lastError: row.last_error, conflicts: row.conflicts };
  }

  private saveState(deviceId: string, patch: Partial<{ paused: boolean; enabled: SyncCollection[]; lastSuccessAt: string | null; lastError: string | null; conflicts: number }>): void {
    const current = this.stateOf(deviceId);
    const next = { ...current, ...patch };
    this.repo.putState({
      device_id: deviceId,
      paused: next.paused ? 1 : 0,
      enabled_collections: JSON.stringify(next.enabled),
      last_success_at: next.lastSuccessAt,
      last_error: next.lastError,
      conflicts: next.conflicts,
      updated_at: this.nowIso(),
    });
  }

  /** The hub's view of every collection the device has enabled. */
  async manifest(deviceId: string, enabled?: readonly SyncCollection[]): Promise<SyncManifest> {
    const collections = (enabled?.length ? enabled : this.stateOf(deviceId).enabled).filter((c) => (ALL_COLLECTIONS as readonly string[]).includes(c));
    const summaries = await Promise.all(collections.map((c) => summarize(c, this.repo.all(c))));
    return {
      schemaVersion: SCHEMA_VERSIONS.syncManifest,
      deviceId,
      generatedAt: this.nowIso(),
      protocolVersion: WS_PROTOCOL_VERSION,
      collections: summaries,
    };
  }

  /** Manifest exchange: returns the hub's manifest and the collections whose digests differ. */
  async exchangeManifest(deviceId: string, incoming: SyncManifest): Promise<{ serverManifest: SyncManifest; needed: SyncCollection[] }> {
    if (incoming.protocolVersion !== WS_PROTOCOL_VERSION) {
      throw new DomainError('upgrade-required', `This hub speaks sync protocol ${WS_PROTOCOL_VERSION}; the device sent ${incoming.protocolVersion}. Update the older side.`);
    }
    const enabled = incoming.collections.map((c) => c.collection);
    this.saveState(deviceId, { enabled: enabled.length ? enabled : [...DEFAULT_COLLECTIONS] });
    const serverManifest = await this.manifest(deviceId, enabled);
    const needed = collectionsNeedingSync(incoming.collections, serverManifest.collections);
    this.metrics.increment('sync.manifest_exchanges');
    this.metrics.gauge('sync.collections_needing_sync', needed.length);
    return { serverManifest, needed };
  }

  /**
   * Delta exchange. Pushed changes are applied inside one transaction so a partial failure cannot
   * leave the hub half-updated; the pull is then computed from the committed state.
   */
  delta(deviceId: string, request: SyncDeltaRequest): SyncDeltaResponse {
    const state = this.stateOf(deviceId);
    if (state.paused) throw new DomainError('conflict', 'Sync is paused for this device; resume it before exchanging changes');
    if (request.deviceId !== deviceId) throw new DomainError('forbidden', 'The delta names a different device than the credential presented');

    const enabled = (request.enabledCollections.length ? request.enabledCollections : state.enabled).filter((c) => (ALL_COLLECTIONS as readonly string[]).includes(c));
    const enabledSet = new Set<SyncCollection>(enabled);
    if (enabled.length !== state.enabled.length || enabled.some((c) => !state.enabled.includes(c))) this.saveState(deviceId, { enabled });

    const conflicts: SyncDeltaResponse['conflicts'] = [];
    let applied = 0;
    let duplicates = 0;
    let rejected = 0;

    const incoming = request.changes.filter((c) => enabledSet.has(c.collection));
    const knownChangeIds = this.repo.appliedChangeIds(incoming.map((c) => c.changeId));

    this.repo.transaction(() => {
      for (const change of incoming) {
        if (!sanitizeBody(change)) {
          rejected += 1;
          continue;
        }
        const local = this.repo.get(change.collection, change.id);
        const decision = mergeChange(local, change, knownChangeIds);
        if (decision.action === 'skip') {
          duplicates += 1;
          continue;
        }
        if (decision.action === 'conflict') {
          conflicts.push(decision.conflict);
          // A conflict still records a decision: whichever record won is what the hub keeps.
          this.repo.put(change.collection, decision.record as SyncRecord, change.changeId, deviceId);
        } else {
          this.repo.put(change.collection, decision.record, change.changeId, deviceId);
          applied += 1;
        }
        this.repo.markApplied(change.changeId, change.collection, change.id, deviceId, this.nowIso());
      }
    });

    // Pull: everything the hub holds that is newer than the device's cursor, oldest first.
    const changes: SyncChange[] = [];
    const cursors: Record<string, string | null> = {};
    let more = false;
    let budget = PAGE_LIMIT;
    for (const collection of enabled) {
      const since = request.since[collection] ?? this.repo.cursor(deviceId, collection);
      const records = this.repo.all(collection);
      if (budget <= 0) {
        cursors[collection] = since ?? null;
        if (records.some((r) => since === null || r.updatedAt > since)) more = true;
        continue;
      }
      const page = changesSince(collection, records, since ?? null, budget, (r) => (r as StoredSyncRecord).lastChangeId ?? uuidv7(this.clock.now()));
      // A device never needs its own changes echoed back to it.
      const outgoing = page.changes.filter((c) => {
        const rec = this.repo.get(collection, c.id);
        return !rec || rec.originDeviceId !== deviceId;
      });
      changes.push(...outgoing);
      budget -= page.changes.length;
      more = more || page.more;
      const last = page.changes[page.changes.length - 1];
      cursors[collection] = last ? last.updatedAt : (since ?? null);
      this.repo.setCursor(deviceId, collection, cursors[collection] ?? null);
    }

    this.saveState(deviceId, { lastSuccessAt: this.nowIso(), lastError: null, conflicts: state.conflicts + conflicts.length });
    this.metrics.increment('sync.deltas');
    this.metrics.increment('sync.records_applied', applied);
    if (conflicts.length) this.metrics.increment('sync.conflicts', conflicts.length);
    if (rejected) this.metrics.increment('sync.rejected_fields', rejected);

    return { applied, duplicates, conflicts, changes, cursors: cursors as SyncDeltaResponse['cursors'], more };
  }

  status(deviceId: string): SyncStatus {
    const state = this.stateOf(deviceId);
    let pendingRemote = 0;
    for (const collection of state.enabled) {
      const since = this.repo.cursor(deviceId, collection);
      pendingRemote += this.repo.all(collection).filter((r) => since === null || r.updatedAt > since).length;
    }
    return {
      deviceId,
      paused: state.paused,
      enabledCollections: state.enabled,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      // The hub cannot see a device's unsent local edits; only the device knows that number.
      pendingLocal: 0,
      pendingRemote,
      progress: pendingRemote === 0 ? 100 : null,
      conflicts: state.conflicts,
    };
  }

  pause(deviceId: string, paused: boolean, meta: RequestMeta, actorDisplayName: string): SyncStatus {
    this.saveState(deviceId, { paused });
    this.audit.record({
      actor: { kind: 'device', id: deviceId, displayName: actorDisplayName },
      action: paused ? 'sync.pause' : 'sync.resume',
      outcome: 'success',
      target: { kind: 'device', id: deviceId },
      ip: meta.ip,
      correlationId: meta.correlationId,
    });
    return this.status(deviceId);
  }

  recordFailure(deviceId: string, error: string): void {
    this.saveState(deviceId, { lastError: error.slice(0, 300) });
    this.metrics.increment('sync.failures');
  }

  /** Records the hub itself originates (a hub library scan, an imported playlist). */
  publish(collection: SyncCollection, record: SyncRecord, originDeviceId = 'hub'): void {
    const changeId = uuidv7(this.clock.now());
    this.repo.put(collection, record, changeId, originDeviceId);
  }

  publishMany(collection: SyncCollection, records: readonly SyncRecord[], originDeviceId = 'hub'): number {
    return this.repo.transaction(() => {
      for (const record of records) this.publish(collection, record, originDeviceId);
      return records.length;
    });
  }

  tombstone(collection: SyncCollection, id: string, originDeviceId = 'hub'): void {
    const now = this.nowIso();
    this.publish(collection, { id, updatedAt: now, deletedAt: now }, originDeviceId);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const collection of ALL_COLLECTIONS) out[collection] = this.repo.count(collection);
    return out;
  }

  /**
   * Drop tombstones every known peer has already seen, and forget replay records that no retry
   * could still reference.
   */
  maintenance(): { tombstonesRemoved: number; appliedPurged: number } {
    const now = this.clock.now();
    let tombstonesRemoved = 0;
    for (const collection of ALL_COLLECTIONS) {
      const peerCursors = this.repo.allCursors(collection);
      const records = this.repo.all(collection);
      const ids = tombstonesToCompactSafe(records, peerCursors, TOMBSTONE_RETENTION_DAYS, now);
      if (ids.length) tombstonesRemoved += this.repo.remove(collection, ids);
    }
    const appliedPurged = this.repo.purgeApplied(new Date(now - APPLIED_RETENTION_DAYS * 86_400_000).toISOString());
    if (tombstonesRemoved) this.metrics.increment('sync.tombstones_compacted', tombstonesRemoved);
    return { tombstonesRemoved, appliedPurged };
  }
}

/**
 * Reject a change whose body carries a field the hub must never hold — a filesystem path or
 * anything token-shaped. Returning false drops the change rather than silently storing it.
 */
function sanitizeBody(change: SyncChange): boolean {
  if (!change.body) return true;
  for (const key of Object.keys(change.body)) if (FORBIDDEN_BODY_KEYS.has(key)) return false;
  return true;
}

/**
 * `tombstonesToCompact` in the domain package treats "no peers" as "safe to compact". The hub is
 * the durable copy, so it additionally refuses to compact while any peer has no cursor at all for
 * the collection — that peer has never synced and would otherwise never learn about the delete.
 */
function tombstonesToCompactSafe(records: readonly StoredSyncRecord[], peerCursors: readonly (string | null)[], retentionDays: number, now: number): string[] {
  if (peerCursors.some((c) => c === null)) return [];
  const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
  const minCursor = peerCursors.length ? peerCursors.reduce<string>((min, c) => (c !== null && c < min ? c : min), peerCursors[0] ?? cutoff) : cutoff;
  return records.filter((r) => r.deletedAt && r.deletedAt < cutoff && r.deletedAt < minCursor).map((r) => r.id);
}

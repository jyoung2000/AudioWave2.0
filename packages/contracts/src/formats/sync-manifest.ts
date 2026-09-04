import { z } from 'zod';
import { IsoDateTime, SCHEMA_VERSIONS, Sha256Hex, Uuid } from '../common.js';

export const SyncCollection = z.enum([
  'tracks',
  'artists',
  'albums',
  'playlists',
  'playlistItems',
  'eqPresets',
  'eqBindings',
  'listeningEvents',
  'aggregateProfiles',
  'transferJobs',
  'availability',
]);
export type SyncCollection = z.infer<typeof SyncCollection>;

/** Compact summary of one collection on one device. */
export const SyncCollectionSummary = z.object({
  collection: SyncCollection,
  count: z.number().int().nonnegative(),
  maxUpdatedAt: IsoDateTime.nullable(),
  /** Digest of (id, updatedAt, deleted) tuples for quick equality checks. */
  digest: Sha256Hex,
});

export type SyncCollectionSummary = z.infer<typeof SyncCollectionSummary>;

export const SyncManifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.syncManifest),
  deviceId: Uuid,
  generatedAt: IsoDateTime,
  protocolVersion: z.number().int().positive(),
  collections: z.array(SyncCollectionSummary),
});
export type SyncManifest = z.infer<typeof SyncManifest>;

/** One change record. `deleted` records are tombstones and carry no body. */
export const SyncChange = z.object({
  collection: SyncCollection,
  id: Uuid,
  updatedAt: IsoDateTime,
  deleted: z.boolean().default(false),
  body: z.record(z.string(), z.unknown()).nullable().default(null),
  /** Idempotency: the same changeId applied twice is a no-op. */
  changeId: Uuid,
});
export type SyncChange = z.infer<typeof SyncChange>;

export const SyncDeltaRequest = z.object({
  deviceId: Uuid,
  /** Partial: a device that syncs only some collections sends cursors only for those. */
  since: z.partialRecord(SyncCollection, IsoDateTime.nullable()).describe('Per-collection cursor of the last change applied from the peer'),
  changes: z.array(SyncChange).max(2000).describe('Local changes to push'),
  enabledCollections: z.array(SyncCollection),
});
export type SyncDeltaRequest = z.infer<typeof SyncDeltaRequest>;

export const SyncConflict = z.object({
  collection: SyncCollection,
  id: Uuid,
  resolution: z.enum(['kept-local', 'kept-remote', 'kept-both', 'tombstone-wins']),
  reason: z.string().max(200),
});

export type SyncConflict = z.infer<typeof SyncConflict>;

export const SyncDeltaResponse = z.object({
  applied: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  conflicts: z.array(SyncConflict).max(2000),
  changes: z.array(SyncChange).max(2000).describe('Remote changes for the requester to apply'),
  cursors: z.partialRecord(SyncCollection, IsoDateTime.nullable()),
  more: z.boolean(),
});
export type SyncDeltaResponse = z.infer<typeof SyncDeltaResponse>;

export const SyncStatus = z.object({
  deviceId: Uuid,
  paused: z.boolean(),
  enabledCollections: z.array(SyncCollection),
  lastSuccessAt: IsoDateTime.nullable(),
  lastError: z.string().nullable(),
  pendingLocal: z.number().int().nonnegative(),
  pendingRemote: z.number().int().nonnegative(),
  progress: z.number().min(0).max(100).nullable(),
  conflicts: z.number().int().nonnegative(),
});
export type SyncStatus = z.infer<typeof SyncStatus>;

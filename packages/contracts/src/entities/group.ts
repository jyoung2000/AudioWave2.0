import { z } from 'zod';
import { DurationMs, IsoDateTime, ProviderId, SCHEMA_VERSIONS, SyncedEntityBase, Uuid } from '../common.js';
import { TrackRef } from './library.js';
import { QueueCommand } from './queue.js';

export const GroupRole = z.enum(['owner', 'admin', 'member', 'guest']);
export type GroupRole = z.infer<typeof GroupRole>;

export const GroupSettings = z.object({
  maxQueuePerUser: z.number().int().positive().max(500).default(25),
  duplicatePolicy: z.enum(['allow', 'reject-in-queue', 'reject-recent']).default('reject-in-queue'),
  cooldownSeconds: z.number().int().nonnegative().max(3600).default(0),
  fairQueue: z.boolean().default(false),
  voteSkipThreshold: z.number().min(0).max(1).default(0.5).describe('Fraction of listeners required'),
  maxTrackDurationMs: DurationMs.max(6 * 3600 * 1000).default(20 * 60 * 1000),
  guestsMayRequest: z.boolean().default(true),
  driftHardSeekThresholdMs: z.number().int().positive().default(400),
  driftSoftCorrectMs: z.number().int().positive().default(60),
});
export type GroupSettings = z.infer<typeof GroupSettings>;

export const Group = SyncedEntityBase.extend({
  hubId: Uuid,
  name: z.string().min(1).max(80),
  ownerId: z.string().min(1).max(200),
  status: z.enum(['active', 'archived']).default('active'),
  settings: GroupSettings.prefault({}),
  inviteCodeHash: z.string().nullable().default(null),
});
export type Group = z.infer<typeof Group>;

export const GroupMembership = SyncedEntityBase.extend({
  groupId: Uuid,
  memberId: z.string().min(1).max(200),
  memberKind: z.enum(['device', 'user', 'discord', 'admin']),
  role: GroupRole.default('member'),
  displayName: z.string().max(120),
  joinedAt: IsoDateTime,
  revokedAt: IsoDateTime.nullable().default(null),
  shareAggregate: z.boolean().default(false).describe('Opted into aggregate taste sharing with this group'),
});
export type GroupMembership = z.infer<typeof GroupMembership>;

export const GroupQueueRevision = z.object({
  groupId: Uuid,
  revision: z.number().int().positive(),
  seq: z.number().int().positive().describe('Global stream sequence for replay'),
  command: QueueCommand,
  actorId: z.string().max(200),
  idempotencyKey: z.string().min(1).max(120),
  occurredAt: IsoDateTime,
  accepted: z.boolean(),
  rejectReason: z.string().max(200).nullable().default(null),
});
export type GroupQueueRevision = z.infer<typeof GroupQueueRevision>;

export const GroupHistoryOutcome = z.enum(['completed', 'skipped', 'failed', 'stopped', 'unavailable', 'playing']);
export type GroupHistoryOutcome = z.infer<typeof GroupHistoryOutcome>;

export const GroupHistoryEntry = z.object({
  id: Uuid.describe('event_id; idempotent on import'),
  schemaVersion: z.number().int().positive().default(SCHEMA_VERSIONS.historyJson),
  groupId: Uuid,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable().default(null),
  track: TrackRef,
  provider: ProviderId,
  providerTrackId: z.string().max(200).nullable().default(null),
  requesterId: z.string().max(200),
  requesterDisplayName: z.string().max(120),
  outcome: GroupHistoryOutcome,
  skipReason: z.string().max(120).nullable().default(null),
  queueRevision: z.number().int().nonnegative(),
});
export type GroupHistoryEntry = z.infer<typeof GroupHistoryEntry>;

export const SyncGrade = z.enum(['exact', 'near', 'best_effort', 'unsupported']);

export const GroupPlaybackState = z.object({
  groupId: Uuid,
  revision: z.number().int().nonnegative(),
  sourceRevision: z.number().int().nonnegative().describe('Increments when the current media representation changes'),
  status: z.enum(['idle', 'preparing', 'playing', 'paused', 'ended']),
  currentItemId: Uuid.nullable(),
  /** Absolute hub-timeline instant at which positionMs === 0 would be heard. */
  startAt: IsoDateTime.nullable(),
  positionMs: DurationMs.default(0),
  pausedAt: IsoDateTime.nullable().default(null),
  syncGrade: SyncGrade,
  syncReason: z.string().max(300).nullable().default(null),
  updatedAt: IsoDateTime,
});
export type GroupPlaybackState = z.infer<typeof GroupPlaybackState>;

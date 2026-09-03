import { z } from 'zod';
import { IsoDateTime, Uuid, WS_PROTOCOL_VERSION } from '../common.js';
import { GroupHistoryEntry, GroupPlaybackState } from '../entities/group.js';
import { Queue, QueueCommand } from '../entities/queue.js';
import { DiscordStatus } from '../entities/discord.js';

/** Every WebSocket message, both directions, is wrapped in this envelope. */
export const Envelope = z.object({
  eventId: Uuid,
  type: z.string().min(1).max(60),
  occurredAt: IsoDateTime,
  schemaVersion: z.number().int().positive().default(WS_PROTOCOL_VERSION),
  actorId: z.string().min(1).max(200),
  payload: z.unknown(),
  /** Server-assigned monotonically increasing sequence number per connection stream (server→client only). */
  seq: z.number().int().positive().optional(),
});
export type Envelope = z.infer<typeof Envelope>;

/* ---------- server → client ---------- */

export const HelloPayload = z.object({
  protocolVersion: z.number().int(),
  minSupportedProtocolVersion: z.number().int(),
  serverTime: IsoDateTime,
  heartbeatIntervalMs: z.number().int().positive(),
  replayWindow: z.number().int().nonnegative().describe('How many events the server can replay'),
  hubId: Uuid,
  deviceId: Uuid,
});

export const GroupSnapshotPayload = z.object({
  groupId: Uuid,
  queue: Queue,
  playback: GroupPlaybackState,
  members: z.array(z.object({ memberId: z.string(), displayName: z.string(), role: z.string(), online: z.boolean() })),
  lastSeq: z.number().int().nonnegative(),
});

export const GroupQueueUpdatedPayload = z.object({
  groupId: Uuid,
  revision: z.number().int().nonnegative(),
  command: QueueCommand,
  idempotencyKey: z.string(),
  queue: Queue,
  actorDisplayName: z.string().optional(),
});

export const GroupPlaybackPayload = GroupPlaybackState;

export const GroupCommandRejectedPayload = z.object({
  groupId: Uuid,
  idempotencyKey: z.string(),
  baseRevision: z.number().int().nonnegative(),
  currentRevision: z.number().int().nonnegative(),
  reason: z.string(),
  code: z.enum(['stale-revision', 'forbidden', 'invalid', 'limit', 'duplicate', 'cooldown', 'unavailable']),
});

export const PresencePayload = z.object({
  groupId: Uuid,
  memberId: z.string(),
  displayName: z.string(),
  online: z.boolean(),
  latencyMs: z.number().nullable().optional(),
});

export const PongPayload = z.object({
  clientTime: z.number().describe('Echoed client monotonic ms'),
  serverReceive: z.number().describe('Server unix ms on receipt'),
  serverSend: z.number().describe('Server unix ms on send'),
});

export const ErrorPayload = z.object({ code: z.string(), message: z.string(), fatal: z.boolean().default(false) });

export const UpgradeRequiredPayload = z.object({
  clientProtocolVersion: z.number().int(),
  serverProtocolVersion: z.number().int(),
  minSupportedProtocolVersion: z.number().int(),
  message: z.string(),
});

export const JobProgressPayload = z.object({
  jobId: Uuid,
  kind: z.enum(['download', 'transfer', 'sync', 'discovery']),
  state: z.string(),
  percent: z.number().min(0).max(100).nullable(),
  message: z.string().optional(),
});

export const HistoryAppendedPayload = z.object({ groupId: Uuid, entry: GroupHistoryEntry });

export const ResyncRequiredPayload = z.object({ groupId: Uuid.optional(), reason: z.string() });

export const ServerEventPayloads = {
  hello: HelloPayload,
  'group.snapshot': GroupSnapshotPayload,
  'group.queue.updated': GroupQueueUpdatedPayload,
  'group.playback': GroupPlaybackPayload,
  'group.command.rejected': GroupCommandRejectedPayload,
  'group.history.appended': HistoryAppendedPayload,
  presence: PresencePayload,
  pong: PongPayload,
  error: ErrorPayload,
  'upgrade-required': UpgradeRequiredPayload,
  'job.progress': JobProgressPayload,
  'discord.status': DiscordStatus,
  'resync.required': ResyncRequiredPayload,
  'device.revoked': z.object({ deviceId: Uuid, reason: z.string() }),
} as const;
export type ServerEventType = keyof typeof ServerEventPayloads;

/* ---------- client → server ---------- */

export const PingPayload = z.object({ clientTime: z.number() });
export const AckPayload = z.object({ lastSeq: z.number().int().nonnegative() });
export const ResyncPayload = z.object({ groupId: Uuid, fromSeq: z.number().int().nonnegative() });
export const SubscribePayload = z.object({ groupId: Uuid });
export const UnsubscribePayload = z.object({ groupId: Uuid });
export const GroupCommandPayload = z.object({
  groupId: Uuid,
  idempotencyKey: z.string().min(1).max(120),
  baseRevision: z.number().int().nonnegative(),
  command: QueueCommand,
});
export const DriftReportPayload = z.object({
  groupId: Uuid,
  driftMs: z.number(),
  positionMs: z.number().int().nonnegative(),
  dspLatencyMs: z.number().nonnegative().default(0),
  revision: z.number().int().nonnegative(),
});
export const AvailabilityReportPayload = z.object({
  groupId: Uuid,
  itemId: Uuid,
  available: z.boolean(),
  reason: z.string().max(300).optional(),
});

export const ClientEventPayloads = {
  ping: PingPayload,
  ack: AckPayload,
  resync: ResyncPayload,
  'group.subscribe': SubscribePayload,
  'group.unsubscribe': UnsubscribePayload,
  'group.command': GroupCommandPayload,
  'group.drift': DriftReportPayload,
  'group.availability': AvailabilityReportPayload,
} as const;
export type ClientEventType = keyof typeof ClientEventPayloads;

export const REALTIME_DEFAULTS = {
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 40_000,
  replayWindow: 500,
  reconnectBaseDelayMs: 500,
  reconnectMaxDelayMs: 30_000,
  reconnectJitter: 0.3,
} as const;

import { z } from 'zod';
import { DurationMs, IsoDateTime, ListeningMode, Uuid } from '../common.js';
import { TrackRef } from './library.js';

export const RepeatMode = z.enum(['off', 'one', 'all']);
export type RepeatMode = z.infer<typeof RepeatMode>;

export const QueueContext = z.object({
  kind: z.enum(['playlist', 'album', 'artist', 'genre', 'search', 'recommendation', 'manual', 'group']),
  id: z.string().max(200).nullable().default(null),
  name: z.string().max(300).nullable().default(null),
});
export type QueueContext = z.infer<typeof QueueContext>;

export const QueueRequester = z.object({
  id: z.string().min(1).max(200).describe('Device id, hub user id, or discord user id'),
  kind: z.enum(['device', 'user', 'discord', 'admin', 'system']),
  displayName: z.string().max(120),
});
export type QueueRequester = z.infer<typeof QueueRequester>;

export const QueueItem = z.object({
  id: Uuid,
  track: TrackRef,
  addedAt: IsoDateTime,
  addedBy: QueueRequester.nullable().default(null),
  requestId: z.string().max(120).nullable().default(null).describe('Idempotency key of the command that added it'),
  availability: z.enum(['available', 'unavailable', 'unknown']).default('unknown'),
  unavailableReason: z.string().max(300).nullable().default(null),
  votesToSkip: z.array(z.string()).default([]),
});
export type QueueItem = z.infer<typeof QueueItem>;

export const Queue = z.object({
  id: Uuid,
  mode: ListeningMode,
  deviceId: Uuid.nullable().default(null),
  groupId: Uuid.nullable().default(null),
  items: z.array(QueueItem).default([]),
  currentIndex: z.number().int().min(-1).default(-1),
  revision: z.number().int().nonnegative().default(0),
  context: QueueContext.nullable().default(null),
  repeat: RepeatMode.default('off'),
  shuffle: z.boolean().default(false),
  shuffleSeed: z.number().int().nullable().default(null),
  fairQueue: z.boolean().default(false),
  positionMs: DurationMs.default(0),
  updatedAt: IsoDateTime,
});
export type Queue = z.infer<typeof Queue>;

export const PlaybackStatus = z.enum(['idle', 'loading', 'buffering', 'ready', 'playing', 'paused', 'seeking', 'ended', 'error']);
export type PlaybackStatus = z.infer<typeof PlaybackStatus>;

export const PlaybackState = z.object({
  status: PlaybackStatus,
  mode: ListeningMode,
  queueItemId: Uuid.nullable().default(null),
  trackId: Uuid.nullable().default(null),
  positionMs: DurationMs.default(0),
  durationMs: DurationMs.nullable().default(null),
  volume: z.number().min(0).max(1).default(1),
  muted: z.boolean().default(false),
  repeat: RepeatMode.default('off'),
  shuffle: z.boolean().default(false),
  playbackRate: z.number().min(0.25).max(4).default(1),
  error: z.string().max(400).nullable().default(null),
  updatedAt: IsoDateTime,
  /** For group mode: the hub timeline the state refers to. */
  startAt: IsoDateTime.nullable().default(null),
  revision: z.number().int().nonnegative().default(0),
});
export type PlaybackState = z.infer<typeof PlaybackState>;

/** Queue mutation commands. Shared by Solo (local reducer) and Group (hub-authoritative). */
export const QueueCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('append'), items: z.array(TrackRef).min(1).max(500) }),
  z.object({ type: z.literal('insert'), index: z.number().int().nonnegative(), items: z.array(TrackRef).min(1).max(500) }),
  z.object({ type: z.literal('playNext'), items: z.array(TrackRef).min(1).max(100) }),
  z.object({ type: z.literal('remove'), itemId: Uuid }),
  z.object({ type: z.literal('reorder'), itemId: Uuid, toIndex: z.number().int().nonnegative() }),
  z.object({ type: z.literal('skip'), reason: z.string().max(120).optional() }),
  z.object({ type: z.literal('voteSkip') }),
  z.object({ type: z.literal('previous') }),
  z.object({ type: z.literal('jump'), itemId: Uuid }),
  z.object({ type: z.literal('shuffle'), seed: z.number().int().optional() }),
  z.object({ type: z.literal('setShuffle'), enabled: z.boolean(), seed: z.number().int().optional() }),
  z.object({ type: z.literal('setRepeat'), repeat: RepeatMode }),
  z.object({ type: z.literal('clear') }),
  z.object({ type: z.literal('play') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('seek'), positionMs: DurationMs }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('setFairQueue'), enabled: z.boolean() }),
  z.object({ type: z.literal('markUnavailable'), itemId: Uuid, reason: z.string().max(300) }),
  z.object({ type: z.literal('advance'), reason: z.enum(['ended', 'error', 'unavailable']) }),
]);
export type QueueCommand = z.infer<typeof QueueCommand>;

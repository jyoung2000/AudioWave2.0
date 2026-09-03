import { z } from 'zod';
import { DurationMs, IsoDateTime, ListeningMode, ProviderId, SCHEMA_VERSIONS, Uuid } from '../common.js';

export const ListeningEventType = z.enum([
  'queued',
  'started',
  'meaningful',
  'seeked',
  'paused',
  'resumed',
  'skipped',
  'completed',
  'replayed',
  'liked',
  'unliked',
  'playlist-added',
  'playlist-removed',
  'download-completed',
  'recommendation-shown',
  'recommendation-accepted',
  'recommendation-dismissed',
  'favorited',
  'disliked',
  'saved',
]);
export type ListeningEventType = z.infer<typeof ListeningEventType>;

export const EventTrackSnapshot = z.object({
  title: z.string().max(300),
  artistName: z.string().max(300),
  artistId: Uuid.nullable().default(null),
  albumName: z.string().max(300).nullable().default(null),
  albumId: Uuid.nullable().default(null),
  genre: z.string().max(60).nullable().default(null),
  tags: z.array(z.string().max(60)).default([]),
  year: z.number().int().nullable().default(null),
  durationMs: DurationMs.nullable().default(null),
  provider: ProviderId.default('local'),
  popularity: z.number().min(0).max(1).nullable().default(null),
});
export type EventTrackSnapshot = z.infer<typeof EventTrackSnapshot>;

/** Append-only local listening event. */
export const ListeningEvent = z.object({
  id: Uuid,
  schemaVersion: z.number().int().positive().default(SCHEMA_VERSIONS.listeningEvent),
  type: ListeningEventType,
  occurredAt: IsoDateTime,
  sessionId: Uuid,
  deviceId: Uuid,
  mode: ListeningMode.default('solo'),
  groupId: Uuid.nullable().default(null),
  trackId: Uuid.nullable().default(null),
  track: EventTrackSnapshot.nullable().default(null),
  positionMs: DurationMs.nullable().default(null),
  secondsPlayed: z.number().nonnegative().nullable().default(null),
  completionPercent: z.number().min(0).max(100).nullable().default(null),
  reason: z.string().max(120).nullable().default(null),
  playlistId: Uuid.nullable().default(null),
  presetId: Uuid.nullable().default(null),
  recommendationId: Uuid.nullable().default(null),
  contextKind: z.enum(['playlist', 'album', 'artist', 'genre', 'search', 'recommendation', 'manual', 'group']).nullable().default(null),
  contextId: z.string().max(200).nullable().default(null),
  /** Optional user-declared mood/activity for contextual profiles. */
  mood: z.string().max(40).nullable().default(null),
  activity: z.string().max(40).nullable().default(null),
});
export type ListeningEvent = z.infer<typeof ListeningEvent>;

export const WeightedKey = z.object({ key: z.string().max(200), weight: z.number().min(-1).max(1) });

/** Privacy-preserving aggregate; contains no titles or timestamps. */
export const AggregateTasteProfile = z.object({
  id: Uuid,
  schemaVersion: z.number().int().positive().default(1),
  ownerId: Uuid.describe('Device id or hub user id'),
  computedAt: IsoDateTime,
  windowDays: z.number().int().positive(),
  sampleSize: z.number().int().nonnegative().describe('Number of meaningful listens in the window'),
  minSampleMet: z.boolean(),
  artists: z.array(WeightedKey).max(200),
  genres: z.array(WeightedKey).max(100),
  albums: z.array(WeightedKey).max(200),
  eras: z.array(WeightedKey).max(20).describe('Decade buckets like "1990s"'),
  discoveryRate: z.number().min(0).max(1),
  listeningPattern: z.array(z.number().min(0).max(1)).length(24).describe('Normalized hour-of-day histogram'),
  sources: z.array(WeightedKey).max(20),
});
export type AggregateTasteProfile = z.infer<typeof AggregateTasteProfile>;

export const RecommendationReason = z.object({
  signal: z.string().max(60),
  weight: z.number(),
  text: z.string().max(300),
});

export const RecommendationFeedback = z.enum(['like', 'not-for-me', 'less-from-artist', 'already-know', 'dismiss', 'accepted']);
export type RecommendationFeedback = z.infer<typeof RecommendationFeedback>;

export const RecommendationMode = z.enum([
  'for-you',
  'playlist',
  'genre',
  'similar',
  'deep',
  'new-releases',
  'recent',
]);
export type RecommendationMode = z.infer<typeof RecommendationMode>;

export const Recommendation = z.object({
  id: Uuid,
  mode: RecommendationMode,
  contextId: z.string().max(200).nullable().default(null),
  canonicalTrackId: z.string().min(1).max(200),
  title: z.string().max(300),
  artistName: z.string().max(300),
  albumName: z.string().max(300).nullable().default(null),
  genre: z.string().max(60).nullable().default(null),
  year: z.number().int().nullable().default(null),
  score: z.number(),
  tier: z.enum(['strong', 'related', 'emerging', 'experimental']),
  candidateSource: z.string().max(60),
  reasons: z.array(RecommendationReason).max(10),
  availability: z.array(
    z.object({
      provider: ProviderId,
      providerTrackId: z.string().max(200),
      url: z.string().url().optional(),
      playable: z.boolean(),
    }),
  ),
  createdAt: IsoDateTime,
  feedback: RecommendationFeedback.nullable().default(null),
});
export type Recommendation = z.infer<typeof Recommendation>;

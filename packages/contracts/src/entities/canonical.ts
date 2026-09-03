import { z } from 'zod';
import { IsoDateTime, ProviderId, Uuid } from '../common.js';

/** Platform-independent recording used by the recommendation engine. */
export const CanonicalTrack = z.object({
  id: Uuid,
  musicbrainzRecordingId: z.uuid().nullable().default(null),
  isrc: z.string().nullable().default(null),
  title: z.string().max(300),
  normalizedTitle: z.string().max(300),
  artistId: Uuid.nullable().default(null),
  artistName: z.string().max(300),
  normalizedArtist: z.string().max(300),
  albumId: Uuid.nullable().default(null),
  albumName: z.string().max(300).nullable().default(null),
  releaseYear: z.number().int().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  genres: z.array(z.string().max(60)).default([]),
  tags: z.array(z.string().max(60)).default([]),
  popularity: z.number().min(0).max(1).nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CanonicalTrack = z.infer<typeof CanonicalTrack>;

export const CanonicalArtist = z.object({
  id: Uuid,
  musicbrainzArtistId: z.uuid().nullable().default(null),
  name: z.string().max(300),
  normalizedName: z.string().max(300),
  genres: z.array(z.string().max(60)).default([]),
  tags: z.array(z.string().max(60)).default([]),
  popularity: z.number().min(0).max(1).nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CanonicalArtist = z.infer<typeof CanonicalArtist>;

export const TrackPlatform = z.object({
  trackId: Uuid,
  provider: ProviderId,
  providerTrackId: z.string().max(200),
  url: z.string().url().nullable().default(null),
  availability: z.enum(['available', 'requires_auth', 'restricted', 'unavailable', 'unknown']).default('unknown'),
  lastVerifiedAt: IsoDateTime.nullable().default(null),
});
export type TrackPlatform = z.infer<typeof TrackPlatform>;

export const ArtistRelation = z.object({
  artistId: Uuid,
  relatedArtistId: Uuid,
  weight: z.number().min(0).max(1),
  source: ProviderId,
  updatedAt: IsoDateTime,
});
export type ArtistRelation = z.infer<typeof ArtistRelation>;

export const DiscoveryCacheEntry = z.object({
  key: z.string().max(400),
  provider: ProviderId,
  query: z.string().max(400),
  results: z.array(z.unknown()),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  hits: z.number().int().nonnegative().default(0),
});
export type DiscoveryCacheEntry = z.infer<typeof DiscoveryCacheEntry>;

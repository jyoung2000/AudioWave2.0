import { z } from 'zod';
import { DurationMs, IsoDateTime, ProviderId, Sha256Hex, SyncedEntityBase, Uuid } from '../common.js';
import { LocatorAvailability, MediaLocator } from '../locators.js';

export const LibraryRootKind = z.enum(['browser-handle', 'opfs', 'windows-directory', 'hub-directory']);
export const LibraryRootStatus = z.enum(['connected', 'needs-permission', 'missing', 'scanning', 'error', 'removed']);

export const LibraryRoot = SyncedEntityBase.extend({
  deviceId: Uuid,
  kind: LibraryRootKind,
  displayName: z.string().min(1).max(200),
  /** Opaque handle or directory id owned by the device; never an absolute path when shared. */
  handleId: z.string().min(1).max(200),
  status: LibraryRootStatus.default('connected'),
  lastScanAt: IsoDateTime.nullable().default(null),
  lastScanError: z.string().max(500).nullable().default(null),
  trackCount: z.number().int().nonnegative().default(0),
  watch: z.boolean().default(true),
  scanCheckpoint: z.string().max(2000).nullable().default(null).describe('Resumable indexing checkpoint (opaque)'),
});
export type LibraryRoot = z.infer<typeof LibraryRoot>;

export const Artist = SyncedEntityBase.extend({
  name: z.string().min(1).max(300),
  sortName: z.string().min(1).max(300),
  musicbrainzArtistId: z.uuid().nullable().default(null),
  followed: z.boolean().default(false).describe('Local follow flag'),
  genres: z.array(z.string().max(60)).default([]),
});
export type Artist = z.infer<typeof Artist>;

export const ReleaseType = z.enum(['album', 'single', 'ep', 'compilation', 'live', 'remix', 'soundtrack', 'other']);
export type ReleaseType = z.infer<typeof ReleaseType>;

export const Album = SyncedEntityBase.extend({
  title: z.string().min(1).max(300),
  albumArtistName: z.string().min(1).max(300),
  artistId: Uuid.nullable().default(null),
  year: z.number().int().min(1000).max(3000).nullable().default(null),
  releaseType: ReleaseType.default('album'),
  musicbrainzReleaseGroupId: z.uuid().nullable().default(null),
  musicbrainzReleaseId: z.uuid().nullable().default(null),
  artworkId: z.string().max(200).nullable().default(null),
  discCount: z.number().int().positive().nullable().default(null),
});
export type Album = z.infer<typeof Album>;

/** External aliases for a recording. Never a mutable title as primary key. */
export const TrackIdentity = z.object({
  contentHash: Sha256Hex.nullable().default(null).describe('SHA-256 of the file bytes when known'),
  quickHash: z.string().max(80).nullable().default(null).describe('Fast size+head+tail hash while full hash pending'),
  isrc: z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/).nullable().default(null),
  musicbrainzRecordingId: z.uuid().nullable().default(null),
  musicbrainzReleaseId: z.uuid().nullable().default(null),
  acoustidId: z.string().max(80).nullable().default(null),
  providerIds: z.record(ProviderId, z.array(z.string().min(1).max(200))).default({}),
});
export type TrackIdentity = z.infer<typeof TrackIdentity>;

export const AudioFormat = z.object({
  container: z.string().max(20).optional(),
  codec: z.string().max(40).optional(),
  mime: z.string().max(80).optional(),
  sampleRateHz: z.number().int().positive().optional(),
  bitrateKbps: z.number().nonnegative().optional(),
  channels: z.number().int().positive().optional(),
  lossless: z.boolean().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type AudioFormat = z.infer<typeof AudioFormat>;

export const Track = SyncedEntityBase.extend({
  title: z.string().min(1).max(300),
  artistId: Uuid.nullable().default(null),
  artistName: z.string().min(1).max(300),
  albumId: Uuid.nullable().default(null),
  albumName: z.string().max(300).nullable().default(null),
  albumArtistName: z.string().max(300).nullable().default(null),
  discNumber: z.number().int().positive().nullable().default(null),
  trackNumber: z.number().int().positive().nullable().default(null),
  genre: z.string().max(60).nullable().default(null),
  genres: z.array(z.string().max(60)).default([]),
  tags: z.array(z.string().max(60)).default([]),
  year: z.number().int().min(1000).max(3000).nullable().default(null),
  durationMs: DurationMs.nullable().default(null),
  bpm: z.number().positive().max(400).nullable().default(null),
  identity: TrackIdentity.prefault({}),
  locators: z.array(MediaLocator).default([]),
  artworkId: z.string().max(200).nullable().default(null),
  format: AudioFormat.nullable().default(null),
  rootId: Uuid.nullable().default(null),
  unsupportedReason: z.string().max(200).nullable().default(null).describe('Set when the browser cannot decode this format'),
  liked: z.boolean().default(false),
  explicit: z.boolean().nullable().default(null),
  popularity: z.number().min(0).max(1).nullable().default(null).describe('Normalized provider popularity when known'),
});
export type Track = z.infer<typeof Track>;

/** Snapshot of a track embedded into playlists, queues and events so they stay meaningful if the track row is gone. */
export const TrackRef = z.object({
  trackId: Uuid,
  title: z.string().min(1).max(300),
  artistName: z.string().min(1).max(300),
  albumName: z.string().max(300).nullable().default(null),
  durationMs: DurationMs.nullable().default(null),
  artworkId: z.string().max(200).nullable().default(null),
  identity: TrackIdentity.prefault({}),
  locators: z.array(MediaLocator).default([]),
  provider: ProviderId.default('local'),
  genre: z.string().max(60).nullable().default(null),
  year: z.number().int().nullable().default(null),
});
export type TrackRef = z.infer<typeof TrackRef>;

export const TrackAvailability = z.object({
  trackId: Uuid,
  status: LocatorAvailability,
  reason: z.string().max(300).optional(),
  checkedAt: IsoDateTime,
});
export type TrackAvailability = z.infer<typeof TrackAvailability>;

export const Artwork = z.object({
  id: z.string().min(1).max(200),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  contentHash: Sha256Hex.optional(),
});
export type Artwork = z.infer<typeof Artwork>;

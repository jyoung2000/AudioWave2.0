import { z } from 'zod';
import { IsoDateTime, ProviderId, SyncedEntityBase, Uuid } from '../common.js';
import { TrackRef } from './library.js';

export const PlaylistKind = z.enum(['user', 'imported', 'smart']);

export const Playlist = SyncedEntityBase.extend({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable().default(null),
  ownerDeviceId: Uuid.nullable().default(null),
  ownerUserId: Uuid.nullable().default(null),
  kind: PlaylistKind.default('user'),
  /** Playlist-level default EQ preset id (precedence: playlist default). */
  eqPresetId: Uuid.nullable().default(null),
  importedFrom: z
    .object({ provider: ProviderId, externalId: z.string().max(200), importedAt: IsoDateTime })
    .nullable()
    .default(null),
  artworkId: z.string().max(200).nullable().default(null),
  /** Contextual taste profile id used by playlist discovery. */
  tasteProfileId: Uuid.nullable().default(null),
  mood: z.string().max(40).nullable().default(null),
  activity: z.string().max(40).nullable().default(null),
});
export type Playlist = z.infer<typeof Playlist>;

export const PlaylistItem = SyncedEntityBase.extend({
  playlistId: Uuid,
  /** Ordering key. Reordering rewrites positions; sync resolves per-item last-writer-wins. */
  position: z.number().int().nonnegative(),
  track: TrackRef,
  /** Per-track-per-playlist EQ override (highest precedence). */
  eqOverridePresetId: Uuid.nullable().default(null),
  addedByDeviceId: Uuid.nullable().default(null),
  note: z.string().max(300).nullable().default(null),
});
export type PlaylistItem = z.infer<typeof PlaylistItem>;

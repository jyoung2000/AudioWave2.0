import { z } from 'zod';
import { IsoDateTime, SCHEMA_VERSIONS, Uuid } from '../common.js';
import { EqPreset } from '../entities/audio.js';
import { TrackRef } from '../entities/library.js';
import { Playlist } from '../entities/playlists.js';

export const PLAYLIST_JSON_FORMAT = 'now-playing-playlist' as const;

export const PlaylistJsonItem = z.object({
  id: Uuid,
  position: z.number().int().nonnegative(),
  track: TrackRef,
  eqOverridePresetId: Uuid.nullable().default(null),
  note: z.string().max(300).nullable().default(null),
});

/** Versioned Now Playing JSON playlist format. Preserves provider ids, EQ bindings and stable ids. */
export const PlaylistJson = z.object({
  format: z.literal(PLAYLIST_JSON_FORMAT),
  schemaVersion: z.literal(SCHEMA_VERSIONS.playlistJson),
  exportedAt: IsoDateTime,
  exportedBy: z.string().max(120).optional(),
  playlist: Playlist.pick({ id: true, name: true, description: true, eqPresetId: true, kind: true, mood: true, activity: true }),
  items: z.array(PlaylistJsonItem).max(10_000),
  /** Presets referenced by the playlist or its items, embedded so the import is self-contained. */
  presets: z.array(EqPreset).max(100).default([]),
});
export type PlaylistJson = z.infer<typeof PlaylistJson>;

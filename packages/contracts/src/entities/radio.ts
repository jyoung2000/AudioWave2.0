import { z } from 'zod';

/**
 * What an internet radio station says it is playing, read from the stream's ICY metadata by the hub
 * or the companion (a page cannot see it). Every field is null when the station sends nothing, and
 * `reason` then says why in words a person can read.
 */
export const StationNowPlaying = z.object({
  raw: z.string().max(500).nullable(),
  artist: z.string().max(300).nullable(),
  title: z.string().max(300).nullable(),
  station: z.string().max(200).nullable(),
  reason: z.string().max(200).nullable(),
});
export type StationNowPlaying = z.infer<typeof StationNowPlaying>;

/** The answer to "put this song in the group": what was queued and where, or why nothing was. */
export const GroupRequestResult = z.object({
  queued: z.boolean(),
  title: z.string().nullable(),
  artistName: z.string().nullable(),
  position: z.number().int().positive().nullable(),
  reason: z.string().nullable(),
});
export type GroupRequestResult = z.infer<typeof GroupRequestResult>;

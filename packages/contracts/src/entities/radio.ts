import { z } from 'zod';

/**
 * What an internet radio station says it is playing, read from the stream's ICY metadata by the hub
 * or the companion (a page cannot see it). The hub may also return a separately identified official
 * scheduled programme for supported stations; it never treats a song title as a programme.
 * When song metadata is absent, `reason` says why in words a person can read.
 */
export const StationNowPlaying = z.object({
  raw: z.string().max(500).nullable(),
  artist: z.string().max(300).nullable(),
  title: z.string().max(300).nullable(),
  station: z.string().max(200).nullable(),
  /** Official schedule programme, when a supported station has a live timed listing. */
  programme: z.string().max(300).nullable().optional(),
  programmeSource: z.literal('schedule').nullable().optional(),
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

/**
 * Discover: what plays when the album ends.
 *
 * The recommender in `packages/recommendations` is deterministic, CPU-only
 * TypeScript with no model, no network and no service behind it — which means
 * there is nothing stopping it running here, in the page, over the library on
 * this device. That is what this module does. The hub runs the same code over
 * a larger catalogue when one is paired; solo mode gets the same algorithm
 * over its own music, and the listening history it reads never leaves the
 * device.
 *
 * Two uses:
 *
 *   **Autoplay.** A queue that runs out used to stop. With discover on, the
 *   last thing you heard becomes the seed for more, and the music keeps going
 *   the way a radio would.
 *
 *   **Similar to this.** A track you are listening to, on demand, as its own
 *   queue.
 *
 * Both carry their reasons. Every recommendation the engine returns says why
 * it was picked, and the player shows that rather than presenting a black
 * box — the same rule the rest of this app follows about not claiming more
 * than it can explain.
 */
import type { CanonicalTrack, ListeningEvent, RecommendationMode, RecommendationReason as ReasonSchema, Track } from '@now-playing/contracts';
import type { z } from 'zod';
import { normalizeArtist, normalizeText } from '@now-playing/domain';
import { applyEvents, createProfile, recommend, type TasteProfile } from '@now-playing/recommendations';

/** One "Why this?" line: a signal, its weight, and a sentence. */
export type DiscoveryReason = z.infer<typeof ReasonSchema>;

/** How many tracks an autoplay top-up adds at a time. */
export const AUTOPLAY_BATCH = 5;
/** How many a "similar to this" queue holds. */
export const SIMILAR_BATCH = 25;

/**
 * The library as a catalogue the recommender can read.
 *
 * The ids are the library's own, so what comes back maps straight home with
 * no second lookup and no chance of a mismatch.
 */
export function catalogueFromLibrary(tracks: readonly Track[]): CanonicalTrack[] {
  const stamp = new Date(0).toISOString();
  return tracks.map((t) => ({
    id: t.id,
    musicbrainzRecordingId: t.identity.musicbrainzRecordingId,
    isrc: t.identity.isrc,
    title: t.title,
    normalizedTitle: normalizeText(t.title),
    artistId: t.artistId,
    artistName: t.artistName,
    normalizedArtist: normalizeArtist(t.artistName),
    albumId: t.albumId,
    albumName: t.albumName,
    releaseYear: t.year,
    durationMs: t.durationMs,
    genres: t.genres.length ? t.genres : t.genre ? [t.genre] : [],
    tags: t.tags,
    // The library has no popularity of its own, and inventing one would tilt
    // every ranking that reads it. Absent is the truthful value.
    popularity: null,
    createdAt: t.createdAt || stamp,
    updatedAt: t.updatedAt || stamp,
  }));
}

/**
 * A taste profile from this device's own listening.
 *
 * `applyEvents` ignores events it has already folded in, so passing the whole
 * history to an existing profile costs only the new ones and this can be
 * called on every top-up.
 */
export function profileFrom(userId: string, events: readonly ListeningEvent[], previous: TasteProfile | null = null, now: number = Date.now()): TasteProfile {
  return applyEvents(previous ?? createProfile(userId, now), events, undefined, now);
}

export interface DiscoverInput {
  userId: string;
  profile: TasteProfile;
  library: readonly Track[];
  /** The track to be similar to. Absent asks for "more like what you play". */
  seed?: Track | null;
  /** Never suggest these: what is queued, and what was just heard. */
  exclude?: Iterable<string>;
  limit?: number;
  now?: number;
}

export interface Discovery {
  track: Track;
  reasons: DiscoveryReason[];
  /** strong · related · emerging · experimental — how familiar this should feel. */
  tier: string;
}

export interface DiscoverResult {
  picks: Discovery[];
  /** Why there are fewer than asked for, or null. Shown rather than swallowed. */
  shortfall: string | null;
}

/**
 * Ask for more music.
 *
 * With a seed this is "similar to this"; without one it is the recommender's
 * own view of what this listener wants next. Either way the answer is drawn
 * from the library on this device, so everything it returns is playable right
 * now, offline, without asking anyone for permission.
 */
export function discover(input: DiscoverInput): DiscoverResult {
  const { userId, profile, library, seed = null, limit = AUTOPLAY_BATCH, now = Date.now() } = input;
  const exclude = new Set(input.exclude ?? []);
  if (seed) exclude.add(seed.id);

  const pool = library.filter((t) => !exclude.has(t.id));
  if (pool.length === 0) {
    return { picks: [], shortfall: 'Everything on this device is already in the queue.' };
  }

  const byId = new Map(pool.map((t) => [t.id, t]));
  const mode: RecommendationMode = seed ? 'similar' : 'for-you';
  const result = recommend({
    userId,
    profile,
    catalogue: catalogueFromLibrary(pool),
    mode,
    limit,
    now,
    context: {
      ...(seed ? { seedTrackId: seed.id } : {}),
      recentlyPlayedIds: exclude,
      // The library is what it can play; nothing here is "not owned yet".
      ownedTrackIds: pool.map((t) => t.id),
    },
  });

  const picks: Discovery[] = [];
  for (const rec of result.recommendations) {
    const track = byId.get(rec.canonicalTrackId);
    if (track) picks.push({ track, reasons: rec.reasons, tier: rec.tier });
  }
  return { picks, shortfall: result.diagnostics.shortfallReason };
}

/** One line a person can read, from the reasons the engine gave. */
export function explain(pick: Discovery): string {
  const top = pick.reasons[0];
  return top ? top.text : 'Picked from what you have been listening to';
}

/**
 * Privacy-preserving projection of a taste profile.
 *
 * An `AggregateTasteProfile` is the only shape that ever leaves a device for group features. It
 * carries weighted buckets — artists, genres, albums, decades, a 24-slot hour histogram — and never
 * track ids, titles, timestamps or anything that identifies a single listen. Buckets seen fewer
 * than `minCount` times are dropped, and when the profile has fewer than `kAnonymity` distinct
 * artists nothing is emitted at all: a "profile" built from two artists is a fingerprint.
 */
import type { AggregateTasteProfile } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import { DAY_MS, topEntries, type AffinityEntry, type Dimension, type SeedInput, type TasteProfile } from './profile.js';

export interface AggregateOptions {
  /** Minimum observations before a bucket may be shared. Default 3. */
  minCount?: number;
  /** Minimum distinct artists before any aggregate is produced at all. Default 5. */
  kAnonymity?: number;
  /** Window the aggregate claims to describe, in days. Default 90. */
  windowDays?: number;
  now?: number;
  id?: string;
}

export interface AggregateResult {
  profile: AggregateTasteProfile | null;
  /** Why nothing was produced, when that is the case. */
  reason: string | null;
  droppedBuckets: number;
}

function normalise(entries: Array<{ key: string; weight: number }>, limit: number): Array<{ key: string; weight: number }> {
  const positive = entries.filter((e) => e.weight > 0);
  const max = Math.max(0, ...positive.map((e) => e.weight));
  if (max <= 0) return [];
  return positive
    .slice(0, limit)
    .map((e) => ({ key: e.key, weight: Math.round((e.weight / max) * 1000) / 1000 }))
    .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
}

/**
 * Build the shareable aggregate. Returns `{ profile: null, reason }` rather than a thin aggregate
 * when the profile is too small to anonymise — the caller shows the reason instead of sharing.
 */
export function profileToAggregate(profile: TasteProfile, options: AggregateOptions = {}): AggregateResult {
  const minCount = options.minCount ?? 3;
  const kAnonymity = options.kAnonymity ?? 5;
  const windowDays = options.windowDays ?? 90;
  const now = options.now ?? Date.now();
  let dropped = 0;

  // "Observed" means any evidence at all: a play, or a positive or negative signal. A history made
  // only of completions and likes carries no `started` events, and would otherwise look empty here.
  const observations = (entry: AffinityEntry): number => entry.n + entry.pos + entry.neg;
  const eligible = <T extends AffinityEntry>(entries: Dimension<T>): Array<[string, T]> => {
    const out: Array<[string, T]> = [];
    for (const [key, entry] of Object.entries(entries)) {
      if (observations(entry) >= minCount) out.push([key, entry]);
      else dropped += 1;
    }
    return out;
  };

  const artists = eligible(profile.dims.artists);
  if (artists.length < kAnonymity) {
    return { profile: null, reason: `An aggregate needs at least ${kAnonymity} artists heard ${minCount}+ times; this profile has ${artists.length}`, droppedBuckets: dropped };
  }

  const pick = (dim: Dimension, limit: number) => {
    const allowed = new Set(eligible(dim).map(([key]) => key));
    return normalise(
      topEntries(dim, limit * 2)
        .filter((e) => allowed.has(e.key))
        .map((e) => ({ key: e.label ?? e.key, weight: e.weight })),
      limit,
    );
  };

  const pattern = Array<number>(24).fill(0);
  const maxHour = Math.max(0, ...profile.hours);
  for (let i = 0; i < 24; i += 1) pattern[i] = maxHour > 0 ? Math.round((profile.hours[i]! / maxHour) * 1000) / 1000 : 0;

  const sampleSize = profile.meaningfulCount;
  const aggregate: AggregateTasteProfile = {
    id: options.id ?? uuidv7(now),
    schemaVersion: 1,
    ownerId: profile.userId,
    computedAt: new Date(Math.floor(now / (7 * DAY_MS)) * 7 * DAY_MS).toISOString(),
    windowDays,
    sampleSize,
    minSampleMet: sampleSize >= 20,
    artists: pick(profile.dims.artists, 200),
    genres: pick(profile.dims.genres, 100),
    albums: pick(profile.dims.albums, 200),
    eras: pick(profile.dims.eras, 20),
    discoveryRate: Math.round(Math.min(1, Math.max(0, profile.discovery.newArtistPlays / Math.max(1, profile.discovery.newArtistPlays + profile.discovery.knownArtistPlays))) * 1000) / 1000,
    listeningPattern: pattern,
    sources: pick(profile.dims.platforms, 20),
  };
  return { profile: aggregate, reason: null, droppedBuckets: dropped };
}

/**
 * The reverse trip: turn a shared aggregate (a friend's, or a merged group one) into cold-start
 * seeds. Only names come back — no track ids exist in an aggregate to begin with.
 */
export function seedsFromAggregate(aggregate: AggregateTasteProfile, options: { artists?: number; genres?: number; minWeight?: number } = {}): SeedInput {
  const minWeight = options.minWeight ?? 0.1;
  return {
    artists: aggregate.artists
      .filter((a) => a.weight >= minWeight)
      .slice(0, options.artists ?? 20)
      .map((a) => a.key),
    genres: aggregate.genres
      .filter((g) => g.weight >= minWeight)
      .slice(0, options.genres ?? 10)
      .map((g) => g.key),
    likedTrackIds: [],
  };
}

/** Assert that an aggregate carries nothing track-level; used by the privacy tests and the hub. */
export function aggregateLeaksTrackIds(aggregate: AggregateTasteProfile, trackIds: Iterable<string>): string[] {
  const ids = new Set(trackIds);
  const found: string[] = [];
  const scan = (entries: readonly { key: string }[]) => {
    for (const e of entries) if (ids.has(e.key)) found.push(e.key);
  };
  scan(aggregate.artists);
  scan(aggregate.genres);
  scan(aggregate.albums);
  scan(aggregate.eras);
  scan(aggregate.sources);
  return found;
}

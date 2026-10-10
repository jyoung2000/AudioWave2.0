/**
 * Discover's look-ahead cache (NP-DISC-007): fetch the next track while this one is playing, so the
 * hand-off between songs feels instant without the app ever claiming the audio was already here.
 *
 * The problem this solves is the one that makes Discover feel like a list rather than a radio. A
 * found row cannot play instantly — this app has no permitted route to a stream it does not own — so
 * tapping one means waiting for the tools transport to fetch it. But a song lasts minutes and a
 * fetch takes seconds, so the wait only exists because nobody started it early. Start it while the
 * previous song plays and it is usually over before anyone notices.
 *
 * What an entry is, and is not. A cache entry is **not** a library entry. It lives in the app's own
 * storage under a ring that is evicted as the playhead moves past it, and it is deleted rather than
 * kept unless the person stars it. Starring promotes an entry into the library, where the usual
 * rules apply (provenance, metadata, artwork). A star that arrives after the entry was evicted
 * simply fetches it again, which is exactly why evicting is free. This module decides; it never
 * performs IO — fetching, writing, deleting and measuring belong to the caller, which is what makes
 * every rule below testable without a network, a browser or a file.
 *
 * The rights basis. The app asks once, at the moment look-ahead is switched on, and remembers the
 * answer; it does not ask again per track. A radio that stops to ask a question cannot run while
 * someone is driving, mid-game, or walking with the phone in a pocket, which is most of when a radio
 * is wanted. The acknowledgment is shown in Settings beside the switch and can be withdrawn there,
 * so the decision is explicit, made once, by the person, and never assumed on their behalf.
 * `enabled` is what this module reads, and it is off until they make it.
 */
import type { OnlinePick } from './online.js';

/** The least a row needs to be worth fetching. Keeps this module independent of the ranker's shape. */
export interface Candidate {
  /** The row's own address, as `toRankSong` keys it. */
  id: string;
  url: string | null;
  title: string;
  artist: string;
  platform: string | null;
}

/** A ranked pick, flattened to what a fetch needs. */
export function candidatesFrom(picks: readonly OnlinePick[]): Candidate[] {
  return picks.map((p) => ({
    id: p.song.id,
    url: p.url,
    title: p.song.title,
    artist: p.song.artist,
    platform: p.platform,
  }));
}

/** One track held in the look-ahead ring. */
export interface CacheEntry {
  id: string;
  title: string;
  artist: string;
  platform: string | null;
  url: string | null;
  /** Bytes on disk, once written. Zero while it is still being written. */
  bytes: number;
  /** When the fetch completed, for the eviction order and for "next". */
  at: number;
  /** Played to (or past) the end: no reason to keep it unless it is starred. */
  played: boolean;
  /** Starred — a library entry now, and never evicted. */
  starred: boolean;
}

export interface LookAheadInput {
  /** False until the person has switched look-ahead on. Nothing is planned while false. */
  enabled: boolean;
  /** Seconds left on the song playing now, whatever is known of it. */
  remainingSec: number;
  /** Ranked candidates, best first — what `rankFound` returned. */
  candidates: readonly Candidate[];
  /** What the ring already holds. */
  cache: readonly CacheEntry[];
  /** Rows a fetch is already running for, so one is never started twice. */
  inFlight?: readonly string[];
  /** How many ready tracks ahead of the playhead the ring keeps. */
  depth?: number;
  /** How many bytes the ring may hold in total. */
  byteBudget: number;
  /** Seconds of headroom required before starting a fetch, on top of the estimate. */
  slackSec?: number;
  /** How long a fetch has been taking, measured rather than assumed. */
  estimateFetchSec?: number;
  /** Average bytes per fetched track, measured; used against the budget as entries fill in. */
  estimateBytes?: number;
}

export interface PlannedFetch {
  id: string;
  url: string;
  title: string;
  artist: string;
  platform: string | null;
  /** Why this row and not another, said the way the rest of the app says things. */
  why: string;
}

export interface LookAheadPlan {
  fetch: PlannedFetch[];
  /** Entries to delete: played through, unstarred, and past the ring. */
  evict: string[];
  /** Entries to keep, in the order they will be needed. */
  keep: string[];
  /** Why nothing is planned, when nothing is — shown rather than left as a silence. */
  reason: string | null;
}

const DEFAULT_DEPTH = 2;
const DEFAULT_SLACK = 15;
const DEFAULT_FETCH_SEC = 12;
const DEFAULT_BYTES = 12 * 1024 * 1024;

/**
 * What to fetch now, what to delete, and what to keep.
 *
 * Nothing is planned when look-ahead is off, when there is not enough time left for a fetch to land,
 * or when every candidate is already cached or on its way — and each of those says which it is,
 * rather than returning an empty plan with no explanation.
 */
export function planLookAhead(input: LookAheadInput): LookAheadPlan {
  const depth = input.depth ?? DEFAULT_DEPTH;
  const slack = input.slackSec ?? DEFAULT_SLACK;
  const estimate = input.estimateFetchSec ?? DEFAULT_FETCH_SEC;
  const perTrack = input.estimateBytes ?? DEFAULT_BYTES;

  // Eviction first, so the budget below is measured against the ring that will actually exist. A
  // starred entry is a library entry and is never evicted; a played-through unstarred one is exactly
  // what the ring is for, so it goes the moment it is behind the playhead.
  const evict: string[] = [];
  const ready: CacheEntry[] = [];
  for (const c of input.cache) {
    if (c.played && !c.starred) evict.push(c.id);
    else ready.push(c);
  }

  // Keep every starred entry, and the best `depth` unstarred ones. Anything else is past the ring
  // and goes, so the budget can be met without deleting something the person chose to keep.
  const keptStarred = ready.filter((c) => c.starred);
  const keptAhead = ready.filter((c) => !c.starred).slice(0, depth);
  const keep = [...keptAhead, ...keptStarred];
  const keepIds = new Set(keep.map((c) => c.id));
  for (const c of ready) if (!keepIds.has(c.id)) evict.push(c.id);

  const held = keep.reduce((n, c) => n + Math.max(0, c.bytes), 0);
  const kept = keep.map((c) => c.id);

  if (!input.enabled) return { fetch: [], evict, keep: kept, reason: null };

  const missing = depth - keptAhead.length;
  if (missing <= 0) {
    return { fetch: [], evict, keep: kept, reason: mention(depth, 'already ready') };
  }

  // A fetch that cannot finish before the song does is a fetch that wasted the trip. Say so, rather
  // than starting one that loses the race and leaves the hand-off as slow as having done nothing.
  if (input.remainingSec < estimate + slack) {
    return {
      fetch: [],
      evict,
      keep: kept,
      reason: `${Math.round(input.remainingSec)}s of this song left, and a fetch has been taking about ${Math.round(estimate)}s`,
    };
  }

  const known = new Set<string>([...keep.map((c) => c.id), ...(input.inFlight ?? [])]);
  const fetch: PlannedFetch[] = [];
  let projected = held;
  let full = false;

  for (const c of input.candidates) {
    if (fetch.length >= missing) break;
    if (typeof c.url !== 'string' || !c.url) continue;
    if (known.has(c.id)) continue;
    if (projected + perTrack > input.byteBudget) {
      full = true;
      continue;
    }
    known.add(c.id);
    projected += perTrack;
    fetch.push({
      id: c.id,
      url: c.url,
      title: c.title,
      artist: c.artist,
      platform: c.platform,
      why: 'Next in the radio, fetched while this song plays',
    });
  }

  if (fetch.length === 0) {
    return {
      fetch: [],
      evict,
      keep: kept,
      reason: full
        ? 'The look-ahead ring is full — star something to keep it, or let the ring turn over'
        : 'Every suggestion is already ready or on its way',
    };
  }

  return { fetch, evict, keep: kept, reason: null };
}

function mention(n: number, tail: string): string {
  return n === 1 ? `1 track is ${tail}` : `${n} tracks are ${tail}`;
}

/**
 * The entry to play next, if the ring is holding it — the whole point of the look-ahead.
 *
 * Returns the oldest cached, unplayed entry that is actually on disk. A row still being written is
 * deliberately not returned: playing a half-written file is worse than a short wait, and the surface
 * says which it is rather than stalling silently.
 */
export function cachedNext(cache: readonly CacheEntry[]): CacheEntry | null {
  let best: CacheEntry | null = null;
  for (const c of cache) {
    if (c.played || c.bytes <= 0) continue;
    if (best === null || c.at < best.at) best = c;
  }
  return best;
}

/** What the surface says about the ring, in words, so it is never a mystery where a track went. */
export function describeCache(cache: readonly CacheEntry[]): string {
  const ready = cache.filter((c) => c.bytes > 0);
  const starred = cache.filter((c) => c.starred).length;
  if (ready.length === 0) return 'Nothing fetched ahead yet.';
  const held = ready.length === 1 ? '1 track ready' : `${ready.length} tracks ready`;
  return starred > 0 ? `${held}, ${starred} kept in your library.` : `${held} ahead of this song.`;
}

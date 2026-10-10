/**
 * Discover's look-ahead (NP-DISC-007): the next online picks' 30-second previews, asked for ahead of
 * time, so choosing one starts at once — within a stated budget, one request at a time, and only
 * while the page is idle.
 *
 * Why previews and not the songs. An online pick is not on this device; playing it plays its preview
 * (labelled "Preview") while the hub or the companion fetches the whole song, and only once the person
 * has said why they may have that file (the fetch sheet's rights basis, asked per song). Fetching
 * whole songs ahead of a choice would need that statement for songs nobody has chosen yet, so it is
 * not done. A preview is what the platform itself offers anyone; asking for it early costs bandwidth
 * and nothing else, so that is what the ring holds — in memory, as a `blob:` URL, gone with the page.
 *
 * The budget: at most `depth` clips ahead (2), at most `byteBudget` bytes held (4 MB), measured from
 * what actually arrived; nothing at all when look-ahead is off (the person switched the catalog off,
 * the browser asked to save data, or the device is offline). This module decides; it never performs
 * IO — fetching, keeping and revoking belong to the caller — which is what makes every rule below
 * testable without a network or a browser.
 */
/** The least a row needs to be worth warming. */
export interface Candidate {
  /** The pick's id, as `toRankSong` keys it. */
  id: string;
  /** Its preview's address; null when no platform offers one. */
  url: string | null;
  title: string;
  artist: string;
  platform: string | null;
}

/** One preview held in the ring. */
export interface CacheEntry {
  id: string;
  /** The preview's own address (what was fetched). */
  url: string;
  /** Bytes held, measured once it arrived. */
  bytes: number;
  /** When it arrived, for the order of "next". */
  at: number;
  /** Played: no reason to keep it. */
  played: boolean;
}

export interface LookAheadInput {
  /** False when the catalog set is off, data saving is asked for, or the device is offline. */
  enabled: boolean;
  /** Ranked candidates, best first. */
  candidates: readonly Candidate[];
  /** What the ring already holds. */
  cache: readonly CacheEntry[];
  /** Rows a request is already running for, so one is never started twice. */
  inFlight?: readonly string[];
  /** How many clips ahead the ring keeps. */
  depth?: number;
  /** How many bytes the ring may hold in total. */
  byteBudget?: number;
  /** What one clip is expected to weigh, until one has been measured. */
  estimateBytes?: number;
}

export interface PlannedFetch {
  id: string;
  url: string;
  title: string;
  artist: string;
}

export interface LookAheadPlan {
  fetch: PlannedFetch[];
  /** Entries to let go: played, or no longer among the candidates ahead. */
  evict: string[];
  /** Entries to keep, in the order they will be wanted. */
  keep: string[];
  /** Why nothing is planned, when nothing is — said rather than left as a silence. */
  reason: string | null;
}

export const LOOKAHEAD_DEPTH = 2;
export const LOOKAHEAD_BYTES = 4 * 1024 * 1024;
/** A 30-second clip at 256 kb/s, the heaviest the stores serve. */
export const LOOKAHEAD_CLIP_BYTES = 1024 * 1024;

/**
 * What to fetch now, what to let go, and what to keep.
 *
 * One request at a time: nothing new is planned while one is running. Nothing is planned when
 * look-ahead is off, when the ring already holds `depth` clips ahead, when the next clip would pass
 * the budget, or when no candidate ahead has a preview — and each of those says which it is.
 */
export function planLookAhead(input: LookAheadInput): LookAheadPlan {
  const depth = input.depth ?? LOOKAHEAD_DEPTH;
  const budget = input.byteBudget ?? LOOKAHEAD_BYTES;
  const perClip = input.estimateBytes ?? LOOKAHEAD_CLIP_BYTES;
  const ahead = input.candidates.filter((c) => typeof c.url === 'string' && c.url).slice(0, depth);
  const wanted = new Set(ahead.map((c) => c.id));

  // Letting go first, so the budget below is measured against the ring that will actually exist: a
  // played clip has done its work, and one that is no longer among the next `depth` is not ahead.
  const evict: string[] = [];
  const keep: CacheEntry[] = [];
  for (const c of input.cache) {
    if (c.played || !wanted.has(c.id)) evict.push(c.id);
    else keep.push(c);
  }
  const order = new Map(ahead.map((c, i) => [c.id, i]));
  keep.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const kept = keep.map((c) => c.id);
  const held = keep.reduce((n, c) => n + Math.max(0, c.bytes), 0);

  if (!input.enabled) return { fetch: [], evict: input.cache.map((c) => c.id), keep: [], reason: null };
  if (!ahead.length) {
    return { fetch: [], evict, keep: kept, reason: input.candidates.length ? 'None of the next picks has a preview to ask for' : null };
  }
  if ((input.inFlight ?? []).length) return { fetch: [], evict, keep: kept, reason: 'A preview is already on its way' };

  const next = ahead.find((c) => !kept.includes(c.id));
  if (!next) return { fetch: [], evict, keep: kept, reason: mention(kept.length, 'ready ahead') };
  if (held + perClip > budget) {
    return { fetch: [], evict, keep: kept, reason: `The look-ahead holds ${mb(held)} of the ${mb(budget)} it may use` };
  }
  return {
    fetch: [{ id: next.id, url: next.url!, title: next.title, artist: next.artist }],
    evict,
    keep: kept,
    reason: null,
  };
}

function mention(n: number, tail: string): string {
  return n === 1 ? `1 preview is ${tail}` : `${n} previews are ${tail}`;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The clip held for this pick, if the ring has it and it actually arrived; null otherwise, so the
 * caller streams the preview from its platform instead.
 */
export function cachedFor(cache: readonly CacheEntry[], id: string): CacheEntry | null {
  return cache.find((c) => c.id === id && !c.played && c.bytes > 0) ?? null;
}

/** What the ring is holding, in words, so it is never a mystery where the bandwidth went. */
export function describeCache(cache: readonly CacheEntry[], budget = LOOKAHEAD_BYTES): string {
  const ready = cache.filter((c) => c.bytes > 0 && !c.played);
  if (ready.length === 0) return 'No previews asked for ahead yet.';
  const held = ready.reduce((n, c) => n + c.bytes, 0);
  return `${mention(ready.length, 'ready ahead')} (${mb(held)} of ${mb(budget)}).`;
}

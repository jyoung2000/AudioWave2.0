import { DEFAULT_RECOMMENDATION_CONFIG, RECOMMENDATION_TIERS, type RecommendationConfig, type RecommendationTier, type TierShares } from './config.js';
import type { ScoredCandidate } from './ranking.js';

export interface DiversifyOptions {
  limit: number;
  /** Tier shares override (must sum to 1); defaults to the config's diversity tiers. */
  tiers?: TierShares;
  maxPerArtist?: number;
  maxGenreShare?: number;
  /** Effective exploration share: raises the experimental tier at the expense of the strong tier. */
  explorationRate?: number;
}

export interface TierStats {
  target: number;
  filled: number;
  available: number;
}

export interface DiversifyResult {
  items: ScoredCandidate[];
  tiers: Record<RecommendationTier, TierStats>;
  artistCapDrops: number;
  genreCapDrops: number;
}

/** Largest-remainder apportionment so that tier targets sum exactly to `limit`. */
export function tierTargets(shares: TierShares, limit: number): Record<RecommendationTier, number> {
  const total = RECOMMENDATION_TIERS.reduce((s, t) => s + shares[t], 0) || 1;
  const raw = RECOMMENDATION_TIERS.map((t) => (shares[t] / total) * limit);
  const floors = raw.map((v) => Math.floor(v));
  let remaining = limit - floors.reduce((a, b) => a + b, 0);
  const order = RECOMMENDATION_TIERS.map((t, i) => ({ t, i, frac: raw[i]! - floors[i]! })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    floors[i] = floors[i]! + 1;
    remaining -= 1;
  }
  return { strong: floors[0]!, related: floors[1]!, emerging: floors[2]!, experimental: floors[3]! };
}

export function applyExploration(shares: TierShares, explorationRate: number | undefined): TierShares {
  if (explorationRate === undefined) return shares;
  const experimental = Math.min(1, Math.max(shares.experimental, explorationRate));
  const delta = experimental - shares.experimental;
  const strong = Math.max(0, shares.strong - delta);
  const spill = delta - (shares.strong - strong);
  const related = Math.max(0, shares.related - spill);
  return { strong, related, emerging: Math.max(0, 1 - strong - related - experimental), experimental };
}

function ordered(items: readonly ScoredCandidate[]): ScoredCandidate[] {
  return [...items].sort((a, b) => b.score - a.score || (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0));
}

/**
 * Enforce the artist cap, the genre share cap and the familiarity tier mix.
 * Under-supplied tiers fall back to the best remaining candidates of any tier. Deterministic: ties break by track id.
 */
export function diversify(scored: readonly ScoredCandidate[], config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG, options: DiversifyOptions): DiversifyResult {
  const limit = Math.max(0, Math.floor(options.limit));
  const d = config.diversity;
  const maxPerArtist = options.maxPerArtist ?? (limit > d.largeListThreshold ? d.maxPerArtistLargeList : d.maxPerArtist);
  const maxPerGenre = Math.max(1, Math.floor(limit * (options.maxGenreShare ?? d.maxGenreShare)));
  const shares = applyExploration(options.tiers ?? d.tiers, options.explorationRate);
  const targets = tierTargets(shares, limit);
  const sorted = ordered(scored);
  const byTier: Record<RecommendationTier, ScoredCandidate[]> = { strong: [], related: [], emerging: [], experimental: [] };
  for (const c of sorted) byTier[c.tier].push(c);
  const artistCount = new Map<string, number>();
  const genreCount = new Map<string, number>();
  const picked = new Set<string>();
  const items: ScoredCandidate[] = [];
  const tiers: Record<RecommendationTier, TierStats> = { strong: { target: targets.strong, filled: 0, available: byTier.strong.length }, related: { target: targets.related, filled: 0, available: byTier.related.length }, emerging: { target: targets.emerging, filled: 0, available: byTier.emerging.length }, experimental: { target: targets.experimental, filled: 0, available: byTier.experimental.length } };
  let artistCapDrops = 0;
  let genreCapDrops = 0;
  const accept = (c: ScoredCandidate): boolean => {
    if (picked.has(c.trackId) || items.length >= limit) return false;
    const artistKey = c.artistKey || `track:${c.trackId}`;
    if ((artistCount.get(artistKey) ?? 0) >= maxPerArtist) {
      artistCapDrops += 1;
      return false;
    }
    if (c.primaryGenre !== null && (genreCount.get(c.primaryGenre) ?? 0) >= maxPerGenre) {
      genreCapDrops += 1;
      return false;
    }
    picked.add(c.trackId);
    items.push(c);
    artistCount.set(artistKey, (artistCount.get(artistKey) ?? 0) + 1);
    if (c.primaryGenre !== null) genreCount.set(c.primaryGenre, (genreCount.get(c.primaryGenre) ?? 0) + 1);
    tiers[c.tier].filled += 1;
    return true;
  };
  for (const tier of RECOMMENDATION_TIERS) {
    let filled = 0;
    for (const c of byTier[tier]) {
      if (filled >= targets[tier]) break;
      if (accept(c)) filled += 1;
    }
  }
  if (items.length < limit) for (const c of sorted) if (items.length < limit && !picked.has(c.trackId)) accept(c);
  return { items: ordered(items), tiers, artistCapDrops, genreCapDrops };
}

import type { RecommendationMode } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';

/** Familiarity tiers: 40 % strong favourites / 30 % related / 20 % emerging / 10 % experimental by default. */
export type RecommendationTier = 'strong' | 'related' | 'emerging' | 'experimental';
export const RECOMMENDATION_TIERS: readonly RecommendationTier[] = ['strong', 'related', 'emerging', 'experimental'];
export const RECOMMENDATION_MODES: readonly RecommendationMode[] = ['for-you', 'playlist', 'genre', 'similar', 'deep', 'new-releases', 'recent'];

/** Behaviour-learning weights. Negative values must stay negative, positive values positive. */
export interface ActionWeights {
  /** Skip before 10 % of the track or 10 s, whichever comes first. */
  immediateSkip: number;
  /** Skip before 30 %. */
  earlySkip: number;
  /** Stopped between 30 % and 50 %. */
  partial: number;
  /** Heard more than half of the track. */
  majority: number;
  completed: number;
  replay: number;
  like: number;
  unlike: number;
  playlistAdd: number;
  playlistRemove: number;
  favorite: number;
  dislike: number;
  save: number;
  download: number;
  recommendationAccepted: number;
  recommendationDismissed: number;
}

export interface SkipThresholds {
  immediateFraction: number;
  immediateSeconds: number;
  earlyFraction: number;
  partialFraction: number;
}

/** One skip only lowers the track. Artists and genres move after repeated evidence on distinct tracks. */
export interface SkipIntelligenceConfig {
  artistDistinctTracks: number;
  genreDistinctTracks: number;
  windowDays: number;
  /** Fraction of the skip weight that reaches the artist once the threshold is met. */
  artistShare: number;
  /** Fraction of the skip weight that reaches each genre once the threshold is met. */
  genreShare: number;
}

export interface DecayConfig {
  halfLifeDays: number;
  /** Entries whose absolute weight decays below this (and are older than four half-lives) are pruned. */
  pruneBelow: number;
}

export interface PenaltyConfig {
  /** Penalty for a track heard within `repeatWindowDays` (from the profile's recent plays). */
  repeat: number;
  repeatWindowDays: number;
  /** Tracks listed in `context.recentlyPlayedIds` are removed entirely when true, penalised otherwise. */
  excludeRecentlyPlayed: boolean;
  /** Penalty per previous skip of the track, capped at `skipMax`. */
  skip: number;
  skipMax: number;
  /** Penalty per previous recommendation impression, capped at `overexposureMax`. */
  overexposure: number;
  overexposureMax: number;
}

export interface TierShares {
  strong: number;
  related: number;
  emerging: number;
  experimental: number;
}

export interface DiversityConfig {
  maxPerArtist: number;
  maxPerArtistLargeList: number;
  largeListThreshold: number;
  maxGenreShare: number;
  tiers: TierShares;
  /** Normalised artist affinity at or above which a candidate counts as a familiar favourite. */
  strongArtistAffinity: number;
  /** Normalised genre affinity at or above which a genre counts as "known" for the emerging tier. */
  knownGenreAffinity: number;
}

export interface RankingWeights {
  tasteMatch: number;
  artistAffinity: number;
  genreAffinity: number;
  collaborative: number;
  recency: number;
  popularityFit: number;
  moodContext: number;
  discoveryBonus: number;
}

export interface ColdStartConfig {
  minEvents: number;
  minMeaningfulListens: number;
  minArtists: number;
}

export interface LimitsConfig {
  maxTracks: number;
  maxArtists: number;
  maxAlbums: number;
  maxGenres: number;
  maxTags: number;
  maxPlaylistContexts: number;
  maxMoodContexts: number;
  maxSessionContexts: number;
  appliedEventIds: number;
  recentPlays: number;
  artistHistory: number;
  skipRecords: number;
}

export interface CandidateConfig {
  perSource: number;
  topArtists: number;
  topGenres: number;
  topTags: number;
  topTracks: number;
  recentDays: number;
  newReleaseYears: number;
  similarityThreshold: number;
  relatedArtistMin: number;
  relatedPerArtist: number;
}

export interface ModeConfig {
  multipliers: Partial<RankingWeights>;
  tiers: TierShares | null;
  popularityInverted: boolean;
  excludeOwned: boolean;
  excludeKnownArtists: boolean;
  excludeTopArtists: boolean;
}

export interface RecommendationConfig {
  version: 1;
  actionWeights: ActionWeights;
  skipThresholds: SkipThresholds;
  skipIntelligence: SkipIntelligenceConfig;
  decay: DecayConfig;
  penalties: PenaltyConfig;
  diversity: DiversityConfig;
  ranking: RankingWeights;
  /** Baseline share of exploration picks; scaled by the profile's discovery appetite. */
  explorationRate: number;
  coldStart: ColdStartConfig;
  limits: LimitsConfig;
  candidates: CandidateConfig;
  modes: Record<RecommendationMode, ModeConfig>;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const defaultMode = (partial: Partial<ModeConfig> = {}): ModeConfig => ({
  multipliers: {},
  tiers: null,
  popularityInverted: false,
  excludeOwned: false,
  excludeKnownArtists: false,
  excludeTopArtists: false,
  ...partial,
});

export const DEFAULT_RECOMMENDATION_CONFIG: RecommendationConfig = Object.freeze<RecommendationConfig>({
  version: 1,
  actionWeights: {
    immediateSkip: -5,
    earlySkip: -3,
    partial: 0.5,
    majority: 2,
    completed: 3,
    replay: 4,
    like: 6,
    unlike: -4,
    playlistAdd: 7,
    playlistRemove: -3,
    favorite: 10,
    dislike: -6,
    save: 5,
    download: 2,
    recommendationAccepted: 1,
    recommendationDismissed: -1,
  },
  skipThresholds: { immediateFraction: 0.1, immediateSeconds: 10, earlyFraction: 0.3, partialFraction: 0.5 },
  skipIntelligence: { artistDistinctTracks: 3, genreDistinctTracks: 3, windowDays: 30, artistShare: 0.5, genreShare: 0.25 },
  decay: { halfLifeDays: 45, pruneBelow: 0.01 },
  penalties: { repeat: 0.35, repeatWindowDays: 7, excludeRecentlyPlayed: true, skip: 0.15, skipMax: 0.45, overexposure: 0.1, overexposureMax: 0.4 },
  diversity: {
    maxPerArtist: 2,
    maxPerArtistLargeList: 3,
    largeListThreshold: 40,
    maxGenreShare: 0.4,
    tiers: { strong: 0.4, related: 0.3, emerging: 0.2, experimental: 0.1 },
    strongArtistAffinity: 0.35,
    knownGenreAffinity: 0.2,
  },
  ranking: { tasteMatch: 0.3, artistAffinity: 0.2, genreAffinity: 0.15, collaborative: 0.1, recency: 0.1, popularityFit: 0.05, moodContext: 0.05, discoveryBonus: 0.05 },
  explorationRate: 0.1,
  coldStart: { minEvents: 20, minMeaningfulListens: 10, minArtists: 3 },
  limits: {
    maxTracks: 5000,
    maxArtists: 2000,
    maxAlbums: 2000,
    maxGenres: 300,
    maxTags: 500,
    maxPlaylistContexts: 64,
    maxMoodContexts: 32,
    maxSessionContexts: 20,
    appliedEventIds: 4096,
    recentPlays: 400,
    artistHistory: 30,
    skipRecords: 64,
  },
  candidates: { perSource: 60, topArtists: 10, topGenres: 6, topTags: 8, topTracks: 20, recentDays: 14, newReleaseYears: 1, similarityThreshold: 0.45, relatedArtistMin: 0.45, relatedPerArtist: 6 },
  modes: {
    'for-you': defaultMode(),
    playlist: defaultMode({ multipliers: { moodContext: 3 }, tiers: { strong: 0.3, related: 0.4, emerging: 0.2, experimental: 0.1 } }),
    genre: defaultMode(),
    similar: defaultMode({ multipliers: { tasteMatch: 2 }, tiers: { strong: 0.3, related: 0.4, emerging: 0.2, experimental: 0.1 } }),
    deep: defaultMode({ multipliers: { discoveryBonus: 3 }, popularityInverted: true, excludeOwned: true, excludeKnownArtists: true, excludeTopArtists: true, tiers: { strong: 0, related: 0.1, emerging: 0.45, experimental: 0.45 } }),
    'new-releases': defaultMode({ multipliers: { recency: 3 }, excludeOwned: true, tiers: { strong: 0.5, related: 0.3, emerging: 0.15, experimental: 0.05 } }),
    recent: defaultMode({ multipliers: { recency: 3 } }),
  },
});

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeInto(base: Json, patch: Json, path: string): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(base)) out[key] = isPlainObject(value) ? mergeInto(value, {}, `${path}${key}.`) : value;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!(key in base)) throw new DomainError('validation', `Unknown recommendation config key "${path}${key}"`, { details: { key: `${path}${key}` } });
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) out[key] = mergeInto(current, value, `${path}${key}.`);
    else if (isPlainObject(current) && value !== null) throw new DomainError('validation', `Expected an object at "${path}${key}"`, { details: { key: `${path}${key}` } });
    else out[key] = value;
  }
  return out;
}

function expectNumber(value: unknown, key: string, options: { min?: number; max?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DomainError('validation', `"${key}" must be a finite number`, { details: { key } });
  if (options.min !== undefined && value < options.min) throw new DomainError('validation', `"${key}" must be >= ${options.min}`, { details: { key, value } });
  if (options.max !== undefined && value > options.max) throw new DomainError('validation', `"${key}" must be <= ${options.max}`, { details: { key, value } });
  return value;
}

const NEGATIVE_ACTIONS: ReadonlyArray<keyof ActionWeights> = ['immediateSkip', 'earlySkip', 'unlike', 'playlistRemove', 'dislike', 'recommendationDismissed'];

/** Throws a DomainError('validation') describing the first invalid value. */
export function validateConfig(config: RecommendationConfig): void {
  for (const [key, value] of Object.entries(config.actionWeights)) {
    const n = expectNumber(value, `actionWeights.${key}`);
    const negative = NEGATIVE_ACTIONS.includes(key as keyof ActionWeights);
    if (negative && n > 0) throw new DomainError('validation', `"actionWeights.${key}" must be <= 0`, { details: { key, value: n } });
    if (!negative && n < 0) throw new DomainError('validation', `"actionWeights.${key}" must be >= 0`, { details: { key, value: n } });
  }
  const st = config.skipThresholds;
  expectNumber(st.immediateFraction, 'skipThresholds.immediateFraction', { min: 0, max: 1 });
  expectNumber(st.immediateSeconds, 'skipThresholds.immediateSeconds', { min: 0 });
  expectNumber(st.earlyFraction, 'skipThresholds.earlyFraction', { min: 0, max: 1 });
  expectNumber(st.partialFraction, 'skipThresholds.partialFraction', { min: 0, max: 1 });
  if (!(st.immediateFraction <= st.earlyFraction && st.earlyFraction <= st.partialFraction)) throw new DomainError('validation', 'skipThresholds must be ordered immediate <= early <= partial');
  const si = config.skipIntelligence;
  expectNumber(si.artistDistinctTracks, 'skipIntelligence.artistDistinctTracks', { min: 1 });
  expectNumber(si.genreDistinctTracks, 'skipIntelligence.genreDistinctTracks', { min: 1 });
  expectNumber(si.windowDays, 'skipIntelligence.windowDays', { min: 1 });
  expectNumber(si.artistShare, 'skipIntelligence.artistShare', { min: 0, max: 1 });
  expectNumber(si.genreShare, 'skipIntelligence.genreShare', { min: 0, max: 1 });
  expectNumber(config.decay.halfLifeDays, 'decay.halfLifeDays', { min: 0.01 });
  expectNumber(config.decay.pruneBelow, 'decay.pruneBelow', { min: 0 });
  for (const [key, value] of Object.entries(config.penalties)) if (key !== 'excludeRecentlyPlayed') expectNumber(value, `penalties.${key}`, { min: 0 });
  if (typeof config.penalties.excludeRecentlyPlayed !== 'boolean') throw new DomainError('validation', '"penalties.excludeRecentlyPlayed" must be a boolean');
  const d = config.diversity;
  expectNumber(d.maxPerArtist, 'diversity.maxPerArtist', { min: 1 });
  expectNumber(d.maxPerArtistLargeList, 'diversity.maxPerArtistLargeList', { min: 1 });
  expectNumber(d.largeListThreshold, 'diversity.largeListThreshold', { min: 1 });
  expectNumber(d.maxGenreShare, 'diversity.maxGenreShare', { min: 0.01, max: 1 });
  expectNumber(d.strongArtistAffinity, 'diversity.strongArtistAffinity', { min: 0, max: 1 });
  expectNumber(d.knownGenreAffinity, 'diversity.knownGenreAffinity', { min: 0, max: 1 });
  validateTiers(d.tiers, 'diversity.tiers');
  let rankingTotal = 0;
  for (const [key, value] of Object.entries(config.ranking)) rankingTotal += expectNumber(value, `ranking.${key}`, { min: 0 });
  if (rankingTotal <= 0) throw new DomainError('validation', 'ranking weights must not all be zero');
  expectNumber(config.explorationRate, 'explorationRate', { min: 0, max: 1 });
  for (const [key, value] of Object.entries(config.coldStart)) expectNumber(value, `coldStart.${key}`, { min: 0 });
  for (const [key, value] of Object.entries(config.limits)) expectNumber(value, `limits.${key}`, { min: 1 });
  for (const [key, value] of Object.entries(config.candidates)) expectNumber(value, `candidates.${key}`, { min: 0 });
  expectNumber(config.candidates.similarityThreshold, 'candidates.similarityThreshold', { min: 0, max: 1 });
  for (const mode of RECOMMENDATION_MODES) {
    const m = config.modes[mode];
    if (!isPlainObject(m)) throw new DomainError('validation', `modes.${mode} is missing`);
    for (const [key, value] of Object.entries(m.multipliers)) expectNumber(value, `modes.${mode}.multipliers.${key}`, { min: 0 });
    if (m.tiers !== null) validateTiers(m.tiers, `modes.${mode}.tiers`);
  }
}

function validateTiers(tiers: TierShares, key: string): void {
  let total = 0;
  for (const tier of RECOMMENDATION_TIERS) total += expectNumber(tiers[tier], `${key}.${tier}`, { min: 0, max: 1 });
  if (Math.abs(total - 1) > 0.001) throw new DomainError('validation', `"${key}" shares must sum to 1 (got ${total.toFixed(3)})`, { details: { key, total } });
}

/**
 * Deep-merge a partial configuration over the defaults (or an explicit base) and validate the result.
 * Unknown keys and invalid values throw DomainError('validation') so admin edits fail loudly.
 */
export function mergeConfig(partial: DeepPartial<RecommendationConfig> = {}, base: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG): RecommendationConfig {
  if (!isPlainObject(partial)) throw new DomainError('validation', 'Recommendation config patch must be an object');
  const merged = mergeInto(base as unknown as Json, partial as Json, '') as unknown as RecommendationConfig;
  if (merged.version !== 1) throw new DomainError('validation', `Unsupported recommendation config version ${String(merged.version)}`);
  validateConfig(merged);
  return merged;
}

/** Resolve a caller-supplied config (full, partial or absent) to a validated config without re-validating known-good defaults. */
export function resolveConfig(config: RecommendationConfig | DeepPartial<RecommendationConfig> | undefined): RecommendationConfig {
  if (config === undefined || config === DEFAULT_RECOMMENDATION_CONFIG) return DEFAULT_RECOMMENDATION_CONFIG;
  return mergeConfig(config);
}

export function effectiveWeights(config: RecommendationConfig, mode: RecommendationMode): RankingWeights {
  const mult = config.modes[mode].multipliers;
  const base = config.ranking;
  return {
    tasteMatch: base.tasteMatch * (mult.tasteMatch ?? 1),
    artistAffinity: base.artistAffinity * (mult.artistAffinity ?? 1),
    genreAffinity: base.genreAffinity * (mult.genreAffinity ?? 1),
    collaborative: base.collaborative * (mult.collaborative ?? 1),
    recency: base.recency * (mult.recency ?? 1),
    popularityFit: base.popularityFit * (mult.popularityFit ?? 1),
    moodContext: base.moodContext * (mult.moodContext ?? 1),
    discoveryBonus: base.discoveryBonus * (mult.discoveryBonus ?? 1),
  };
}

export function tierSharesFor(config: RecommendationConfig, mode: RecommendationMode): TierShares {
  return config.modes[mode].tiers ?? config.diversity.tiers;
}

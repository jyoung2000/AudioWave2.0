/**
 * The entry point: seeds → candidates from every source → ranking → diversity → `Recommendation[]`.
 *
 * Deterministic for a given (profile, catalogue, context, seed): every source is ordered, ties
 * break on track id, and the only randomness is a seeded PRNG used by exploration. No network, no
 * model, no GPU — the whole thing runs in the player offline and on the hub for shared profiles.
 */
import type { ArtistRelation, CanonicalArtist, CanonicalTrack, DiscoveryCacheEntry, ProviderId, Recommendation, RecommendationMode, TrackPlatform } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import {
  contextSimilarCandidates,
  discoveryCacheCandidates,
  exploration,
  generateSeeds,
  genreNeighbourCandidates,
  libraryGapCandidates,
  mergeCandidates,
  newReleaseCandidates,
  recentlyLikedSimilarCandidates,
  relatedArtistCandidates,
  toCatalogue,
  topArtistCandidates,
  trackFeatures,
  type Candidate,
  type CandidateSourceKind,
  type Catalogue,
} from './candidates.js';
import { collaborativeCandidates, type Cooccurrence } from './collaborative.js';
import { DEFAULT_RECOMMENDATION_CONFIG, type RecommendationConfig } from './config.js';
import { diversify, type DiversifyResult } from './diversity.js';
import { discoveryAppetite, isColdStart, type TasteProfile } from './profile.js';
import { rankCandidates, reasonsFor, type RankingContext, type ScoredCandidate } from './ranking.js';
import { artistKeyOf } from './similarity.js';

export interface RecommendContext {
  /** Playlist being extended (mode `playlist`), by track ids present in it. */
  playlistTrackIds?: readonly string[];
  playlistId?: string | null;
  playlistName?: string | null;
  /** Seed track for mode `similar`. */
  seedTrackId?: string | null;
  /** Extra seed ids (artists or tracks) supplied by the caller. */
  seedIds?: readonly string[];
  /** Genre filter for mode `genre`. */
  genre?: string | null;
  mood?: string | null;
  activity?: string | null;
  timeOfDay?: string | null;
  /** Queue history: penalised, or excluded outright when `penalties.excludeRecentlyPlayed`. */
  recentlyPlayedIds?: Iterable<string>;
  /** Impressions per track id from earlier rounds, for the overexposure penalty. */
  recentlyRecommended?: Readonly<Record<string, number>>;
  /** Tracks the user already has; `deep` and `new-releases` exclude them. */
  ownedTrackIds?: Iterable<string>;
}

export interface RecommendInput {
  userId: string;
  profile: TasteProfile;
  /** Canonical tracks to choose from, or a prebuilt `Catalogue` (cheaper across repeated calls). */
  catalogue: readonly CanonicalTrack[] | Catalogue;
  artists?: readonly CanonicalArtist[];
  relations?: readonly ArtistRelation[];
  /** Provider availability per canonical track; results carry only what is actually playable. */
  platforms?: readonly TrackPlatform[];
  mode?: RecommendationMode;
  context?: RecommendContext;
  limit?: number;
  /** Seeds the exploration PRNG. Same seed, same output. */
  seed?: number;
  config?: RecommendationConfig;
  cooccurrence?: Cooccurrence | null;
  /** Results cached from provider discovery searches (hub side). */
  discoveryCache?: readonly (DiscoveryCacheEntry | CanonicalTrack)[];
  now?: number;
}

export interface RecommendDiagnostics {
  mode: RecommendationMode;
  candidateCount: number;
  /** How many candidates each source contributed (before ranking). */
  sources: Record<string, number>;
  coldStart: boolean;
  tiersFilled: DiversifyResult['tiers'];
  artistCapDrops: number;
  genreCapDrops: number;
  explorationRate: number;
  contextLabel: string | null;
  elapsedMs: number;
  /** Set when the catalogue could not fill the requested limit, so the caller can say why. */
  shortfallReason: string | null;
}

export interface RecommendResult {
  recommendations: Recommendation[];
  scored: ScoredCandidate[];
  diagnostics: RecommendDiagnostics;
}

function toSet(values: Iterable<string> | undefined): Set<string> {
  return new Set(values ?? []);
}

function platformIndex(platforms: readonly TrackPlatform[] | undefined): Map<string, TrackPlatform[]> {
  const out = new Map<string, TrackPlatform[]>();
  for (const p of platforms ?? []) {
    const list = out.get(p.trackId);
    if (list) list.push(p);
    else out.set(p.trackId, [p]);
  }
  return out;
}

function availabilityOf(trackId: string, index: Map<string, TrackPlatform[]>): Recommendation['availability'] {
  const list = index.get(trackId) ?? [];
  return list
    .slice()
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.providerTrackId.localeCompare(b.providerTrackId))
    .map((p) => ({
      provider: p.provider as ProviderId,
      providerTrackId: p.providerTrackId,
      ...(p.url ? { url: p.url } : {}),
      playable: p.availability === 'available',
    }));
}

/** Which candidate sources a mode is allowed to draw from. Keeping this explicit makes modes honest. */
export function sourcesForMode(mode: RecommendationMode): readonly CandidateSourceKind[] {
  switch (mode) {
    case 'playlist':
      return ['playlist-context', 'related-artist', 'genre-neighbour', 'collaborative', 'top-artist', 'exploration'];
    case 'genre':
      return ['genre-neighbour', 'related-artist', 'discovery-cache', 'exploration'];
    case 'similar':
      return ['playlist-context', 'related-artist', 'collaborative', 'genre-neighbour'];
    case 'deep':
      return ['related-artist', 'genre-neighbour', 'discovery-cache', 'exploration'];
    case 'new-releases':
      return ['new-release'];
    case 'recent':
      return ['recently-liked-similar', 'related-artist', 'collaborative', 'genre-neighbour'];
    default:
      return ['top-artist', 'related-artist', 'genre-neighbour', 'collaborative', 'recently-liked-similar', 'new-release', 'discovery-cache', 'library-gap', 'exploration'];
  }
}

function contextKeysFor(mode: RecommendationMode, ctx: RecommendContext, now: number): string[] {
  const keys: string[] = [];
  if (ctx.playlistId) keys.push(`playlist:${ctx.playlistId}`);
  if (ctx.mood) keys.push(`mood:${ctx.mood.toLowerCase()}`);
  if (ctx.activity) keys.push(`activity:${ctx.activity.toLowerCase()}`);
  const hour = ctx.timeOfDay ? null : new Date(now).getHours();
  const slot = ctx.timeOfDay ?? (hour === null ? null : hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening');
  if (slot) keys.push(`time:${slot}`);
  void mode;
  return keys;
}

/**
 * Cold start: no meaningful history yet, so lean on the explicit seeds the user gave plus
 * popularity and genre spread, and say so in the diagnostics rather than pretending to personalise.
 */
function coldStartCandidates(catalogue: Catalogue, profile: TasteProfile, config: RecommendationConfig, seed: number, limit: number): Candidate[] {
  const seeded = new Set<string>([...(profile.seeds?.artists ?? []).map((a) => artistKeyOf(a)), ...Object.keys(profile.dims.artists)]);
  const genres = new Set<string>((profile.seeds?.genres ?? []).map((g) => g.toLowerCase()));
  const scored = catalogue.tracks.map((track) => {
    const features = catalogue.features.get(track.id) ?? trackFeatures(track);
    const artistMatch = seeded.has(features.artist) ? 1 : 0;
    const genreMatch = features.genres.some((g) => genres.has(g)) ? 1 : 0;
    return { track, features, weight: artistMatch * 2 + genreMatch + (track.popularity ?? 0.3) };
  });
  scored.sort((a, b) => b.weight - a.weight || (a.track.id < b.track.id ? -1 : 1));
  const perArtist = new Map<string, number>();
  const out: Candidate[] = [];
  for (const entry of scored) {
    const used = perArtist.get(entry.features.artist) ?? 0;
    if (used >= 2) continue;
    perArtist.set(entry.features.artist, used + 1);
    out.push({
      trackId: entry.track.id,
      track: entry.track,
      sources: [{ kind: 'exploration', via: null, score: Math.min(1, entry.weight / 3) }],
      reasons: ['Starting point while Now Playing learns what you like'],
    });
    if (out.length >= limit) break;
  }
  void config;
  void seed;
  return out;
}

export function recommend(input: RecommendInput): RecommendResult {
  const started = Date.now();
  const config = input.config ?? DEFAULT_RECOMMENDATION_CONFIG;
  const mode: RecommendationMode = input.mode ?? 'for-you';
  const modeConfig = config.modes[mode];
  const limit = Math.max(1, Math.min(input.limit ?? 30, 200));
  const seed = input.seed ?? 1;
  const now = input.now ?? Date.now();
  const ctx = input.context ?? {};
  const profile = input.profile;
  const catalogue = toCatalogue(input.catalogue, { ...(input.artists ? { artists: input.artists } : {}), ...(input.relations ? { relations: input.relations } : {}) });
  const coldStart = isColdStart(profile, config);
  const seeds = generateSeeds(profile, config, now);
  const owned = toSet(ctx.ownedTrackIds);
  const recentlyPlayed = toSet(ctx.recentlyPlayedIds);
  const allowed = new Set(sourcesForMode(mode));
  const platforms = platformIndex(input.platforms);

  /* ---- candidate generation ---- */
  const lists: Candidate[][] = [];
  const contextTracks: CanonicalTrack[] = [];

  if (mode === 'playlist' || mode === 'similar') {
    const ids = mode === 'similar' ? [ctx.seedTrackId, ...(ctx.seedIds ?? [])].filter((v): v is string => !!v) : [...(ctx.playlistTrackIds ?? []), ...(ctx.seedIds ?? [])];
    for (const id of ids) {
      const track = catalogue.byId.get(id);
      if (track) contextTracks.push(track);
    }
    const exclude = new Set(contextTracks.map((t) => t.id));
    lists.push(
      contextSimilarCandidates(
        contextTracks.map((t) => ({ id: t.id, title: t.title, artistName: t.artistName, genres: (catalogue.features.get(t.id) ?? trackFeatures(t)).genres, tags: (catalogue.features.get(t.id) ?? trackFeatures(t)).tags, releaseYear: t.releaseYear, popularity: t.popularity, durationMs: t.durationMs })),
        catalogue,
        config,
        { kind: 'playlist-context', via: ctx.playlistName ?? (contextTracks[0]?.title ?? null), exclude, limit: config.candidates.perSource },
      ),
    );
  }

  if (coldStart && mode !== 'new-releases') {
    lists.push(coldStartCandidates(catalogue, profile, config, seed, Math.max(limit * 3, config.candidates.perSource)));
  }

  if (allowed.has('top-artist')) lists.push(topArtistCandidates(seeds, catalogue, profile, config));
  if (allowed.has('related-artist')) lists.push(relatedArtistCandidates(seeds, catalogue, profile, config));
  if (allowed.has('genre-neighbour')) {
    const genreSeeds = ctx.genre ? { ...seeds, genres: [{ key: ctx.genre.toLowerCase(), label: ctx.genre, weight: 1 }] } : seeds;
    lists.push(genreNeighbourCandidates(genreSeeds, catalogue, config));
  }
  if (allowed.has('collaborative') && input.cooccurrence) lists.push(collaborativeCandidates(input.cooccurrence, profile, catalogue, config.candidates.perSource));
  if (allowed.has('recently-liked-similar')) lists.push(recentlyLikedSimilarCandidates(seeds, catalogue, profile, config));
  if (allowed.has('new-release')) lists.push(newReleaseCandidates(seeds, catalogue, profile, config, now));
  if (allowed.has('discovery-cache') && input.discoveryCache?.length) lists.push(discoveryCacheCandidates(input.discoveryCache, catalogue, seeds, config));
  if (allowed.has('library-gap')) lists.push(libraryGapCandidates(profile, catalogue, owned, config));
  if (allowed.has('exploration')) {
    const appetite = discoveryAppetite(profile);
    const explorationLimit = Math.max(config.candidates.perSource, Math.round(limit * (mode === 'deep' ? 3 : 1 + appetite)));
    lists.push(exploration(catalogue, profile, config, seed, { limit: explorationLimit }));
  }

  let candidates = mergeCandidates(lists);

  /* ---- mode-honest exclusions ---- */
  const contextIds = new Set(contextTracks.map((t) => t.id));
  const excludedTopArtists = new Set(modeConfig.excludeTopArtists ? seeds.artists.map((a) => a.key) : []);
  candidates = candidates.filter((c) => {
    if (contextIds.has(c.trackId)) return false;
    if (modeConfig.excludeOwned && owned.has(c.trackId)) return false;
    if (config.penalties.excludeRecentlyPlayed && recentlyPlayed.has(c.trackId)) return false;
    const features = catalogue.features.get(c.trackId) ?? trackFeatures(c.track);
    if (modeConfig.excludeTopArtists && excludedTopArtists.has(features.artist)) return false;
    if (modeConfig.excludeKnownArtists && seeds.knownArtists.has(features.artist)) return false;
    if (mode === 'genre' && ctx.genre) {
      const wanted = ctx.genre.toLowerCase();
      if (!features.genres.some((g) => g === wanted)) return false;
    }
    if (mode === 'new-releases') {
      const year = c.track.releaseYear;
      if (year === null || year < new Date(now).getFullYear() - config.candidates.newReleaseYears) return false;
    }
    return true;
  });

  const sourceCounts: Record<string, number> = {};
  for (const c of candidates) for (const s of c.sources) sourceCounts[s.kind] = (sourceCounts[s.kind] ?? 0) + 1;

  /* ---- ranking ---- */
  const rankingContext: RankingContext = {
    now,
    mode,
    catalogue,
    recentlyPlayedIds: recentlyPlayed,
    recentlyRecommended: ctx.recentlyRecommended ?? {},
    cooccurrence: input.cooccurrence ?? null,
    contextKeys: contextKeysFor(mode, ctx, now),
    contextTracks,
    contextLabel: ctx.playlistName ?? (mode === 'similar' ? (contextTracks[0]?.title ?? null) : null),
    coldStart,
  };
  const scored = rankCandidates(candidates, profile, rankingContext, config);

  /* ---- diversity ---- */
  const appetite = discoveryAppetite(profile);
  const explorationRate = Math.min(1, config.explorationRate * (0.5 + appetite));
  const result = diversify(scored, config, {
    limit,
    ...(modeConfig.tiers ? { tiers: modeConfig.tiers } : {}),
    explorationRate: mode === 'deep' ? Math.max(explorationRate, 0.45) : explorationRate,
  });

  const createdAt = new Date(now).toISOString();
  const recommendations: Recommendation[] = result.items.map((item, index) => ({
    id: uuidv7(now + index),
    mode,
    contextId: ctx.playlistId ?? ctx.seedTrackId ?? ctx.genre ?? null,
    canonicalTrackId: item.trackId,
    title: item.track.title,
    artistName: item.track.artistName,
    albumName: item.track.albumName,
    genre: item.primaryGenre,
    year: item.track.releaseYear,
    score: item.score,
    tier: item.tier,
    candidateSource: item.sources[0]?.kind ?? 'exploration',
    reasons: reasonsFor(item).map((r) => ({ signal: r.signal, weight: r.weight, text: r.text })),
    availability: availabilityOf(item.trackId, platforms),
    createdAt,
    feedback: null,
  }));

  const shortfallReason =
    recommendations.length >= limit
      ? null
      : candidates.length === 0
        ? `No candidate matched this mode in a catalogue of ${catalogue.tracks.length} tracks`
        : `Only ${recommendations.length} of ${limit} could be filled without breaking the artist and genre caps`;

  return {
    recommendations,
    scored: result.items,
    diagnostics: {
      mode,
      candidateCount: candidates.length,
      sources: sourceCounts,
      coldStart,
      tiersFilled: result.tiers,
      artistCapDrops: result.artistCapDrops,
      genreCapDrops: result.genreCapDrops,
      explorationRate,
      contextLabel: rankingContext.contextLabel,
      elapsedMs: Date.now() - started,
      shortfallReason,
    },
  };
}

import type { CanonicalTrack, RecommendationMode } from '@now-playing/contracts';
import type { Candidate, CandidateSource, Catalogue } from './candidates.js';
import { trackFeatures } from './candidates.js';
import { collaborativeScores, type Cooccurrence } from './collaborative.js';
import { DEFAULT_RECOMMENDATION_CONFIG, effectiveWeights, type RankingWeights, type RecommendationConfig, type RecommendationTier } from './config.js';
import { DAY_MS, discoveryAppetite, maxPositiveWeight, normalizedWeight, popularityPreference, recentPlays, type TasteProfile } from './profile.js';
import { clamp01, trackSimilarity } from './similarity.js';

export interface RankingContext {
  now: number;
  mode: RecommendationMode;
  catalogue: Catalogue;
  /** Explicitly recently played (queue history). Excluded upstream when configured, penalised otherwise. */
  recentlyPlayedIds: ReadonlySet<string>;
  /** Impressions per track id from earlier recommendation rounds. */
  recentlyRecommended: Readonly<Record<string, number>>;
  cooccurrence: Cooccurrence | null;
  /** Profile context keys to consult, e.g. "playlist:<id>", "mood:focus", "time:evening". */
  contextKeys: readonly string[];
  /** Tracks defining the context (playlist tracks, or the seed track of "similar"). */
  contextTracks: readonly CanonicalTrack[];
  contextLabel: string | null;
  coldStart: boolean;
}

export type ScoreBreakdown = Record<keyof RankingWeights, number>;

export interface Penalties {
  repeat: number;
  skip: number;
  overexposure: number;
}

export type Familiarity = 'known-track' | 'known-artist' | 'known-genre' | 'unknown';

/** Facts gathered while scoring so explanations need no further profile access. */
export interface Evidence {
  artistLabel: string;
  artistPlays: number;
  artistCompletionsMonth: number;
  artistLikes: number;
  artistNorm: number;
  genreLabel: string | null;
  genreNorm: number;
  relatedVia: string | null;
  collaborativeVia: string | null;
  contextLabel: string | null;
  contextSimilarity: number;
  recentArtistPlays: number;
  trackKnown: boolean;
  artistKnown: boolean;
  year: number | null;
  popularity: number | null;
  skipCount: number;
  recommendedBefore: number;
  playedRecently: boolean;
  albumLabel: string | null;
  libraryGapVia: string | null;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  base: number;
  components: ScoreBreakdown;
  weighted: ScoreBreakdown;
  penalties: Penalties;
  tier: RecommendationTier;
  familiarity: Familiarity;
  artistKey: string;
  genres: string[];
  primaryGenre: string | null;
  evidence: Evidence;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sourceOf(c: Candidate, kind: CandidateSource['kind']): CandidateSource | undefined {
  return c.sources.find((s) => s.kind === kind);
}

/** Score candidates with per-component breakdown and penalties; sorted by score desc, then track id. */
export function rankCandidates(candidates: readonly Candidate[], profile: TasteProfile, ctx: RankingContext, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG): ScoredCandidate[] {
  const weights = effectiveWeights(config, ctx.mode);
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const modeConfig = config.modes[ctx.mode];
  const dims = profile.dims;
  const max = { track: maxPositiveWeight(dims.tracks), artist: maxPositiveWeight(dims.artists), genre: maxPositiveWeight(dims.genres), tag: maxPositiveWeight(dims.tags), era: maxPositiveWeight(dims.eras), band: maxPositiveWeight(dims.popularity) };
  const appetite = discoveryAppetite(profile);
  const preferredPopularity = popularityPreference(profile);
  const collab = ctx.cooccurrence ? collaborativeScores(ctx.cooccurrence, profile) : null;
  const recent = recentPlays(profile, ctx.now, config.candidates.recentDays);
  const recentArtists = new Map<string, number>();
  const recentGenres = new Map<string, number>();
  for (const r of recent) {
    if (r.artist) recentArtists.set(r.artist, (recentArtists.get(r.artist) ?? 0) + 1);
    for (const g of r.genres) recentGenres.set(g, (recentGenres.get(g) ?? 0) + 1);
  }
  const repeatCutoff = ctx.now - config.penalties.repeatWindowDays * DAY_MS;
  const playedRecently = new Set<string>();
  for (const r of profile.recent) if (r.at >= repeatCutoff) playedRecently.add(r.trackId);
  const monthAgo = ctx.now - 30 * DAY_MS;
  const nowYear = new Date(ctx.now).getUTCFullYear();
  const contexts = ctx.contextKeys.map((key) => profile.contexts[key]).filter((c): c is NonNullable<typeof c> => c !== undefined);
  const contextMax = contexts.map((c) => ({ artist: maxPositiveWeight(c.artists), genre: maxPositiveWeight(c.genres) }));

  const scored: ScoredCandidate[] = candidates.map((c) => {
    const f = ctx.catalogue.features.get(c.trackId) ?? trackFeatures(c.track);
    const trackEntry = dims.tracks[c.trackId];
    const artistEntry = f.artist ? dims.artists[f.artist] : undefined;
    const trackNorm = normalizedWeight(trackEntry, max.track);
    const artistNorm = normalizedWeight(artistEntry, max.artist);
    const artistKnown = artistEntry !== undefined && (artistEntry.n > 0 || artistEntry.w > 0);
    const trackKnown = trackEntry !== undefined && (trackEntry.n > 0 || trackEntry.w !== 0);
    let genreAff = 0;
    let genreLabel: string | null = f.genres[0] ?? null;
    for (const g of f.genres) {
      const v = Math.max(0, normalizedWeight(dims.genres[g], max.genre));
      if (v > genreAff) {
        genreAff = v;
        genreLabel = g;
      }
    }
    const tagAff = f.tags.length ? f.tags.reduce((s, t) => s + Math.max(0, normalizedWeight(dims.tags[t], max.tag)), 0) / f.tags.length : 0;
    const eraAff = max.era > 0 ? (f.era ? Math.max(0, normalizedWeight(dims.eras[f.era], max.era)) : 0.5) : 0.5;
    const bandAff = max.band > 0 ? (f.band !== 'unknown' ? Math.max(0, normalizedWeight(dims.popularity[f.band], max.band)) : 0.5) : 0.5;
    let tasteMatch = 0.45 * (max.genre > 0 ? genreAff : 0.5) + 0.2 * (max.tag > 0 ? tagAff : 0.5) + 0.2 * eraAff + 0.15 * bandAff;
    let contextSimilarity = 0;
    if (ctx.contextTracks.length) {
      for (const t of ctx.contextTracks) contextSimilarity = Math.max(contextSimilarity, trackSimilarity(c.track, t));
      if (ctx.mode === 'similar') tasteMatch = 0.3 * tasteMatch + 0.7 * contextSimilarity;
    }

    let relatedVia: string | null = null;
    let artistAffinity = Math.max(0, artistNorm);
    if (artistAffinity === 0) {
      const related = sourceOf(c, 'related-artist');
      if (related) {
        artistAffinity = Math.max(artistAffinity, related.score * 0.8);
        relatedVia = related.via;
      }
      for (const rel of ctx.catalogue.related.get(f.artist) ?? []) {
        const v = rel.weight * Math.max(0, normalizedWeight(dims.artists[rel.key], max.artist)) * 0.8;
        if (v > artistAffinity) {
          artistAffinity = v;
          relatedVia = dims.artists[rel.key]?.label ?? rel.key;
        }
      }
    }
    const genreAffinity = 0.7 * genreAff + 0.3 * tagAff;

    let collaborative = 0;
    let collaborativeVia: string | null = null;
    const collabSource = sourceOf(c, 'collaborative');
    if (collabSource) {
      collaborative = collabSource.score;
      collaborativeVia = collabSource.via;
    }
    const collabHit = collab?.get(c.trackId);
    if (collabHit && collabHit.score > collaborative) {
      collaborative = collabHit.score;
      collaborativeVia = collabHit.via;
    }

    const yearsSince = c.track.releaseYear !== null ? Math.max(0, nowYear - c.track.releaseYear) : null;
    const freshness = yearsSince === null ? 0.2 : Math.pow(2, -yearsSince / 2);
    const recentTotal = recent.length || 1;
    const recentArtistPlays = f.artist ? (recentArtists.get(f.artist) ?? 0) : 0;
    const recentArtistAff = clamp01((recentArtistPlays / recentTotal) * 4);
    const recentGenreAff = f.genres.length ? clamp01((Math.max(...f.genres.map((g) => recentGenres.get(g) ?? 0)) / recentTotal) * 2) : 0;
    const recentAff = 0.6 * recentArtistAff + 0.4 * recentGenreAff;
    const recency = ctx.mode === 'new-releases' ? freshness : ctx.mode === 'recent' ? recentAff : 0.5 * freshness + 0.5 * recentAff;

    const pop = c.track.popularity;
    let popularityFit: number;
    if (modeConfig.popularityInverted) popularityFit = pop === null ? 0.5 : 1 - pop;
    else if (ctx.coldStart) popularityFit = pop ?? 0.5;
    else popularityFit = pop === null ? 0.5 : 1 - Math.abs(pop - preferredPopularity);

    let moodContext = 0;
    contexts.forEach((context, i) => {
      const m = contextMax[i]!;
      const a = f.artist ? Math.max(0, normalizedWeight(context.artists[f.artist], m.artist)) : 0;
      const g = f.genres.length ? Math.max(...f.genres.map((x) => Math.max(0, normalizedWeight(context.genres[x], m.genre)))) : 0;
      moodContext = Math.max(moodContext, 0.6 * a + 0.4 * g);
    });
    if (ctx.contextTracks.length && ctx.mode !== 'similar') moodContext = contexts.length ? 0.5 * moodContext + 0.5 * contextSimilarity : contextSimilarity;

    const discoveryBonus = !artistKnown ? 0.5 + 0.5 * appetite : trackKnown ? 0 : 0.3;

    const components: ScoreBreakdown = { tasteMatch: clamp01(tasteMatch), artistAffinity: clamp01(artistAffinity), genreAffinity: clamp01(genreAffinity), collaborative: clamp01(collaborative), recency: clamp01(recency), popularityFit: clamp01(popularityFit), moodContext: clamp01(moodContext), discoveryBonus: clamp01(discoveryBonus) };
    const weighted: ScoreBreakdown = { tasteMatch: 0, artistAffinity: 0, genreAffinity: 0, collaborative: 0, recency: 0, popularityFit: 0, moodContext: 0, discoveryBonus: 0 };
    let base = 0;
    for (const key of Object.keys(components) as (keyof RankingWeights)[]) {
      weighted[key] = round6((weights[key] * components[key]) / totalWeight);
      base += weighted[key];
    }
    const skipStats = profile.skips.tracks[c.trackId];
    const recommendedBefore = ctx.recentlyRecommended[c.trackId] ?? 0;
    const recentlyPlayed = ctx.recentlyPlayedIds.has(c.trackId) || playedRecently.has(c.trackId);
    const penalties: Penalties = {
      repeat: recentlyPlayed ? config.penalties.repeat : 0,
      skip: skipStats ? Math.min(config.penalties.skipMax, config.penalties.skip * skipStats.n) : 0,
      overexposure: Math.min(config.penalties.overexposureMax, config.penalties.overexposure * recommendedBefore),
    };
    const score = round6(base - penalties.repeat - penalties.skip - penalties.overexposure);

    let tier: RecommendationTier;
    if (artistNorm >= config.diversity.strongArtistAffinity || trackNorm >= 0.5) tier = 'strong';
    else if (artistKnown || relatedVia !== null || collaborative >= 0.2) tier = 'related';
    else if (genreAff >= config.diversity.knownGenreAffinity) tier = 'emerging';
    else tier = 'experimental';
    const familiarity: Familiarity = trackKnown ? 'known-track' : artistKnown ? 'known-artist' : genreAff >= config.diversity.knownGenreAffinity ? 'known-genre' : 'unknown';

    const evidence: Evidence = {
      artistLabel: artistEntry?.label ?? c.track.artistName,
      artistPlays: artistEntry?.n ?? 0,
      artistCompletionsMonth: artistEntry ? artistEntry.completions.filter((t) => t >= monthAgo).length : 0,
      artistLikes: artistEntry?.pos ?? 0,
      artistNorm: round6(artistNorm),
      genreLabel,
      genreNorm: round6(genreAff),
      relatedVia,
      collaborativeVia,
      contextLabel: ctx.contextLabel,
      contextSimilarity: round6(contextSimilarity),
      recentArtistPlays,
      trackKnown,
      artistKnown,
      year: c.track.releaseYear,
      popularity: pop,
      skipCount: skipStats?.n ?? 0,
      recommendedBefore,
      playedRecently: recentlyPlayed,
      albumLabel: c.track.albumName,
      libraryGapVia: sourceOf(c, 'library-gap')?.via ?? null,
    };
    return { ...c, score, base: round6(base), components, weighted, penalties, tier, familiarity, artistKey: f.artist, genres: f.genres, primaryGenre: f.genres[0] ?? null, evidence };
  });
  scored.sort((a, b) => b.score - a.score || (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0));
  return scored;
}

export interface ReasonEntry {
  signal: string;
  weight: number;
  text: string;
}

/** Structured "Why this?" reasons ordered by contribution (contract `RecommendationReason` shape). */
export function reasonsFor(scored: ScoredCandidate, limit = 10): ReasonEntry[] {
  const e = scored.evidence;
  const w = scored.weighted;
  const out: ReasonEntry[] = [];
  const add = (signal: string, weight: number, text: string) => {
    if (!out.some((r) => r.text === text)) out.push({ signal, weight: round6(weight), text });
  };
  if (w.artistAffinity > 0) {
    if (e.artistCompletionsMonth > 0) add('artistAffinity', w.artistAffinity, `Because you finished ${e.artistCompletionsMonth} ${e.artistCompletionsMonth === 1 ? 'song' : 'songs'} by ${e.artistLabel} this month`);
    else if (e.artistPlays > 0) add('artistAffinity', w.artistAffinity, `Because you often play ${e.artistLabel}`);
    else if (e.artistLikes > 0) add('artistAffinity', w.artistAffinity, `Because you like ${e.artistLabel}`);
    else if (e.relatedVia) add('artistAffinity', w.artistAffinity, `Because ${e.artistLabel} is related to ${e.relatedVia}, an artist you play often`);
  }
  if (w.genreAffinity > 0 && e.genreLabel && e.genreNorm > 0) add('genreAffinity', w.genreAffinity, `Because you listen to a lot of ${e.genreLabel}`);
  if (w.collaborative > 0 && e.collaborativeVia) add('collaborative', w.collaborative, `Because people who play ${e.collaborativeVia} also play this`);
  if (w.tasteMatch > 0 && e.contextSimilarity > 0 && scored.sources.some((s) => s.kind === 'playlist-context' && s.via?.startsWith('seed:'))) add('tasteMatch', w.tasteMatch, `Closely matches the song you picked`);
  else if (w.tasteMatch > 0 && scored.components.tasteMatch >= 0.6) add('tasteMatch', w.tasteMatch, 'Matches the genres, eras and tags you gravitate to');
  if (w.moodContext > 0 && e.contextLabel) add('moodContext', w.moodContext, e.contextSimilarity > 0 ? `Fits ${e.contextLabel}` : `Fits your ${e.contextLabel} listening`);
  if (w.recency > 0) {
    if (e.recentArtistPlays > 0) add('recency', w.recency, `Matches what you have been playing in the last ${14} days`);
    else if (e.year !== null && scored.components.recency >= 0.5) add('recency', w.recency, `Released in ${e.year}`);
  }
  if (w.discoveryBonus > 0 && !e.artistKnown) add('discoveryBonus', w.discoveryBonus, e.genreLabel && e.genreNorm > 0 ? `A new artist for you in ${e.genreLabel}` : 'Something outside your usual listening');
  if (w.popularityFit > 0 && e.popularity !== null) add('popularityFit', w.popularityFit, e.popularity < 0.35 ? 'An under-the-radar pick' : e.popularity >= 0.75 ? 'A widely popular pick' : 'Matches how mainstream your usual picks are');
  if (e.libraryGapVia) add('library-gap', 0, `Completes ${e.libraryGapVia} in your library`);
  for (const source of scored.sources) {
    const reason = scored.reasons.find((r) => !out.some((o) => o.text === r));
    if (reason) add(`source:${source.kind}`, source.score, reason);
  }
  if (scored.penalties.repeat > 0) add('penalty:repeat', -scored.penalties.repeat, 'Ranked lower because you played it recently');
  if (scored.penalties.skip > 0) add('penalty:skip', -scored.penalties.skip, `Ranked lower because you skipped it ${e.skipCount === 1 ? 'once' : `${e.skipCount} times`}`);
  if (scored.penalties.overexposure > 0) add('penalty:overexposure', -scored.penalties.overexposure, `Ranked lower because it was already recommended ${e.recommendedBefore} ${e.recommendedBefore === 1 ? 'time' : 'times'}`);
  return out.sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/** Human-readable explanations, strongest signal first. */
export function explain(scored: ScoredCandidate, limit = 6): string[] {
  return reasonsFor(scored, limit).map((r) => r.text);
}

/**
 * Offline evaluation. Splits a synthetic listening history in time, builds a profile from the
 * earlier part, asks for recommendations, and scores them against what the listener actually went
 * on to enjoy. It is the only honest way to claim the recommender does anything: the numbers in
 * the README come from `pnpm --filter @now-playing/recommendations evaluate`, not from intuition.
 *
 * Metrics, per user, averaged: hit rate@k, NDCG@k, artist diversity (1 − Herfindahl over artists),
 * catalogue coverage, novelty (share of results whose artist the profile had never heard) and
 * skip precision (how rarely a previously-skipped artist is recommended back).
 */
import type { CanonicalTrack, ListeningEvent, RecommendationMode } from '@now-playing/contracts';
import { seededRandom } from '@now-playing/domain';
import { buildCooccurrence, sessionsFromEvents } from './collaborative.js';
import { DEFAULT_RECOMMENDATION_CONFIG, type RecommendationConfig } from './config.js';
import { applyEvents, createProfile, isColdStart } from './profile.js';
import { recommend } from './recommend.js';
import { artistKeyOf } from './similarity.js';
import { buildCatalogue } from './candidates.js';

export interface EvaluationUser {
  userId: string;
  events: readonly ListeningEvent[];
}

export interface EvaluateOptions {
  users: readonly EvaluationUser[];
  catalogue: readonly CanonicalTrack[];
  /** Fraction of each user's timeline used for training. Default 0.7. */
  trainFraction?: number;
  /** Recommendations requested per user. Default 20. */
  k?: number;
  modes?: readonly RecommendationMode[];
  config?: RecommendationConfig;
  seed?: number;
  now?: number;
}

export interface ModeMetrics {
  mode: RecommendationMode;
  users: number;
  hitRate: number;
  ndcg: number;
  artistDiversity: number;
  coverage: number;
  novelty: number;
  skipPrecision: number;
  coldStartUsers: number;
  meanCandidates: number;
}

export interface EvaluationReport {
  generatedAt: string;
  config: { version: number; halfLifeDays: number; explorationRate: number; tiers: RecommendationConfig['diversity']['tiers'] };
  catalogueSize: number;
  users: number;
  k: number;
  trainFraction: number;
  modes: ModeMetrics[];
  /** Aggregate over the primary "for-you" mode, for a single headline number. */
  headline: { hitRate: number; ndcg: number; artistDiversity: number; novelty: number };
  notes: string[];
}

function positive(event: ListeningEvent): boolean {
  return event.type === 'completed' || event.type === 'liked' || event.type === 'favorited' || event.type === 'replayed' || event.type === 'playlist-added';
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function ndcgAt(recommendedIds: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, recommendedIds.length); i += 1) {
    if (relevant.has(recommendedIds[i]!)) dcg += 1 / Math.log2(i + 2);
  }
  let ideal = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i += 1) ideal += 1 / Math.log2(i + 2);
  return ideal > 0 ? dcg / ideal : 0;
}

/** 1 − Herfindahl index over artists: 0 when every result is the same artist, →1 when all differ. */
function artistDiversity(artists: readonly string[]): number {
  if (!artists.length) return 0;
  const counts = new Map<string, number>();
  for (const a of artists) counts.set(a, (counts.get(a) ?? 0) + 1);
  let sum = 0;
  for (const n of counts.values()) sum += (n / artists.length) ** 2;
  return 1 - sum;
}

export function evaluate(options: EvaluateOptions): EvaluationReport {
  const config = options.config ?? DEFAULT_RECOMMENDATION_CONFIG;
  const k = options.k ?? 20;
  const trainFraction = options.trainFraction ?? 0.7;
  const modes = options.modes ?? (['for-you', 'deep', 'recent'] as const);
  const seed = options.seed ?? 42;
  const catalogue = buildCatalogue(options.catalogue);
  const now = options.now ?? Date.parse('2026-09-01T00:00:00.000Z');
  const rnd = seededRandom(seed);
  const modeMetrics: ModeMetrics[] = [];
  const notes: string[] = [];

  const prepared = options.users.map((user) => {
    const events = [...user.events].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const cut = Math.max(1, Math.floor(events.length * trainFraction));
    const train = events.slice(0, cut);
    const test = events.slice(cut);
    const profile = applyEvents(createProfile(user.userId, Date.parse(events[0]?.occurredAt ?? new Date(now).toISOString())), train, config, now);
    const heldOut = new Set(test.filter(positive).map((e) => e.trackId).filter((id): id is string => !!id));
    const heardArtists = new Set(Object.keys(profile.dims.artists));
    const skippedArtists = new Set(Object.keys(profile.skips.artists));
    const ownedTrackIds = new Set(train.map((e) => e.trackId).filter((id): id is string => !!id));
    return { user, profile, heldOut, heardArtists, skippedArtists, ownedTrackIds, cooccurrence: buildCooccurrence(sessionsFromEvents(train)) };
  });

  for (const mode of modes) {
    let hits = 0;
    let ndcgSum = 0;
    let diversitySum = 0;
    let noveltySum = 0;
    let skipCleanSum = 0;
    let coldStartUsers = 0;
    let candidateSum = 0;
    let evaluated = 0;
    const covered = new Set<string>();

    for (const p of prepared) {
      if (p.heldOut.size === 0) continue;
      evaluated += 1;
      if (isColdStart(p.profile, config)) coldStartUsers += 1;
      const result = recommend({
        userId: p.user.userId,
        profile: p.profile,
        catalogue,
        mode,
        limit: k,
        seed: Math.floor(rnd() * 1_000_000),
        config,
        cooccurrence: p.cooccurrence,
        context: { ownedTrackIds: mode === 'for-you' ? [] : p.ownedTrackIds, recentlyRecommended: {} },
        now,
      });
      const ids = result.recommendations.map((r) => r.canonicalTrackId);
      const artists = result.recommendations.map((r) => artistKeyOf(r.artistName));
      for (const id of ids) covered.add(id);
      if (ids.some((id) => p.heldOut.has(id))) hits += 1;
      ndcgSum += ndcgAt(ids, p.heldOut, k);
      diversitySum += artistDiversity(artists);
      noveltySum += artists.length ? artists.filter((a) => !p.heardArtists.has(a)).length / artists.length : 0;
      skipCleanSum += artists.length ? artists.filter((a) => !p.skippedArtists.has(a)).length / artists.length : 1;
      candidateSum += result.diagnostics.candidateCount;
    }

    const n = Math.max(1, evaluated);
    modeMetrics.push({
      mode,
      users: evaluated,
      hitRate: round(hits / n),
      ndcg: round(ndcgSum / n),
      artistDiversity: round(diversitySum / n),
      coverage: round(covered.size / Math.max(1, catalogue.tracks.length)),
      novelty: round(noveltySum / n),
      skipPrecision: round(skipCleanSum / n),
      coldStartUsers,
      meanCandidates: round(candidateSum / n),
    });
  }

  const headlineMode = modeMetrics.find((m) => m.mode === 'for-you') ?? modeMetrics[0]!;
  if (headlineMode.coldStartUsers > 0) notes.push(`${headlineMode.coldStartUsers} of ${headlineMode.users} users were still in cold start; their results come from seeds and popularity, not personalisation.`);
  // A held-out set drawn from a listener's own history can only be hit by modes that are allowed to
  // return music they already know. Discovery modes scoring 0 here is the design working, not a bug.
  for (const m of modeMetrics) {
    if (m.hitRate === 0 && m.novelty >= 0.4) {
      notes.push(`Mode "${m.mode}" scores hit@k 0 by design: its candidate sources exclude tracks the profile already knows, and the held-out set is drawn from the listener's own history. Judge it on novelty (${m.novelty}), artist diversity (${m.artistDiversity}) and skip precision (${m.skipPrecision}) instead.`);
    }
  }
  notes.push('Synthetic fixtures, not real listeners: these numbers verify the pipeline behaves as designed and guard against regressions. They are not a claim about real-world quality.');

  return {
    generatedAt: new Date(now).toISOString(),
    config: { version: config.version, halfLifeDays: config.decay.halfLifeDays, explorationRate: config.explorationRate, tiers: config.diversity.tiers },
    catalogueSize: catalogue.tracks.length,
    users: prepared.length,
    k,
    trainFraction,
    modes: modeMetrics,
    headline: { hitRate: headlineMode.hitRate, ndcg: headlineMode.ndcg, artistDiversity: headlineMode.artistDiversity, novelty: headlineMode.novelty },
    notes,
  };
}

export interface SyntheticCatalogueOptions {
  /** Extra tracks to synthesise around the seed tracks. Default 200. */
  size?: number;
  seed?: number;
  /** Artists invented beyond those in the seed tracks, so discovery has somewhere to go. */
  newArtists?: number;
  baseYear?: number;
}

const SYNTH_GENRES = ['ambient', 'indie', 'electronic', 'folk', 'jazz', 'post-rock', 'dream pop', 'techno'];
const SYNTH_WORDS = ['Amber', 'Harbour', 'Signal', 'Paper', 'Copper', 'Quiet', 'Lantern', 'Glass', 'Tide', 'Ember', 'Marble', 'Slow', 'North', 'Velvet', 'Pale', 'Winter'];
const SYNTH_NOUNS = ['Line', 'Hour', 'Road', 'Fade', 'Meridian', 'Arithmetic', 'Carousel', 'Lights', 'Field', 'Cassette', 'Window', 'Machine'];

/**
 * Deterministically widen a set of known tracks into a catalogue the recommender can explore:
 * more tracks by the same artists, plus invented artists in the same and adjacent genres.
 * Evaluation needs somewhere to discover; the fixture library alone is a dozen tracks.
 */
export function syntheticCatalogue(seedTracks: readonly CanonicalTrack[], options: SyntheticCatalogueOptions = {}): CanonicalTrack[] {
  const size = options.size ?? 200;
  const newArtists = options.newArtists ?? 12;
  const baseYear = options.baseYear ?? 2016;
  const rnd = seededRandom(options.seed ?? 11);
  const out: CanonicalTrack[] = [...seedTracks];
  const knownArtists = [...new Set(seedTracks.map((t) => t.artistName))];
  const artistGenres = new Map<string, string[]>();
  for (const t of seedTracks) if (!artistGenres.has(t.artistName)) artistGenres.set(t.artistName, t.genres.length ? [...t.genres] : ['ambient']);
  for (let i = 0; i < newArtists; i += 1) {
    const name = `${SYNTH_WORDS[Math.floor(rnd() * SYNTH_WORDS.length)]!} ${SYNTH_NOUNS[Math.floor(rnd() * SYNTH_NOUNS.length)]!}`;
    if (!artistGenres.has(name)) artistGenres.set(name, [SYNTH_GENRES[Math.floor(rnd() * SYNTH_GENRES.length)]!]);
  }
  const artists = [...artistGenres.keys()];
  const pad = (n: number): string => String(n).padStart(12, '0');
  for (let i = out.length; i < size; i += 1) {
    const artistName = artists[Math.floor(rnd() * artists.length)]!;
    const genres = artistGenres.get(artistName) ?? ['ambient'];
    const title = `${SYNTH_WORDS[Math.floor(rnd() * SYNTH_WORDS.length)]!} ${SYNTH_NOUNS[Math.floor(rnd() * SYNTH_NOUNS.length)]!} ${i}`;
    const year = baseYear + Math.floor(rnd() * 11);
    const known = knownArtists.includes(artistName);
    const id = `00000000-0000-7000-8000-${pad(900_000 + i)}`;
    out.push({
      id,
      musicbrainzRecordingId: null,
      isrc: null,
      title,
      normalizedTitle: title.toLowerCase(),
      artistId: null,
      artistName,
      normalizedArtist: artistName.toLowerCase(),
      albumId: null,
      albumName: `${artistName} Collected`,
      releaseYear: year,
      durationMs: 150_000 + Math.floor(rnd() * 180_000),
      genres: [...genres],
      tags: known ? ['catalogue'] : ['discovery'],
      popularity: Math.round(rnd() * 100) / 100,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  return out;
}

/** Canonical tracks recovered from a listening history's own snapshots (ids stay stable). */
export function catalogueFromEvents(events: readonly ListeningEvent[]): CanonicalTrack[] {
  const byId = new Map<string, CanonicalTrack>();
  for (const e of events) {
    if (!e.trackId || !e.track || byId.has(e.trackId)) continue;
    byId.set(e.trackId, {
      id: e.trackId,
      musicbrainzRecordingId: null,
      isrc: null,
      title: e.track.title,
      normalizedTitle: e.track.title.toLowerCase(),
      artistId: e.track.artistId,
      artistName: e.track.artistName,
      normalizedArtist: e.track.artistName.toLowerCase(),
      albumId: e.track.albumId,
      albumName: e.track.albumName,
      releaseYear: e.track.year,
      durationMs: e.track.durationMs,
      genres: e.track.genre ? [e.track.genre.toLowerCase()] : [],
      tags: [...e.track.tags],
      popularity: e.track.popularity,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Build several users from one fixture generator by re-seeding it, so evaluation has a cohort. */
export function cohortFromGenerator(generate: (seed: number, deviceId: string) => ListeningEvent[], count: number, baseSeed = 1): EvaluationUser[] {
  const users: EvaluationUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const suffix = String(i + 1).padStart(4, '0');
    users.push({ userId: `00000000-0000-7000-8000-0000000${suffix}`, events: generate(baseSeed + i, `00000000-0000-7000-8000-1000000${suffix}`) });
  }
  return users;
}

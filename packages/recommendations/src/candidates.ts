import { CanonicalTrack as CanonicalTrackSchema, type ArtistRelation, type CanonicalArtist, type CanonicalTrack, type DiscoveryCacheEntry } from '@now-playing/contracts';
import { seededShuffle } from '@now-playing/domain';
import { DEFAULT_RECOMMENDATION_CONFIG, type RecommendationConfig } from './config.js';
import { DAY_MS, albumKeyOf, discoveryAppetite, maxPositiveWeight, normalizedWeight, recentPlays, toMs, topEntries, type RankedKey, type TasteProfile, type Timestamp, type TrackEntry } from './profile.js';
import { artistKeyOf, artistSimilarity, eraOf, normalizeGenres, normalizeTags, popularityBand, trackSimilarity, type PopularityBand, type SimilarityArtist, type SimilarityTrack } from './similarity.js';

/* ---------- candidate types ---------- */

/** The ten candidate sources of the design document. */
export type CandidateSourceKind =
  | 'top-artist'
  | 'related-artist'
  | 'genre-neighbour'
  | 'collaborative'
  | 'playlist-context'
  | 'recently-liked-similar'
  | 'new-release'
  | 'discovery-cache'
  | 'library-gap'
  | 'exploration';

export const CANDIDATE_SOURCE_KINDS: readonly CandidateSourceKind[] = ['top-artist', 'related-artist', 'genre-neighbour', 'collaborative', 'playlist-context', 'recently-liked-similar', 'new-release', 'discovery-cache', 'library-gap', 'exploration'];

export interface CandidateSource {
  kind: CandidateSourceKind;
  /** 0..1 confidence of this source in the candidate. */
  score: number;
  /** What produced it (seed artist, context track, provider ...). */
  via: string | null;
}

export interface Candidate {
  trackId: string;
  track: CanonicalTrack;
  sources: CandidateSource[];
  reasons: string[];
}

/* ---------- catalogue index ---------- */

export interface TrackFeatures {
  artist: string;
  artistName: string;
  genres: string[];
  tags: string[];
  album: string | null;
  era: string | null;
  band: PopularityBand;
}

export interface RelatedArtist {
  key: string;
  weight: number;
}

export interface Catalogue {
  readonly kind: 'catalogue';
  readonly tracks: readonly CanonicalTrack[];
  readonly byId: ReadonlyMap<string, CanonicalTrack>;
  readonly features: ReadonlyMap<string, TrackFeatures>;
  readonly byArtist: ReadonlyMap<string, readonly CanonicalTrack[]>;
  readonly byGenre: ReadonlyMap<string, readonly CanonicalTrack[]>;
  readonly byTag: ReadonlyMap<string, readonly CanonicalTrack[]>;
  readonly byAlbum: ReadonlyMap<string, readonly CanonicalTrack[]>;
  readonly artistNames: ReadonlyMap<string, string>;
  readonly artistProfiles: ReadonlyMap<string, SimilarityArtist>;
  readonly artistKeyById: ReadonlyMap<string, string>;
  readonly related: ReadonlyMap<string, readonly RelatedArtist[]>;
}

export interface CatalogueOptions {
  artists?: readonly CanonicalArtist[];
  relations?: readonly ArtistRelation[];
}

export function trackFeatures(track: CanonicalTrack): TrackFeatures {
  const artist = artistKeyOf(track.artistName, track.artistId);
  return { artist, artistName: track.artistName, genres: normalizeGenres(track.genres), tags: normalizeTags(track.tags), album: albumKeyOf(artist, track.albumId, track.albumName), era: eraOf(track.releaseYear), band: popularityBand(track.popularity) };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function isCatalogue(value: unknown): value is Catalogue {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'catalogue';
}

/** Index a canonical catalogue once; every source and the ranker read from the same maps. Track order is preserved. */
export function buildCatalogue(tracks: readonly CanonicalTrack[], options: CatalogueOptions = {}): Catalogue {
  const byId = new Map<string, CanonicalTrack>();
  const features = new Map<string, TrackFeatures>();
  const byArtist = new Map<string, CanonicalTrack[]>();
  const byGenre = new Map<string, CanonicalTrack[]>();
  const byTag = new Map<string, CanonicalTrack[]>();
  const byAlbum = new Map<string, CanonicalTrack[]>();
  const artistNames = new Map<string, string>();
  const artistKeyById = new Map<string, string>();
  const genreCounts = new Map<string, Map<string, number>>();
  const tagCounts = new Map<string, Map<string, number>>();
  const popularity = new Map<string, number[]>();
  const unique: CanonicalTrack[] = [];
  for (const track of tracks) {
    if (byId.has(track.id)) continue;
    byId.set(track.id, track);
    unique.push(track);
    const f = trackFeatures(track);
    features.set(track.id, f);
    if (f.artist) {
      push(byArtist, f.artist, track);
      if (!artistNames.has(f.artist)) artistNames.set(f.artist, track.artistName);
      if (track.artistId) artistKeyById.set(track.artistId, f.artist);
      const gc = genreCounts.get(f.artist) ?? new Map<string, number>();
      for (const g of f.genres) gc.set(g, (gc.get(g) ?? 0) + 1);
      genreCounts.set(f.artist, gc);
      const tc = tagCounts.get(f.artist) ?? new Map<string, number>();
      for (const t of f.tags) tc.set(t, (tc.get(t) ?? 0) + 1);
      tagCounts.set(f.artist, tc);
      if (track.popularity !== null) push(popularity, f.artist, track.popularity);
    }
    for (const g of f.genres) push(byGenre, g, track);
    for (const t of f.tags) push(byTag, t, track);
    if (f.album) push(byAlbum, f.album, track);
  }
  const artistProfiles = new Map<string, SimilarityArtist>();
  for (const artist of options.artists ?? []) {
    const key = artistKeyOf(artist.name, artist.id);
    if (!key) continue;
    artistKeyById.set(artist.id, key);
    if (!artistNames.has(key)) artistNames.set(key, artist.name);
    artistProfiles.set(key, { name: artist.name, genres: normalizeGenres(artist.genres), tags: normalizeTags(artist.tags), popularity: artist.popularity });
  }
  const ranked = (counts: Map<string, number> | undefined): string[] => [...(counts ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
  for (const [key, name] of artistNames) {
    if (artistProfiles.has(key)) continue;
    const pops = popularity.get(key) ?? [];
    artistProfiles.set(key, { name, genres: ranked(genreCounts.get(key)), tags: ranked(tagCounts.get(key)), popularity: pops.length ? pops.reduce((a, b) => a + b, 0) / pops.length : null });
  }
  const related = new Map<string, Map<string, number>>();
  for (const rel of options.relations ?? []) {
    const a = artistKeyById.get(rel.artistId);
    const b = artistKeyById.get(rel.relatedArtistId);
    if (!a || !b || a === b) continue;
    const list = related.get(a) ?? new Map<string, number>();
    list.set(b, Math.max(list.get(b) ?? 0, rel.weight));
    related.set(a, list);
  }
  const relatedSorted = new Map<string, RelatedArtist[]>();
  for (const [key, list] of related) relatedSorted.set(key, [...list.entries()].map(([k, weight]) => ({ key: k, weight })).sort((x, y) => y.weight - x.weight || (x.key < y.key ? -1 : 1)));
  return { kind: 'catalogue', tracks: unique, byId, features, byArtist, byGenre, byTag, byAlbum, artistNames, artistProfiles, artistKeyById, related: relatedSorted };
}

export function toCatalogue(input: readonly CanonicalTrack[] | Catalogue, options: CatalogueOptions = {}): Catalogue {
  return isCatalogue(input) ? input : buildCatalogue(input, options);
}

/* ---------- seeds ---------- */

export interface Seeds {
  artists: RankedKey[];
  genres: RankedKey[];
  tags: RankedKey[];
  tracks: RankedKey[];
  eras: RankedKey[];
  popularityBand: PopularityBand | null;
  /** Recently positively-played tracks (newest first). */
  recent: RankedKey[];
  knownArtists: ReadonlySet<string>;
  knownTracks: ReadonlySet<string>;
  /** Track ids last played within the repeat window. */
  recentTrackIds: ReadonlySet<string>;
}

export function knownArtistKeys(profile: TasteProfile): Set<string> {
  const out = new Set<string>();
  for (const [key, entry] of Object.entries(profile.dims.artists)) if (entry.n > 0 || entry.w > 0) out.add(key);
  return out;
}

export function knownTrackIds(profile: TasteProfile): Set<string> {
  const out = new Set<string>();
  for (const [key, entry] of Object.entries(profile.dims.tracks)) if (entry.n > 0 || entry.w !== 0) out.add(key);
  return out;
}

/** "Search for likely-good music, not everything": the profile's strongest artists, genres, tags, tracks and eras. */
export function generateSeeds(profile: TasteProfile, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG, now: Timestamp = profile.lastEventAt ?? profile.updatedAt): Seeds {
  const c = config.candidates;
  const bands = topEntries(profile.dims.popularity, 1);
  const recentWindow = recentPlays(profile, now, c.recentDays);
  const recentMax = Math.max(0, ...recentWindow.map((r) => r.w));
  const recentSeen = new Set<string>();
  const recent: RankedKey[] = [];
  for (let i = recentWindow.length - 1; i >= 0 && recent.length < c.topTracks; i -= 1) {
    const r = recentWindow[i]!;
    if (r.w <= 0 || recentSeen.has(r.trackId)) continue;
    recentSeen.add(r.trackId);
    recent.push({ key: r.trackId, label: profile.dims.tracks[r.trackId]?.label ?? r.trackId, weight: recentMax > 0 ? r.w / recentMax : 1 });
  }
  const repeatCutoff = toMs(now) - config.penalties.repeatWindowDays * DAY_MS;
  const recentTrackIds = new Set<string>();
  for (const r of profile.recent) if (r.at >= repeatCutoff) recentTrackIds.add(r.trackId);
  return {
    artists: topEntries(profile.dims.artists, c.topArtists),
    genres: topEntries(profile.dims.genres, c.topGenres),
    tags: topEntries(profile.dims.tags, c.topTags),
    tracks: topEntries(profile.dims.tracks, c.topTracks),
    eras: topEntries(profile.dims.eras, 3),
    popularityBand: (bands[0]?.key as PopularityBand | undefined) ?? null,
    recent,
    knownArtists: knownArtistKeys(profile),
    knownTracks: knownTrackIds(profile),
    recentTrackIds,
  };
}

/* ---------- helpers ---------- */

function candidate(track: CanonicalTrack, source: CandidateSource, reason: string): Candidate {
  return { trackId: track.id, track, sources: [source], reasons: [reason] };
}

function byScore(a: Candidate, b: Candidate): number {
  const sa = a.sources[0]?.score ?? 0;
  const sb = b.sources[0]?.score ?? 0;
  return sb - sa || (b.track.popularity ?? 0) - (a.track.popularity ?? 0) || (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0);
}

function take(list: Candidate[], limit: number): Candidate[] {
  return list.sort(byScore).slice(0, limit);
}

function similarityView(entry: TrackEntry): SimilarityTrack {
  return { artistName: entry.artistName, genres: entry.genres, tags: entry.tags, releaseYear: entry.year, popularity: entry.popularity, durationMs: null };
}

/** Dedupe by track id, keeping first-seen order; sources and reasons are unioned. */
export function mergeCandidates(lists: readonly (readonly Candidate[])[]): Candidate[] {
  const merged = new Map<string, Candidate>();
  for (const list of lists) {
    for (const c of list) {
      const existing = merged.get(c.trackId);
      if (!existing) {
        merged.set(c.trackId, { trackId: c.trackId, track: c.track, sources: [...c.sources], reasons: [...c.reasons] });
        continue;
      }
      for (const s of c.sources) if (!existing.sources.some((e) => e.kind === s.kind && e.via === s.via)) existing.sources.push(s);
      for (const r of c.reasons) if (!existing.reasons.includes(r)) existing.reasons.push(r);
    }
  }
  const out = [...merged.values()];
  for (const c of out) c.sources.sort((a, b) => b.score - a.score || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return out;
}

/* ---------- the ten sources ---------- */

/** 1. Unheard (or long-unplayed) tracks by the user's most played artists. */
export function topArtistCandidates(seeds: Seeds, catalogue: Catalogue, profile: TasteProfile, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG): Candidate[] {
  const out: Candidate[] = [];
  for (const artist of seeds.artists) {
    for (const track of catalogue.byArtist.get(artist.key) ?? []) {
      const known = profile.dims.tracks[track.id];
      if (known && seeds.recentTrackIds.has(track.id)) continue;
      const rediscovery = known !== undefined && known.n > 0;
      const score = artist.weight * (rediscovery ? 0.5 : 1);
      out.push(candidate(track, { kind: 'top-artist', score, via: artist.label }, rediscovery ? `A ${artist.label} track you have not played in a while` : `From ${artist.label}, one of your most played artists`));
    }
  }
  return take(out, config.candidates.perSource);
}

function derivedRelated(key: string, seedProfile: SimilarityArtist, catalogue: Catalogue, seeds: Seeds, config: RecommendationConfig): RelatedArtist[] {
  const out: RelatedArtist[] = [];
  for (const [other, profile] of catalogue.artistProfiles) {
    if (other === key || seeds.knownArtists.has(other)) continue;
    const sim = artistSimilarity(seedProfile, profile);
    if (sim >= config.candidates.relatedArtistMin) out.push({ key: other, weight: sim });
  }
  return out.sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : 1)).slice(0, config.candidates.relatedPerArtist);
}

/** 2. Tracks by artists related to the seed artists (explicit relations, else genre/tag similarity). */
export function relatedArtistCandidates(seeds: Seeds, catalogue: Catalogue, profile: TasteProfile, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG): Candidate[] {
  const out: Candidate[] = [];
  for (const artist of seeds.artists) {
    let related = catalogue.related.get(artist.key);
    if (!related || !related.length) {
      const seedProfile = catalogue.artistProfiles.get(artist.key) ?? artistProfileFromTracks(profile, artist.key);
      related = seedProfile ? derivedRelated(artist.key, seedProfile, catalogue, seeds, config) : [];
    }
    for (const rel of related.slice(0, config.candidates.relatedPerArtist)) {
      for (const track of catalogue.byArtist.get(rel.key) ?? []) {
        if (seeds.knownTracks.has(track.id)) continue;
        const name = catalogue.artistNames.get(rel.key) ?? track.artistName;
        out.push(candidate(track, { kind: 'related-artist', score: artist.weight * rel.weight, via: artist.label }, `${name} is related to ${artist.label}, an artist you play often`));
      }
    }
  }
  return take(out, config.candidates.perSource);
}

function artistProfileFromTracks(profile: TasteProfile, key: string): SimilarityArtist | null {
  const genres = new Map<string, number>();
  const tags = new Map<string, number>();
  const pops: number[] = [];
  let name: string | null = null;
  for (const entry of Object.values(profile.dims.tracks)) {
    if (entry.artist !== key) continue;
    name ??= entry.artistName;
    for (const g of entry.genres) genres.set(g, (genres.get(g) ?? 0) + 1);
    for (const t of entry.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    if (entry.popularity !== null) pops.push(entry.popularity);
  }
  if (name === null) return null;
  const ranked = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
  return { name, genres: ranked(genres), tags: ranked(tags), popularity: pops.length ? pops.reduce((a, b) => a + b, 0) / pops.length : null };
}

/** 3. Tracks by unfamiliar artists in the user's top genres and tags. */
export function genreNeighbourCandidates(seeds: Seeds, catalogue: Catalogue, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (track: CanonicalTrack, weight: number, via: string, reason: string) => {
    const f = catalogue.features.get(track.id);
    if (!f || !f.artist || seeds.knownArtists.has(f.artist) || seeds.knownTracks.has(track.id) || seen.has(track.id)) return;
    seen.add(track.id);
    out.push(candidate(track, { kind: 'genre-neighbour', score: weight * (0.5 + 0.5 * (track.popularity ?? 0.5)), via }, reason));
  };
  for (const genre of seeds.genres) for (const track of catalogue.byGenre.get(genre.key) ?? []) add(track, genre.weight, genre.label, `More ${genre.label}, a genre you play a lot`);
  for (const tag of seeds.tags) for (const track of catalogue.byTag.get(tag.key) ?? []) add(track, tag.weight * 0.8, tag.label, `Tagged ${tag.label}, like much of what you play`);
  return take(out, config.candidates.perSource);
}

/** 5 (and "similar to this"): tracks similar to a set of context tracks (a playlist, a seed track, or recent likes). */
export function contextSimilarCandidates(contextTracks: readonly (SimilarityTrack & { id: string; title: string })[], catalogue: Catalogue, config: RecommendationConfig, options: { kind: 'playlist-context' | 'recently-liked-similar'; via: string | null; exclude?: ReadonlySet<string>; threshold?: number; limit?: number }): Candidate[] {
  if (!contextTracks.length) return [];
  const threshold = options.threshold ?? config.candidates.similarityThreshold;
  const contextIds = new Set(contextTracks.map((t) => t.id));
  const out: Candidate[] = [];
  for (const track of catalogue.tracks) {
    if (contextIds.has(track.id) || options.exclude?.has(track.id)) continue;
    let best = 0;
    let bestTrack = contextTracks[0]!;
    for (const ctx of contextTracks) {
      const sim = trackSimilarity(track, ctx);
      if (sim > best) {
        best = sim;
        bestTrack = ctx;
      }
    }
    if (best < threshold) continue;
    out.push(candidate(track, { kind: options.kind, score: best, via: options.via ?? bestTrack.title }, `Similar to ${bestTrack.title} by ${bestTrack.artistName}`));
  }
  return take(out, options.limit ?? config.candidates.perSource);
}

/** 6. Tracks similar to what the user recently finished or liked. */
export function recentlyLikedSimilarCandidates(seeds: Seeds, catalogue: Catalogue, profile: TasteProfile, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG): Candidate[] {
  const context: (SimilarityTrack & { id: string; title: string })[] = [];
  for (const recent of seeds.recent.slice(0, 10)) {
    const track = catalogue.byId.get(recent.key);
    if (track) context.push({ ...track, id: track.id, title: track.title });
    else {
      const entry = profile.dims.tracks[recent.key];
      if (entry) context.push({ ...similarityView(entry), id: recent.key, title: entry.label ?? recent.key });
    }
  }
  return contextSimilarCandidates(context, catalogue, config, { kind: 'recently-liked-similar', via: null, exclude: seeds.knownTracks });
}

/** 7. Recent releases from artists the user plays or likes, or in their top genres. */
export function newReleaseCandidates(seeds: Seeds, catalogue: Catalogue, profile: TasteProfile, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG, now: Timestamp = Date.now()): Candidate[] {
  const minYear = new Date(toMs(now)).getUTCFullYear() - config.candidates.newReleaseYears;
  const artistMax = maxPositiveWeight(profile.dims.artists);
  const genreWeights = new Map(seeds.genres.map((g) => [g.key, g.weight] as const));
  const out: Candidate[] = [];
  for (const track of catalogue.tracks) {
    if (track.releaseYear === null || track.releaseYear < minYear || seeds.knownTracks.has(track.id)) continue;
    const f = catalogue.features.get(track.id);
    if (!f) continue;
    const artistNorm = normalizedWeight(profile.dims.artists[f.artist], artistMax);
    if (artistNorm > 0) {
      out.push(candidate(track, { kind: 'new-release', score: 0.6 + 0.4 * artistNorm, via: track.artistName }, `New in ${track.releaseYear} from ${track.artistName}, an artist you play`));
      continue;
    }
    const genre = f.genres.find((g) => genreWeights.has(g));
    if (genre) out.push(candidate(track, { kind: 'new-release', score: 0.4 * (genreWeights.get(genre) ?? 0), via: genre }, `New ${genre} release from ${track.releaseYear}`));
  }
  return take(out, config.candidates.perSource);
}

/** 8. Hits from the hub's shared discovery cache (parsed defensively; unknown shapes are ignored). */
export function discoveryCacheCandidates(entries: readonly (DiscoveryCacheEntry | CanonicalTrack)[], catalogue: Catalogue, seeds: Seeds, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (track: CanonicalTrack, via: string, reason: string, hits: number) => {
    if (seeds.knownTracks.has(track.id) || seen.has(track.id)) return;
    seen.add(track.id);
    out.push(candidate(catalogue.byId.get(track.id) ?? track, { kind: 'discovery-cache', score: Math.min(0.8, 0.5 + hits * 0.05), via }, reason));
  };
  for (const entry of entries) {
    if ('results' in entry) {
      for (const raw of entry.results) {
        const parsed = CanonicalTrackSchema.safeParse(raw);
        if (parsed.success) add(parsed.data, entry.provider, `Found on ${entry.provider} while searching for "${entry.query}"`, entry.hits);
      }
    } else add(entry, 'cache', 'From the shared discovery cache', 0);
  }
  return take(out, config.candidates.perSource);
}

/** 9. Albums the user only partly owns: the missing tracks. */
export function libraryGapCandidates(profile: TasteProfile, catalogue: Catalogue, ownedTrackIds?: Iterable<string>, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG): Candidate[] {
  const owned = ownedTrackIds ? new Set(ownedTrackIds) : knownTrackIds(profile);
  const out: Candidate[] = [];
  for (const [, tracks] of catalogue.byAlbum) {
    if (tracks.length < 2) continue;
    const have = tracks.filter((t) => owned.has(t.id)).length;
    if (have === 0 || have === tracks.length) continue;
    const share = have / tracks.length;
    for (const track of tracks) {
      if (owned.has(track.id)) continue;
      out.push(candidate(track, { kind: 'library-gap', score: share, via: track.albumName }, `Completes ${track.albumName ?? 'an album'} by ${track.artistName} (you have ${have} of ${tracks.length} tracks)`));
    }
  }
  return take(out, config.candidates.perSource);
}

export interface ExplorationOptions {
  limit?: number;
  /** Prefer popular tracks and spread across genres (cold start). */
  popularityWeighted?: boolean;
  knownArtists?: ReadonlySet<string>;
  knownTracks?: ReadonlySet<string>;
}

/** 10. Seeded wildcard picks from artists the user has never played, spread across genres. */
export function exploration(catalogue: Catalogue, profile: TasteProfile, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG, seed: number, options: ExplorationOptions = {}): Candidate[] {
  const knownArtists = options.knownArtists ?? knownArtistKeys(profile);
  const knownTracks = options.knownTracks ?? knownTrackIds(profile);
  const appetite = discoveryAppetite(profile);
  const pool = catalogue.tracks.filter((t) => {
    const f = catalogue.features.get(t.id);
    return f !== undefined && !knownTracks.has(t.id) && (!f.artist || !knownArtists.has(f.artist));
  });
  const shuffled = seededShuffle(pool, seed);
  const buckets = new Map<string, CanonicalTrack[]>();
  for (const track of shuffled) push(buckets, catalogue.features.get(track.id)?.genres[0] ?? 'unknown', track);
  if (options.popularityWeighted) for (const list of buckets.values()) list.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || (a.id < b.id ? -1 : 1));
  const limit = options.limit ?? Math.max(5, Math.round(config.candidates.perSource * Math.max(config.explorationRate, 0.05) * (0.5 + appetite)));
  const out: Candidate[] = [];
  const lists = [...buckets.values()];
  for (let round = 0; out.length < limit && lists.some((l) => l.length > round); round += 1) {
    for (const list of lists) {
      const track = list[round];
      if (!track || out.length >= limit) continue;
      const genre = catalogue.features.get(track.id)?.genres[0] ?? null;
      const score = options.popularityWeighted ? 0.3 + 0.5 * (track.popularity ?? 0.3) : 0.3 + 0.4 * appetite;
      const reason = options.popularityWeighted ? (genre ? `Popular in ${genre}` : 'A popular starting point') : genre ? `Something different: ${genre}` : 'A wildcard pick outside your usual listening';
      out.push(candidate(track, { kind: 'exploration', score, via: options.popularityWeighted ? 'popularity' : 'wildcard' }, reason));
    }
  }
  return out;
}

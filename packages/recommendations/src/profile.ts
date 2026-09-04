import type { CanonicalTrack, EventTrackSnapshot, ListeningEvent, RecommendationFeedback } from '@now-playing/contracts';
import { DomainError, normalizeText } from '@now-playing/domain';
import { DEFAULT_RECOMMENDATION_CONFIG, type ActionWeights, type RecommendationConfig } from './config.js';
import { POPULARITY_BAND_CENTRE, artistKeyOf, clamp01, eraOf, normalizeGenres, normalizeTags, popularityBand, type PopularityBand } from './similarity.js';

export const PROFILE_VERSION = 1;
export const DAY_MS = 86_400_000;
export type Timestamp = number | string;

export function toMs(value: Timestamp): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DomainError('validation', 'Invalid timestamp');
    return value;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new DomainError('validation', `Invalid ISO timestamp: ${value}`);
  return ms;
}

/* ---------- profile shape ---------- */

export interface AffinityEntry {
  /** Decayed affinity weight (positive = liked, negative = rejected). */
  w: number;
  /** Plays (not decayed). */
  n: number;
  /** Positive signals. */
  pos: number;
  /** Negative signals. */
  neg: number;
  /** Last event time (ms since epoch). */
  at: number;
  label: string | null;
}

export interface TrackEntry extends AffinityEntry {
  artist: string;
  artistName: string;
  album: string | null;
  albumName: string | null;
  genres: string[];
  tags: string[];
  year: number | null;
  popularity: number | null;
  provider: string | null;
}

export interface ArtistEntry extends AffinityEntry {
  /** Bounded ring of completion timestamps, used for explanations ("finished 4 songs by X this month"). */
  completions: number[];
}

export type Dimension<E extends AffinityEntry = AffinityEntry> = Record<string, E>;

export interface ProfileDimensions {
  tracks: Dimension<TrackEntry>;
  artists: Dimension<ArtistEntry>;
  albums: Dimension;
  genres: Dimension;
  tags: Dimension;
  eras: Dimension;
  popularity: Dimension;
  platforms: Dimension;
}

export type ContextKind = 'playlist' | 'mood' | 'activity' | 'time' | 'session';

export interface ContextProfile {
  kind: ContextKind;
  id: string;
  label: string | null;
  n: number;
  at: number;
  artists: Dimension;
  genres: Dimension;
  tags: Dimension;
}

export interface SkipRecord {
  trackId: string;
  at: number;
}

export interface TrackSkipStats {
  n: number;
  immediate: number;
  at: number;
}

export interface SkipCounters {
  tracks: Record<string, TrackSkipStats>;
  artists: Record<string, SkipRecord[]>;
  genres: Record<string, SkipRecord[]>;
}

export interface RecentPlay {
  trackId: string;
  artist: string;
  genres: string[];
  at: number;
  w: number;
}

export interface DiscoveryStats {
  newArtistPlays: number;
  knownArtistPlays: number;
  newArtistPositive: number;
  newArtistNegative: number;
  /** 0..1 appetite for unfamiliar artists, derived from the counters above. */
  appetite: number;
}

export interface ProfileSeeds {
  artists: string[];
  genres: string[];
  likedTrackIds: string[];
}

export interface AppliedRecord {
  id: string;
  at: number;
}

export interface TasteProfile {
  version: number;
  userId: string;
  createdAt: number;
  updatedAt: number;
  /** Time up to which exponential decay has been applied. */
  decayedAt: number;
  eventCount: number;
  /** Meaningful-listen and completion events seen. */
  meaningfulCount: number;
  lastEventAt: number | null;
  dims: ProfileDimensions;
  contexts: Record<string, ContextProfile>;
  skips: SkipCounters;
  discovery: DiscoveryStats;
  /** Play starts per UTC hour of day. */
  hours: number[];
  /** Bounded ring of recent plays (newest last). */
  recent: RecentPlay[];
  /** Bounded ring of applied event / feedback / seed ids for idempotency. */
  applied: AppliedRecord[];
  /** Events older than this were dropped from the ring and are treated as already applied. */
  appliedWatermark: number;
  seeds: ProfileSeeds | null;
}

export function createProfile(userId: string, now: Timestamp = 0): TasteProfile {
  const t = toMs(now);
  return {
    version: PROFILE_VERSION,
    userId,
    createdAt: t,
    updatedAt: t,
    decayedAt: t,
    eventCount: 0,
    meaningfulCount: 0,
    lastEventAt: null,
    dims: { tracks: {}, artists: {}, albums: {}, genres: {}, tags: {}, eras: {}, popularity: {}, platforms: {} },
    contexts: {},
    skips: { tracks: {}, artists: {}, genres: {} },
    discovery: { newArtistPlays: 0, knownArtistPlays: 0, newArtistPositive: 0, newArtistNegative: 0, appetite: 0.5 },
    hours: Array<number>(24).fill(0),
    recent: [],
    applied: [],
    appliedWatermark: Number.NEGATIVE_INFINITY,
    seeds: null,
  };
}

export function cloneProfile(profile: TasteProfile): TasteProfile {
  return structuredClone(profile);
}

/* ---------- track metadata ---------- */

export interface TrackMeta {
  title: string;
  artist: string;
  artistName: string;
  album: string | null;
  albumName: string | null;
  genres: string[];
  tags: string[];
  year: number | null;
  popularity: number | null;
  provider: string | null;
}

export function albumKeyOf(artistKey: string, albumId: string | null | undefined, albumName: string | null | undefined): string | null {
  if (albumId) return albumId;
  const name = normalizeText(albumName);
  return name ? `${artistKey}::${name}` : null;
}

export function emptyMeta(): TrackMeta {
  return { title: '', artist: '', artistName: '', album: null, albumName: null, genres: [], tags: [], year: null, popularity: null, provider: null };
}

/** Metadata remembered in a profile track entry, as similarity/seed input. */
export function metaFromEntry(entry: TrackEntry): TrackMeta {
  return { title: entry.label ?? '', artist: entry.artist, artistName: entry.artistName, album: entry.album, albumName: entry.albumName, genres: [...entry.genres], tags: [...entry.tags], year: entry.year, popularity: entry.popularity, provider: entry.provider };
}

export function metaFromSnapshot(t: EventTrackSnapshot | null | undefined): TrackMeta {
  if (!t) return emptyMeta();
  const artist = artistKeyOf(t.artistName, t.artistId);
  return {
    title: t.title,
    artist,
    artistName: t.artistName,
    album: albumKeyOf(artist, t.albumId, t.albumName),
    albumName: t.albumName,
    genres: normalizeGenres([t.genre]),
    tags: normalizeTags(t.tags),
    year: t.year,
    popularity: t.popularity,
    provider: t.provider,
  };
}

export function metaFromCanonical(t: CanonicalTrack): TrackMeta {
  const artist = artistKeyOf(t.artistName, t.artistId);
  return {
    title: t.title,
    artist,
    artistName: t.artistName,
    album: albumKeyOf(artist, t.albumId, t.albumName),
    albumName: t.albumName,
    genres: normalizeGenres(t.genres),
    tags: normalizeTags(t.tags),
    year: t.releaseYear,
    popularity: t.popularity,
    provider: null,
  };
}

/* ---------- event classification (action weights) ---------- */

export type ActionKind = keyof ActionWeights | 'neutral';

export interface EventAction {
  kind: ActionKind;
  weight: number;
  skip: 'immediate' | 'early' | null;
  play: boolean;
  meaningful: boolean;
}

const NEUTRAL: EventAction = { kind: 'neutral', weight: 0, skip: null, play: false, meaningful: false };

function played(kind: keyof ActionWeights, config: RecommendationConfig, extra: Partial<EventAction> = {}): EventAction {
  return { kind, weight: config.actionWeights[kind], skip: null, play: false, meaningful: false, ...extra };
}

/** Map an event to its configured action weight. Skips are graded by how much of the track was heard. */
export function classifyEvent(event: ListeningEvent, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG): EventAction {
  switch (event.type) {
    case 'started':
      return { ...NEUTRAL, play: true };
    case 'meaningful':
      return { ...NEUTRAL, meaningful: true };
    case 'skipped': {
      const t = config.skipThresholds;
      const seconds = event.secondsPlayed ?? (event.positionMs !== null ? event.positionMs / 1000 : null);
      let fraction: number | null = event.completionPercent !== null ? event.completionPercent / 100 : null;
      if (fraction === null && seconds !== null && event.track?.durationMs) fraction = (seconds * 1000) / event.track.durationMs;
      if ((fraction !== null && fraction < t.immediateFraction) || (seconds !== null && seconds < t.immediateSeconds)) return played('immediateSkip', config, { skip: 'immediate' });
      if (fraction === null || fraction < t.earlyFraction) return played('earlySkip', config, { skip: 'early' });
      if (fraction < t.partialFraction) return played('partial', config);
      return played('majority', config);
    }
    case 'completed':
      return played('completed', config, { meaningful: true });
    case 'replayed':
      return played('replay', config);
    case 'liked':
      return played('like', config);
    case 'unliked':
      return played('unlike', config);
    case 'playlist-added':
      return played('playlistAdd', config);
    case 'playlist-removed':
      return played('playlistRemove', config);
    case 'favorited':
      return played('favorite', config);
    case 'disliked':
      return played('dislike', config);
    case 'saved':
      return played('save', config);
    case 'download-completed':
      return played('download', config);
    case 'recommendation-accepted':
      return played('recommendationAccepted', config);
    case 'recommendation-dismissed':
      return played('recommendationDismissed', config);
    default:
      return NEUTRAL;
  }
}

/* ---------- decay ---------- */

/** Exponential decay multiplier for a signal `ageMs` old: 2^(-age / halfLife). */
export function decayFactor(ageMs: number, halfLifeDays: number): number {
  if (!(ageMs > 0) || !(halfLifeDays > 0)) return 1;
  return Math.pow(2, -ageMs / (halfLifeDays * DAY_MS));
}

function decayDimension(dim: Dimension, factor: number): void {
  for (const entry of Object.values(dim)) entry.w *= factor;
}

function decayTo(profile: TasteProfile, nowMs: number, config: RecommendationConfig): void {
  if (nowMs <= profile.decayedAt) return;
  const factor = decayFactor(nowMs - profile.decayedAt, config.decay.halfLifeDays);
  for (const dim of Object.values(profile.dims)) decayDimension(dim, factor);
  for (const ctx of Object.values(profile.contexts)) {
    decayDimension(ctx.artists, factor);
    decayDimension(ctx.genres, factor);
    decayDimension(ctx.tags, factor);
  }
  profile.decayedAt = nowMs;
}

function pruneDimension(dim: Dimension, max: number, nowMs: number, config: RecommendationConfig): void {
  const stale = config.decay.halfLifeDays * DAY_MS * 4;
  for (const [key, entry] of Object.entries(dim)) if (Math.abs(entry.w) < config.decay.pruneBelow && nowMs - entry.at > stale) delete dim[key];
  const keys = Object.keys(dim);
  if (keys.length <= max) return;
  keys.sort((a, b) => Math.abs(dim[b]!.w) - Math.abs(dim[a]!.w) || dim[b]!.n - dim[a]!.n || (a < b ? -1 : 1));
  for (const key of keys.slice(max)) delete dim[key];
}

function boundContexts(profile: TasteProfile, config: RecommendationConfig): void {
  const byKind: Record<ContextKind, string[]> = { playlist: [], mood: [], activity: [], time: [], session: [] };
  for (const [key, ctx] of Object.entries(profile.contexts)) byKind[ctx.kind].push(key);
  const limits: Record<ContextKind, number> = { playlist: config.limits.maxPlaylistContexts, mood: config.limits.maxMoodContexts, activity: config.limits.maxMoodContexts, time: 4, session: config.limits.maxSessionContexts };
  for (const kind of Object.keys(byKind) as ContextKind[]) {
    const keys = byKind[kind];
    if (keys.length <= limits[kind]) continue;
    keys.sort((a, b) => profile.contexts[b]!.at - profile.contexts[a]!.at || (a < b ? -1 : 1));
    for (const key of keys.slice(limits[kind])) delete profile.contexts[key];
  }
}

function compact(profile: TasteProfile, nowMs: number, config: RecommendationConfig): void {
  const l = config.limits;
  pruneDimension(profile.dims.tracks, l.maxTracks, nowMs, config);
  pruneDimension(profile.dims.artists, l.maxArtists, nowMs, config);
  pruneDimension(profile.dims.albums, l.maxAlbums, nowMs, config);
  pruneDimension(profile.dims.genres, l.maxGenres, nowMs, config);
  pruneDimension(profile.dims.tags, l.maxTags, nowMs, config);
  boundContexts(profile, config);
  if (profile.recent.length > l.recentPlays) profile.recent.splice(0, profile.recent.length - l.recentPlays);
  if (profile.applied.length > l.appliedEventIds) {
    const dropped = profile.applied.splice(0, profile.applied.length - l.appliedEventIds);
    for (const rec of dropped) if (rec.at > profile.appliedWatermark) profile.appliedWatermark = rec.at;
  }
}

/* ---------- helpers ---------- */

function newEntry(label: string | null, at: number): AffinityEntry {
  return { w: 0, n: 0, pos: 0, neg: 0, at, label };
}

function ensure(dim: Dimension, key: string, label: string | null, at: number): AffinityEntry {
  let entry = dim[key];
  if (!entry) {
    entry = newEntry(label, at);
    dim[key] = entry;
  } else {
    if (at > entry.at) entry.at = at;
    if (!entry.label && label) entry.label = label;
  }
  return entry;
}

function ensureTrack(profile: TasteProfile, trackId: string, meta: TrackMeta, at: number): TrackEntry {
  let entry = profile.dims.tracks[trackId];
  if (!entry) {
    entry = { ...newEntry(meta.title || null, at), artist: meta.artist, artistName: meta.artistName, album: meta.album, albumName: meta.albumName, genres: [...meta.genres], tags: [...meta.tags], year: meta.year, popularity: meta.popularity, provider: meta.provider };
    profile.dims.tracks[trackId] = entry;
    return entry;
  }
  if (at > entry.at) entry.at = at;
  if (!entry.label && meta.title) entry.label = meta.title;
  if (!entry.artist && meta.artist) {
    entry.artist = meta.artist;
    entry.artistName = meta.artistName;
  }
  if (!entry.album && meta.album) {
    entry.album = meta.album;
    entry.albumName = meta.albumName;
  }
  if (!entry.genres.length && meta.genres.length) entry.genres = [...meta.genres];
  if (!entry.tags.length && meta.tags.length) entry.tags = [...meta.tags];
  if (entry.year === null && meta.year !== null) entry.year = meta.year;
  if (entry.popularity === null && meta.popularity !== null) entry.popularity = meta.popularity;
  if (entry.provider === null && meta.provider !== null) entry.provider = meta.provider;
  return entry;
}

function ensureArtist(profile: TasteProfile, key: string, label: string | null, at: number): ArtistEntry {
  let entry = profile.dims.artists[key];
  if (!entry) {
    entry = { ...newEntry(label, at), completions: [] };
    profile.dims.artists[key] = entry;
  } else {
    if (at > entry.at) entry.at = at;
    if (!entry.label && label) entry.label = label;
  }
  return entry;
}

function ensureContext(profile: TasteProfile, kind: ContextKind, id: string, label: string | null, at: number): ContextProfile {
  const key = `${kind}:${id}`;
  let ctx = profile.contexts[key];
  if (!ctx) {
    ctx = { kind, id, label, n: 0, at, artists: {}, genres: {}, tags: {} };
    profile.contexts[key] = ctx;
  } else if (at > ctx.at) ctx.at = at;
  return ctx;
}

export type TimeSlot = 'morning' | 'afternoon' | 'evening' | 'night';
export const TIME_SLOTS: readonly TimeSlot[] = ['morning', 'afternoon', 'evening', 'night'];

/** Coarse time-of-day slot from an hour (0-23). Events carry UTC times; callers may pass a local hour instead. */
export function timeSlotOf(hour: number): TimeSlot {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

interface ContextRef {
  kind: ContextKind;
  id: string;
  label: string | null;
}

function contextRefs(event: ListeningEvent, at: number): ContextRef[] {
  const refs: ContextRef[] = [];
  const playlistId = event.playlistId ?? (event.contextKind === 'playlist' ? event.contextId : null);
  if (playlistId) refs.push({ kind: 'playlist', id: playlistId, label: null });
  const mood = normalizeText(event.mood);
  if (mood) refs.push({ kind: 'mood', id: mood, label: event.mood });
  const activity = normalizeText(event.activity);
  if (activity) refs.push({ kind: 'activity', id: activity, label: event.activity });
  const slot = timeSlotOf(new Date(at).getUTCHours());
  refs.push({ kind: 'time', id: slot, label: slot });
  refs.push({ kind: 'session', id: event.sessionId, label: null });
  return refs;
}

function bounded(list: number[], value: number, max: number): void {
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
}

function addSkipRecord(map: Record<string, SkipRecord[]>, key: string, trackId: string, at: number, windowMs: number, max: number): number {
  const list = map[key] ?? [];
  const existing = list.find((r) => r.trackId === trackId);
  if (existing) existing.at = Math.max(existing.at, at);
  else list.push({ trackId, at });
  const latest = list.reduce((m, r) => Math.max(m, r.at), 0);
  const kept = list.filter((r) => r.at >= latest - windowMs).sort((a, b) => a.at - b.at || (a.trackId < b.trackId ? -1 : 1));
  if (kept.length > max) kept.splice(0, kept.length - max);
  map[key] = kept;
  return kept.length;
}

function syntheticTrackId(meta: TrackMeta): string | null {
  if (!meta.title || !meta.artist) return null;
  return `meta:${meta.artist}::${normalizeText(meta.title)}`;
}

function recentEntryFor(profile: TasteProfile, trackId: string, at: number): RecentPlay | null {
  for (let i = profile.recent.length - 1; i >= 0 && i >= profile.recent.length - 50; i -= 1) {
    const r = profile.recent[i]!;
    if (r.trackId === trackId && at >= r.at) return r;
  }
  return null;
}

function recomputeAppetite(d: DiscoveryStats): void {
  const rated = d.newArtistPositive + d.newArtistNegative;
  const success = rated ? (d.newArtistPositive + 1) / (rated + 2) : 0.5;
  const plays = d.newArtistPlays + d.knownArtistPlays;
  const share = plays ? d.newArtistPlays / plays : 0.5;
  d.appetite = clamp01(0.6 * success + 0.4 * share);
}

interface Contribution {
  trackId: string;
  meta: TrackMeta;
  track: TrackEntry;
  artist: ArtistEntry | null;
  contexts: ContextProfile[];
  at: number;
  amount: number;
  firstPlay: boolean;
  completed: boolean;
}

function propagatePositive(profile: TasteProfile, c: Contribution, config: RecommendationConfig): void {
  const { track, artist, meta, at, amount } = c;
  track.w += amount;
  track.pos += 1;
  if (artist) {
    artist.w += amount;
    artist.pos += 1;
    if (c.completed) bounded(artist.completions, at, config.limits.artistHistory);
    if (c.firstPlay) profile.discovery.newArtistPositive += 1;
  }
  if (meta.album) {
    const album = ensure(profile.dims.albums, meta.album, meta.albumName, at);
    album.w += amount * 0.5;
    album.pos += 1;
  }
  for (const g of meta.genres) {
    const entry = ensure(profile.dims.genres, g, g, at);
    entry.w += (amount * 0.5) / meta.genres.length;
    entry.pos += 1;
  }
  for (const t of meta.tags) {
    const entry = ensure(profile.dims.tags, t, t, at);
    entry.w += (amount * 0.25) / meta.tags.length;
    entry.pos += 1;
  }
  const era = eraOf(meta.year);
  if (era) {
    const entry = ensure(profile.dims.eras, era, era, at);
    entry.w += amount * 0.25;
    entry.pos += 1;
  }
  const band = popularityBand(meta.popularity);
  if (band !== 'unknown') {
    const entry = ensure(profile.dims.popularity, band, band, at);
    entry.w += amount * 0.25;
    entry.pos += 1;
  }
  if (meta.provider) {
    const entry = ensure(profile.dims.platforms, meta.provider, meta.provider, at);
    entry.w += amount * 0.1;
    entry.pos += 1;
  }
  for (const ctx of c.contexts) {
    if (meta.artist) {
      const entry = ensure(ctx.artists, meta.artist, meta.artistName, at);
      entry.w += amount;
      entry.pos += 1;
    }
    for (const g of meta.genres) ensure(ctx.genres, g, g, at).w += (amount * 0.5) / meta.genres.length;
    for (const t of meta.tags) ensure(ctx.tags, t, t, at).w += (amount * 0.25) / meta.tags.length;
  }
  const recent = recentEntryFor(profile, c.trackId, at);
  if (recent) recent.w += amount;
  else profile.recent.push({ trackId: c.trackId, artist: meta.artist, genres: [...meta.genres], at, w: amount });
}

/** Negative evidence: the track always takes the hit; artist/genre only after repeated distinct-track skips. */
function propagateNegative(profile: TasteProfile, c: Contribution, config: RecommendationConfig, options: { countsAsSkip: boolean; immediate: boolean; directArtist: boolean }): void {
  const { track, artist, meta, at, amount } = c;
  track.w += amount;
  track.neg += 1;
  if (artist && c.firstPlay) profile.discovery.newArtistNegative += 1;
  if (artist) artist.neg += 1;
  const si = config.skipIntelligence;
  let artistHit = options.directArtist ? amount : 0;
  const genreHits = new Map<string, number>();
  if (options.countsAsSkip) {
    const stats = profile.skips.tracks[c.trackId] ?? { n: 0, immediate: 0, at: 0 };
    stats.n += 1;
    if (options.immediate) stats.immediate += 1;
    stats.at = Math.max(stats.at, at);
    profile.skips.tracks[c.trackId] = stats;
    const windowMs = si.windowDays * DAY_MS;
    if (meta.artist) {
      const distinct = addSkipRecord(profile.skips.artists, meta.artist, c.trackId, at, windowMs, config.limits.skipRecords);
      if (distinct >= si.artistDistinctTracks && !options.directArtist) artistHit = amount * si.artistShare;
    }
    for (const g of meta.genres) {
      const distinct = addSkipRecord(profile.skips.genres, g, c.trackId, at, windowMs, config.limits.skipRecords);
      if (distinct >= si.genreDistinctTracks) genreHits.set(g, (amount * si.genreShare) / meta.genres.length);
    }
  }
  if (artist && artistHit !== 0) {
    artist.w += artistHit;
    for (const ctx of c.contexts) if (meta.artist) ensure(ctx.artists, meta.artist, meta.artistName, at).w += artistHit;
  }
  for (const [g, hit] of genreHits) {
    const entry = ensure(profile.dims.genres, g, g, at);
    entry.w += hit;
    entry.neg += 1;
    for (const ctx of c.contexts) ensure(ctx.genres, g, g, at).w += hit;
  }
  const recent = recentEntryFor(profile, c.trackId, at);
  if (recent) recent.w += amount;
}

function applyOne(profile: TasteProfile, event: ListeningEvent, config: RecommendationConfig, nowMs: number): void {
  const at = toMs(event.occurredAt);
  profile.eventCount += 1;
  profile.lastEventAt = profile.lastEventAt === null ? at : Math.max(profile.lastEventAt, at);
  const action = classifyEvent(event, config);
  const meta = metaFromSnapshot(event.track);
  const trackId = event.trackId ?? syntheticTrackId(meta);
  if (!trackId) return;
  const track = ensureTrack(profile, trackId, meta, at);
  const artist = track.artist ? ensureArtist(profile, track.artist, track.artistName || null, at) : null;
  const artistWasNew = artist !== null && artist.n === 0;
  const contexts = contextRefs(event, at).map((ref) => ensureContext(profile, ref.kind, ref.id, ref.label, at));
  if (action.play) {
    track.n += 1;
    if (artist) {
      artist.n += 1;
      if (artistWasNew) profile.discovery.newArtistPlays += 1;
      else profile.discovery.knownArtistPlays += 1;
    }
    if (meta.album) ensure(profile.dims.albums, meta.album, meta.albumName, at).n += 1;
    for (const g of meta.genres) ensure(profile.dims.genres, g, g, at).n += 1;
    for (const t of meta.tags) ensure(profile.dims.tags, t, t, at).n += 1;
    const era = eraOf(meta.year);
    if (era) ensure(profile.dims.eras, era, era, at).n += 1;
    const band = popularityBand(meta.popularity);
    if (band !== 'unknown') ensure(profile.dims.popularity, band, band, at).n += 1;
    if (meta.provider) ensure(profile.dims.platforms, meta.provider, meta.provider, at).n += 1;
    const hour = new Date(at).getUTCHours();
    profile.hours[hour] = (profile.hours[hour] ?? 0) + 1;
    for (const ctx of contexts) ctx.n += 1;
    profile.recent.push({ trackId, artist: meta.artist, genres: [...meta.genres], at, w: 0 });
  }
  if (action.meaningful) profile.meaningfulCount += 1;
  if (action.weight === 0) return;
  const amount = action.weight * decayFactor(nowMs - at, config.decay.halfLifeDays);
  const contribution: Contribution = { trackId, meta, track, artist, contexts, at, amount, firstPlay: artist !== null && artist.n <= 1, completed: action.kind === 'completed' };
  if (amount > 0) propagatePositive(profile, contribution, config);
  else propagateNegative(profile, contribution, config, { countsAsSkip: action.skip !== null || action.kind === 'dislike', immediate: action.skip === 'immediate', directArtist: false });
  recomputeAppetite(profile.discovery);
}

function sortEvents(events: readonly ListeningEvent[]): ListeningEvent[] {
  return [...events].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Fold listening events into a profile. Returns a new profile (the input is not mutated).
 * Idempotent on event ids within the retained ring; events older than the ring watermark are ignored.
 * Decay is applied lazily up to `now`; contributions are pre-decayed by their age.
 */
export function applyEvents(profile: TasteProfile, events: readonly ListeningEvent[], config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG, now: Timestamp = Date.now()): TasteProfile {
  const nowMs = toMs(now);
  const next = cloneProfile(profile);
  decayTo(next, nowMs, config);
  const applied = new Set(next.applied.map((r) => r.id));
  for (const event of sortEvents(events)) {
    if (applied.has(event.id)) continue;
    const at = toMs(event.occurredAt);
    if (at <= next.appliedWatermark) continue;
    applied.add(event.id);
    next.applied.push({ id: event.id, at });
    applyOne(next, event, config, nowMs);
  }
  compact(next, nowMs, config);
  next.updatedAt = Math.max(next.updatedAt, nowMs);
  return next;
}

/* ---------- feedback ---------- */

export interface FeedbackInput {
  trackId: string;
  feedback: RecommendationFeedback;
  recommendationId?: string;
  title?: string | null;
  artistId?: string | null;
  artistName?: string | null;
  albumName?: string | null;
  genres?: readonly string[] | null;
  tags?: readonly string[] | null;
  year?: number | null;
  popularity?: number | null;
}

function metaFromFeedback(profile: TasteProfile, input: FeedbackInput): TrackMeta {
  const existing = profile.dims.tracks[input.trackId];
  const artistName = input.artistName ?? existing?.artistName ?? '';
  const artist = artistKeyOf(artistName, input.artistId) || existing?.artist || '';
  return {
    title: input.title ?? existing?.label ?? '',
    artist,
    artistName,
    album: existing?.album ?? albumKeyOf(artist, null, input.albumName),
    albumName: input.albumName ?? existing?.albumName ?? null,
    genres: input.genres?.length ? normalizeGenres(input.genres) : (existing?.genres ?? []),
    tags: input.tags?.length ? normalizeTags(input.tags) : (existing?.tags ?? []),
    year: input.year ?? existing?.year ?? null,
    popularity: input.popularity ?? existing?.popularity ?? null,
    provider: existing?.provider ?? null,
  };
}

/** Like / Not for me / Less from this artist / Already know it / Dismiss / Accepted. Idempotent per recommendation id. */
export function applyFeedback(profile: TasteProfile, input: FeedbackInput, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG, now: Timestamp = Date.now()): TasteProfile {
  const nowMs = toMs(now);
  const next = cloneProfile(profile);
  decayTo(next, nowMs, config);
  const dedupeKey = input.recommendationId ? `fb:${input.recommendationId}:${input.feedback}` : null;
  if (dedupeKey && next.applied.some((r) => r.id === dedupeKey)) return next;
  if (dedupeKey) next.applied.push({ id: dedupeKey, at: nowMs });
  const meta = metaFromFeedback(next, input);
  const track = ensureTrack(next, input.trackId, meta, nowMs);
  const artist = track.artist ? ensureArtist(next, track.artist, track.artistName || null, nowMs) : null;
  const w = config.actionWeights;
  const base: Omit<Contribution, 'amount'> = { trackId: input.trackId, meta, track, artist, contexts: [], at: nowMs, firstPlay: false, completed: false };
  switch (input.feedback) {
    case 'like':
      propagatePositive(next, { ...base, amount: w.like }, config);
      break;
    case 'accepted':
      propagatePositive(next, { ...base, amount: w.recommendationAccepted }, config);
      break;
    case 'not-for-me':
      propagateNegative(next, { ...base, amount: w.dislike }, config, { countsAsSkip: true, immediate: false, directArtist: false });
      break;
    case 'less-from-artist':
      propagateNegative(next, { ...base, amount: w.dislike }, config, { countsAsSkip: true, immediate: false, directArtist: true });
      break;
    case 'already-know':
      track.n += 1;
      if (artist) {
        artist.n += 1;
        artist.w += w.recommendationAccepted;
      }
      next.recent.push({ trackId: input.trackId, artist: meta.artist, genres: [...meta.genres], at: nowMs, w: 0 });
      break;
    case 'dismiss':
      propagateNegative(next, { ...base, amount: w.recommendationDismissed }, config, { countsAsSkip: false, immediate: false, directArtist: false });
      break;
    default:
      break;
  }
  next.eventCount += 1;
  compact(next, nowMs, config);
  next.updatedAt = Math.max(next.updatedAt, nowMs);
  return next;
}

/* ---------- seeds ---------- */

export interface SeedInput {
  artists?: readonly string[];
  genres?: readonly string[];
  likedTrackIds?: readonly string[];
  /** Optional metadata for the liked track ids so likes propagate to artists and genres. */
  tracks?: readonly CanonicalTrack[];
}

/** Cold-start seeds: each artist, genre and liked track counts as one "like". Re-applying the same seed is a no-op. */
export function applySeeds(profile: TasteProfile, seeds: SeedInput, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG, now: Timestamp = Date.now()): TasteProfile {
  const nowMs = toMs(now);
  const next = cloneProfile(profile);
  decayTo(next, nowMs, config);
  const applied = new Set(next.applied.map((r) => r.id));
  const mark = (key: string): boolean => {
    if (applied.has(key)) return false;
    applied.add(key);
    next.applied.push({ id: key, at: nowMs });
    return true;
  };
  const stored: ProfileSeeds = next.seeds ?? { artists: [], genres: [], likedTrackIds: [] };
  const like = config.actionWeights.like;
  for (const name of seeds.artists ?? []) {
    const key = artistKeyOf(name);
    if (!key || !mark(`seed:artist:${key}`)) continue;
    const entry = ensureArtist(next, key, name.trim(), nowMs);
    entry.w += like;
    entry.pos += 1;
    stored.artists.push(name.trim());
  }
  for (const genre of normalizeGenres(seeds.genres ?? [])) {
    if (!mark(`seed:genre:${genre}`)) continue;
    const entry = ensure(next.dims.genres, genre, genre, nowMs);
    entry.w += like;
    entry.pos += 1;
    stored.genres.push(genre);
  }
  const byId = new Map((seeds.tracks ?? []).map((t) => [t.id, t] as const));
  for (const trackId of seeds.likedTrackIds ?? []) {
    if (!mark(`seed:track:${trackId}`)) continue;
    const canonical = byId.get(trackId);
    const existing = next.dims.tracks[trackId];
    const resolved: TrackMeta = canonical ? metaFromCanonical(canonical) : existing ? metaFromEntry(existing) : emptyMeta();
    const track = ensureTrack(next, trackId, resolved, nowMs);
    const artist = track.artist ? ensureArtist(next, track.artist, track.artistName || null, nowMs) : null;
    propagatePositive(next, { trackId, meta: resolved, track, artist, contexts: [], at: nowMs, amount: like, firstPlay: false, completed: false }, config);
    stored.likedTrackIds.push(trackId);
  }
  next.seeds = stored;
  compact(next, nowMs, config);
  next.updatedAt = Math.max(next.updatedAt, nowMs);
  return next;
}

/* ---------- queries ---------- */

export function maxPositiveWeight(dim: Dimension): number {
  let max = 0;
  for (const entry of Object.values(dim)) if (entry.w > max) max = entry.w;
  return max;
}

/** Weight relative to the strongest positive entry of its dimension, clamped to [-1, 1]. */
export function normalizedWeight(entry: AffinityEntry | undefined, max: number): number {
  if (!entry || max <= 0) return 0;
  const v = entry.w / max;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

export interface RankedKey {
  key: string;
  label: string;
  weight: number;
}

/** Top entries of a dimension by positive weight, normalised to the strongest entry. */
export function topEntries(dim: Dimension, limit: number): RankedKey[] {
  const max = maxPositiveWeight(dim);
  if (max <= 0) return [];
  return Object.entries(dim)
    .filter(([, e]) => e.w > 0)
    .sort(([ka, a], [kb, b]) => b.w - a.w || b.n - a.n || (ka < kb ? -1 : 1))
    .slice(0, limit)
    .map(([key, e]) => ({ key, label: e.label ?? key, weight: round(e.w / max) }));
}

export function positiveArtistCount(profile: TasteProfile): number {
  return Object.values(profile.dims.artists).filter((a) => a.w > 0).length;
}

/** Too little evidence to personalise: fall back to seeds, popularity and genre spread. */
export function isColdStart(profile: TasteProfile, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG): boolean {
  return profile.eventCount < config.coldStart.minEvents || profile.meaningfulCount < config.coldStart.minMeaningfulListens || positiveArtistCount(profile) < config.coldStart.minArtists;
}

/** Preferred popularity (0..1) from the popularity-band dimension; 0.5 when unknown. */
export function popularityPreference(profile: TasteProfile): number {
  let total = 0;
  let sum = 0;
  for (const [band, entry] of Object.entries(profile.dims.popularity)) {
    if (entry.w <= 0) continue;
    total += entry.w;
    sum += entry.w * POPULARITY_BAND_CENTRE[band as PopularityBand];
  }
  return total > 0 ? sum / total : 0.5;
}

export function discoveryAppetite(profile: TasteProfile): number {
  return profile.discovery.appetite;
}

/** Recent plays within `days` of `now` (newest last). */
export function recentPlays(profile: TasteProfile, now: Timestamp, days: number): RecentPlay[] {
  const cutoff = toMs(now) - days * DAY_MS;
  return profile.recent.filter((r) => r.at >= cutoff);
}

/* ---------- serialisation ---------- */

export function serializeProfile(profile: TasteProfile): string {
  return JSON.stringify(profile);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function readEntry(raw: unknown, key: string): AffinityEntry | null {
  if (!isRecord(raw)) return null;
  return { w: num(raw.w, 0), n: num(raw.n, 0), pos: num(raw.pos, 0), neg: num(raw.neg, 0), at: num(raw.at, 0), label: str(raw.label, key) };
}

function readDimension(raw: unknown): Dimension {
  const out: Dimension = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const entry = readEntry(value, key);
    if (entry) out[key] = entry;
  }
  return out;
}

function readTracks(raw: unknown): Dimension<TrackEntry> {
  const out: Dimension<TrackEntry> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const entry = readEntry(value, key);
    if (!entry || !isRecord(value)) continue;
    out[key] = {
      ...entry,
      label: str(value.label, null),
      artist: str(value.artist, '') ?? '',
      artistName: str(value.artistName, '') ?? '',
      album: str(value.album, null),
      albumName: str(value.albumName, null),
      genres: strings(value.genres),
      tags: strings(value.tags),
      year: typeof value.year === 'number' ? value.year : null,
      popularity: typeof value.popularity === 'number' ? value.popularity : null,
      provider: str(value.provider, null),
    };
  }
  return out;
}

function readArtists(raw: unknown): Dimension<ArtistEntry> {
  const out: Dimension<ArtistEntry> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const entry = readEntry(value, key);
    if (!entry || !isRecord(value)) continue;
    out[key] = { ...entry, completions: Array.isArray(value.completions) ? value.completions.filter((v): v is number => typeof v === 'number') : [] };
  }
  return out;
}

function readSkipRecords(raw: unknown): Record<string, SkipRecord[]> {
  const out: Record<string, SkipRecord[]> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    out[key] = value.filter((r): r is SkipRecord => isRecord(r) && typeof r.trackId === 'string' && typeof r.at === 'number');
  }
  return out;
}

/** Parse a stored profile. Missing fields get defaults (forward compatible); unknown fields are dropped. */
export function deserializeProfile(input: string | unknown): TasteProfile {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (cause) {
      throw new DomainError('validation', 'Taste profile is not valid JSON', { cause });
    }
  }
  if (!isRecord(raw)) throw new DomainError('validation', 'Taste profile must be an object');
  const version = num(raw.version, 0);
  if (version > PROFILE_VERSION) throw new DomainError('upgrade-required', `Taste profile version ${version} is newer than supported ${PROFILE_VERSION}`);
  if (typeof raw.userId !== 'string' || !raw.userId) throw new DomainError('validation', 'Taste profile is missing userId');
  const base = createProfile(raw.userId, num(raw.createdAt, 0));
  const dims = isRecord(raw.dims) ? raw.dims : {};
  const contexts: Record<string, ContextProfile> = {};
  if (isRecord(raw.contexts)) {
    for (const [key, value] of Object.entries(raw.contexts)) {
      if (!isRecord(value)) continue;
      const kind = value.kind;
      if (kind !== 'playlist' && kind !== 'mood' && kind !== 'activity' && kind !== 'time' && kind !== 'session') continue;
      contexts[key] = { kind, id: str(value.id, key) ?? key, label: str(value.label, null), n: num(value.n, 0), at: num(value.at, 0), artists: readDimension(value.artists), genres: readDimension(value.genres), tags: readDimension(value.tags) };
    }
  }
  const skips = isRecord(raw.skips) ? raw.skips : {};
  const trackSkips: Record<string, TrackSkipStats> = {};
  if (isRecord(skips.tracks)) for (const [key, value] of Object.entries(skips.tracks)) if (isRecord(value)) trackSkips[key] = { n: num(value.n, 0), immediate: num(value.immediate, 0), at: num(value.at, 0) };
  const discovery = isRecord(raw.discovery) ? raw.discovery : {};
  const hours = Array.isArray(raw.hours) && raw.hours.length === 24 ? raw.hours.map((h) => num(h, 0)) : base.hours;
  const seeds = isRecord(raw.seeds) ? { artists: strings(raw.seeds.artists), genres: strings(raw.seeds.genres), likedTrackIds: strings(raw.seeds.likedTrackIds) } : null;
  const profile: TasteProfile = {
    ...base,
    version: PROFILE_VERSION,
    updatedAt: num(raw.updatedAt, base.createdAt),
    decayedAt: num(raw.decayedAt, base.createdAt),
    eventCount: num(raw.eventCount, 0),
    meaningfulCount: num(raw.meaningfulCount, 0),
    lastEventAt: typeof raw.lastEventAt === 'number' ? raw.lastEventAt : null,
    dims: { tracks: readTracks(dims.tracks), artists: readArtists(dims.artists), albums: readDimension(dims.albums), genres: readDimension(dims.genres), tags: readDimension(dims.tags), eras: readDimension(dims.eras), popularity: readDimension(dims.popularity), platforms: readDimension(dims.platforms) },
    contexts,
    skips: { tracks: trackSkips, artists: readSkipRecords(skips.artists), genres: readSkipRecords(skips.genres) },
    discovery: { newArtistPlays: num(discovery.newArtistPlays, 0), knownArtistPlays: num(discovery.knownArtistPlays, 0), newArtistPositive: num(discovery.newArtistPositive, 0), newArtistNegative: num(discovery.newArtistNegative, 0), appetite: num(discovery.appetite, 0.5) },
    hours,
    recent: Array.isArray(raw.recent) ? raw.recent.filter((r): r is RecentPlay => isRecord(r) && typeof r.trackId === 'string' && typeof r.at === 'number').map((r) => ({ trackId: r.trackId, artist: str(r.artist, '') ?? '', genres: strings(r.genres), at: r.at, w: num(r.w, 0) })) : [],
    applied: Array.isArray(raw.applied) ? raw.applied.filter((r): r is AppliedRecord => isRecord(r) && typeof r.id === 'string' && typeof r.at === 'number').map((r) => ({ id: r.id, at: r.at })) : [],
    appliedWatermark: typeof raw.appliedWatermark === 'number' ? raw.appliedWatermark : Number.NEGATIVE_INFINITY,
    seeds,
  };
  return profile;
}

/* ---------- explainable view ---------- */

export interface SkipPattern {
  kind: 'artist' | 'genre' | 'track';
  key: string;
  label: string;
  distinctTracks: number;
  skips: number;
  lastAt: string;
  affectsAffinity: boolean;
}

export interface ContextView {
  kind: ContextKind;
  id: string;
  name: string | null;
  eventCount: number;
  topArtists: RankedKey[];
  topGenres: RankedKey[];
}

export interface ProfileView {
  ownerId: string;
  computedAt: string;
  eventCount: number;
  meaningfulListens: number;
  coldStart: boolean;
  dimensions: Record<string, RankedKey[]>;
  contexts: ContextView[];
  discoveryPreference: number;
  popularityPreference: number;
  skipPatterns: SkipPattern[];
  topTracks: RankedKey[];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Compact, explainable summary: normalised top entries per dimension, contexts, skip patterns and appetite. */
export function profileView(profile: TasteProfile, config: RecommendationConfig = DEFAULT_RECOMMENDATION_CONFIG, options: { limit?: number } = {}): ProfileView {
  const limit = options.limit ?? 20;
  const dimensions: Record<string, RankedKey[]> = {
    artists: topEntries(profile.dims.artists, limit),
    genres: topEntries(profile.dims.genres, limit),
    tags: topEntries(profile.dims.tags, limit),
    albums: topEntries(profile.dims.albums, limit),
    eras: topEntries(profile.dims.eras, limit),
    popularity: topEntries(profile.dims.popularity, limit),
    platforms: topEntries(profile.dims.platforms, limit),
  };
  const contexts = Object.values(profile.contexts)
    .filter((ctx) => ctx.kind !== 'session')
    .sort((a, b) => b.n - a.n || b.at - a.at || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map((ctx) => ({ kind: ctx.kind, id: ctx.id, name: ctx.label, eventCount: ctx.n, topArtists: topEntries(ctx.artists, 5), topGenres: topEntries(ctx.genres, 5) }));
  const si = config.skipIntelligence;
  const skipPatterns: SkipPattern[] = [];
  for (const [key, records] of Object.entries(profile.skips.artists)) {
    if (!records.length) continue;
    const lastAt = Math.max(...records.map((r) => r.at));
    skipPatterns.push({ kind: 'artist', key, label: profile.dims.artists[key]?.label ?? key, distinctTracks: records.length, skips: profile.dims.artists[key]?.neg ?? records.length, lastAt: new Date(lastAt).toISOString(), affectsAffinity: records.length >= si.artistDistinctTracks });
  }
  for (const [key, records] of Object.entries(profile.skips.genres)) {
    if (!records.length) continue;
    const lastAt = Math.max(...records.map((r) => r.at));
    skipPatterns.push({ kind: 'genre', key, label: key, distinctTracks: records.length, skips: records.length, lastAt: new Date(lastAt).toISOString(), affectsAffinity: records.length >= si.genreDistinctTracks });
  }
  for (const [key, stats] of Object.entries(profile.skips.tracks)) {
    if (stats.n < 2) continue;
    skipPatterns.push({ kind: 'track', key, label: profile.dims.tracks[key]?.label ?? key, distinctTracks: 1, skips: stats.n, lastAt: new Date(stats.at).toISOString(), affectsAffinity: true });
  }
  skipPatterns.sort((a, b) => b.distinctTracks - a.distinctTracks || b.skips - a.skips || (a.key < b.key ? -1 : 1));
  return {
    ownerId: profile.userId,
    computedAt: new Date(profile.updatedAt).toISOString(),
    eventCount: profile.eventCount,
    meaningfulListens: profile.meaningfulCount,
    coldStart: isColdStart(profile, config),
    dimensions,
    contexts,
    discoveryPreference: round(profile.discovery.appetite),
    popularityPreference: round(popularityPreference(profile)),
    skipPatterns: skipPatterns.slice(0, limit),
    topTracks: topEntries(profile.dims.tracks, limit),
  };
}

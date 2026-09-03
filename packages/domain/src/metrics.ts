import type { AggregateTasteProfile, ListeningEvent } from '@now-playing/contracts';
import { dayKey, decadeOf, isoWeekKey, monthKey } from './time.js';

/** Documented thresholds: a listen is "meaningful" after 30 s or 50 % of a short track, whichever comes first. */
export const MEANINGFUL_LISTEN_SECONDS = 30;
export const MEANINGFUL_LISTEN_FRACTION = 0.5;
export const SESSION_GAP_MINUTES = 30;
export const EARLY_SKIP_SECONDS = 10;
export const COMPLETION_FRACTION = 0.9;

export function isMeaningfulListen(secondsPlayed: number, durationMs: number | null): boolean {
  if (secondsPlayed >= MEANINGFUL_LISTEN_SECONDS) return true;
  if (durationMs && durationMs > 0) return secondsPlayed * 1000 >= durationMs * MEANINGFUL_LISTEN_FRACTION;
  return false;
}

export interface RankedEntry {
  key: string;
  label: string;
  plays: number;
  minutes: number;
  completions: number;
  skips: number;
}

export interface TrendPoint {
  key: string;
  minutes: number;
  plays: number;
  completions: number;
  skips: number;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  endedAt: string;
  minutes: number;
  plays: number;
}

export interface ListeningMetrics {
  windowStart: string | null;
  windowEnd: string | null;
  eventCount: number;
  plays: number;
  meaningfulListens: number;
  completions: number;
  skips: number;
  earlySkips: number;
  replays: number;
  likes: number;
  completionRate: number;
  skipRate: number;
  totalMinutes: number;
  topArtists: RankedEntry[];
  topAlbums: RankedEntry[];
  topSongs: RankedEntry[];
  topGenres: RankedEntry[];
  byDay: TrendPoint[];
  byWeek: TrendPoint[];
  byMonth: TrendPoint[];
  hourOfDay: number[];
  sessions: SessionSummary[];
  averageSessionMinutes: number;
  currentStreakDays: number;
  longestStreakDays: number;
  discoveryRate: number;
  familiarRate: number;
  sourceMix: RankedEntry[];
  playlistUsage: RankedEntry[];
  presetUsage: RankedEntry[];
  unknownGenrePercent: number;
  coverage: { withGenre: number; withYear: number; withDuration: number; total: number };
  recommendations: { shown: number; accepted: number; dismissed: number; acceptanceRate: number };
}

interface Acc { key: string; label: string; plays: number; minutes: number; completions: number; skips: number }

function bump(map: Map<string, Acc>, key: string | null | undefined, label: string | null | undefined, field: keyof Omit<Acc, 'key' | 'label'>, amount = 1): void {
  if (!key) return;
  const acc = map.get(key) ?? { key, label: label ?? key, plays: 0, minutes: 0, completions: 0, skips: 0 };
  acc[field] += amount;
  map.set(key, acc);
}

function ranked(map: Map<string, Acc>, limit: number): RankedEntry[] {
  return [...map.values()].sort((a, b) => b.minutes - a.minutes || b.plays - a.plays || a.key.localeCompare(b.key)).slice(0, limit);
}

function trend(map: Map<string, TrendPoint>, key: string): TrendPoint {
  const p = map.get(key) ?? { key, minutes: 0, plays: 0, completions: 0, skips: 0 };
  map.set(key, p);
  return p;
}

/** Derive metrics from append-only events. Deterministic for a given event list. */
export function computeListeningMetrics(events: readonly ListeningEvent[], options: { topN?: number; firstSeenArtists?: ReadonlySet<string> } = {}): ListeningMetrics {
  const topN = options.topN ?? 10;
  const sorted = [...events].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  const artists = new Map<string, Acc>();
  const albums = new Map<string, Acc>();
  const songs = new Map<string, Acc>();
  const genres = new Map<string, Acc>();
  const sources = new Map<string, Acc>();
  const playlists = new Map<string, Acc>();
  const presets = new Map<string, Acc>();
  const byDay = new Map<string, TrendPoint>();
  const byWeek = new Map<string, TrendPoint>();
  const byMonth = new Map<string, TrendPoint>();
  const hourOfDay = Array<number>(24).fill(0);
  let plays = 0, meaningful = 0, completions = 0, skips = 0, earlySkips = 0, replays = 0, likes = 0, totalMinutes = 0;
  let recShown = 0, recAccepted = 0, recDismissed = 0;
  const knownArtists = new Set<string>(options.firstSeenArtists ?? []);
  let discovery = 0, familiar = 0;
  const coverage = { withGenre: 0, withYear: 0, withDuration: 0, total: 0 };
  const sessions: SessionSummary[] = [];
  let session: SessionSummary | null = null;
  const days = new Set<string>();

  for (const e of sorted) {
    const t = e.track;
    const artistKey = t ? `artist:${(t.artistId ?? t.artistName).toLowerCase()}` : null;
    const albumKey = t?.albumName ? `album:${(t.albumId ?? `${t.artistName}::${t.albumName}`).toLowerCase()}` : null;
    const songKey = e.trackId ? `song:${e.trackId}` : t ? `song:${t.artistName}::${t.title}`.toLowerCase() : null;
    const genreKey = t?.genre ? `genre:${t.genre.toLowerCase()}` : null;
    const minutesOf = (e.secondsPlayed ?? 0) / 60;

    if (e.type === 'started') {
      plays += 1;
      coverage.total += 1;
      if (t?.genre) coverage.withGenre += 1;
      if (t?.year) coverage.withYear += 1;
      if (t?.durationMs) coverage.withDuration += 1;
      const hour = new Date(Date.parse(e.occurredAt)).getUTCHours();
      hourOfDay[hour] = (hourOfDay[hour] ?? 0) + 1;
      bump(artists, artistKey, t?.artistName, 'plays');
      bump(albums, albumKey, t?.albumName, 'plays');
      bump(songs, songKey, t ? `${t.title} — ${t.artistName}` : null, 'plays');
      bump(genres, genreKey, t?.genre, 'plays');
      bump(sources, `source:${t?.provider ?? 'local'}`, t?.provider ?? 'local', 'plays');
      if (e.playlistId) bump(playlists, `playlist:${e.playlistId}`, e.playlistId, 'plays');
      if (e.presetId) bump(presets, `preset:${e.presetId}`, e.presetId, 'plays');
      trend(byDay, dayKey(e.occurredAt)).plays += 1;
      trend(byWeek, isoWeekKey(e.occurredAt)).plays += 1;
      trend(byMonth, monthKey(e.occurredAt)).plays += 1;
      if (artistKey) {
        if (knownArtists.has(artistKey)) familiar += 1;
        else {
          discovery += 1;
          knownArtists.add(artistKey);
        }
      }
      const ts = Date.parse(e.occurredAt);
      if (!session || ts - Date.parse(session.endedAt) > SESSION_GAP_MINUTES * 60000) {
        session = { id: e.sessionId, startedAt: e.occurredAt, endedAt: e.occurredAt, minutes: 0, plays: 0 };
        sessions.push(session);
      }
      session.plays += 1;
      session.endedAt = e.occurredAt;
      days.add(dayKey(e.occurredAt));
    }
    if (e.type === 'meaningful') meaningful += 1;
    if (e.type === 'completed' || e.type === 'skipped' || e.type === 'meaningful' || e.type === 'paused') {
      if (e.secondsPlayed && (e.type === 'completed' || e.type === 'skipped')) {
        totalMinutes += minutesOf;
        bump(artists, artistKey, t?.artistName, 'minutes', minutesOf);
        bump(albums, albumKey, t?.albumName, 'minutes', minutesOf);
        bump(songs, songKey, null, 'minutes', minutesOf);
        bump(genres, genreKey, t?.genre, 'minutes', minutesOf);
        bump(sources, `source:${t?.provider ?? 'local'}`, t?.provider ?? 'local', 'minutes', minutesOf);
        if (e.playlistId) bump(playlists, `playlist:${e.playlistId}`, e.playlistId, 'minutes', minutesOf);
        if (e.presetId) bump(presets, `preset:${e.presetId}`, e.presetId, 'minutes', minutesOf);
        trend(byDay, dayKey(e.occurredAt)).minutes += minutesOf;
        trend(byWeek, isoWeekKey(e.occurredAt)).minutes += minutesOf;
        trend(byMonth, monthKey(e.occurredAt)).minutes += minutesOf;
        if (session) {
          session.minutes += minutesOf;
          session.endedAt = e.occurredAt;
        }
      }
    }
    if (e.type === 'completed') {
      completions += 1;
      bump(artists, artistKey, null, 'completions');
      bump(songs, songKey, null, 'completions');
      trend(byDay, dayKey(e.occurredAt)).completions += 1;
      trend(byWeek, isoWeekKey(e.occurredAt)).completions += 1;
      trend(byMonth, monthKey(e.occurredAt)).completions += 1;
    }
    if (e.type === 'skipped') {
      skips += 1;
      if ((e.secondsPlayed ?? 0) < EARLY_SKIP_SECONDS) earlySkips += 1;
      bump(artists, artistKey, null, 'skips');
      bump(songs, songKey, null, 'skips');
      trend(byDay, dayKey(e.occurredAt)).skips += 1;
      trend(byWeek, isoWeekKey(e.occurredAt)).skips += 1;
      trend(byMonth, monthKey(e.occurredAt)).skips += 1;
    }
    if (e.type === 'replayed') replays += 1;
    if (e.type === 'liked') likes += 1;
    if (e.type === 'recommendation-shown') recShown += 1;
    if (e.type === 'recommendation-accepted') recAccepted += 1;
    if (e.type === 'recommendation-dismissed') recDismissed += 1;
  }

  const sortedDays = [...days].sort();
  let longest = 0, current = 0, run = 0, prev: string | null = null;
  for (const d of sortedDays) {
    if (prev && Date.parse(d) - Date.parse(prev) === 86400000) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  const last = sortedDays[sortedDays.length - 1];
  if (last) {
    const lastMs = Date.parse(last);
    current = run;
    const endMs = Date.parse(sorted[sorted.length - 1]!.occurredAt.slice(0, 10));
    if (endMs - lastMs > 86400000) current = 0;
  }
  const terminal = completions + skips;
  const total = discovery + familiar;
  const hourTotal = hourOfDay.reduce((a, b) => a + b, 0) || 1;
  return {
    windowStart: sorted[0]?.occurredAt ?? null,
    windowEnd: sorted[sorted.length - 1]?.occurredAt ?? null,
    eventCount: events.length,
    plays,
    meaningfulListens: meaningful,
    completions,
    skips,
    earlySkips,
    replays,
    likes,
    completionRate: terminal ? completions / terminal : 0,
    skipRate: terminal ? skips / terminal : 0,
    totalMinutes,
    topArtists: ranked(artists, topN),
    topAlbums: ranked(albums, topN),
    topSongs: ranked(songs, topN),
    topGenres: ranked(genres, topN),
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byWeek: [...byWeek.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byMonth: [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key)),
    hourOfDay: hourOfDay.map((h) => h / hourTotal),
    sessions,
    averageSessionMinutes: sessions.length ? sessions.reduce((a, s) => a + s.minutes, 0) / sessions.length : 0,
    currentStreakDays: current,
    longestStreakDays: longest,
    discoveryRate: total ? discovery / total : 0,
    familiarRate: total ? familiar / total : 0,
    sourceMix: ranked(sources, topN),
    playlistUsage: ranked(playlists, topN),
    presetUsage: ranked(presets, topN),
    unknownGenrePercent: coverage.total ? ((coverage.total - coverage.withGenre) / coverage.total) * 100 : 0,
    coverage,
    recommendations: { shown: recShown, accepted: recAccepted, dismissed: recDismissed, acceptanceRate: recShown ? recAccepted / recShown : 0 },
  };
}

export const AGGREGATE_MIN_SAMPLE = 20;

/** Build a privacy-preserving aggregate: normalized weights, no titles, no timestamps. */
export function buildAggregateProfile(events: readonly ListeningEvent[], options: { id: string; ownerId: string; windowDays: number; now: string; minSample?: number }): AggregateTasteProfile {
  const minSample = options.minSample ?? AGGREGATE_MIN_SAMPLE;
  const cutoff = Date.parse(options.now) - options.windowDays * 86400000;
  const recent = events.filter((e) => Date.parse(e.occurredAt) >= cutoff);
  const m = computeListeningMetrics(recent, { topN: 200 });
  const norm = (entries: RankedEntry[], limit: number) => {
    const max = Math.max(1e-9, ...entries.map((e) => e.minutes || e.plays));
    return entries.slice(0, limit).map((e) => ({ key: e.label.toLowerCase(), weight: Math.min(1, (e.minutes || e.plays) / max) }));
  };
  const eras = new Map<string, number>();
  for (const e of recent) if (e.type === 'started' && e.track?.year) eras.set(decadeOf(e.track.year)!, (eras.get(decadeOf(e.track.year)!) ?? 0) + 1);
  const eraMax = Math.max(1, ...eras.values());
  return {
    id: options.id,
    schemaVersion: 1,
    ownerId: options.ownerId,
    computedAt: options.now,
    windowDays: options.windowDays,
    sampleSize: m.meaningfulListens,
    minSampleMet: m.meaningfulListens >= minSample,
    artists: norm(m.topArtists, 200),
    genres: norm(m.topGenres, 100),
    albums: norm(m.topAlbums, 200),
    eras: [...eras.entries()].map(([key, n]) => ({ key, weight: n / eraMax })).slice(0, 20),
    discoveryRate: m.discoveryRate,
    listeningPattern: m.hourOfDay,
    sources: norm(m.sourceMix, 20),
  };
}

export interface AggregateComparison {
  overlapPercent: { artists: number; albums: number; genres: number; eras: number };
  discoveryRate: { mine: number; group: number };
  listeningPatternSimilarity: number;
  newToMe: Array<{ key: string; kind: 'artist' | 'album' | 'genre'; weight: number }>;
  incompleteData: string[];
}

function weightedJaccard(a: readonly { key: string; weight: number }[], b: readonly { key: string; weight: number }[]): number {
  const mapA = new Map(a.map((x) => [x.key, x.weight]));
  const mapB = new Map(b.map((x) => [x.key, x.weight]));
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  let inter = 0, union = 0;
  for (const k of keys) {
    const wa = mapA.get(k) ?? 0, wb = mapB.get(k) ?? 0;
    inter += Math.min(wa, wb);
    union += Math.max(wa, wb);
  }
  return union ? inter / union : 0;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Compare my aggregate with another aggregate (or a merged group aggregate). Never exposes raw timelines. */
export function compareAggregates(mine: AggregateTasteProfile, other: AggregateTasteProfile, limit = 20): AggregateComparison {
  const incomplete: string[] = [];
  if (!mine.minSampleMet) incomplete.push('Your profile has fewer listens than the minimum sample; percentages are approximate.');
  if (!other.minSampleMet) incomplete.push('The other profile has fewer listens than the minimum sample; percentages are approximate.');
  const mineArtists = new Set(mine.artists.map((a) => a.key));
  const mineAlbums = new Set(mine.albums.map((a) => a.key));
  const mineGenres = new Set(mine.genres.map((a) => a.key));
  const newToMe = [
    ...other.artists.filter((a) => !mineArtists.has(a.key)).map((a) => ({ key: a.key, kind: 'artist' as const, weight: a.weight })),
    ...other.albums.filter((a) => !mineAlbums.has(a.key)).map((a) => ({ key: a.key, kind: 'album' as const, weight: a.weight })),
    ...other.genres.filter((a) => !mineGenres.has(a.key)).map((a) => ({ key: a.key, kind: 'genre' as const, weight: a.weight })),
  ]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
  return {
    overlapPercent: {
      artists: Math.round(weightedJaccard(mine.artists, other.artists) * 100),
      albums: Math.round(weightedJaccard(mine.albums, other.albums) * 100),
      genres: Math.round(weightedJaccard(mine.genres, other.genres) * 100),
      eras: Math.round(weightedJaccard(mine.eras, other.eras) * 100),
    },
    discoveryRate: { mine: mine.discoveryRate, group: other.discoveryRate },
    listeningPatternSimilarity: cosine(mine.listeningPattern, other.listeningPattern),
    newToMe,
    incompleteData: incomplete,
  };
}

/** Merge several opted-in aggregates into a group aggregate (mean weights); requires a minimum cohort. */
export function mergeAggregates(profiles: readonly AggregateTasteProfile[], options: { id: string; ownerId: string; now: string; minCohort: number }): AggregateTasteProfile | null {
  if (profiles.length < options.minCohort) return null;
  const merge = (pick: (p: AggregateTasteProfile) => readonly { key: string; weight: number }[], limit: number) => {
    const sums = new Map<string, number>();
    for (const p of profiles) for (const e of pick(p)) sums.set(e.key, (sums.get(e.key) ?? 0) + e.weight);
    return [...sums.entries()].map(([key, w]) => ({ key, weight: w / profiles.length })).sort((a, b) => b.weight - a.weight).slice(0, limit);
  };
  const pattern = Array<number>(24).fill(0);
  for (const p of profiles) p.listeningPattern.forEach((v, i) => (pattern[i] = (pattern[i] ?? 0) + v / profiles.length));
  return {
    id: options.id,
    schemaVersion: 1,
    ownerId: options.ownerId,
    computedAt: options.now,
    windowDays: Math.max(...profiles.map((p) => p.windowDays)),
    sampleSize: profiles.reduce((a, p) => a + p.sampleSize, 0),
    minSampleMet: profiles.every((p) => p.minSampleMet),
    artists: merge((p) => p.artists, 200),
    genres: merge((p) => p.genres, 100),
    albums: merge((p) => p.albums, 200),
    eras: merge((p) => p.eras, 20),
    discoveryRate: profiles.reduce((a, p) => a + p.discoveryRate, 0) / profiles.length,
    listeningPattern: pattern,
    sources: merge((p) => p.sources, 20),
  };
}

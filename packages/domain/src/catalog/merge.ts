/**
 * One song, however many services have it (UX-CAT-002).
 *
 * Two rows are the same recording when they share an ISRC, or — when either lacks one — when the
 * main artist and the title agree once the noise is gone ("feat. …", "Remastered 2011", "(Official
 * Video)") and the durations are within three seconds. A row with no duration is never merged on
 * names alone: "Intro" by the same artist is not one song.
 *
 * The merged row keeps every source and takes each field from the best service that has it: the
 * stores (Deezer, Apple Music, Spotify) write titles and credits the way a library wants them;
 * MusicBrainz next; a YouTube upload's title is the last resort.
 */
import type { CatalogAlbum, CatalogArtist, CatalogPlatform, CatalogQuery, CatalogSource, CatalogTrack } from '@now-playing/contracts';
import { normalizeText } from '../identity.js';

export const DURATION_TOLERANCE_MS = 3000;

/** How much a platform's own words are trusted for titles, credits and dates. */
const PLATFORM_QUALITY: Record<CatalogPlatform, number> = {
  deezer: 6,
  'apple-music': 6,
  spotify: 6,
  tidal: 5,
  qobuz: 5,
  'amazon-music': 5,
  musicbrainz: 4,
  bandcamp: 3,
  soundcloud: 2,
  'youtube-music': 2,
  youtube: 1,
};

const NOISE = [
  /\s*[[(]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^\])]*[\])]/gi,
  /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i,
  /\s*[[(]\s*(?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video|visuali[sz]er)|lyrics?(?:\s*video)?|audio|visuali[sz]er|hd|hq|4k|\d{2,3}\s?fps|explicit|clean|music\s*video|mv|m\/v)\s*[\])]/gi,
  /\s*[[(]\s*(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+(?:version|edition))?(?:\s*\d{4})?\s*[\])]/gi,
  /\s+[-–—]\s+(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+(?:version|edition))?(?:\s*\d{4})?\s*$/i,
  /\s+[-–—]\s+official\b.*$/i,
];

/** A title with the noise removed, for matching only. Never shown. */
export function matchTitle(title: string): string {
  let out = title;
  for (let i = 0; i < 2; i += 1) for (const re of NOISE) out = out.replace(re, ' ');
  return normalizeText(out) || normalizeText(title);
}

/** The main artist, for matching only: the first name of a credit, without "The" or a feature. */
export function matchArtist(artist: string): string {
  const first = artist.split(/\s*(?:,|&|\+|\/|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?)\s*/i)[0] ?? artist;
  return normalizeText(first.replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '')).replace(/^the /, '');
}

export function sameRecording(a: Pick<CatalogTrack, 'isrc' | 'title' | 'artist' | 'durationMs'>, b: Pick<CatalogTrack, 'isrc' | 'title' | 'artist' | 'durationMs'>): boolean {
  if (a.isrc && b.isrc) return a.isrc === b.isrc;
  if (a.durationMs === null || b.durationMs === null) return false;
  if (Math.abs(a.durationMs - b.durationMs) > DURATION_TOLERANCE_MS) return false;
  return matchArtist(a.artist) === matchArtist(b.artist) && matchTitle(a.title) === matchTitle(b.title);
}

function quality(sources: readonly CatalogSource[]): number {
  return Math.max(0, ...sources.map((s) => PLATFORM_QUALITY[s.platform] ?? 0));
}

export function mergeSources(a: readonly CatalogSource[], b: readonly CatalogSource[]): CatalogSource[] {
  const out = [...a];
  for (const source of b) {
    const same = out.findIndex((s) => s.platform === source.platform && (s.url === source.url || (s.id !== null && s.id === source.id)));
    if (same === -1) out.push(source);
    else if (!out[same]!.previewUrl && source.previewUrl) out[same] = { ...out[same]!, previewUrl: source.previewUrl };
  }
  return out.slice(0, 20);
}

/** Bigger artwork wins; a store's square cover beats a video thumbnail of any size. */
function artworkScore(url: string | null, q: number): number {
  if (!url) return -1;
  const size = /(\d{3,4})x(\d{3,4})/.exec(url);
  return q * 10_000 + (size ? Number(size[1]) : 300);
}

/** Two copies of one song as one, each field from the better source. */
export function mergeTrack(into: CatalogTrack, other: CatalogTrack): CatalogTrack {
  const qa = quality(into.sources);
  const qb = quality(other.sources);
  const [best, rest] = qb > qa ? [other, into] : [into, other];
  const pick = <K extends keyof CatalogTrack>(key: K): CatalogTrack[K] => (best[key] ?? rest[key]) as CatalogTrack[K];
  return {
    id: into.id,
    title: best.title,
    artist: best.artist,
    // A store that credits "A, B & C" as one name says less than one that lists A, B and C.
    artists: best.artists.length > 1 || rest.artists.length <= best.artists.length ? best.artists : rest.artists,
    album: pick('album'),
    albumArtist: pick('albumArtist'),
    durationMs: pick('durationMs'),
    isrc: pick('isrc'),
    artworkUrl: artworkScore(other.artworkUrl, qb) > artworkScore(into.artworkUrl, qa) ? other.artworkUrl : into.artworkUrl,
    // The fuller date wins: "2013-05-17" says more than "2013".
    releaseDate: (best.releaseDate?.length ?? 0) >= (rest.releaseDate?.length ?? 0) ? best.releaseDate : rest.releaseDate,
    year: pick('year'),
    trackNumber: pick('trackNumber'),
    discNumber: pick('discNumber'),
    bpm: pick('bpm'),
    explicit: pick('explicit'),
    genre: pick('genre'),
    label: pick('label'),
    sources: mergeSources(into.sources, other.sources),
    rank: Math.max(into.rank, other.rank),
  };
}

function mergeArtist(into: CatalogArtist, other: CatalogArtist): CatalogArtist {
  return {
    ...into,
    pictureUrl: into.pictureUrl ?? other.pictureUrl,
    albumCount: into.albumCount ?? other.albumCount,
    fans: into.fans ?? other.fans,
    genre: into.genre ?? other.genre,
    sources: mergeSources(into.sources, other.sources),
    rank: Math.max(into.rank, other.rank),
  };
}

function mergeAlbum(into: CatalogAlbum, other: CatalogAlbum): CatalogAlbum {
  const qa = quality(into.sources);
  const qb = quality(other.sources);
  return {
    ...into,
    artworkUrl: artworkScore(other.artworkUrl, qb) > artworkScore(into.artworkUrl, qa) ? other.artworkUrl : into.artworkUrl,
    releaseDate: (into.releaseDate?.length ?? 0) >= (other.releaseDate?.length ?? 0) ? into.releaseDate : other.releaseDate,
    year: into.year ?? other.year,
    trackCount: into.trackCount ?? other.trackCount,
    label: into.label ?? other.label,
    genre: into.genre ?? other.genre,
    explicit: into.explicit ?? other.explicit,
    upc: into.upc ?? other.upc,
    sources: mergeSources(into.sources, other.sources),
    rank: Math.max(into.rank, other.rank),
  };
}

/* ---------- ranking ---------- */

function tokens(text: string | null | undefined): string[] {
  return normalizeText(text).split(' ').filter(Boolean);
}

/** How well a row answers the query, 0–1: the share of query words it contains, and an exact title. */
export function relevance(query: CatalogQuery, title: string, artist: string | null, album: string | null = null): number {
  if (query.kind === 'isrc') return 1;
  const want = new Set(tokens(query.text));
  if (!want.size) return 0;
  const have = new Set([...tokens(title), ...tokens(artist), ...tokens(album)]);
  let hit = 0;
  for (const w of want) if (have.has(w) || [...have].some((h) => h.startsWith(w) && w.length >= 3)) hit += 1;
  let score = hit / want.size;
  const target = query.kind === 'advanced' ? query.track : null;
  if (target && matchTitle(title) === matchTitle(target)) score += 0.5;
  if (query.kind === 'advanced' && query.artist && artist && matchArtist(artist) === matchArtist(query.artist)) score += 0.3;
  if (query.kind === 'text' && normalizeText(title) && normalizeText(query.text).includes(matchTitle(title))) score += 0.2;
  return Math.min(score, 2);
}

/** Relevance first; then how many services agree; then where the services put it themselves. */
export function rankOf(query: CatalogQuery, row: { title: string; artist: string | null; album?: string | null; sources: readonly unknown[] }, position: number): number {
  return Math.round((relevance(query, row.title, row.artist, row.album ?? null) * 100 + Math.min(row.sources.length, 6) * 4 - Math.min(position, 100) * 0.5) * 100) / 100;
}

/* ---------- the merger a search feeds ---------- */

export interface MergeUpdate {
  tracks: CatalogTrack[];
  artists: CatalogArtist[];
  albums: CatalogAlbum[];
}

/**
 * Accumulates one search's rows across services. `add` returns the rows that are new or changed,
 * keyed by the id they first arrived with, which is what a chunk carries.
 */
export class CatalogMerger {
  private readonly tracks: CatalogTrack[] = [];
  private readonly artists: CatalogArtist[] = [];
  private readonly albums: CatalogAlbum[] = [];

  constructor(private readonly query: CatalogQuery) {}

  add(rows: Partial<MergeUpdate>): MergeUpdate {
    const changed: MergeUpdate = { tracks: [], artists: [], albums: [] };
    (rows.tracks ?? []).forEach((row, position) => {
      const ranked = { ...row, rank: rankOf(this.query, row, position) };
      const index = this.tracks.findIndex((t) => sameRecording(t, ranked));
      const next = index === -1 ? ranked : mergeTrack(this.tracks[index]!, ranked);
      const rescored = { ...next, rank: Math.max(next.rank, rankOf(this.query, next, position)) };
      if (index === -1) this.tracks.push(rescored);
      else this.tracks[index] = rescored;
      upsert(changed.tracks, rescored);
    });
    (rows.artists ?? []).forEach((row, position) => {
      const ranked = { ...row, rank: rankOf(this.query, { title: row.name, artist: row.name, sources: row.sources }, position) };
      const index = this.artists.findIndex((a) => matchArtist(a.name) === matchArtist(ranked.name) && normalizeText(a.name) === normalizeText(ranked.name));
      const next = index === -1 ? ranked : mergeArtist(this.artists[index]!, ranked);
      if (index === -1) this.artists.push(next);
      else this.artists[index] = next;
      upsert(changed.artists, next);
    });
    (rows.albums ?? []).forEach((row, position) => {
      const ranked = { ...row, rank: rankOf(this.query, { title: row.title, artist: row.artist, sources: row.sources }, position) };
      const index = this.albums.findIndex((a) => matchTitle(a.title) === matchTitle(ranked.title) && matchArtist(a.artist ?? '') === matchArtist(ranked.artist ?? '') && (a.trackCount === null || ranked.trackCount === null || a.trackCount === ranked.trackCount));
      const next = index === -1 ? ranked : mergeAlbum(this.albums[index]!, ranked);
      if (index === -1) this.albums.push(next);
      else this.albums[index] = next;
      upsert(changed.albums, next);
    });
    return changed;
  }

  /** Replace a merged track by id (cross-links found after the search). */
  patchTrack(id: string, update: (track: CatalogTrack) => CatalogTrack): CatalogTrack | null {
    const index = this.tracks.findIndex((t) => t.id === id);
    if (index === -1) return null;
    this.tracks[index] = update(this.tracks[index]!);
    return this.tracks[index]!;
  }

  snapshot(): MergeUpdate {
    const byRank = <T extends { rank: number }>(rows: T[]): T[] => rows.map((row, i) => ({ row, i })).sort((a, b) => b.row.rank - a.row.rank || a.i - b.i).map(({ row }) => row);
    return { tracks: byRank(this.tracks), artists: byRank(this.artists), albums: byRank(this.albums) };
  }
}

function upsert<T extends { id: string }>(list: T[], row: T): void {
  const at = list.findIndex((r) => r.id === row.id);
  if (at === -1) list.push(row);
  else list[at] = row;
}

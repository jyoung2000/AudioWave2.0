import { decadeOf, normalizeArtist, normalizeText } from '@now-playing/domain';

/** Minimal structural view of a track used by the similarity functions (CanonicalTrack satisfies it). */
export interface SimilarityTrack {
  artistName: string;
  genres: readonly string[];
  tags: readonly string[];
  releaseYear: number | null;
  popularity: number | null;
  durationMs: number | null;
}

/** Minimal structural view of an artist (CanonicalArtist satisfies it). */
export interface SimilarityArtist {
  name: string;
  genres: readonly string[];
  tags: readonly string[];
  popularity: number | null;
}

export type PopularityBand = 'niche' | 'rising' | 'mainstream' | 'hit' | 'unknown';

const GENRE_ALIASES: Readonly<Record<string, string>> = {
  hiphop: 'hip hop',
  rap: 'hip hop',
  'r and b': 'rnb',
  'rhythm and blues': 'rnb',
  electronica: 'electronic',
  edm: 'electronic',
  'alt rock': 'alternative rock',
  alt: 'alternative',
  'lo fi': 'lofi',
  dnb: 'drum and bass',
  'd and b': 'drum and bass',
  'drum n bass': 'drum and bass',
  'synth pop': 'synthpop',
  'chill out': 'chillout',
  'singer songwriter': 'singer songwriter',
  'classical music': 'classical',
  ost: 'soundtrack',
  score: 'soundtrack',
  'k pop': 'kpop',
  'j pop': 'jpop',
  'post rock': 'post rock',
};

const GENRE_FAMILIES: readonly (readonly string[])[] = [
  ['rock', 'alternative rock', 'alternative', 'indie rock', 'indie', 'punk', 'post punk', 'grunge', 'garage rock', 'shoegaze', 'dream pop', 'psychedelic rock', 'psychedelic', 'hard rock', 'classic rock', 'post rock', 'emo', 'math rock', 'noise rock', 'britpop'],
  ['electronic', 'techno', 'house', 'trance', 'ambient', 'idm', 'drum and bass', 'dubstep', 'synthpop', 'electro', 'downtempo', 'trip hop', 'lofi', 'chillwave', 'breakbeat', 'industrial', 'electropop', 'glitch', 'minimal', 'deep house'],
  ['pop', 'synthpop', 'dream pop', 'indie pop', 'dance pop', 'electropop', 'kpop', 'jpop', 'art pop', 'power pop', 'chamber pop'],
  ['hip hop', 'trap', 'grime', 'rnb', 'neo soul', 'boom bap', 'drill'],
  ['soul', 'funk', 'rnb', 'neo soul', 'disco', 'motown', 'gospel', 'nu disco'],
  ['jazz', 'nu jazz', 'bebop', 'swing', 'fusion', 'smooth jazz', 'big band', 'jazz fusion', 'free jazz', 'cool jazz'],
  ['folk', 'acoustic', 'singer songwriter', 'americana', 'country', 'bluegrass', 'indie folk', 'folk rock', 'alt country', 'roots'],
  ['classical', 'baroque', 'orchestral', 'chamber', 'opera', 'contemporary classical', 'minimalism', 'soundtrack', 'piano', 'neoclassical'],
  ['metal', 'heavy metal', 'death metal', 'black metal', 'doom', 'thrash', 'metalcore', 'hard rock', 'progressive metal', 'sludge'],
  ['latin', 'reggae', 'dub', 'afrobeat', 'ska', 'bossa nova', 'samba', 'salsa', 'reggaeton', 'world', 'cumbia', 'dancehall'],
  ['blues', 'blues rock', 'delta blues', 'chicago blues', 'soul'],
  ['ambient', 'downtempo', 'chillout', 'new age', 'drone', 'lofi', 'chillwave', 'shoegaze', 'dream pop'],
];

const FAMILY_INDEX: ReadonlyMap<string, readonly number[]> = (() => {
  const map = new Map<string, number[]>();
  GENRE_FAMILIES.forEach((family, index) => {
    for (const genre of family) {
      const list = map.get(genre) ?? [];
      list.push(index);
      map.set(genre, list);
    }
  });
  return map;
})();

/** Lower-case, accent- and punctuation-free genre with common aliases folded ("Hip-Hop" → "hip hop", "R&B" → "rnb"). */
export function normalizeGenre(genre: string | null | undefined): string {
  let g = normalizeText(genre);
  if (!g) return '';
  g = g.replace(/\s+music$/, '');
  return GENRE_ALIASES[g] ?? g;
}

export function normalizeGenres(genres: readonly (string | null | undefined)[] | null | undefined): string[] {
  const out: string[] = [];
  for (const genre of genres ?? []) {
    const g = normalizeGenre(genre);
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

export function normalizeTag(tag: string | null | undefined): string {
  return normalizeText(tag);
}

export function normalizeTags(tags: readonly (string | null | undefined)[] | null | undefined): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    const t = normalizeTag(tag);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Decade bucket such as "2010s"; null when the year is unknown. */
export function eraOf(year: number | null | undefined): string | null {
  return decadeOf(year);
}

export function eraSimilarity(a: number | null | undefined, b: number | null | undefined): number {
  if (!a || !b) return 0.5;
  return 1 - Math.min(1, Math.abs(a - b) / 20);
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length && !b.length) return 0.5;
  if (!a.length || !b.length) return 0.2;
  const setB = new Set(b);
  let inter = 0;
  for (const x of new Set(a)) if (setB.has(x)) inter += 1;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

/** 1 for the same genre, 0.7 for same family plus shared words, 0.6 same family, 0.5 shared words, 0 otherwise. */
export function genreSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalizeGenre(a);
  const nb = normalizeGenre(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const fa = FAMILY_INDEX.get(na) ?? [];
  const fb = FAMILY_INDEX.get(nb) ?? [];
  const sameFamily = fa.some((f) => fb.includes(f));
  const ta = na.split(' ');
  const tb = nb.split(' ');
  const sharedWord = ta.some((t) => tb.includes(t));
  if (sameFamily && sharedWord) return 0.7;
  if (sameFamily) return 0.6;
  if (sharedWord) return 0.5;
  return 0;
}

/** Symmetric best-match average across two genre lists. */
export function genreListSimilarity(a: readonly string[], b: readonly string[]): number {
  const na = normalizeGenres(a);
  const nb = normalizeGenres(b);
  if (!na.length && !nb.length) return 0.5;
  if (!na.length || !nb.length) return 0.25;
  const best = (from: readonly string[], to: readonly string[]) => from.reduce((sum, g) => sum + Math.max(...to.map((h) => genreSimilarity(g, h))), 0) / from.length;
  return (best(na, nb) + best(nb, na)) / 2;
}

export function popularityBand(popularity: number | null | undefined): PopularityBand {
  if (popularity === null || popularity === undefined || !Number.isFinite(popularity)) return 'unknown';
  if (popularity < 0.25) return 'niche';
  if (popularity < 0.5) return 'rising';
  if (popularity < 0.75) return 'mainstream';
  return 'hit';
}

export const POPULARITY_BAND_CENTRE: Readonly<Record<PopularityBand, number>> = { niche: 0.125, rising: 0.375, mainstream: 0.625, hit: 0.875, unknown: 0.5 };

function popularitySimilarity(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0.5;
  return 1 - Math.min(1, Math.abs(a - b));
}

function durationSimilarity(a: number | null, b: number | null): number {
  if (!a || !b) return 0.5;
  return 1 - Math.min(1, Math.abs(a - b) / 180_000);
}

/** 0..1 similarity from genres (0.35), tags (0.20), era (0.15), popularity (0.10), duration (0.10) and same artist (0.10). */
export function trackSimilarity(a: SimilarityTrack, b: SimilarityTrack): number {
  const genre = genreListSimilarity(a.genres, b.genres);
  const tags = jaccard(normalizeTags(a.tags), normalizeTags(b.tags));
  const era = eraSimilarity(a.releaseYear, b.releaseYear);
  const pop = popularitySimilarity(a.popularity, b.popularity);
  const duration = durationSimilarity(a.durationMs, b.durationMs);
  const ka = normalizeArtist(a.artistName);
  const artist = ka && ka === normalizeArtist(b.artistName) ? 1 : 0;
  return clamp01(0.35 * genre + 0.2 * tags + 0.15 * era + 0.1 * pop + 0.1 * duration + 0.1 * artist);
}

/** 0..1 similarity from genres (0.6), tags (0.3) and popularity (0.1). */
export function artistSimilarity(a: SimilarityArtist, b: SimilarityArtist): number {
  const genre = genreListSimilarity(a.genres, b.genres);
  const tags = jaccard(normalizeTags(a.tags), normalizeTags(b.tags));
  const pop = popularitySimilarity(a.popularity, b.popularity);
  return clamp01(0.6 * genre + 0.3 * tags + 0.1 * pop);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Stable artist key shared by profiles, catalogues and relations: normalised name, falling back to the id. */
export function artistKeyOf(artistName: string | null | undefined, artistId?: string | null): string {
  return normalizeArtist(artistName) || (artistId ?? '');
}

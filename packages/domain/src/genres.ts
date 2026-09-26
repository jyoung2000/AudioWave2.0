/**
 * One fixed genre vocabulary — MusicBrainz's genre list, parents first — so that every source's
 * free text ("Hip-Hop", "hiphop", "rap/hip-hop") lands on one key the recommender can compare.
 * Unknown labels are not genres; they belong in tags.
 */
import type { GenreProfile } from '@now-playing/contracts';
export type { GenreProfile };

/** genre → parent (null for a top-level genre). Keys are the canonical lower-case names. */
export const GENRE_PARENTS: Record<string, string | null> = {
  // top level
  'hip hop': null, 'r&b': null, rock: null, pop: null, electronic: null, jazz: null, blues: null, soul: null, funk: null, disco: null,
  country: null, folk: null, classical: null, metal: null, punk: null, reggae: null, latin: null, world: null, 'spoken word': null, ambient: null,
  // children (a representative set; extend from https://musicbrainz.org/genres)
  trap: 'hip hop', drill: 'hip hop', 'boom bap': 'hip hop', grime: 'hip hop', 'conscious hip hop': 'hip hop',
  'neo soul': 'soul', 'contemporary r&b': 'r&b', 'alternative r&b': 'r&b',
  'alternative rock': 'rock', 'indie rock': 'rock', 'classic rock': 'rock', 'hard rock': 'rock', 'progressive rock': 'rock', 'psychedelic rock': 'rock', shoegaze: 'rock', grunge: 'rock',
  'indie pop': 'pop', 'synth-pop': 'pop', 'dance-pop': 'pop', 'k-pop': 'pop', 'dream pop': 'pop',
  house: 'electronic', techno: 'electronic', trance: 'electronic', 'drum and bass': 'electronic', dubstep: 'electronic', 'uk garage': 'electronic', idm: 'electronic', downtempo: 'electronic', 'lo-fi': 'electronic', 'deep house': 'house', 'tech house': 'house',
  'smooth jazz': 'jazz', bebop: 'jazz', 'jazz fusion': 'jazz',
  'heavy metal': 'metal', 'death metal': 'metal', 'black metal': 'metal', metalcore: 'metal',
  'pop punk': 'punk', 'post-punk': 'punk', hardcore: 'punk',
  dancehall: 'reggae', dub: 'reggae', reggaeton: 'latin', salsa: 'latin', bachata: 'latin', afrobeats: 'world', 'bossa nova': 'latin',
  'singer-songwriter': 'folk', americana: 'country', bluegrass: 'country',
  gospel: 'soul', 'new age': 'ambient',
};

/** Spellings and abbreviations that mean a vocabulary entry. Keys are lower-case, punctuation collapsed. */
const ALIASES: Record<string, string> = {
  hiphop: 'hip hop', 'hip-hop': 'hip hop', rap: 'hip hop', 'rap hip hop': 'hip hop', 'rap/hip-hop': 'hip hop', 'rap/hip hop': 'hip hop',
  rnb: 'r&b', 'r n b': 'r&b', 'rhythm and blues': 'r&b',
  dnb: 'drum and bass', 'drum & bass': 'drum and bass', 'drum n bass': 'drum and bass', 'd&b': 'drum and bass',
  'alt rock': 'alternative rock', alternative: 'alternative rock', indie: 'indie rock',
  edm: 'electronic', electronica: 'electronic', dance: 'electronic', electro: 'electronic',
  synthpop: 'synth-pop', lofi: 'lo-fi', 'lo fi': 'lo-fi', chillout: 'downtempo', chill: 'downtempo',
  kpop: 'k-pop', 'latin pop': 'latin', afrobeat: 'afrobeats', 'afro beats': 'afrobeats',
  hardrock: 'hard rock',
};

function key(label: string): string {
  return label.toLowerCase().replace(/_+/g, ' ').replace(/\s*[/,]\s*/g, '/').replace(/\s+/g, ' ').trim();
}

export function mapGenreLabel(label: string): { genre: string; parent: string | null } | null {
  const k = key(label);
  const candidates = [k, k.replace(/\//g, ' '), k.replace(/-/g, ' '), ...k.split('/')];
  for (const c of candidates) {
    const g = ALIASES[c] ?? (c in GENRE_PARENTS ? c : null);
    if (g) return { genre: g, parent: GENRE_PARENTS[g] ?? null };
  }
  return null;
}

/** Votes from every source, merged: a child genre also lends half its weight to its parent; the top six, normalised to sum to one. */
export function mergeGenreProfile(votes: ReadonlyArray<{ label: string; weight: number }>): GenreProfile {
  const acc = new Map<string, number>();
  for (const v of votes) {
    if (!(v.weight > 0)) continue;
    const m = mapGenreLabel(v.label);
    if (!m) continue;
    acc.set(m.genre, (acc.get(m.genre) ?? 0) + v.weight);
    if (m.parent) acc.set(m.parent, (acc.get(m.parent) ?? 0) + v.weight * 0.5);
  }
  const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const sum = top.reduce((s, [, w]) => s + w, 0);
  const out: GenreProfile = {};
  for (const [g, w] of top) out[g] = Math.round((w / sum) * 1e4) / 1e4;
  return out;
}

export function topGenre(profile: GenreProfile): string | null {
  let best: string | null = null;
  for (const [g, w] of Object.entries(profile)) if (best === null || w > profile[best]!) best = g;
  return best;
}

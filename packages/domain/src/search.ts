import type { SearchResult, SearchScope } from '@now-playing/contracts';
import { matchTracks, normalizeText } from './identity.js';

export interface IndexedTrackLike {
  id: string;
  title: string;
  artistName: string;
  albumName?: string | null;
  genre?: string | null;
  year?: number | null;
  playlistNames?: readonly string[];
  source?: string;
}

interface Posting { id: string; field: Field; position: number }
type Field = 'title' | 'artist' | 'album' | 'genre' | 'playlist' | 'source';

const FIELD_BOOST: Record<Field, number> = { title: 5, artist: 4, album: 3, genre: 2, playlist: 2, source: 1 };

export function tokenize(text: string | null | undefined): string[] {
  return normalizeText(text).split(' ').filter(Boolean);
}

/** Small in-memory inverted index with prefix matching. Deterministic ranking: field boost × match quality, ties by title. */
export class LocalSearchIndex<T extends IndexedTrackLike> {
  private readonly postings = new Map<string, Posting[]>();
  private readonly items = new Map<string, T>();
  private readonly prefixKeys: string[] = [];

  constructor(items: readonly T[] = []) {
    for (const item of items) this.add(item);
    this.rebuildPrefixKeys();
  }

  add(item: T): void {
    this.items.set(item.id, item);
    const fields: Array<[Field, string | null | undefined]> = [
      ['title', item.title],
      ['artist', item.artistName],
      ['album', item.albumName],
      ['genre', item.genre],
      ['source', item.source],
    ];
    for (const name of item.playlistNames ?? []) fields.push(['playlist', name]);
    for (const [field, text] of fields) {
      tokenize(text).forEach((token, position) => {
        const list = this.postings.get(token) ?? [];
        list.push({ id: item.id, field, position });
        this.postings.set(token, list);
      });
    }
  }

  remove(id: string): void {
    this.items.delete(id);
    for (const [token, list] of this.postings) {
      const filtered = list.filter((p) => p.id !== id);
      if (filtered.length) this.postings.set(token, filtered);
      else this.postings.delete(token);
    }
  }

  rebuildPrefixKeys(): void {
    this.prefixKeys.length = 0;
    this.prefixKeys.push(...[...this.postings.keys()].sort());
  }

  get size(): number {
    return this.items.size;
  }

  search(query: string, options: { scope?: SearchScope; limit?: number } = {}): Array<{ item: T; score: number; matchedFields: Field[] }> {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const limit = options.limit ?? 50;
    const scope = options.scope ?? 'all';
    const allowedFields = scopeFields(scope);
    const scores = new Map<string, { score: number; fields: Set<Field>; tokensHit: number }>();
    for (const token of tokens) {
      const candidates = new Set<string>();
      if (this.postings.has(token)) candidates.add(token);
      // prefix expansion (bounded)
      const start = lowerBound(this.prefixKeys, token);
      for (let i = start; i < this.prefixKeys.length && candidates.size < 64; i += 1) {
        const key = this.prefixKeys[i]!;
        if (!key.startsWith(token)) break;
        candidates.add(key);
      }
      const seenForToken = new Set<string>();
      for (const key of candidates) {
        const quality = key === token ? 1 : token.length / key.length;
        for (const posting of this.postings.get(key) ?? []) {
          if (!allowedFields.has(posting.field)) continue;
          const entry = scores.get(posting.id) ?? { score: 0, fields: new Set<Field>(), tokensHit: 0 };
          entry.score += FIELD_BOOST[posting.field] * quality * (posting.position === 0 ? 1.2 : 1);
          entry.fields.add(posting.field);
          if (!seenForToken.has(posting.id)) {
            entry.tokensHit += 1;
            seenForToken.add(posting.id);
          }
          scores.set(posting.id, entry);
        }
      }
    }
    return [...scores.entries()]
      .filter(([, s]) => s.tokensHit === tokens.length)
      .map(([id, s]) => ({ item: this.items.get(id)!, score: s.score, matchedFields: [...s.fields] }))
      .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title) || a.item.id.localeCompare(b.item.id))
      .slice(0, limit);
  }
}

function scopeFields(scope: SearchScope): Set<Field> {
  switch (scope) {
    case 'artists': return new Set(['artist']);
    case 'albums': return new Set(['album']);
    case 'songs': return new Set(['title']);
    case 'playlists': return new Set(['playlist']);
    default: return new Set(['title', 'artist', 'album', 'genre', 'playlist', 'source']);
  }
}

function lowerBound(keys: readonly string[], needle: string): number {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]! < needle) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const PROVIDER_PRIORITY: Record<string, number> = { local: 0, hub: 1, companion: 2, 'public-domain': 3, soundcloud: 4, bandcamp: 5, youtube: 6, spotify: 7, musicbrainz: 8 };

/** Merge results from several providers: confidently matched recordings collapse into one row with variants; the primary is the most capable/local. */
export function mergeSearchResults(groups: ReadonlyArray<readonly SearchResult[]>): SearchResult[] {
  const all = groups.flat();
  const merged: SearchResult[] = [];
  for (const r of all) {
    if (r.kind !== 'track') {
      merged.push(r);
      continue;
    }
    const existing = merged.find((m) => m.kind === 'track' && matchTracks({ title: m.title, artistName: m.artistName ?? '', durationMs: m.durationMs, identity: m.identity }, { title: r.title, artistName: r.artistName ?? '', durationMs: r.durationMs, identity: r.identity }).confidence >= 0.85);
    if (!existing) {
      merged.push({ ...r, variants: [] });
      continue;
    }
    const better = rank(r) < rank(existing);
    if (better) {
      const { variants, ...primary } = existing;
      const idx = merged.indexOf(existing);
      merged[idx] = { ...r, variants: [primary, ...variants] };
    } else {
      const { variants: _v, ...variant } = r;
      existing.variants.push(variant);
    }
  }
  return merged;
}

function rank(r: SearchResult): number {
  const cap = r.capabilities.playback === 'available' ? 0 : r.capabilities.preview === 'available' ? 10 : 20;
  return cap + (PROVIDER_PRIORITY[r.provider] ?? 9);
}

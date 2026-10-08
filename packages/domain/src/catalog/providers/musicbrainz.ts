/**
 * MusicBrainz ws/2: recordings by text or ISRC, and the facts a store leaves out — genre, label,
 * first release year — plus the links editors keep on a recording (Spotify, YouTube Music, Deezer,
 * Apple Music, Tidal, Qobuz…), which is how the catalog finds a song's other homes without a key.
 *
 * MusicBrainz asks applications for a meaningful User-Agent and no more than one request a second.
 * Every call here goes through one `Pacer`, shared by search and enrichment.
 */
import type { CatalogEnrichment, CatalogPlatform, CatalogQuery, CatalogSearchSection, CatalogSource, CatalogTrack } from '@now-playing/contracts';
import { arr, calendarDate, getJson, isObject, num, str, yearOf, type CatalogFetch, type Json } from '../http.js';
import { Pacer, type Now, type Sleep } from '../limits.js';
import { emptyResult, type CatalogProvider, type ProviderResult, type ProviderSearchOptions } from '../provider.js';
import { parseMusicLink } from '../query.js';

export const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2';
export const MUSICBRAINZ_INTERVAL_MS = 1100;

/** Lucene's special characters, escaped, so a title with a colon is a title and not a field. */
export function luceneEscape(text: string): string {
  return text.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
}

function credit(row: Json): { line: string; names: string[] } {
  const parts = arr(row['artist-credit']);
  const names = parts.map((p) => str(p['name']) ?? str(isObject(p['artist']) ? p['artist']['name'] : null)).filter((n): n is string => Boolean(n));
  const line = parts.map((p) => `${str(p['name']) ?? ''}${typeof p['joinphrase'] === 'string' ? p['joinphrase'] : ''}`).join('').trim();
  return { line: line || names.join(', '), names };
}

/** The release a recording first came out on, preferring official ones. */
function firstRelease(row: Json): Json | null {
  const releases = arr(row['releases']);
  const dated = releases.filter((r) => typeof r['date'] === 'string' && r['date']);
  const official = dated.filter((r) => r['status'] === 'Official');
  const pool = official.length ? official : dated.length ? dated : releases;
  return [...pool].sort((a, b) => String(a['date'] ?? '9999').localeCompare(String(b['date'] ?? '9999')))[0] ?? null;
}

/**
 * The first release of each recording a search listed, by recording id, so a MusicBrainz-only row
 * (which has no cover) can be given the Cover Art Archive's front image for that release when the
 * page is filled in (UX-CAT-006). A `CatalogTrack` has no field for it, and rows are copied as they
 * merge, so this is kept beside them, bounded.
 */
const RELEASE_OF_RECORDING = new Map<string, string>();
const RELEASES_KEPT = 2000;

export function releaseOfRecording(recordingId: string): string | null {
  return RELEASE_OF_RECORDING.get(recordingId) ?? null;
}

function rememberRelease(recordingId: string, releaseId: string): void {
  RELEASE_OF_RECORDING.delete(recordingId);
  while (RELEASE_OF_RECORDING.size >= RELEASES_KEPT) RELEASE_OF_RECORDING.delete(RELEASE_OF_RECORDING.keys().next().value!);
  RELEASE_OF_RECORDING.set(recordingId, releaseId);
}

export function musicbrainzTrack(row: Json): CatalogTrack | null {
  const id = str(row['id'], 40);
  const title = str(row['title']);
  const { line, names } = credit(row);
  if (!id || !title || !line) return null;
  const release = firstRelease(row);
  const releaseId = str(release?.['id'], 40);
  if (releaseId && /^[0-9a-f-]{36}$/.test(releaseId)) rememberRelease(id, releaseId);
  const releaseDate = calendarDate(row['first-release-date']) ?? calendarDate(release?.['date']);
  const isrcs = Array.isArray(row['isrcs']) ? (row['isrcs'] as unknown[]).filter((i): i is string => typeof i === 'string' && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(i)) : [];
  const length = num(row['length']);
  return {
    id: `musicbrainz:${id}`,
    title,
    artist: line,
    artists: names.length ? names : [line],
    album: str(release?.['title']),
    albumArtist: null,
    durationMs: length !== null && length > 0 ? Math.round(length) : null,
    isrc: isrcs[0] ?? null,
    artworkUrl: null,
    releaseDate,
    year: yearOf(releaseDate),
    trackNumber: null,
    discNumber: null,
    bpm: null,
    explicit: null,
    genre: topGenre(row),
    label: null,
    sources: [{ platform: 'musicbrainz', id, url: `https://musicbrainz.org/recording/${id}`, previewUrl: null, matchedBy: 'search' }],
    rank: 0,
  };
}

/** The genre editors voted for most; tags are the fallback. */
export function topGenre(row: Json): string | null {
  const ranked = (list: Json[]) => [...list].sort((a, b) => (num(b['count']) ?? 0) - (num(a['count']) ?? 0)).map((g) => str(g['name'], 100)).filter((n): n is string => Boolean(n));
  return ranked(arr(row['genres']))[0] ?? null;
}

export function genresOf(row: Json): string[] {
  const list = [...arr(row['genres'])].sort((a, b) => (num(b['count']) ?? 0) - (num(a['count']) ?? 0));
  return list.map((g) => str(g['name'], 100)).filter((n): n is string => Boolean(n)).slice(0, 10);
}

/** A recording's URL relations as catalog sources, one per address, on the platforms the catalog knows. */
export function sourcesFromRelations(row: Json): CatalogSource[] {
  const out: CatalogSource[] = [];
  for (const rel of arr(row['relations'])) {
    const resource = isObject(rel['url']) ? str(rel['url']['resource'], 2048) : null;
    if (!resource || rel['ended'] === true) continue;
    const link = parseMusicLink(resource);
    if (!link || link.kind !== 'track') continue;
    if (out.some((s) => s.platform === link.platform && s.id === link.id)) continue;
    out.push({ platform: link.platform as CatalogPlatform, id: link.id, url: link.url, previewUrl: null, matchedBy: 'musicbrainz' });
  }
  return out;
}

export interface MusicBrainzOptions {
  fetch: CatalogFetch;
  userAgent: string;
  now?: Now;
  sleep?: Sleep;
  timeoutMs?: number;
  intervalMs?: number;
}

export class MusicBrainzClient {
  private readonly pacer: Pacer;
  readonly timeoutMs: number;

  constructor(private readonly options: MusicBrainzOptions) {
    this.pacer = new Pacer(options.intervalMs ?? MUSICBRAINZ_INTERVAL_MS, options.now ?? Date.now, options.sleep);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** One paced call. `null` for "no such thing" (404). */
  get(path: string, signal?: AbortSignal): Promise<Json | null> {
    return this.pacer.run(async () => {
      const sep = path.includes('?') ? '&' : '?';
      const { status, body } = await getJson(this.options.fetch, `${MUSICBRAINZ_API}${path}${sep}fmt=json`, { timeoutMs: this.timeoutMs, signal, headers: { 'User-Agent': this.options.userAgent }, accept: [404] });
      return status === 404 || !isObject(body) ? null : body;
    }, signal);
  }

  async searchRecordings(lucene: string, offset: number, limit: number, signal?: AbortSignal): Promise<Json[]> {
    const body = await this.get(`/recording?query=${encodeURIComponent(lucene)}&limit=${limit}&offset=${offset}`, signal);
    return arr(body?.['recordings']);
  }

  async byIsrc(isrc: string, signal?: AbortSignal): Promise<Json[]> {
    const body = await this.get(`/isrc/${encodeURIComponent(isrc)}?inc=artist-credits+releases`, signal);
    return arr(body?.['recordings']);
  }

  recording(id: string, signal?: AbortSignal): Promise<Json | null> {
    return this.get(`/recording/${encodeURIComponent(id)}?inc=url-rels+isrcs+genres+tags+releases+artist-credits`, signal);
  }

  release(id: string, signal?: AbortSignal): Promise<Json | null> {
    return this.get(`/release/${encodeURIComponent(id)}?inc=labels`, signal);
  }

  /** A recording's links on other platforms, for an ISRC: two paced calls. */
  async linksByIsrc(isrc: string, signal?: AbortSignal): Promise<CatalogSource[]> {
    const candidates = await this.byIsrc(isrc, signal);
    const id = str(candidates[0]?.['id'], 40);
    if (!id) return [];
    const full = await this.recording(id, signal);
    return full ? [{ platform: 'musicbrainz', id, url: `https://musicbrainz.org/recording/${id}`, previewUrl: null, matchedBy: 'isrc' }, ...sourcesFromRelations(full)] : [];
  }

  /**
   * Genre, label and year for a recording (by ISRC, or by title and artist), and its links.
   * Three paced calls at most: the lookup, the recording, its first official release's labels.
   */
  async enrich(input: { isrc?: string | null | undefined; title?: string | null | undefined; artist?: string | null | undefined; durationMs?: number | null | undefined }, signal?: AbortSignal): Promise<CatalogEnrichment> {
    const empty: CatalogEnrichment = { isrc: input.isrc ?? null, musicbrainzRecordingId: null, genre: null, genres: [], label: null, releaseDate: null, year: null, sources: [] };
    let candidates: Json[] = [];
    if (input.isrc) candidates = await this.byIsrc(input.isrc, signal);
    if (!candidates.length && input.title && input.artist) {
      candidates = await this.searchRecordings(`recording:"${luceneEscape(input.title)}" AND artist:"${luceneEscape(input.artist)}"`, 0, 5, signal);
      if (input.durationMs) {
        const near = candidates.filter((c) => {
          const length = num(c['length']);
          return length === null || Math.abs(length - input.durationMs!) <= 5000;
        });
        if (near.length) candidates = near;
      }
    }
    // The earliest-released recording is the one a store's ISRC most often means.
    const pick = [...candidates].sort((a, b) => String(a['first-release-date'] || '9999').localeCompare(String(b['first-release-date'] || '9999')))[0];
    const id = str(pick?.['id'], 40);
    if (!id) return empty;
    const full = (await this.recording(id, signal)) ?? pick!;
    const release = firstRelease(full);
    let label: string | null = null;
    const releaseId = str(release?.['id'], 40);
    if (releaseId) {
      const detail = await this.release(releaseId, signal).catch(() => null);
      label = str(arr(detail?.['label-info']).map((l) => (isObject(l['label']) ? l['label']['name'] : null)).find((n) => typeof n === 'string' && n !== '[no label]'));
    }
    const genres = genresOf(full);
    const artistGenres = arr(full['artist-credit']).flatMap((c) => (isObject(c['artist']) ? genresOf(c['artist']) : []));
    const releaseDate = calendarDate(full['first-release-date']) ?? calendarDate(release?.['date']);
    const isrcs = Array.isArray(full['isrcs']) ? (full['isrcs'] as unknown[]).filter((i): i is string => typeof i === 'string') : [];
    return {
      isrc: input.isrc ?? isrcs[0] ?? null,
      musicbrainzRecordingId: id,
      genre: genres[0] ?? artistGenres[0] ?? null,
      genres: genres.length ? genres : artistGenres.slice(0, 10),
      label,
      releaseDate,
      year: yearOf(releaseDate),
      sources: [{ platform: 'musicbrainz', id, url: `https://musicbrainz.org/recording/${id}`, previewUrl: null, matchedBy: input.isrc ? 'isrc' : 'metadata' }, ...sourcesFromRelations(full)],
    };
  }
}

export function musicbrainzLucene(query: CatalogQuery): string {
  if (query.kind === 'advanced') {
    const parts: string[] = [];
    if (query.track) parts.push(`recording:"${luceneEscape(query.track)}"`);
    if (query.artist) parts.push(`artist:"${luceneEscape(query.artist)}"`);
    if (query.album) parts.push(`release:"${luceneEscape(query.album)}"`);
    if (parts.length) return parts.join(' AND ');
  }
  return luceneEscape(query.text);
}

export class MusicBrainzProvider implements CatalogProvider {
  readonly id = 'musicbrainz' as const;
  readonly sections: readonly CatalogSearchSection[] = ['tracks'];
  readonly timeoutMs: number;

  constructor(readonly client: MusicBrainzClient) {
    // Its turn may wait behind an enrichment's calls.
    this.timeoutMs = client.timeoutMs + 3000;
  }

  supports(query: CatalogQuery): boolean {
    return query.kind !== 'url';
  }

  async search(query: CatalogQuery, options: ProviderSearchOptions): Promise<ProviderResult> {
    const out = emptyResult();
    if (!options.sections.includes('tracks')) return out;
    const rows = query.kind === 'isrc' && query.isrc ? await this.client.byIsrc(query.isrc, options.signal) : await this.client.searchRecordings(musicbrainzLucene(query), options.offset, options.limit, options.signal);
    // A search answer gives no ISRC; an ISRC lookup's own code is the one asked for.
    out.tracks = rows
      .filter((r) => r['video'] !== true)
      .map((r) => musicbrainzTrack(query.kind === 'isrc' && query.isrc ? { ...r, isrcs: [query.isrc] } : r))
      .filter((t): t is CatalogTrack => t !== null);
    out.full.tracks = query.kind !== 'isrc' && rows.length >= options.limit;
    return out;
  }
}

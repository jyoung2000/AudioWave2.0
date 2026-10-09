/**
 * What a search window does with the catalog's answers (DEC-039; rules UX-SEARCH-001…006): the hub's
 * admin window and the companion draw the same search with their own kits (DEC-026), and the
 * behaviour they share lives here, pure, so the two cannot drift.
 *
 * - Folding the live feed: a `results` chunk upserts rows by `id` (a later chunk can carry a row
 *   already shown, merged with another service's copy); rows are shown by `rank`, ties by arrival.
 * - What a row says: its platforms, a Spotify song's "plays from YouTube Music", its preview clip,
 *   its time; a service's state in words.
 * - Collections: the 2×2 mosaic, and the `SavedCollection` a star keeps.
 * - Lyrics: LRC read into timed lines.
 */
import {
  CATALOG_PLATFORM_LABELS,
  type CatalogAlbum,
  type CatalogArtist,
  type CatalogCollection,
  type CatalogCollectionRef,
  type CatalogPlatform,
  type CatalogPlaylist,
  type CatalogProviderId,
  type CatalogSearchChunk,
  type CatalogSearchDoneChunk,
  type CatalogSearchSection,
  type CatalogSection,
  type CatalogSource,
  type CatalogSourceStatus,
  type CatalogTrack,
  type SavedCollection,
} from '@now-playing/contracts';
import { normaliseIsrc, parseMusicLink } from './query.js';
import { sameRecording } from './merge.js';

/* ------------------------------------------------------------------ the live feed */

export interface CatalogResults {
  tracks: CatalogTrack[];
  artists: CatalogArtist[];
  albums: CatalogAlbum[];
  /** Public playlists (UX-CAT-005): Deezer's, when the search asked for the section. */
  playlists: CatalogPlaylist[];
  /** Every service's latest state: from the first chunk on, replaced by each later one. */
  status: CatalogSourceStatus[];
  /** The closing chunk, once it has arrived: paging, totals, and a pasted link to resolve. */
  done: CatalogSearchDoneChunk | null;
}

export const EMPTY_RESULTS: CatalogResults = { tracks: [], artists: [], albums: [], playlists: [], status: [], done: null };

/** Replace rows already shown, in place (so arrival order holds), and add new ones at the end. */
export function upsertById<T extends { id: string }>(list: readonly T[], rows: readonly T[]): T[] {
  if (!rows.length) return list as T[];
  const out = list.slice();
  const at = new Map(out.map((row, index) => [row.id, index]));
  for (const row of rows) {
    const index = at.get(row.id);
    if (index === undefined) {
      at.set(row.id, out.length);
      out.push(row);
    } else out[index] = row;
  }
  return out;
}

/** One chunk folded into what is on screen. */
export function foldCatalogChunk(state: CatalogResults, chunk: CatalogSearchChunk): CatalogResults {
  if (chunk.type === 'done') return { ...state, status: chunk.status, done: chunk };
  return {
    tracks: upsertById(state.tracks, chunk.tracks),
    artists: upsertById(state.artists, chunk.artists),
    albums: upsertById(state.albums, chunk.albums),
    playlists: upsertById(state.playlists, chunk.playlists),
    status: chunk.status.length ? chunk.status : state.status,
    done: state.done,
  };
}

/** Best answer first; equal ranks keep the order they arrived in (the sort is stable). */
export function byRank<T extends { rank: number }>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) => b.rank - a.rank);
}

/**
 * A further page of one section added under the rows already shown ("See All"): merging happens per
 * page on the server, so the same song can come back on a later page from another service. Tracks
 * already shown are dropped by id and by `sameRecording`; artists and albums by id.
 */
export function appendPage<T extends { id: string }>(shown: readonly T[], page: readonly T[], same?: (a: T, b: T) => boolean): T[] {
  const out = shown.slice();
  const ids = new Set(out.map((row) => row.id));
  for (const row of page) {
    if (ids.has(row.id)) continue;
    if (same && out.some((other) => same(other, row))) continue;
    ids.add(row.id);
    out.push(row);
  }
  return out;
}

export function appendTracks(shown: readonly CatalogTrack[], page: readonly CatalogTrack[]): CatalogTrack[] {
  return appendPage(shown, page, sameRecording);
}

/* ------------------------------------------------------------------ the overview and a type's page */

/**
 * The calm overview (UX-SEARCH-007, owner 2026-10-07): a few of each kind, each group ending in
 * "See all N", and no pager. The same counts as the player's (NP-FIND-003).
 */
export const OVERVIEW_ROWS: Record<CatalogSearchSection, number> = { tracks: 5, artists: 3, albums: 3, playlists: 3 };

/** A type's own page (UX-SEARCH-009) is paged in these: 25 songs, or 12 artists, albums or playlists. */
export const TYPE_PAGE_ROWS: Record<CatalogSearchSection, number> = { tracks: 25, artists: 12, albums: 12, playlists: 12 };

/** The kinds in the order every window shows them. */
export const SEARCH_TYPES: readonly CatalogSearchSection[] = ['tracks', 'artists', 'albums', 'playlists'];

const NOUNS: Record<CatalogSearchSection, [string, string]> = { tracks: ['song', 'songs'], artists: ['artist', 'artists'], albums: ['album', 'albums'], playlists: ['playlist', 'playlists'] };

/** "12+ songs", "1 artist": a count with its kind, `+` while the services say there is more. */
export function typeCount(section: CatalogSearchSection, n: number, more: boolean): string {
  const [one, many] = NOUNS[section];
  return `${n}${more ? '+' : ''} ${n === 1 && !more ? one : many}`;
}

/** The overview's way into a type's page: "See all 12+ songs". */
export function seeAllText(section: CatalogSearchSection, n: number, more: boolean): string {
  return `See all ${typeCount(section, n, more)}`;
}

/** The end of a type's page, once the services have nothing more: "That’s all 31 songs." */
export function thatsAllText(section: CatalogSearchSection, n: number): string {
  return `That’s all ${typeCount(section, n, false)}.`;
}

export interface SectionPages {
  /** 0-based page on show. */
  page: number;
  /** Pages that can be drawn from the rows already loaded. */
  known: number;
  /** True while the services say there is more past what is loaded (`hasMore`). */
  more: boolean;
  canPrev: boolean;
  canNext: boolean;
  /** The next page needs rows the window has not loaded yet: ask the server for its next `offset`. */
  fetchForNext: boolean;
  /** "Page 2 of 3", "Page 2 of 3+" (the owner's words: M+ while more may exist). */
  label: string;
}

/**
 * Where a type page's pager stands (UX-SEARCH-009): pages of `size` over the rows loaded so far, with
 * the services' `hasMore` saying whether there are pages past them. Page `n` starts at row
 * `n * size`; ‹ › scroll to that row, and fetch first when `fetchForNext` says it has not arrived.
 */
export function sectionPages(loaded: number, size: number, page: number, more: boolean): SectionPages {
  const known = Math.max(1, Math.ceil(loaded / size));
  const at = Math.max(0, Math.min(page, known - 1));
  const lastKnown = at >= known - 1;
  return {
    page: at,
    known,
    more,
    canPrev: at > 0,
    canNext: !lastKnown || more,
    fetchForNext: lastKnown && more,
    label: `Page ${at + 1} of ${known}${more ? '+' : ''}`,
  };
}

/** "Playlist on Deezer · Playlist Editor · 40 songs" (NP-FIND-009). */
export function playlistLine(playlist: Pick<CatalogPlaylist, 'sources' | 'owner' | 'trackCount'>): string {
  const platform = playlist.sources[0] ? platformLabel(playlist.sources[0].platform) : null;
  return [platform ? `Playlist on ${platform}` : 'Playlist', playlist.owner, playlist.trackCount === null ? null : count(playlist.trackCount, 'song')].filter(Boolean).join(' · ');
}

/**
 * The starred lists a type's page shows first, "In your library": those of `kind` whose title or
 * owner holds every word searched (all of them when nothing was typed).
 */
export function savedMatching(items: readonly SavedCollection[], kind: 'album' | 'playlist', words: string): SavedCollection[] {
  const terms = words.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => item.ref.kind === kind && terms.every((term) => `${item.ref.title} ${item.ref.owner ?? ''}`.toLowerCase().includes(term)));
}

/* ------------------------------------------------------------------ the services */

export const CATALOG_PROVIDER_LABELS: Record<CatalogProviderId, string> = {
  itunes: 'iTunes',
  deezer: 'Deezer',
  musicbrainz: 'MusicBrainz',
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
};

export const CATALOG_SECTION_LABELS: Record<CatalogSection, string> = { tracks: 'Songs', artists: 'Artists', albums: 'Albums' };
/** The same, for every section a search can be asked for (UX-CAT-005). */
export const CATALOG_SEARCH_SECTION_LABELS: Record<CatalogSearchSection, string> = { ...CATALOG_SECTION_LABELS, playlists: 'Playlists' };

export type CatalogDot = 'ok' | 'warn' | 'bad' | 'busy' | 'off';

/** The lamp beside a service's name. Its words (`sourceStateText`) always say the same thing. */
export function sourceDot(state: CatalogSourceStatus['state']): CatalogDot {
  switch (state) {
    case 'pending':
      return 'busy';
    case 'ok':
      return 'ok';
    case 'empty':
    case 'skipped':
      return 'off';
    case 'cooling-down':
    case 'timeout':
      return 'warn';
    case 'failed':
      return 'bad';
  }
}

/** "back at 14:05" in the viewer's own clock, or "back in a moment" when it is that close. */
export function retryText(retryAt: string | null, now: number): string | null {
  if (!retryAt) return null;
  const at = Date.parse(retryAt);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 5) return 'back in a moment';
  if (seconds < 90) return `back in ${seconds} s`;
  if (seconds < 3600) return `back in ${Math.round(seconds / 60)} min`;
  return `back at ${new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** A service's state in a few words (UX-CAT-001), never a status code. */
export function sourceStateText(status: CatalogSourceStatus, now: number): string {
  switch (status.state) {
    case 'pending':
      return 'asking…';
    case 'ok':
      return status.count === 1 ? '1 found' : `${status.count} found`;
    case 'empty':
      return 'nothing found';
    case 'failed':
      return 'failed';
    case 'timeout':
      return 'took too long';
    case 'cooling-down':
      return `resting${retryText(status.retryAt, now) ? `, ${retryText(status.retryAt, now)}` : ''}`;
    case 'skipped':
      return 'not asked';
  }
}

/** The status line's one sentence for a screen reader: "Searching: 2 of 5 services have answered." */
export function statusSummary(status: readonly CatalogSourceStatus[], done: boolean, totals?: { tracks: number; artists: number; albums: number; playlists?: number }): string {
  if (!status.length) return '';
  const answered = status.filter((s) => s.state !== 'pending').length;
  if (!done) return `Searching: ${answered} of ${status.length} services have answered.`;
  // Playlists are said only when some came: a search that did not ask for them has nothing to say.
  const found = totals ? [count(totals.tracks, 'song'), count(totals.artists, 'artist'), count(totals.albums, 'album'), totals.playlists ? count(totals.playlists, 'playlist') : null].filter(Boolean).join(', ') : null;
  const trouble = status.filter((s) => s.state === 'failed' || s.state === 'timeout' || s.state === 'cooling-down').map((s) => CATALOG_PROVIDER_LABELS[s.provider]);
  return [`Done${found ? `: ${found}` : ''}.`, trouble.length ? `${trouble.join(', ')} did not answer.` : null].filter(Boolean).join(' ');
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ what a row says */

/** Each platform once, in the order its sources came. */
export function platformsOf(sources: readonly CatalogSource[]): CatalogPlatform[] {
  const out: CatalogPlatform[] = [];
  for (const source of sources) if (!out.includes(source.platform)) out.push(source.platform);
  return out;
}

export function platformLabel(platform: CatalogPlatform): string {
  return CATALOG_PLATFORM_LABELS[platform];
}

/** What a Spotify song's row says beside its Spotify chip. */
export const PLAYS_FROM_SPOTDL = 'plays from YouTube Music via spotDL';

/**
 * Whether a song plays only through Spotify (UX-CAT-003): spotDL fetches YouTube Music's recording
 * of it, so the row says so. False when it is also somewhere it plays from directly.
 */
export function playsThroughSpotdl(sources: readonly CatalogSource[]): boolean {
  if (!sources.some((s) => s.platform === 'spotify')) return false;
  return !sources.some((s) => s.platform !== 'spotify' && !(s.platform === 'youtube-music' && s.matchedBy === 'spotdl') && ['youtube', 'youtube-music', 'soundcloud', 'bandcamp'].includes(s.platform));
}

/** The same in one line where no chip is drawn: "Spotify · plays from YouTube Music via spotDL", or null. */
export function playsFromText(sources: readonly CatalogSource[]): string | null {
  return playsThroughSpotdl(sources) ? `Spotify · ${PLAYS_FROM_SPOTDL}` : null;
}

/** The 30-second clip a row can play: Apple Music's, else Deezer's (DRM-free, keyless). */
export function previewOf(sources: readonly CatalogSource[]): { url: string; platform: CatalogPlatform } | null {
  for (const platform of ['apple-music', 'deezer'] as const) {
    const found = sources.find((s) => s.platform === platform && s.previewUrl);
    if (found?.previewUrl) return { url: found.previewUrl, platform };
  }
  return null;
}

/** 3:09, 1:02:09. */
export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** How many featured names a credit line spells out before "& others". */
export const CREDIT_FEATURES_MAX = 4;

const FEATURE_WORDS = /\b(?:feat\.?|ft\.?|featuring|with)\b/i;

/**
 * Who made the song, in one line (UX-CAT-006): the main artist, then "feat. A & B" from the other
 * credited names (`artists[1..]`) when the artist line does not already name them — a store writes
 * "Daft Punk" and lists Pharrell Williams and Nile Rodgers as contributors; an upload's title may
 * already say "feat.". Names already in the line, and repeats, are left out; order is kept; after
 * `CREDIT_FEATURES_MAX` names the rest are "& others".
 */
export function creditLine(track: Pick<CatalogTrack, 'artist' | 'artists'>): string {
  const main = track.artist.trim() || track.artists[0] || '';
  const said = main.toLowerCase();
  const seen = new Set<string>([said, (track.artists[0] ?? '').trim().toLowerCase()]);
  const features: string[] = [];
  for (const name of track.artists.slice(1)) {
    const clean = name.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key) || said.includes(key)) continue;
    seen.add(key);
    features.push(clean);
  }
  if (!features.length || FEATURE_WORDS.test(main)) return main;
  const named = features.slice(0, CREDIT_FEATURES_MAX);
  const tail = features.length > CREDIT_FEATURES_MAX ? [...named, 'others'] : named;
  const list = tail.length === 1 ? tail[0]! : `${tail.slice(0, -1).join(', ')} & ${tail.at(-1)!}`;
  return `${main} feat. ${list}`;
}

/** The album line under a song: "Random Access Memories · 2013". */
export function albumLine(track: Pick<CatalogTrack, 'album' | 'year'>): string {
  return [track.album, track.year].filter(Boolean).join(' · ');
}

/** What a catalog download carried into its tags, in words: "ISRC, genre, year and lyrics". */
export function embeddedText(embedded: { isrc: boolean; genre: boolean; label: boolean; year: boolean; lyrics: boolean }): string {
  const parts = [embedded.isrc && 'ISRC', embedded.genre && 'genre', embedded.label && 'label', embedded.year && 'year', embedded.lyrics && 'lyrics'].filter((p): p is string => Boolean(p));
  if (!parts.length) return 'no extra tags';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
}

/* ------------------------------------------------------------------ the query */

export interface CatalogFields {
  q: string;
  track: string;
  artist: string;
  album: string;
}

export const EMPTY_FIELDS: CatalogFields = { q: '', track: '', artist: '', album: '' };

/**
 * The advanced fields folded back into the one line when they are put away, so nothing typed is
 * lost: "daft punk" with Track "Get Lucky" becomes "daft punk Get Lucky".
 */
export function collapseFields(fields: CatalogFields): CatalogFields {
  const q = [fields.q, fields.track, fields.artist, fields.album].map((part) => part.trim()).filter(Boolean).join(' ');
  return { q, track: '', artist: '', album: '' };
}

export function hasQuery(fields: CatalogFields): boolean {
  return Boolean(fields.q.trim() || fields.track.trim() || fields.artist.trim() || fields.album.trim());
}

/** What the person typed reads as a link (resolved, not searched) or an ISRC. */
export function queryKind(q: string): 'url' | 'isrc' | 'text' {
  const text = q.trim();
  if (/^https?:\/\//i.test(text) && parseMusicLink(text)) return 'url';
  if (normaliseIsrc(text)) return 'isrc';
  return 'text';
}

/* ------------------------------------------------------------------ collections */

export type CoverArt = { kind: 'mosaic'; covers: [string, string, string, string] } | { kind: 'single'; url: string } | { kind: 'none' };

/**
 * A list's cover: a 2×2 mosaic of its first four songs' artwork when four differ, else the list's
 * own cover, else the one piece of artwork it has. An album whose songs all wear its cover is
 * therefore drawn with that cover, and a playlist with four songs' artwork as a mosaic.
 */
export function coverArt(collection: Pick<CatalogCollection, 'artworkUrl' | 'covers'>): CoverArt {
  const distinct = [...new Set(collection.covers)];
  if (distinct.length >= 4) return { kind: 'mosaic', covers: [distinct[0]!, distinct[1]!, distinct[2]!, distinct[3]!] };
  if (collection.artworkUrl) return { kind: 'single', url: collection.artworkUrl };
  if (distinct[0]) return { kind: 'single', url: distinct[0] };
  return { kind: 'none' };
}

/** One key per album or playlist, whatever page it was opened from. */
export function collectionKey(ref: Pick<CatalogCollectionRef, 'platform' | 'kind' | 'id'>): string {
  return `${ref.platform}:${ref.kind}:${ref.id}`;
}

/** What a star keeps: the stable ref and what the library draws it with. */
export function savedCollectionOf(collection: CatalogCollection, savedAt: string): SavedCollection {
  return {
    ref: collection.ref,
    savedAt,
    artworkUrl: collection.artworkUrl,
    covers: collection.covers.slice(0, 4),
    trackCount: collection.page.total,
  };
}

/** "Playlist · Spotify · 42 songs", "Album · Deezer · 13 songs". */
export function collectionLine(collection: Pick<CatalogCollection, 'ref' | 'page'>): string {
  const total = collection.page.total;
  return [collection.ref.kind === 'album' ? 'Album' : 'Playlist', platformLabel(collection.ref.platform), total === null ? null : count(total, 'song')].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------ lyrics */

export interface LyricLine {
  /** Milliseconds from the start of the song. */
  at: number;
  text: string;
}

/** LRC (`[mm:ss.xx] line`) read into timed lines; untimed and metadata lines are left out. */
export function parseLrc(synced: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const line of synced.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const stamp of stamps) {
      const fraction = stamp[3] ? Number(stamp[3].padEnd(3, '0').slice(0, 3)) : 0;
      out.push({ at: Number(stamp[1]) * 60_000 + Number(stamp[2]) * 1000 + fraction, text });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

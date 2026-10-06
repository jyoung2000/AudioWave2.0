/**
 * The header search (NP-FIND-001..008): music — songs, artists and albums — from the catalog, live.
 *
 * Loaded lazily by the bridge after the shell starts; it takes over the header field `#q` and its
 * popover `#srch`, whose markup make-shell.py writes. What it keeps from the shell's first search:
 * Enter runs it, the rows are the iTunes 11 Up Next popover's, the artwork tile is a 30-second
 * audition with its ring (click, or a five-second hold), + files a song in the library over the
 * `library:add` wall, a stale query dims, and people on the paired hub sit above the songs.
 *
 * What is new: answers stream in and upsert by id, with every service's state on a quiet line;
 * Songs / Artists / Albums sections, each with a "see all" that scrolls without end; album, artist
 * and song details that stack and go back; Track / Artist / Album fields and ISRC search; a filter
 * for sections and services, kept in the player's settings store; a pasted link of any platform,
 * whose album or playlist opens in the music list. No row ever offers "search on another site".
 */
import type {
  CatalogAlbum,
  CatalogAlbumDetail,
  CatalogArtist,
  CatalogArtistDetail,
  CatalogCollection,
  CatalogCollectionRef,
  CatalogEnrichment,
  CatalogLyrics,
  CatalogProviderId,
  CatalogResolveResult,
  CatalogSearchChunk,
  CatalogSection,
  CatalogSourceStatus,
  CatalogTrack,
  CatalogTrackPage,
  SavedCollection,
} from '@now-playing/contracts';
import { CATALOG_COLLECTION_CAP, CATALOG_PLATFORM_LABELS, CATALOG_PROVIDERS } from '@now-playing/contracts';
import { pickDownloadSource, sameRecording } from '@now-playing/domain/catalog';
import { ask, clients, jsonp, legacyHubSearch, Refused, Unreachable, type CatalogClient, type SearchParams } from './client.js';
import * as V from './view.js';

/* ------------------------------------------------------------------ shapes */

type Opt =
  | { kind: 'track'; t: CatalogTrack }
  | { kind: 'artist'; a: CatalogArtist }
  | { kind: 'album'; al: CatalogAlbum }
  | { kind: 'more'; section: CatalogSection }
  | { kind: 'collection'; c: CatalogCollection };

interface AdvFields {
  track: string;
  artist: string;
  album: string;
  isrc: string;
}

interface Filter {
  sections: Record<CatalogSection, boolean>;
  providers: Record<CatalogProviderId, boolean>;
}

/** Rows of one section, upserted by id; ordered by rank, ties by arrival (UX-CAT-002). */
class Bag<T extends { id: string; rank: number }> {
  private rows: Array<{ row: T; at: number }> = [];
  private n = 0;
  constructor(private readonly same?: (a: T, b: T) => boolean) {}
  upsert(list: readonly T[]): void {
    for (const row of list) {
      // By id first (a later chunk replaces its row in place), then by recording (a duplicate is dropped).
      const byId = this.rows.find((r) => r.row.id === row.id);
      if (byId) byId.row = row;
      else if (!this.same || !this.rows.some((r) => this.same!(r.row, row))) this.rows.push({ row, at: this.n++ });
    }
    this.rows.sort((a, b) => b.row.rank - a.row.rank || a.at - b.at);
  }
  /** Appends a later page beneath what is there: a song seen already (by id or recording) is skipped. */
  append(list: readonly T[]): number {
    let added = 0;
    for (const row of list) {
      if (this.rows.some((r) => r.row.id === row.id || (this.same ? this.same(r.row, row) : false))) continue;
      this.rows.push({ row, at: this.n++ });
      added += 1;
    }
    return added;
  }
  get list(): T[] {
    return this.rows.map((r) => r.row);
  }
  get size(): number {
    return this.rows.length;
  }
}

const sameSong = (a: CatalogTrack, b: CatalogTrack): boolean => a.id !== b.id && sameRecording(a, b);

interface Results {
  tracks: Bag<CatalogTrack>;
  artists: Bag<CatalogArtist>;
  albums: Bag<CatalogAlbum>;
  status: CatalogSourceStatus[];
  done: boolean;
  more: Record<CatalogSection, boolean>;
  via: string;
  error: string | null;
}

const freshResults = (): Results => ({ tracks: new Bag<CatalogTrack>(sameSong), artists: new Bag(), albums: new Bag(), status: [], done: false, more: { tracks: false, artists: false, albums: false }, via: '', error: null });

type View =
  | { kind: 'results' }
  | { kind: 'link'; url: string; result: CatalogResolveResult | null; error: string | null; client: CatalogClient | null }
  | { kind: 'all'; section: CatalogSection; res: Results; offset: number; loading: boolean; ctl: AbortController | null }
  | { kind: 'album'; id: string; title: string; detail: CatalogAlbumDetail | null; error: string | null; client: CatalogClient | null }
  | { kind: 'artist'; id: string; name: string; detail: CatalogArtistDetail | null; error: string | null }
  | { kind: 'song'; t: CatalogTrack; enrich: CatalogEnrichment | null; enrichSaid: string | null; lyrics: CatalogLyrics | null; lyricsSaid: string | null };

/** What the shell's library (index.html) offers this module; see make-shell.py, "the music list". */
interface ShellList {
  showCollection(info: ListedCollection): void;
}

export interface ListSong {
  id: string;
  kind: 'music';
  title: string;
  artist: string;
  album: string;
  duration: number;
  bpm: number | null;
  date: string | null;
  platform: string;
  url: string;
  art: string | null;
}

/** An album or playlist as the music list shows it: rows now, more on request (NP-FIND-007). */
export interface ListedCollection {
  ref: CatalogCollectionRef;
  /** "Spotify", "Deezer": the list's platform, named in the bar. */
  platformLabel: string;
  artworkUrl: string | null;
  covers: string[];
  trackCount: number | null;
  rows: ListSong[];
  capped: boolean;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** The next page; resolves with its rows and whether more remain. */
  more(): Promise<{ rows: ListSong[]; hasMore: boolean; total: number | null; capped: boolean }>;
}

const PREVIEW_N: Record<CatalogSection, number> = { tracks: 5, artists: 3, albums: 3 };
const PAGE_LIMIT = 25;
const FILTER_KEY = 'player:search';
const SECTIONS: CatalogSection[] = ['tracks', 'artists', 'albums'];

/* ----------------------------------------------------------------- module */

export interface SearchApi {
  openSaved(saved: SavedCollection): void;
}

let installed: SearchApi | null = null;

export function installSearch(): SearchApi {
  if (installed) return installed;
  const w = window as unknown as {
    kv: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> | void };
    say?: (s: string) => void;
    NP_PLAYER?: { playing?(): boolean; pause(): void; resume(): void };
    outputVolume?: number;
    hubPeople?: { ready(): boolean; hubName(): string; search(q: string): Promise<Array<{ id: string; name: string; playlists: number; img: string | null }>>; open(id: string): void };
    NP_LIST?: ShellList;
    NP_FETCH?: (song: unknown) => void;
    LIBRARY?: Array<{ id: string; title: string; url?: string | null }>;
    NP_SRCH_CLIP?: number;
    NP_SRCH_ARM_MS?: number;
    NP_FIND?: (q: string) => Promise<Array<{ t: string; a: string; al: string; d: number | null; bpm: number | null; p: string | null; u: string | null }>>;
    srchClose?: () => void;
  };
  const $ = <E extends HTMLElement>(id: string): E => document.getElementById(id) as E;
  const input = $<HTMLInputElement>('q');
  const pop = $('srch');
  const count = $('srchCount');
  const body = $('srchBody');
  const foot = $('srchFoot');
  const live = $('srchLive');
  const statusEl = $('srchStatus');
  const back = $<HTMLButtonElement>('srchBack');
  const filterBtn = $<HTMLButtonElement>('srchFilterBtn');
  const advForm = $<HTMLFormElement>('srchAdv');
  const advBtn = $<HTMLButtonElement>('qMore');
  const peopleBox = $('srchPeople');
  const say = (s: string): void => w.say?.(s);

  const CLIP = V.CLIP_SECONDS;
  const TAIL = 0.7;
  w.NP_SRCH_CLIP = CLIP;
  const ARM_DEFAULT_MS = 5000;
  w.NP_SRCH_ARM_MS = ARM_DEFAULT_MS;

  let res = freshResults();
  let stack: View[] = [];
  let options: Opt[] = [];
  let hot = -1;
  let lastQ = '';
  let lastLabel = '';
  let seq = 0;
  let ctl: AbortController | null = null;
  const added = new Set<string>();
  let filter: Filter = { sections: { tracks: true, artists: true, albums: true }, providers: { itunes: true, deezer: true, musicbrainz: true, youtube: true, soundcloud: true } };

  void Promise.resolve(w.kv.get(FILTER_KEY))
    .then((v) => {
      const f = v as Partial<Filter> | null;
      if (f && typeof f === 'object') {
        for (const s of SECTIONS) if (typeof f.sections?.[s] === 'boolean') filter.sections[s] = f.sections[s];
        for (const p of CATALOG_PROVIDERS) if (typeof f.providers?.[p] === 'boolean') filter.providers[p] = f.providers[p];
        paintFilterBtn();
      }
    })
    .catch(() => undefined);

  const top = (): View | undefined => stack[stack.length - 1];
  const hotOf = new WeakMap<View, number>();

  /* --------------------------------------------------------------- open/close */

  function open(): void {
    pop.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function close(): void {
    stopPreview();
    pop.hidden = true;
    pop.classList.remove('is-stale');
    hot = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  // The toolbar shuts the popover when the header field is hidden (other tabs).
  w.srchClose = close;

  /* -------------------------------------------------------------- rendering */

  function msg(html: string): string {
    return `<div class="srch__msg">${html}</div>`;
  }

  function sectionRows(r: Results, section: CatalogSection, limit: number): Opt[] {
    const list = section === 'tracks' ? r.tracks.list : section === 'artists' ? r.artists.list : r.albums.list;
    return list.slice(0, limit).map((x) => (section === 'tracks' ? { kind: 'track', t: x as CatalogTrack } : section === 'artists' ? { kind: 'artist', a: x as CatalogArtist } : { kind: 'album', al: x as CatalogAlbum }));
  }

  function optHTML(o: Opt, i: number): string {
    switch (o.kind) {
      case 'track':
        return V.trackRowHTML(o.t, i, added.has(o.t.id));
      case 'artist':
        return V.artistRowHTML(o.a, i);
      case 'album':
        return V.albumRowHTML(o.al, i);
      case 'collection':
        return V.collectionRowHTML(o.c, i);
      case 'more': {
        const bag = o.section === 'tracks' ? res.tracks : o.section === 'artists' ? res.artists : res.albums;
        return V.moreRowHTML(o.section, PREVIEW_N[o.section], bag.size, res.more[o.section], i);
      }
    }
  }

  /** Rows inside a listbox; groups name their section. */
  function listbox(groups: Array<{ label: string | null; opts: Opt[] }>, label: string): string {
    options = [];
    let html = `<div role="listbox" id="srchList" aria-label="${V.esc(label)}">`;
    for (const g of groups) {
      if (!g.opts.length) continue;
      const rows = g.opts.map((o) => {
        options.push(o);
        return optHTML(o, options.length - 1);
      });
      html += g.label
        ? `<div class="srch__sec" role="group" aria-label="${V.esc(g.label)}"><div class="srch__cap" aria-hidden="true">${V.esc(g.label)}</div>${rows.join('')}</div>`
        : rows.join('');
    }
    return `${html}</div>`;
  }

  function wanted(): CatalogSection[] {
    const on = SECTIONS.filter((s) => filter.sections[s]);
    return on.length ? on : ['tracks'];
  }

  function totalsLine(r: Results): string {
    return wanted()
      .map((s) => V.count((s === 'tracks' ? r.tracks : s === 'artists' ? r.artists : r.albums).size, s))
      .join(' · ');
  }

  function paintStatus(list: CatalogSourceStatus[], via: string): void {
    statusEl.hidden = !list.length && !via;
    statusEl.innerHTML = list.length ? V.statusHTML(list, via) : via ? `<span class="srch__via2">Through ${V.esc(via)}</span>` : '';
  }

  function render(): void {
    const v = top();
    back.hidden = stack.length < 2;
    foot.hidden = true;
    if (!v) {
      body.innerHTML = '';
      return;
    }
    if (v.kind === 'results') renderResults();
    else if (v.kind === 'link') renderLink(v);
    else if (v.kind === 'all') renderAll(v);
    else if (v.kind === 'album') renderAlbum(v);
    else if (v.kind === 'artist') renderArtist(v);
    else renderSong(v);
    if (hot >= options.length) hot = options.length - 1;
    applyHot();
    enrichTempo();
  }

  function renderResults(): void {
    const r = res;
    const n = r.tracks.size + r.artists.size + r.albums.size;
    paintStatus(r.status, r.via);
    if (!n) {
      options = [];
      if (!r.done) {
        count.innerHTML = 'Searching…';
        body.innerHTML = msg(`${V.spinner()}<span>Searching…</span>`);
        live.textContent = 'Searching';
        return;
      }
      count.innerHTML = '<b>Results:</b> 0 songs';
      if (r.error) {
        body.innerHTML = msg(V.esc(r.error));
        live.textContent = 'Search failed';
      } else {
        const said = V.statusWords(r.status.filter((s) => s.state === 'failed' || s.state === 'timeout' || s.state === 'cooling-down'));
        const failedAll = r.status.length > 0 && r.status.every((s) => s.state !== 'ok' && s.state !== 'empty');
        body.innerHTML = msg(failedAll ? `Couldn’t search just now — ${V.esc(said || 'no service answered')}.` : `No matches for “${V.esc(lastLabel)}”.`);
        live.textContent = failedAll ? 'Search failed' : 'No results';
      }
      return;
    }
    const groups: Array<{ label: string | null; opts: Opt[] }> = [];
    for (const s of wanted()) {
      const bag = s === 'tracks' ? r.tracks : s === 'artists' ? r.artists : r.albums;
      const opts = sectionRows(r, s, PREVIEW_N[s]);
      if (opts.length && (bag.size > PREVIEW_N[s] || r.more[s])) opts.push({ kind: 'more', section: s });
      groups.push({ label: V.SECTION_LABEL[s], opts });
    }
    count.innerHTML = `<b>Results:</b> ${totalsLine(r)}${r.done ? '' : ' …'}`;
    body.innerHTML = listbox(groups, 'Search results') + (r.error ? msg(V.esc(r.error)) : '');
    live.textContent = `${totalsLine(r)}${r.done ? '' : ', still searching'}`;
  }

  function renderLink(v: Extract<View, { kind: 'link' }>): void {
    paintStatus([], v.client ? v.client.label : '');
    if (!v.result && !v.error) {
      options = [];
      count.innerHTML = 'Reading the link…';
      const slow = /spotify\.com\//.test(v.url) ? ' Spotify links are read by spotDL, which can take a minute.' : '';
      body.innerHTML = msg(`${V.spinner()}<span>Reading the link…${slow}</span>`);
      live.textContent = 'Reading the link';
      return;
    }
    if (v.error || !v.result) {
      options = [];
      count.innerHTML = 'Link';
      body.innerHTML = msg(V.esc(v.error ?? 'The link could not be read.'));
      live.textContent = 'The link could not be read';
      return;
    }
    const r = v.result;
    if (r.kind === 'unavailable' || r.kind === 'unsupported') {
      options = [];
      count.innerHTML = `<b>${V.esc(r.platform ? CATALOG_PLATFORM_LABELS[r.platform] : 'Link')}:</b> ${r.kind === 'unavailable' ? 'unavailable' : 'not readable here'}`;
      body.innerHTML = msg(V.esc(r.reason ?? 'That link cannot be read.'));
      live.textContent = r.reason ?? 'That link cannot be read';
      return;
    }
    const opts: Opt[] = [];
    if (r.track) opts.push({ kind: 'track', t: r.track });
    if (r.artist) opts.push({ kind: 'artist', a: r.artist });
    if (r.collection) opts.push({ kind: 'collection', c: r.collection });
    count.innerHTML = r.track ? '<b>Results:</b> 1 song' : r.collection ? `<b>${V.esc(r.collection.ref.kind === 'album' ? 'Album' : 'Playlist')}:</b> ${V.esc(CATALOG_PLATFORM_LABELS[r.collection.ref.platform])}` : '<b>Artist</b>';
    body.innerHTML = listbox([{ label: null, opts }], 'The pasted link') + (r.collection ? msg('Open it to see its songs in the music list, where the star keeps it in your library.') : '');
    live.textContent = r.track ? `1 song: ${r.track.title}` : r.collection ? `${r.collection.ref.title}, ${V.collectionWords(r.collection)}` : 'An artist';
  }

  function renderAll(v: Extract<View, { kind: 'all' }>): void {
    const r = v.res;
    const bag = v.section === 'tracks' ? r.tracks : v.section === 'artists' ? r.artists : r.albums;
    paintStatus(r.status, r.via);
    count.innerHTML = `<b>${V.SECTION_LABEL[v.section]}:</b> ${V.count(bag.size, v.section)}${r.more[v.section] ? '+' : ''} for “${V.esc(lastLabel)}”`;
    const opts = sectionRows(r, v.section, bag.size);
    const tail = v.loading ? msg(`${V.spinner()}<span>Loading more…</span>`) : r.error ? msg(V.esc(r.error)) : !r.more[v.section] && bag.size ? `<div class="srch__end">That’s all ${V.count(bag.size, v.section)}.</div>` : '';
    body.innerHTML = opts.length ? listbox([{ label: null, opts }], `All ${V.SECTION_LABEL[v.section].toLowerCase()}`) + tail : tail || msg(`${V.spinner()}<span>Loading…</span>`);
    live.textContent = `${V.count(bag.size, v.section)}${r.more[v.section] ? ', more as you scroll' : ''}`;
  }

  function renderAlbum(v: Extract<View, { kind: 'album' }>): void {
    paintStatus([], v.client?.label ?? '');
    count.innerHTML = `<b>Album:</b> ${V.esc(v.title)}`;
    if (!v.detail) {
      options = [];
      body.innerHTML = msg(v.error ? V.esc(v.error) : `${V.spinner()}<span>Opening the album…</span>`);
      live.textContent = v.error ?? 'Opening the album';
      return;
    }
    const { album, page } = v.detail;
    const facts = [album.year ?? album.releaseDate?.slice(0, 4), album.label, album.genre, page.total ? `${page.total} songs` : null].filter(Boolean).map((x) => V.esc(x)).join(' · ');
    const head = V.detailHead({
      cover: V.coverHTML(album.artworkUrl),
      title: album.title,
      sub: album.artist ?? '',
      facts,
      badges: V.badgesHTML(album.sources),
      actions: '<button class="srch__btn" type="button" data-act="list">Open in Music</button>',
    });
    body.innerHTML = head + listbox([{ label: 'Songs', opts: page.tracks.map((t) => ({ kind: 'track' as const, t })) }], `${album.title}: songs`);
    live.textContent = `${album.title}, ${page.tracks.length} songs`;
  }

  function renderArtist(v: Extract<View, { kind: 'artist' }>): void {
    paintStatus([], '');
    count.innerHTML = `<b>Artist:</b> ${V.esc(v.name)}`;
    if (!v.detail) {
      options = [];
      body.innerHTML = msg(v.error ? V.esc(v.error) : `${V.spinner()}<span>Opening the artist…</span>`);
      live.textContent = v.error ?? 'Opening the artist';
      return;
    }
    const { artist, topTracks, albums } = v.detail;
    const facts = [artist.genre, artist.fans ? `${artist.fans.toLocaleString('en-US')} fans` : null, artist.albumCount ? `${artist.albumCount} albums` : null].filter(Boolean).map((x) => V.esc(x)).join(' · ');
    // Apple has no artist pictures: the first album's cover stands in.
    const picture = artist.pictureUrl ?? albums[0]?.artworkUrl ?? null;
    const head = V.detailHead({ cover: V.coverHTML(picture, true), title: artist.name, sub: '', facts, badges: V.badgesHTML(artist.sources), actions: '' });
    body.innerHTML =
      head +
      listbox(
        [
          { label: 'Top songs', opts: topTracks.map((t) => ({ kind: 'track' as const, t })) },
          { label: 'Albums', opts: albums.map((al) => ({ kind: 'album' as const, al })) },
        ],
        `${artist.name}: songs and albums`,
      );
    live.textContent = `${artist.name}: ${topTracks.length} songs, ${albums.length} albums`;
  }

  function renderSong(v: Extract<View, { kind: 'song' }>): void {
    const t = v.t;
    paintStatus([], '');
    count.innerHTML = `<b>Song:</b> ${V.esc(t.title)}`;
    const e = v.enrich;
    const genre = e?.genre ?? t.genre;
    const label = e?.label ?? t.label;
    const year = e?.year ?? t.year ?? (t.releaseDate ? Number(t.releaseDate.slice(0, 4)) : null);
    const facts = [
      genre ? `<span class="srch__fact"><b>Genre</b> ${V.esc(genre)}</span>` : '',
      label ? `<span class="srch__fact"><b>Label</b> ${V.esc(label)}</span>` : '',
      year ? `<span class="srch__fact"><b>Year</b> ${V.esc(year)}</span>` : '',
      t.isrc ?? e?.isrc ? `<span class="srch__fact"><b>ISRC</b> ${V.esc(t.isrc ?? e?.isrc)}</span>` : '',
      !e && !v.enrichSaid ? '<span class="srch__fact srch__fact--wait">Looking up genre, label and year…</span>' : '',
      v.enrichSaid ? `<span class="srch__fact srch__fact--wait">${V.esc(v.enrichSaid)}</span>` : '',
    ]
      .filter(Boolean)
      .join('');
    const sources = e ? [...t.sources, ...e.sources.filter((s) => !t.sources.some((x) => x.platform === s.platform))] : t.sources;
    const dl = pickDownloadSource(sources);
    const actions =
      (added.has(t.id) ? '<button class="srch__btn" type="button" disabled>In your library</button>' : '<button class="srch__btn" type="button" data-act="add">Add to Library</button>') +
      `<button class="srch__btn" type="button" data-act="download"${dl ? ` title="Fetched by the helper on this PC from ${V.esc(CATALOG_PLATFORM_LABELS[dl.platform])}"` : ' aria-disabled="true" title="Only in stores (Apple Music, Deezer): there is no copy the helper can fetch"'}>Download…</button>`;
    const head = V.detailHead({ cover: V.coverHTML(t.artworkUrl), title: t.title, sub: V.songSub(t), facts, badges: V.badgesHTML(sources), actions });
    const lyr = v.lyrics
      ? v.lyrics.found
        ? v.lyrics.instrumental
          ? msg('An instrumental: no words to show.')
          : V.lyricsHTML(v.lyrics.synced, v.lyrics.plain) || msg('LRCLIB has this song but no words for it.')
        : msg('No lyrics found for this song on LRCLIB.')
      : msg(v.lyricsSaid ? V.esc(v.lyricsSaid) : `${V.spinner()}<span>Looking for the lyrics…</span>`);
    body.innerHTML = head + listbox([{ label: null, opts: [{ kind: 'track', t }] }], t.title) + `<div class="srch__cap srch__cap--lyrics">Lyrics${v.lyrics?.synced ? ' <span>(synced)</span>' : ''}</div>` + lyr;
    live.textContent = `${t.title}${genre ? `, ${genre}` : ''}${year ? `, ${year}` : ''}`;
  }

  function applyHot(): void {
    const rows = body.querySelectorAll<HTMLElement>('.srch__row[data-i]');
    rows.forEach((el) => {
      const on = Number(el.dataset['i']) === hot;
      el.classList.toggle('is-hot', on);
      el.setAttribute('aria-selected', String(on));
      if (on) el.scrollIntoView?.({ block: 'nearest' });
    });
    if (hot >= 0) input.setAttribute('aria-activedescendant', `srchOpt${hot}`);
    else input.removeAttribute('aria-activedescendant');
  }

  /* ----------------------------------------------------------------- search */

  function upsert(r: Results, chunk: CatalogSearchChunk, client: CatalogClient): void {
    r.via = client.label;
    r.status = chunk.status.length ? chunk.status : r.status;
    if (chunk.type === 'results') {
      r.tracks.upsert(chunk.tracks);
      r.artists.upsert(chunk.artists);
      r.albums.upsert(chunk.albums);
    } else {
      r.done = true;
      for (const s of SECTIONS) r.more[s] = Boolean(chunk.page[s]?.hasMore);
    }
  }

  /**
   * One search against the first client that answers. `onChunk` sees every chunk as it arrives; a
   * server that cannot be reached before its first chunk is passed over for the next.
   */
  async function stream(p: SearchParams, signal: AbortSignal, onChunk: (c: CatalogSearchChunk, client: CatalogClient) => void, legacy: boolean): Promise<{ resolve: string | null }> {
    const list = await clients();
    let last: unknown = null;
    for (const c of list) {
      let got = false;
      let resolve: string | null = null;
      try {
        for await (const chunk of c.search(p, signal)) {
          got = true;
          if (chunk.type === 'done') resolve = chunk.resolve;
          onChunk(chunk, c);
        }
        if (!got) throw new Unreachable('it sent nothing');
        return { resolve };
      } catch (err) {
        if (signal.aborted) throw err;
        if (got) throw new Refused(`The search stopped part way (${err instanceof Error ? err.message : 'connection lost'}); these are the answers that came.`);
        // A hub from before the catalog still searches songs (NP-FIND-001).
        if (legacy && c.kind === 'hub' && err instanceof Unreachable && err.status === 404 && p.q && !p.offset) {
          const rows = await legacyHubSearch(p.q, signal).catch(() => null);
          if (rows && rows.length) {
            const query = { kind: 'text' as const, text: p.q, track: null, artist: null, album: null, isrc: null, url: null };
            onChunk({ type: 'results', seq: 0, provider: null, query, tracks: rows, artists: [], albums: [], status: [] }, { ...c, label: `${c.label} (songs only: it has no catalog yet)` });
            onChunk({ type: 'done', seq: 1, query, status: [], page: { tracks: { offset: 0, limit: rows.length, hasMore: false }, artists: null, albums: null }, totals: { tracks: rows.length, artists: 0, albums: 0 }, resolve: null }, { ...c, label: `${c.label} (songs only: it has no catalog yet)` });
            lendClips(p.q, rows);
            return { resolve: null };
          }
        }
        if (err instanceof Unreachable) {
          last = err;
          continue;
        }
        throw err;
      }
    }
    throw last instanceof Error ? last : new Error('Nothing could be reached');
  }

  function params(q: string, adv: AdvFields | null, sections: readonly CatalogSection[], offset: number): SearchParams {
    const providers = CATALOG_PROVIDERS.filter((p) => filter.providers[p]);
    const base = { sections, providers: providers.length ? providers : [...CATALOG_PROVIDERS], offset, limit: PAGE_LIMIT };
    if (adv && !adv.isrc) return { ...base, track: adv.track || undefined, artist: adv.artist || undefined, album: adv.album || undefined };
    return { ...base, q: adv?.isrc ? adv.isrc : q };
  }

  let lastAdv: AdvFields | null = null;

  function go(q: string, adv: AdvFields | null = null): void {
    people(adv ? '' : q);
    stopPreview();
    pop.classList.remove('is-stale');
    ctl?.abort();
    lastQ = q;
    lastAdv = adv;
    lastLabel = adv ? (adv.isrc ? `ISRC ${adv.isrc}` : [adv.track, adv.artist, adv.album].filter(Boolean).join(' · ')) : q;
    hot = -1;
    const mine = ++seq;
    const signal = (ctl = new AbortController()).signal;
    if (!adv && urlish(q)) {
      const v: View = { kind: 'link', url: q, result: null, error: null, client: null };
      stack = [v];
      open();
      render();
      void readLink(v, mine, signal);
      return;
    }
    res = freshResults();
    const r = res;
    stack = [{ kind: 'results' }];
    open();
    render();
    stream(params(q, adv, wanted(), 0), signal, (chunk, client) => {
      if (mine !== seq) return;
      upsert(r, chunk, client);
      if (top()?.kind === 'results') render();
    }, true)
      .then(({ resolve }) => {
        if (mine !== seq) return;
        // The server read it as a link after all: resolve it.
        if (resolve) {
          const v: View = { kind: 'link', url: resolve, result: null, error: null, client: null };
          stack = [v];
          render();
          void readLink(v, mine, signal);
          return;
        }
        r.done = true;
        if (top()?.kind === 'results') render();
      })
      .catch((err: unknown) => {
        if (mine !== seq || signal.aborted) return;
        r.done = true;
        r.error = failureWords(err);
        if (top()?.kind === 'results') render();
      });
  }

  function failureWords(err: unknown): string {
    if (err instanceof Refused) return err.message;
    if (err instanceof Unreachable) return 'Couldn’t search: neither the hub, the companion nor the music services answered. Check the connection and try again.';
    return `Couldn’t search: ${err instanceof Error ? err.message : 'something went wrong'}.`;
  }

  async function readLink(v: Extract<View, { kind: 'link' }>, mine: number, signal: AbortSignal): Promise<void> {
    try {
      const { value, client } = await ask((c) => c.resolve(v.url, 0, 100, signal));
      if (mine !== seq) return;
      v.result = value;
      v.client = client;
    } catch (err) {
      if (mine !== seq || signal.aborted) return;
      v.error = err instanceof Refused ? err.message : `The link could not be read: ${err instanceof Error ? err.message : 'no answer'}.`;
    }
    if (top() === v) render();
  }

  /** See all: one section, page after page as the list scrolls (NP-FIND-004). */
  function openAll(section: CatalogSection): void {
    stopPreview();
    const r = freshResults();
    // What the overview already has is the first page; the rest come from offset 25 onward.
    if (section === 'tracks') r.tracks.upsert(res.tracks.list);
    if (section === 'artists') r.artists.upsert(res.artists.list);
    if (section === 'albums') r.albums.upsert(res.albums.list);
    r.status = res.status;
    r.via = res.via;
    r.more[section] = res.more[section];
    r.done = true;
    const v: Extract<View, { kind: 'all' }> = { kind: 'all', section, res: r, offset: 0, loading: false, ctl: null };
    push(v);
    render();
    body.scrollTop = 0;
    if (res.more[section]) void loadMore(v);
  }

  async function loadMore(v: Extract<View, { kind: 'all' }>): Promise<void> {
    if (v.loading || !v.res.more[v.section]) return;
    v.loading = true;
    v.offset += PAGE_LIMIT;
    const mine = seq;
    const c = (v.ctl = new AbortController());
    const r = v.res;
    const fresh = freshResults();
    if (top() === v) render();
    try {
      await stream(params(lastQ, lastAdv, [v.section], v.offset), c.signal, (chunk, client) => {
        if (mine !== seq) return;
        upsert(fresh, chunk, client);
        r.status = fresh.status;
        r.via = fresh.via;
      }, false);
      if (mine !== seq) return;
      const bag = v.section === 'tracks' ? r.tracks : v.section === 'artists' ? r.artists : r.albums;
      const got = v.section === 'tracks' ? bag.append(fresh.tracks.list as never) : v.section === 'artists' ? bag.append(fresh.artists.list as never) : bag.append(fresh.albums.list as never);
      r.more[v.section] = fresh.more[v.section] && v.offset + PAGE_LIMIT <= 1000;
      r.error = null;
      if (!got && r.more[v.section]) {
        v.loading = false;
        return loadMore(v);
      }
    } catch (err) {
      if (mine !== seq || c.signal.aborted) return;
      r.error = failureWords(err);
      r.more[v.section] = false;
    }
    v.loading = false;
    if (top() === v) render();
  }

  body.addEventListener(
    'scroll',
    () => {
      const v = top();
      if (v?.kind !== 'all') return;
      if (body.scrollTop + body.clientHeight > body.scrollHeight - 120) void loadMore(v);
    },
    { passive: true },
  );

  /* ---------------------------------------------------------------- details */

  function openAlbum(al: Pick<CatalogAlbum, 'id' | 'title'>): void {
    stopPreview();
    const v: Extract<View, { kind: 'album' }> = { kind: 'album', id: al.id, title: al.title, detail: null, error: null, client: null };
    push(v);
    render();
    const mine = seq;
    ask((c) => c.album(al.id, 0, 100))
      .then(({ value, client }) => {
        v.detail = value;
        v.client = client;
      })
      .catch((err: unknown) => {
        v.error = err instanceof Refused ? err.message : 'The album could not be opened: nothing answered.';
      })
      .finally(() => {
        if (mine === seq && top() === v) render();
      });
  }

  function openArtist(a: Pick<CatalogArtist, 'id' | 'name'>): void {
    stopPreview();
    const v: Extract<View, { kind: 'artist' }> = { kind: 'artist', id: a.id, name: a.name, detail: null, error: null };
    push(v);
    render();
    const mine = seq;
    ask((c) => c.artist(a.id))
      .then(({ value }) => {
        v.detail = value;
      })
      .catch((err: unknown) => {
        v.error = err instanceof Refused ? err.message : 'The artist could not be opened: nothing answered.';
      })
      .finally(() => {
        if (mine === seq && top() === v) render();
      });
  }

  /** Genre, label and year from enrichment; lyrics, synced or plain (NP-FIND-006). */
  function openSong(t: CatalogTrack): void {
    stopPreview();
    const v: Extract<View, { kind: 'song' }> = { kind: 'song', t, enrich: null, enrichSaid: null, lyrics: null, lyricsSaid: null };
    push(v);
    render();
    const mine = seq;
    const again = (): void => {
      if (mine === seq && top() === v) render();
    };
    ask((c) => c.enrich(t))
      .then(({ value }) => {
        v.enrich = value;
      })
      .catch((err: unknown) => {
        v.enrichSaid = err instanceof Refused ? `MusicBrainz: ${err.message}` : 'Genre, label and year could not be looked up just now.';
      })
      .finally(again);
    if (!t.artist) {
      v.lyricsSaid = 'Lyrics are looked up by artist and title, and this song has no artist.';
      return;
    }
    ask((c) => c.lyrics(t))
      .then(({ value }) => {
        v.lyrics = value;
      })
      .catch((err: unknown) => {
        v.lyricsSaid = err instanceof Refused ? err.message : 'The lyrics could not be looked up just now.';
      })
      .finally(again);
  }

  /** A view on top of the stack; the one beneath remembers which row the keys were on. */
  function push(v: View): void {
    const under = top();
    if (under) hotOf.set(under, hot);
    stack.push(v);
    hot = -1;
  }

  function goBack(): void {
    if (stack.length < 2) return;
    stopPreview();
    const v = stack.pop();
    if (v?.kind === 'all') v.ctl?.abort();
    const now = top();
    hot = now ? (hotOf.get(now) ?? -1) : -1;
    render();
  }

  /* ------------------------------------------------------ the music list */

  function songFor(t: CatalogTrack): ListSong {
    const dl = pickDownloadSource(t.sources);
    const first = dl ?? t.sources.find((s) => /^https?:/.test(s.url)) ?? t.sources[0]!;
    return {
      id: `cat-${t.id}`,
      kind: 'music',
      title: t.title.slice(0, 120),
      artist: t.artist.slice(0, 80),
      album: (t.album ?? '').slice(0, 80),
      duration: t.durationMs ? Math.round(t.durationMs / 1000) : 0,
      bpm: t.bpm ? Math.round(t.bpm) : null,
      date: t.releaseDate,
      platform: CATALOG_PLATFORM_LABELS[first.platform],
      url: first.url,
      art: t.artworkUrl,
    };
  }

  /** The next page of a list, from whichever server answers: an album by its id, anything else by its link. */
  function pager(ref: CatalogCollectionRef): (offset: number) => Promise<CatalogTrackPage> {
    const byId = ref.kind === 'album' && (ref.platform === 'deezer' || ref.platform === 'apple-music');
    return async (offset) => {
      const { value } = await ask((c) => (byId ? c.album(`${ref.platform}:${ref.id}`, offset, CATALOG_COLLECTION_CAP - offset).then((d) => d.page) : c.resolve(ref.url, offset, Math.min(200, CATALOG_COLLECTION_CAP - offset)).then((r) => {
        if (!r.collection) throw new Refused(r.reason ?? 'The list could not be read again.');
        return r.collection.page;
      })));
      return value;
    };
  }

  /** Opens an album or playlist in the music list the way an album opens (NP-FIND-007). */
  function showInList(c: Pick<CatalogCollection, 'ref' | 'artworkUrl' | 'covers'>, first: CatalogTrackPage | null): void {
    const list = w.NP_LIST;
    if (!list) {
      say('The music list is not ready yet');
      return;
    }
    const next = pager(c.ref);
    let offset = first ? first.offset + first.tracks.length : 0;
    const info: ListedCollection = {
      ref: c.ref,
      platformLabel: CATALOG_PLATFORM_LABELS[c.ref.platform],
      artworkUrl: c.artworkUrl,
      covers: [...c.covers].slice(0, 4),
      trackCount: first?.total ?? null,
      rows: first ? first.tracks.map(songFor) : [],
      capped: first?.capped ?? false,
      hasMore: first ? first.hasMore : true,
      loading: !first,
      error: null,
      async more() {
        const page = await next(offset);
        offset = page.offset + page.tracks.length;
        return { rows: page.tracks.map(songFor), hasMore: page.hasMore && page.tracks.length > 0 && offset < CATALOG_COLLECTION_CAP, total: page.total, capped: page.capped };
      },
    };
    close();
    input.blur();
    list.showCollection(info);
  }

  const api = {
    /** A starred album or playlist, chosen from the library menu: its songs, read again. */
    openSaved(saved: SavedCollection): void {
      showInList({ ref: saved.ref, artworkUrl: saved.artworkUrl, covers: saved.covers }, null);
    },
  };

  /* ---------------------------------------------------------- activation */

  function activate(i: number): void {
    const o = options[i];
    if (!o) return;
    if (o.kind === 'more') openAll(o.section);
    else if (o.kind === 'album') openAlbum(o.al);
    else if (o.kind === 'artist') {
      // A Spotify artist read from a link has no catalog id to open; its songs are the list beside it.
      if (/^(deezer|apple-music):/.test(o.a.id)) openArtist(o.a);
      else say('Only Deezer and Apple Music artists open here; the songs are listed beside it.');
    } else if (o.kind === 'collection') showInList(o.c, o.c.page);
    else if (top()?.kind === 'song') {
      const el = body.querySelector<HTMLElement>(`.srch__row[data-i="${i}"] .srch__art[data-preview]`);
      if (el) preview(i, el);
    } else openSong(o.t);
  }

  function addToLibrary(i: number): void {
    const o = options[i];
    if (!o || o.kind !== 'track' || added.has(o.t.id)) return;
    added.add(o.t.id);
    const s = songFor(o.t);
    document.dispatchEvent(new CustomEvent('library:add', { detail: { title: s.title, artist: s.artist, album: s.album, duration: s.duration, bpm: s.bpm, date: s.date, platform: s.platform, url: s.url } }));
    render();
  }

  /** Download as the player does: the song joins the library with its link, and the helper fetches it. */
  function download(t: CatalogTrack, sources: CatalogTrack['sources']): void {
    const dl = pickDownloadSource(sources);
    if (!dl) {
      say('This song is only in stores (Apple Music, Deezer): there is no copy the helper can fetch.');
      return;
    }
    if (!added.has(t.id)) {
      added.add(t.id);
      const s = songFor({ ...t, sources: [dl, ...t.sources] });
      document.dispatchEvent(new CustomEvent('library:add', { detail: { title: s.title, artist: s.artist, album: s.album, duration: s.duration, bpm: s.bpm, date: s.date, platform: s.platform, url: s.url } }));
    }
    const row = (w.LIBRARY ?? []).find((x) => x.title.toLowerCase() === t.title.toLowerCase().slice(0, 120));
    if (row && w.NP_FETCH) {
      if (!row.url) row.url = dl.url;
      close();
      w.NP_FETCH(row);
    } else say('Added to your library; the Download key fetches it.');
  }

  /* ----------------------------------------------- tempo, lent from Deezer */

  const bpmCache = new Map<string, Promise<{ bpm: number | null; d: number | null }>>();
  function enrichTempo(): void {
    options.forEach((o, i) => {
      if (o.kind !== 'track' || o.t.bpm) return;
      const t = o.t;
      const key = `${t.artist}|${t.title}`.toLowerCase();
      if (!bpmCache.has(key)) {
        const q = encodeURIComponent(`${t.artists[0] ?? t.artist} ${t.title}`.trim());
        bpmCache.set(
          key,
          jsonp(`https://api.deezer.com/search?limit=1&q=${q}`, 7000)
            .then((d) => {
              const hit = (d as { data?: Array<{ id?: number; duration?: number }> })?.data?.[0];
              if (!hit?.id) throw new Error('no match');
              return jsonp(`https://api.deezer.com/track/${hit.id}`, 7000).then((tr) => {
                const bpm = (tr as { bpm?: number })?.bpm;
                return { bpm: bpm && bpm > 0 ? Math.round(bpm) : null, d: hit.duration && hit.duration > 0 ? Math.round(hit.duration) : null };
              });
            })
            .catch(() => ({ bpm: null, d: null })),
        );
      }
      void bpmCache.get(key)!.then((m) => {
        if (m.bpm) t.bpm = m.bpm;
        if (m.d && !t.durationMs) t.durationMs = m.d * 1000;
        if (m.bpm && added.has(t.id)) {
          // The song already moved into the library; hand the late answer over the same wall.
          document.dispatchEvent(new CustomEvent('library:bpm', { detail: { title: t.title, artist: songFor(t).artist, bpm: m.bpm } }));
        }
        const el = body.querySelector(`.srch__row[data-i="${i}"]`);
        if (el && options[i] === o) {
          const tEl = el.querySelector('.srch__time');
          const bEl = el.querySelector('.srch__bpm');
          if (tEl && t.durationMs) tEl.textContent = V.fmtTime(t.durationMs / 1000);
          if (bEl) bEl.textContent = t.bpm ? `${Math.round(t.bpm)} bpm` : '';
        }
      });
    });
  }

  /** iTunes lends its clips to an older hub's rows that came without one: same name, same length. */
  function lendClips(q: string, rows: CatalogTrack[]): void {
    const wanting = rows.filter((r) => !V.previewOf(r));
    if (!wanting.length) return;
    fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=25&term=${encodeURIComponent(q)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { results?: Array<{ trackName?: string; artistName?: string; previewUrl?: string; trackTimeMillis?: number }> } | null) => {
        let changed = false;
        for (const r of wanting) {
          const m = (d?.results ?? []).find(
            (x) => x.previewUrl && (x.trackName ?? '').toLowerCase() === r.title.toLowerCase() && (x.artistName ?? '').toLowerCase() === (r.artists[0] ?? '').toLowerCase() && !(r.durationMs && x.trackTimeMillis && Math.abs(r.durationMs - x.trackTimeMillis) > 3000),
          );
          if (m?.previewUrl && /^https?:/.test(m.previewUrl)) {
            r.sources.push({ platform: 'apple-music', id: null, url: '', previewUrl: m.previewUrl, matchedBy: 'metadata' });
            changed = true;
          }
        }
        if (changed && top()?.kind === 'results') render();
      })
      .catch(() => undefined);
  }

  /* ------------------------------------------------- hold-to-hear (NP-FIND-001) */

  let armTimer = 0;
  let armedEl: HTMLElement | null = null;
  function canArm(): boolean {
    try {
      return matchMedia('(hover: hover) and (pointer: fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }
  function disarm(): void {
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = 0;
    }
    if (armedEl) {
      armedEl.classList.remove('is-arming');
      armedEl.style.removeProperty('--p');
      armedEl.style.removeProperty('--arm-ms');
      armedEl = null;
    }
  }
  body.addEventListener(
    'pointerenter',
    (e) => {
      if (!canArm()) return;
      const rowEl = (e.target as Element | null)?.closest?.('.srch__row') as HTMLElement | null;
      if (!rowEl) return;
      const i = Number(rowEl.dataset['i']);
      const o = options[i];
      const el = rowEl.querySelector<HTMLElement>('button.srch__art');
      if (!o || o.kind !== 'track' || !V.previewOf(o.t) || !el || playing === o.t) return;
      // pointerenter fires again at every child boundary inside the row; an armed row keeps its hold.
      if (armedEl === el) return;
      disarm();
      armedEl = el;
      const ms = w.NP_SRCH_ARM_MS || ARM_DEFAULT_MS;
      el.style.setProperty('--arm-ms', `${ms}ms`);
      el.classList.add('is-arming');
      // Two frames: the class lands with the ring empty, then the transition carries it full.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (armedEl === el) el.style.setProperty('--p', '1');
      }));
      armTimer = window.setTimeout(() => {
        const target = armedEl;
        disarm();
        if (target) {
          const now = body.querySelector<HTMLElement>(`.srch__row[data-i="${i}"] button.srch__art`);
          if (now) preview(i, now);
        }
      }, ms);
    },
    true,
  );
  body.addEventListener(
    'pointerleave',
    (e) => {
      if (!armedEl) return;
      const rowEl = (e.target as Element | null)?.closest?.('.srch__row');
      if (!rowEl || !rowEl.contains(armedEl)) return;
      // Still inside the armed row (a child boundary): the hold goes on.
      if (e.relatedTarget instanceof Node && rowEl.contains(e.relatedTarget)) return;
      disarm();
    },
    true,
  );
  body.addEventListener('scroll', disarm, true);
  document.addEventListener('keydown', disarm, true);

  /* ------------------------------------------------------------- previews */

  let audio: HTMLAudioElement | null = null;
  let playing: CatalogTrack | null = null;
  let raf = 0;
  let resumeMain = false;
  let retried = '';

  function stopPreview(): void {
    disarm();
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      try {
        audio.load();
      } catch {
        /* nothing loaded */
      }
    }
    if (playing) {
      const el = body.querySelector<HTMLElement>('.srch__art.is-preview');
      if (el) {
        el.classList.remove('is-preview');
        el.style.removeProperty('--p');
        el.setAttribute('aria-pressed', 'false');
      }
    }
    playing = null;
    if (resumeMain) {
      resumeMain = false;
      try {
        w.NP_PLAYER?.resume();
      } catch {
        /* the engine may have been torn down */
      }
    }
  }

  function tick(): void {
    raf = 0;
    if (!audio || !playing) return;
    const el = body.querySelector<HTMLElement>('.srch__art.is-preview');
    const p = Math.min(1, audio.currentTime / CLIP);
    if (el) el.style.setProperty('--p', p.toFixed(4));
    const left = CLIP - audio.currentTime;
    // The tail ramp is a fraction of the output level, never louder than the station it interrupted.
    const out = typeof w.outputVolume === 'number' ? w.outputVolume : 1;
    audio.volume = out * (left < TAIL ? Math.max(0, left / TAIL) : 1);
    if (audio.currentTime >= CLIP) {
      stopPreview();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function preview(i: number, el: HTMLElement): void {
    const o = options[i];
    if (!o || o.kind !== 'track') return;
    const t = o.t;
    const src = V.previewOf(t);
    if (!src) return;
    const same = playing === t;
    // Switching clips: the main track is already aside — keep it aside. A same-row click is a stop.
    const keepAside = !same && resumeMain;
    if (keepAside) resumeMain = false;
    stopPreview();
    if (same) return;
    // One sound at a time: the main track steps aside for the audition and returns after.
    if (keepAside) resumeMain = true;
    else if (w.NP_PLAYER?.playing?.()) {
      try {
        w.NP_PLAYER.pause();
        resumeMain = true;
      } catch {
        resumeMain = false;
      }
    }
    if (!audio) {
      audio = new Audio();
      audio.preload = 'none';
      audio.addEventListener('ended', stopPreview);
      audio.addEventListener('error', () => {
        const t2 = playing;
        stopPreview();
        if (t2) refreshClip(t2);
      });
    }
    playing = t;
    audio.src = src;
    audio.volume = typeof w.outputVolume === 'number' ? w.outputVolume : 1;
    el.classList.add('is-preview');
    el.style.setProperty('--p', '0');
    el.setAttribute('aria-pressed', 'true');
    const mine = playing;
    audio
      .play()
      .then(() => {
        if (playing !== mine) return;
        if (!raf) raf = requestAnimationFrame(tick);
      })
      .catch(() => {
        if (playing === mine) stopPreview();
      });
  }

  /** Deezer's clips are signed and expire: a failed one is asked for again, once, through its own link. */
  function refreshClip(t: CatalogTrack): void {
    const dz = t.sources.find((s) => s.platform === 'deezer' && s.previewUrl);
    if (!dz || retried === t.id) return;
    retried = t.id;
    ask((c) => c.resolve(dz.url, 0, 1))
      .then(({ value }) => {
        const fresh = value.track?.sources.find((s) => s.platform === 'deezer')?.previewUrl;
        if (!fresh) return;
        dz.previewUrl = fresh;
        const i = options.findIndex((o) => o.kind === 'track' && o.t === t);
        const el = body.querySelector<HTMLElement>(`.srch__row[data-i="${i}"] button.srch__art`);
        if (el) preview(i, el);
      })
      .catch(() => say('That preview has expired and could not be renewed.'));
  }

  /* ---------------------------------------------------------------- people */

  let pseq = 0;
  function people(q: string): void {
    const my = ++pseq;
    peopleBox.hidden = true;
    peopleBox.innerHTML = '';
    const hp = w.hubPeople;
    if (!hp || !hp.ready() || !q || urlish(q) || q.length < 2) return;
    void hp.search(q).then((list) => {
      if (my !== pseq || !list.length) return;
      peopleBox.innerHTML =
        `<p class="srch__cap">People on ${V.esc(hp.hubName())}</p>` +
        list
          .slice(0, 4)
          .map(
            (u) =>
              `<button class="srch__row srch__person" type="button" data-person="${V.esc(u.id)}">` +
              `<span class="srch__art" aria-hidden="true">${u.img ? `<img src="${V.esc(u.img)}" alt="">` : V.esc((u.name || '?').charAt(0).toUpperCase())}</span>` +
              `<span class="srch__meta"><span class="srch__title">${V.esc(u.name)}</span><span class="srch__sub">${u.playlists}${u.playlists === 1 ? ' shared playlist' : ' shared playlists'}</span></span>` +
              '<span class="srch__go" aria-hidden="true">›</span></button>',
          )
          .join('');
      peopleBox.hidden = false;
      open();
    });
  }
  peopleBox.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-person]');
    if (!b) return;
    close();
    w.hubPeople?.open(b.dataset['person'] ?? '');
  });

  function reset(): void {
    pseq++;
    peopleBox.hidden = true;
    stopPreview();
    ctl?.abort();
    res = freshResults();
    stack = [];
    lastQ = '';
    seq++;
    statusEl.hidden = true;
    close();
  }

  /* -------------------------------------------- advanced fields and ISRC */

  const advIn = (name: string): HTMLInputElement => advForm.elements.namedItem(name) as HTMLInputElement;
  const advOpen = (): boolean => !advForm.hidden;
  function advValues(): AdvFields {
    return { track: advIn('track').value.trim(), artist: advIn('artist').value.trim(), album: advIn('album').value.trim(), isrc: advIn('isrc').value.trim().toUpperCase().replace(/[-\s]/g, '') };
  }
  /** The fields merged into one line of words, for the header field when they fold away. */
  function merged(f: AdvFields): string {
    return f.isrc || [f.track, f.artist, f.album].filter(Boolean).join(' ');
  }
  function setAdv(on: boolean): void {
    if (on === advOpen()) return;
    advBtn.setAttribute('aria-expanded', String(on));
    if (on) {
      const q = input.value.trim();
      if (q && !urlish(q)) {
        if (/^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/i.test(q)) advIn('isrc').value = q;
        else if (!advIn('track').value && !advIn('artist').value && !advIn('album').value) advIn('track').value = q;
      }
      advForm.hidden = false;
      input.readOnly = true;
      input.value = merged(advValues());
      if (pop.hidden) {
        stack = stack.length ? stack : [];
        open();
        if (!stack.length) body.innerHTML = '';
        count.textContent = 'Search by track, artist and album, or ISRC';
      }
      advIn('track').focus();
    } else {
      advForm.hidden = true;
      input.readOnly = false;
      input.value = merged(advValues());
      input.focus();
      if (!stack.length) close();
    }
  }
  advBtn.addEventListener('click', () => setAdv(!advOpen()));
  advForm.addEventListener('input', () => {
    input.value = merged(advValues());
  });
  advForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = advValues();
    if (!f.track && !f.artist && !f.album && !f.isrc) {
      count.textContent = 'Fill in a track, an artist, an album or an ISRC';
      return;
    }
    if (f.isrc && !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(f.isrc)) {
      stack = [];
      body.innerHTML = msg('An ISRC is two letters, three letters or digits, then seven digits — like USQX91300108.');
      return;
    }
    input.value = merged(f);
    go(merged(f), f);
  });
  advForm.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setAdv(false);
    }
  });

  /* ------------------------------------------------------------ the filter */

  const dialog = $<HTMLDialogElement>('srchFilter');
  function paintFilterBtn(): void {
    const off = SECTIONS.filter((s) => !filter.sections[s]).length + CATALOG_PROVIDERS.filter((p) => !filter.providers[p]).length;
    filterBtn.classList.toggle('is-on', off > 0);
    filterBtn.setAttribute('aria-label', off ? `Filter: ${off} switched off` : 'Filter sections and services');
  }
  filterBtn.addEventListener('click', () => {
    for (const s of SECTIONS) (dialog.querySelector(`input[name="sec"][value="${s}"]`) as HTMLInputElement).checked = filter.sections[s];
    for (const p of CATALOG_PROVIDERS) (dialog.querySelector(`input[name="pf"][value="${p}"]`) as HTMLInputElement).checked = filter.providers[p];
    $('srchFilterMsg').textContent = '';
    dialog.showModal();
  });
  $('srchFilterCancel').addEventListener('click', () => dialog.close());
  dialog.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const next: Filter = { sections: { tracks: false, artists: false, albums: false }, providers: { itunes: false, deezer: false, musicbrainz: false, youtube: false, soundcloud: false } };
    for (const s of SECTIONS) next.sections[s] = (dialog.querySelector(`input[name="sec"][value="${s}"]`) as HTMLInputElement).checked;
    for (const p of CATALOG_PROVIDERS) next.providers[p] = (dialog.querySelector(`input[name="pf"][value="${p}"]`) as HTMLInputElement).checked;
    if (!SECTIONS.some((s) => next.sections[s])) {
      $('srchFilterMsg').textContent = 'Keep at least one section.';
      return;
    }
    if (!CATALOG_PROVIDERS.some((p) => next.providers[p])) {
      $('srchFilterMsg').textContent = 'Keep at least one service.';
      return;
    }
    filter = next;
    void Promise.resolve(w.kv.set(FILTER_KEY, filter)).catch(() => undefined);
    paintFilterBtn();
    dialog.close();
    say('Search filter saved');
    // A search on screen is asked again with the new filter.
    if (lastQ && stack[0]?.kind === 'results') go(lastQ, lastAdv);
    input.focus();
  });

  /* ---------------------------------------------------------------- wiring */

  function urlish(text: string): boolean {
    return /^(https?:\/\/|www\.)\S+$/i.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(text);
  }

  function move(delta: number): void {
    const n = options.length;
    if (!n) return;
    const was = hot;
    hot = Math.max(0, Math.min(n - 1, hot < 0 ? (delta > 0 ? 0 : n - 1) : hot + delta));
    applyHot();
    const v = top();
    if (v?.kind === 'all' && hot === n - 1 && (was === hot || delta > 1 || hot >= n - 3)) void loadMore(v);
  }

  input.addEventListener('keydown', (e) => {
    const showing = !pop.hidden;
    if (e.key === 'Escape') {
      if (showing && stack.length > 1) {
        e.preventDefault();
        goBack();
      } else if (showing) {
        e.preventDefault();
        close();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!showing) {
        if (stack.length) {
          e.preventDefault();
          open();
          render();
        }
        return;
      }
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((e.key === 'PageDown' || e.key === 'PageUp') && showing && options.length) {
      e.preventDefault();
      move(e.key === 'PageDown' ? 5 : -5);
      return;
    }
    if (e.key === 'Enter') {
      // Cmd/Ctrl+Enter files the hot song in the library: the keyboard twin of the row's +.
      if (showing && hot >= 0 && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        addToLibrary(hot);
        return;
      }
      const o = hot >= 0 ? options[hot] : undefined;
      if (showing && o && !pop.classList.contains('is-stale')) {
        e.preventDefault();
        // A song with a clip plays it; one without opens its details.
        const el = body.querySelector<HTMLElement>(`.srch__row[data-i="${hot}"] .srch__art[data-preview]`);
        if (o.kind === 'track' && el && top()?.kind !== 'song') preview(hot, el);
        else activate(hot);
        return;
      }
      if (advOpen()) {
        e.preventDefault();
        advForm.requestSubmit();
        return;
      }
      const q = input.value.trim();
      if (!q) return;
      e.preventDefault();
      go(q);
    }
  });

  /* Search runs on Enter, so between a keystroke and that Enter the rows on screen answer the
     previous query: dimmed, inert, and the count says what resolves it. */
  function markStale(): void {
    const q = input.value.trim();
    const stale = Boolean(q) && q !== lastQ && stack.length > 0 && !advOpen();
    pop.classList.toggle('is-stale', stale);
    if (stale) count.textContent = 'Press ⏎ to search';
  }
  input.addEventListener('input', () => {
    if (!input.value.trim()) {
      reset();
      return;
    }
    markStale();
  });
  function reopen(): void {
    if (pop.hidden && stack.length && input.value.trim()) {
      open();
      render();
      markStale();
    }
  }
  input.addEventListener('focus', reopen);
  input.addEventListener('click', reopen);

  // Clicks inside keep focus in the field, except where typing or a link needs it.
  pop.addEventListener('mousedown', (e) => {
    if (!(e.target as Element).closest('a, input, select, textarea, label')) e.preventDefault();
  });
  document.querySelector('.search')!.addEventListener('focusout', (e) => {
    const to = (e as FocusEvent).relatedTarget as Element | null;
    if (!to || !to.closest || (!to.closest('.search') && !to.closest('#srchFilter'))) {
      if (!dialog.open) close();
    }
  });

  body.addEventListener('click', (e) => {
    const target = e.target as Element;
    const addBtn = target.closest<HTMLElement>('.srch__add[data-add]');
    if (addBtn) {
      e.preventDefault();
      addToLibrary(Number(addBtn.dataset['add']));
      return;
    }
    const art = target.closest<HTMLElement>('.srch__art[data-preview]');
    if (art) {
      e.preventDefault();
      preview(Number(art.dataset['preview']), art);
      return;
    }
    const act = target.closest<HTMLElement>('[data-act]');
    if (act) {
      e.preventDefault();
      const v = top();
      if (act.dataset['act'] === 'list' && v?.kind === 'album' && v.detail) showInList({ ref: v.detail.collection, artworkUrl: v.detail.album.artworkUrl, covers: v.detail.page.tracks.map((t) => t.artworkUrl).filter((u): u is string => Boolean(u)).slice(0, 4) }, v.detail.page);
      if (act.dataset['act'] === 'add' && v?.kind === 'song') addToLibrary(0);
      if (act.dataset['act'] === 'download' && v?.kind === 'song') download(v.t, v.enrich ? [...v.t.sources, ...v.enrich.sources] : v.t.sources);
      return;
    }
    if (target.closest('a, .srch__add')) return;
    const row = target.closest<HTMLElement>('.srch__row[data-i]');
    if (!row) return;
    hot = Number(row.dataset['i']);
    applyHot();
    activate(hot);
  });

  back.addEventListener('click', () => {
    goBack();
    input.focus();
  });
  $('srchClear').addEventListener('click', () => {
    input.value = '';
    if (advOpen()) {
      for (const n of ['track', 'artist', 'album', 'isrc']) advIn(n).value = '';
      setAdv(false);
    }
    reset();
    input.focus();
  });
  document.addEventListener('mousedown', (e) => {
    if (!pop.hidden && !(e.target as Element).closest('.search') && !(e.target as Element).closest('#srchFilter')) close();
  });

  /** Kept for the shell's "keep this song" (the radio's on-air menu): songs for a query, in the old row shape. */
  w.NP_FIND = async (q: string) => {
    const signal = AbortSignal.timeout(8000);
    const r = freshResults();
    await stream(params(q, null, ['tracks'], 0), signal, (chunk, client) => upsert(r, chunk, client), true).catch(() => undefined);
    return r.tracks.list.slice(0, 10).map((t) => {
      const s = songFor(t);
      return { t: t.title, a: t.artist, al: t.album ?? '', d: s.duration || null, bpm: s.bpm, p: s.platform, u: s.url || null };
    });
  };

  paintFilterBtn();
  installed = api;
  return api;
}

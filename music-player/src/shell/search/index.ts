/**
 * The header search (NP-FIND-001..010): music — songs, artists, albums and playlists — from the
 * catalog, live.
 *
 * Loaded lazily by the bridge after the shell starts; it takes over the header field `#q` and its
 * popover `#srch`, whose markup make-shell.py writes. What it keeps from the shell's first search:
 * Enter runs it, the rows are the iTunes 11 Up Next popover's, the artwork tile is a 30-second
 * audition with its ring (click, or a five-second hold), + files a song in the library over the
 * `library:add` wall, a stale query dims, and people on the paired hub sit above the songs.
 *
 * The shape (owner, 2026-10-07): the first view after Enter is a calm overview — five songs, three
 * artists, three albums, three playlists, each with "See all N" — with no pager. "See all" opens a
 * page for that type alone: a field that searches that type (`sections=<type>`), a segmented control
 * to switch type, and the one pager — the list scrolls on by itself, and a footer's ‹ › and "Page N
 * of M" move it a page at a time, fetching first when needed. Playlists are a type of their own,
 * keyless from Deezer, and the person's starred lists sit above them under "In your library". The
 * card hangs centred under the field at every width. Every song row has a "…" (and right-click, and
 * long-press) opening the shell's contextual menu: Add to Up Next, Add to Playlist ▸, Add to
 * Library, Download…, Audition. No row ever offers "search on another site".
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
  CatalogPlaylist,
  CatalogProviderId,
  CatalogResolveResult,
  CatalogSearchChunk,
  CatalogSearchSection,
  CatalogSourceStatus,
  CatalogTrack,
  CatalogTrackPage,
  SavedCollection,
} from '@now-playing/contracts';
import {
  CATALOG_MAX_LIMIT,
  CATALOG_PAGE_MAX,
  CATALOG_PLATFORM_LABELS,
  CATALOG_PROVIDERS,
  CATALOG_SEARCH_SECTIONS,
} from '@now-playing/contracts';
import { mergeTrack, pickDownloadSource, sameRecording } from '@now-playing/domain/catalog';
import {
  ask,
  clients,
  jsonp,
  legacyHubSearch,
  Refused,
  Unreachable,
  type CatalogClient,
  type SearchParams,
} from './client.js';
import * as V from './view.js';

/* ------------------------------------------------------------------ shapes */

type Section = CatalogSearchSection;

type Opt =
  | { kind: 'track'; t: CatalogTrack }
  | { kind: 'artist'; a: CatalogArtist }
  | { kind: 'album'; al: CatalogAlbum }
  | { kind: 'playlist'; p: CatalogPlaylist }
  | { kind: 'saved'; s: SavedCollection }
  | { kind: 'more'; section: Section }
  | { kind: 'collection'; c: CatalogCollection };

interface AdvFields {
  track: string;
  artist: string;
  album: string;
  isrc: string;
}

interface Filter {
  sections: Record<Section, boolean>;
  providers: Record<CatalogProviderId, boolean>;
}

/** Rows of one section, upserted by id; ordered by rank, ties by arrival (UX-CAT-002). */
class Bag<T extends { id: string; rank: number }> {
  private rows: Array<{ row: T; at: number }> = [];
  private n = 0;
  /**
   * `same` is the engine's identity (one recording on several platforms); `merge` is its merger, so
   * the one row keeps every platform's badge. Without them, rows are one only by id.
   */
  constructor(
    private readonly same?: (a: T, b: T) => boolean,
    private readonly merge?: (into: T, other: T) => T,
  ) {}
  /** The row already shown that is this one: by id, else by recording. */
  private find(row: T): { row: T; at: number } | undefined {
    return (
      this.rows.find((r) => r.row.id === row.id) ??
      (this.same ? this.rows.find((r) => this.same!(r.row, row)) : undefined)
    );
  }
  private fold(have: { row: T }, row: T): void {
    // A later chunk's copy replaces its row in place; what this page already folded in stays.
    have.row = this.merge
      ? have.row.id === row.id
        ? this.merge(row, have.row)
        : this.merge(have.row, row)
      : have.row.id === row.id
        ? row
        : have.row;
  }
  upsert(list: readonly T[]): void {
    for (const row of list) {
      const have = this.find(row);
      if (have) this.fold(have, row);
      else this.rows.push({ row, at: this.n++ });
    }
    this.rows.sort((a, b) => b.row.rank - a.row.rank || a.at - b.at);
  }
  /**
   * Appends a later page beneath what is there. A song already shown — by id or as the same recording
   * — is never a second row: its badges join the row it is. Returns how many new rows came.
   */
  append(list: readonly T[]): number {
    let added = 0;
    for (const row of list) {
      const have = this.find(row);
      if (have) {
        this.fold(have, row);
        continue;
      }
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

const sameSong = (a: CatalogTrack, b: CatalogTrack): boolean =>
  a.id !== b.id && sameRecording(a, b);

interface Results {
  tracks: Bag<CatalogTrack>;
  artists: Bag<CatalogArtist>;
  albums: Bag<CatalogAlbum>;
  playlists: Bag<CatalogPlaylist>;
  status: CatalogSourceStatus[];
  /** Platforms that only contributed links (a song's other homes), named on the status line. */
  linkedOnly: string[];
  done: boolean;
  more: Record<Section, boolean>;
  /** The offset each section's next page is asked from, and which sections are being asked now. */
  next: Record<Section, number>;
  pending: Set<Section>;
  via: string;
  error: string | null;
}

const freshResults = (): Results => ({
  tracks: new Bag<CatalogTrack>(sameSong, mergeTrack),
  artists: new Bag(),
  albums: new Bag(),
  playlists: new Bag(),
  status: [],
  linkedOnly: [],
  done: false,
  more: { tracks: false, artists: false, albums: false, playlists: false },
  next: { tracks: 0, artists: 0, albums: 0, playlists: 0 },
  pending: new Set(),
  via: '',
  error: null,
});

type View =
  | { kind: 'results' }
  | {
      kind: 'link';
      url: string;
      result: CatalogResolveResult | null;
      error: string | null;
      client: CatalogClient | null;
    }
  | {
      /** One type alone, on its own page (NP-FIND-004). */
      kind: 'type';
      section: Section;
      res: Results;
      ctl: AbortController;
      /** The words this page searched for, and the fields when they came from the pill's fields. */
      q: string;
      adv: AdvFields | null;
      label: string;
      /** The page the list is scrolled to, counted in rows of PAGE_ROWS[section]. */
      page: number;
    }
  | {
      kind: 'album';
      id: string;
      title: string;
      detail: CatalogAlbumDetail | null;
      error: string | null;
      client: CatalogClient | null;
    }
  | {
      kind: 'artist';
      id: string;
      name: string;
      detail: CatalogArtistDetail | null;
      error: string | null;
    }
  | {
      kind: 'song';
      t: CatalogTrack;
      enrich: CatalogEnrichment | null;
      enrichSaid: string | null;
      lyrics: CatalogLyrics | null;
      lyricsSaid: string | null;
    };

/** What the shell's library (index.html) offers this module; see make-shell.py, "the music list". */
interface ShellList {
  showCollection(info: ListedCollection): void;
  saved?(): SavedCollection[];
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

/** The shell's contextual menu, opened over a song from the catalog (make-shell.py, NP-FIND-010). */
interface SongMenu {
  open(c: SongMenuSubject, x: number, y: number): void;
  run(act: 'cat-next', c: SongMenuSubject): void;
  close(): void;
  isOpen(): boolean;
}
interface SongMenuSubject {
  song: Omit<ListSong, 'id' | 'kind'>;
  inLibrary: boolean;
  canDownload: boolean;
  canAudition: boolean;
  auditioning: boolean;
  touch: boolean;
  back: HTMLElement;
  onAdd(): void;
  onDownload(): void;
  onAudition(): void;
  onFiled(row: { id: string }): void;
}

/** The overview shows this many of each type (NP-FIND-003). */
const PREVIEW_N: Record<Section, number> = { tracks: 5, artists: 3, albums: 3, playlists: 3 };
/** The overview asks every section for one page of this many. */
const OVERVIEW_LIMIT = 25;
/** A type page's rows per page — what ‹ › move by, and what each fetch asks for (NP-FIND-004). */
const PAGE_ROWS: Record<Section, number> = {
  tracks: Math.min(25, CATALOG_MAX_LIMIT, CATALOG_PAGE_MAX),
  artists: Math.min(12, CATALOG_MAX_LIMIT, CATALOG_PAGE_MAX),
  albums: Math.min(12, CATALOG_MAX_LIMIT, CATALOG_PAGE_MAX),
  playlists: Math.min(12, CATALOG_MAX_LIMIT, CATALOG_PAGE_MAX),
};
/** The engine's search offset limit: past it a page is not asked for. */
const OFFSET_MAX = 1000;
/** One page of an album's or playlist's songs: the contract's page limit (catalog/resolve, catalog/album). */
const LIST_PAGE = CATALOG_PAGE_MAX;
const FILTER_KEY = 'player:search';
const SECTIONS: Section[] = [...CATALOG_SEARCH_SECTIONS];
/** The card: as wide as this, or the window less a 10 px margin each side (NP-FIND-006). */
const CARD_WIDTH = 560;
const CARD_MARGIN = 10;
const LONG_PRESS_MS = 500;

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
    hubPeople?: {
      ready(): boolean;
      hubName(): string;
      search(
        q: string,
      ): Promise<Array<{ id: string; name: string; playlists: number; img: string | null }>>;
      open(id: string): void;
    };
    NP_LIST?: ShellList;
    NP_FETCH?: (song: unknown) => void;
    NP_SONG_MENU?: SongMenu;
    LIBRARY?: Array<{ id: string; title: string; url?: string | null }>;
    NP_SRCH_CLIP?: number;
    NP_SRCH_ARM_MS?: number;
    NP_FIND?: (
      q: string,
    ) => Promise<
      Array<{
        t: string;
        a: string;
        al: string;
        d: number | null;
        bpm: number | null;
        p: string | null;
        u: string | null;
      }>
    >;
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
  const typeEl = $('srchType');
  const typeForm = $<HTMLFormElement>('srchTypeForm');
  const typeQ = $<HTMLInputElement>('srchTypeQ');
  const searchBox = document.querySelector<HTMLElement>('.search')!;
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
  let filter: Filter = {
    sections: { tracks: true, artists: true, albums: true, playlists: true },
    providers: { itunes: true, deezer: true, musicbrainz: true, youtube: true, soundcloud: true },
  };

  void Promise.resolve(w.kv.get(FILTER_KEY))
    .then((v) => {
      const f = v as Partial<Filter> | null;
      if (f && typeof f === 'object') {
        for (const s of SECTIONS)
          if (typeof f.sections?.[s] === 'boolean') filter.sections[s] = f.sections[s];
        for (const p of CATALOG_PROVIDERS)
          if (typeof f.providers?.[p] === 'boolean') filter.providers[p] = f.providers[p];
        paintFilterBtn();
      }
    })
    .catch(() => undefined);

  const top = (): View | undefined => stack[stack.length - 1];
  const hotOf = new WeakMap<View, number>();
  /** The field the keys come from: the type page's own while it has focus, else the header's. */
  const field = (): HTMLInputElement => (document.activeElement === typeQ ? typeQ : input);

  /* --------------------------------------------------------------- open/close */

  /**
   * Centred under the field (NP-FIND-006): the card hangs from the field's centre, as wide as
   * CARD_WIDTH or the window less its margins, and moves only as far as it must to stay on screen.
   * The caret stays at the field's centre (the stylesheet reads --srch-shift for both).
   */
  function place(): void {
    const box = searchBox.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const width = Math.min(CARD_WIDTH, vw - CARD_MARGIN * 2);
    const cx = box.left + box.width / 2;
    const left = Math.max(CARD_MARGIN, Math.min(cx - width / 2, vw - CARD_MARGIN - width));
    pop.style.setProperty('--srch-shift', `${Math.round(left + width / 2 - cx)}px`);
  }
  window.addEventListener('resize', () => {
    if (!pop.hidden) place();
  });

  function open(): void {
    place();
    pop.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function close(): void {
    stopPreview();
    cancelPress();
    pop.hidden = true;
    pop.classList.remove('is-stale');
    hot = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    typeQ.removeAttribute('aria-activedescendant');
  }
  // The toolbar shuts the popover when the header field is hidden (other tabs).
  w.srchClose = close;

  /* -------------------------------------------------------------- rendering */

  function msg(html: string): string {
    return `<div class="srch__msg">${html}</div>`;
  }

  const bagOf = (
    r: Results,
    s: Section,
  ): Bag<CatalogTrack> | Bag<CatalogArtist> | Bag<CatalogAlbum> | Bag<CatalogPlaylist> =>
    s === 'tracks'
      ? r.tracks
      : s === 'artists'
        ? r.artists
        : s === 'albums'
          ? r.albums
          : r.playlists;

  function sectionRows(r: Results, section: Section, limit: number): Opt[] {
    return bagOf(r, section)
      .list.slice(0, limit)
      .map((x) =>
        section === 'tracks'
          ? { kind: 'track', t: x as CatalogTrack }
          : section === 'artists'
            ? { kind: 'artist', a: x as CatalogArtist }
            : section === 'albums'
              ? { kind: 'album', al: x as CatalogAlbum }
              : { kind: 'playlist', p: x as CatalogPlaylist },
      );
  }

  function optHTML(o: Opt, i: number): string {
    switch (o.kind) {
      case 'track':
        return V.trackRowHTML(o.t, i, added.has(o.t.id));
      case 'artist':
        return V.artistRowHTML(o.a, i);
      case 'album':
        return V.albumRowHTML(o.al, i);
      case 'playlist':
        return V.playlistRowHTML(o.p, i);
      case 'saved':
        return V.savedRowHTML(o.s, i);
      case 'collection':
        return V.collectionRowHTML(o.c, i);
      case 'more':
        return V.moreRowHTML(o.section, bagOf(res, o.section).size, res.more[o.section], i);
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

  function wanted(): Section[] {
    const on = SECTIONS.filter((s) => filter.sections[s]);
    return on.length ? on : ['tracks'];
  }

  function totalsLine(r: Results): string {
    return wanted()
      .map((s) => V.count(bagOf(r, s).size, s))
      .join(' · ');
  }

  function paintStatus(
    list: CatalogSourceStatus[],
    via: string,
    linked: readonly string[] = [],
  ): void {
    statusEl.hidden = !list.length && !via;
    statusEl.innerHTML = list.length
      ? V.statusHTML(list, via, linked)
      : via
        ? `<span class="srch__via2">Through ${V.esc(via)}</span>`
        : '';
  }

  function render(): void {
    const v = top();
    back.hidden = stack.length < 2;
    // The pager and the type header belong to a type page alone (NP-FIND-003/004).
    if (v?.kind !== 'type') {
      foot.hidden = true;
      typeEl.hidden = true;
      typeQ.removeAttribute('aria-activedescendant');
    }
    if (!v) {
      body.innerHTML = '';
      return;
    }
    if (v.kind === 'results') renderResults();
    else if (v.kind === 'link') renderLink(v);
    else if (v.kind === 'type') renderType(v);
    else if (v.kind === 'album') renderAlbum(v);
    else if (v.kind === 'artist') renderArtist(v);
    else renderSong(v);
    if (hot >= options.length) hot = options.length - 1;
    applyHot();
    // The engine fills a page's facts itself (UX-CAT-006): the browser's own tempo lookup is the
    // fallback for what is still missing once the search is done, never a race with it.
    if ((v.kind !== 'results' && v.kind !== 'type') || res.done) enrichTempo();
  }

  /** The overview: a short group per type with "See all N", and no pager (NP-FIND-003). */
  function renderResults(): void {
    const r = res;
    const n = wanted().reduce((sum, s) => sum + bagOf(r, s).size, 0);
    paintStatus(r.status, r.via, r.linkedOnly);
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
        const said = V.statusWords(
          r.status.filter(
            (s) => s.state === 'failed' || s.state === 'timeout' || s.state === 'cooling-down',
          ),
        );
        const failedAll =
          r.status.length > 0 && r.status.every((s) => s.state !== 'ok' && s.state !== 'empty');
        body.innerHTML = msg(
          failedAll
            ? `Couldn’t search just now — ${V.esc(said || 'no service answered')}.`
            : `No matches for “${V.esc(lastLabel)}”.`,
        );
        live.textContent = failedAll ? 'Search failed' : 'No results';
      }
      return;
    }
    const groups: Array<{ label: string | null; opts: Opt[] }> = [];
    for (const s of wanted()) {
      const bag = bagOf(r, s);
      const opts = sectionRows(r, s, PREVIEW_N[s]);
      if (opts.length && (bag.size > PREVIEW_N[s] || r.more[s])) opts.push({ kind: 'more', section: s });
      groups.push({ label: V.SECTION_LABEL[s], opts });
    }
    count.innerHTML = `<b>Results:</b> ${totalsLine(r)}${r.done ? '' : ' …'}`;
    body.innerHTML =
      listbox(groups, 'Search results') + (r.error ? msg(V.esc(r.error)) : '');
    live.textContent = `${totalsLine(r)}${r.done ? '' : ', still searching'}`;
  }

  function renderLink(v: Extract<View, { kind: 'link' }>): void {
    paintStatus([], v.client ? v.client.label : '');
    if (!v.result && !v.error) {
      options = [];
      count.innerHTML = 'Reading the link…';
      const slow = /spotify\.com\//.test(v.url)
        ? ' Spotify links are read by spotDL, which can take a minute.'
        : '';
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
    count.innerHTML = r.track
      ? '<b>Results:</b> 1 song'
      : r.collection
        ? `<b>${V.esc(r.collection.ref.kind === 'album' ? 'Album' : 'Playlist')}:</b> ${V.esc(CATALOG_PLATFORM_LABELS[r.collection.ref.platform])}`
        : '<b>Artist</b>';
    body.innerHTML =
      listbox([{ label: null, opts }], 'The pasted link') +
      (r.collection
        ? msg(
            'Open it to see its songs in the music list, where the star keeps it in your library.',
          )
        : '');
    live.textContent = r.track
      ? `1 song: ${r.track.title}`
      : r.collection
        ? `${r.collection.ref.title}, ${V.collectionWords(r.collection)}`
        : 'An artist';
  }

  /** The starred playlists (or albums), for the Playlists page's "In your library" (NP-FIND-009). */
  function savedOf(kind: 'playlist' | 'album'): SavedCollection[] {
    try {
      return (w.NP_LIST?.saved?.() ?? []).filter((s) => s.ref.kind === kind);
    } catch {
      return [];
    }
  }

  /** Pages a type page knows of, and whether the services say there may be more. */
  function pageCount(v: Extract<View, { kind: 'type' }>): { known: number; more: boolean } {
    const size = bagOf(v.res, v.section).size;
    return { known: Math.max(1, Math.ceil(size / PAGE_ROWS[v.section])), more: v.res.more[v.section] };
  }

  /** One type on its own page: header, its field, its rows, and the pager (NP-FIND-004). */
  function renderType(v: Extract<View, { kind: 'type' }>): void {
    const r = v.res;
    const s = v.section;
    const bag = bagOf(r, s);
    paintStatus(r.status, r.via, r.linkedOnly);
    typeEl.hidden = false;
    typeEl.querySelectorAll<HTMLButtonElement>('.srch__segbtn').forEach((b) => {
      const on = b.dataset['type'] === s;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    typeQ.setAttribute('aria-label', `Search ${V.SECTION_LABEL[s].toLowerCase()}`);
    typeQ.placeholder = `Search ${V.SECTION_LABEL[s].toLowerCase()}`;
    if (document.activeElement !== typeQ) typeQ.value = v.label;
    count.innerHTML = `<b>${V.SECTION_LABEL[s]}:</b> ${bag.size}${r.more[s] ? '+' : ''} ${V.SECTION_NOUN[s][bag.size === 1 && !r.more[s] ? 0 : 1]} for “${V.esc(v.label)}”`;
    const groups: Array<{ label: string | null; opts: Opt[] }> = [];
    if (s === 'playlists') {
      const mine = savedOf('playlist');
      if (mine.length)
        groups.push({ label: 'In your library', opts: mine.map((x) => ({ kind: 'saved', s: x })) });
    }
    const typeOpts = sectionRows(r, s, bag.size);
    groups.push({ label: s === 'playlists' && groups.length ? 'From the catalog' : null, opts: typeOpts });
    const tail = r.pending.has(s)
      ? msg(`${V.spinner()}<span>Loading more…</span>`)
      : r.error
        ? msg(V.esc(r.error))
        : !r.more[s] && bag.size && r.done
          ? `<div class="srch__end">That’s all ${V.count(bag.size, s)}.</div>`
          : '';
    const empty = !bag.size && r.done && !r.pending.has(s) && !r.error;
    body.innerHTML =
      (groups.some((g) => g.opts.length)
        ? listbox(groups, `All ${V.SECTION_LABEL[s].toLowerCase()}`)
        : ((options = []), ''))
      + (empty ? msg(`No ${V.SECTION_NOUN[s][1]} for “${V.esc(v.label)}”.`) : '')
      + (tail || (!bag.size && !r.done ? msg(`${V.spinner()}<span>Searching…</span>`) : ''));
    // Each of the type's rows knows its page, so the scroll and the arrows can find page N's first row.
    let k = 0;
    options.forEach((o, i) => {
      if (o.kind !== 'more' && o.kind !== 'saved' && o.kind !== 'collection') {
        const el = body.querySelector<HTMLElement>(`.srch__row[data-i="${i}"]`);
        if (el) el.dataset['page'] = String(Math.floor(k / PAGE_ROWS[s]));
        k += 1;
      }
    });
    paintPager(v);
    live.textContent = `${V.count(bag.size, s)}${r.more[s] ? ', more as you scroll' : ''}, page ${v.page + 1} of ${pageCount(v).known}${r.more[s] ? ' or more' : ''}`;
  }

  /** The footer: ‹ › and "Page N of M" (M+ while more may exist). */
  function paintPager(v: Extract<View, { kind: 'type' }>): void {
    const { known, more } = pageCount(v);
    const bag = bagOf(v.res, v.section);
    foot.hidden = !bag.size;
    if (foot.hidden) return;
    const of = Math.max(known, v.page + 1);
    $<HTMLButtonElement>('srchPrev').disabled = v.page === 0;
    $<HTMLButtonElement>('srchNext').disabled = v.page >= known - 1 && !more;
    $('srchPageOf').textContent = `Page ${v.page + 1} of ${of}${more ? '+' : ''}`;
  }

  /**
   * The page the list is scrolled to: the first of the type's rows in view says which; at the very
   * end, the last page is the one on show.
   */
  function pageFromScroll(v: Extract<View, { kind: 'type' }>): void {
    const rows = body.querySelectorAll<HTMLElement>('.srch__row[data-page]');
    if (!rows.length) return;
    const top = body.getBoundingClientRect().top;
    let page = Number(rows[rows.length - 1]!.dataset['page']);
    const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
    if (!atEnd)
      for (const el of rows) {
        if (el.getBoundingClientRect().bottom - top > 1) {
          page = Number(el.dataset['page']);
          break;
        }
      }
    if (page !== v.page) {
      v.page = page;
      paintPager(v);
    }
  }

  function renderAlbum(v: Extract<View, { kind: 'album' }>): void {
    paintStatus([], v.client?.label ?? '');
    count.innerHTML = `<b>Album:</b> ${V.esc(v.title)}`;
    if (!v.detail) {
      options = [];
      body.innerHTML = msg(
        v.error ? V.esc(v.error) : `${V.spinner()}<span>Opening the album…</span>`,
      );
      live.textContent = v.error ?? 'Opening the album';
      return;
    }
    const { album, page } = v.detail;
    const facts = [
      album.year ?? album.releaseDate?.slice(0, 4),
      album.label,
      album.genre,
      page.total ? `${page.total} songs` : null,
    ]
      .filter(Boolean)
      .map((x) => V.esc(x))
      .join(' · ');
    const head = V.detailHead({
      cover: V.coverHTML(album.artworkUrl),
      title: album.title,
      sub: album.artist ?? '',
      facts,
      badges: V.badgesHTML(album.sources),
      actions: '<button class="srch__btn" type="button" data-act="list">Open in Music</button>',
    });
    body.innerHTML =
      head +
      listbox(
        [{ label: 'Songs', opts: page.tracks.map((t) => ({ kind: 'track' as const, t })) }],
        `${album.title}: songs`,
      );
    live.textContent = `${album.title}, ${page.tracks.length} songs`;
  }

  function renderArtist(v: Extract<View, { kind: 'artist' }>): void {
    paintStatus([], '');
    count.innerHTML = `<b>Artist:</b> ${V.esc(v.name)}`;
    if (!v.detail) {
      options = [];
      body.innerHTML = msg(
        v.error ? V.esc(v.error) : `${V.spinner()}<span>Opening the artist…</span>`,
      );
      live.textContent = v.error ?? 'Opening the artist';
      return;
    }
    const { artist, topTracks, albums } = v.detail;
    const facts = [
      artist.genre,
      artist.fans ? `${artist.fans.toLocaleString('en-US')} fans` : null,
      artist.albumCount
        ? `${artist.albumCount} ${artist.albumCount === 1 ? 'album' : 'albums'}`
        : null,
    ]
      .filter(Boolean)
      .map((x) => V.esc(x))
      .join(' · ');
    // Apple has no artist pictures: the first album's cover stands in.
    const picture = artist.pictureUrl ?? albums[0]?.artworkUrl ?? null;
    const head = V.detailHead({
      cover: V.coverHTML(picture, true),
      title: artist.name,
      sub: '',
      facts,
      badges: V.badgesHTML(artist.sources),
      actions: '',
    });
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
      (t.isrc ?? e?.isrc)
        ? `<span class="srch__fact"><b>ISRC</b> ${V.esc(t.isrc ?? e?.isrc)}</span>`
        : '',
      !e && !v.enrichSaid
        ? '<span class="srch__fact srch__fact--wait">Looking up genre, label and year…</span>'
        : '',
      v.enrichSaid ? `<span class="srch__fact srch__fact--wait">${V.esc(v.enrichSaid)}</span>` : '',
    ]
      .filter(Boolean)
      .join('');
    const sources = e
      ? [
          ...t.sources,
          ...e.sources.filter((s) => !t.sources.some((x) => x.platform === s.platform)),
        ]
      : t.sources;
    const dl = pickDownloadSource(sources);
    const actions =
      (added.has(t.id)
        ? '<button class="srch__btn" type="button" disabled>In your library</button>'
        : '<button class="srch__btn" type="button" data-act="add">Add to Library</button>') +
      `<button class="srch__btn" type="button" data-act="download"${dl ? ` title="Fetched by the helper on this PC from ${V.esc(CATALOG_PLATFORM_LABELS[dl.platform])}"` : ' aria-disabled="true" title="Only in stores (Apple Music, Deezer): there is no copy the helper can fetch"'}>Download…</button>`;
    const head = V.detailHead({
      cover: V.coverHTML(t.artworkUrl),
      title: t.title,
      sub: V.songSub(t),
      facts,
      badges: V.badgesHTML(sources),
      actions,
    });
    const lyr = v.lyrics
      ? v.lyrics.found
        ? v.lyrics.instrumental
          ? msg('An instrumental: no words to show.')
          : V.lyricsHTML(v.lyrics.synced, v.lyrics.plain) ||
            msg('LRCLIB has this song but no words for it.')
        : msg('No lyrics found for this song on LRCLIB.')
      : msg(
          v.lyricsSaid ? V.esc(v.lyricsSaid) : `${V.spinner()}<span>Looking for the lyrics…</span>`,
        );
    body.innerHTML =
      head +
      listbox([{ label: null, opts: [{ kind: 'track', t }] }], t.title) +
      `<div class="srch__cap srch__cap--lyrics">Lyrics${v.lyrics?.synced ? ' <span>(synced)</span>' : ''}</div>` +
      lyr;
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
    for (const f of [input, typeQ]) {
      if (hot >= 0) f.setAttribute('aria-activedescendant', `srchOpt${hot}`);
      else f.removeAttribute('aria-activedescendant');
    }
  }

  /* ----------------------------------------------------------------- search */

  function upsert(r: Results, chunk: CatalogSearchChunk, client: CatalogClient): void {
    r.via = client.label;
    r.status = chunk.status.length ? chunk.status : r.status;
    if (chunk.type === 'results') {
      r.tracks.upsert(chunk.tracks);
      r.artists.upsert(chunk.artists);
      r.albums.upsert(chunk.albums);
      r.playlists.upsert(chunk.playlists ?? []);
    } else {
      r.done = true;
      r.linkedOnly = (chunk.linkedOnly ?? []).map((pf) => CATALOG_PLATFORM_LABELS[pf]);
      for (const s of SECTIONS) {
        const pg = chunk.page[s];
        if (pg) r.next[s] = Math.max(r.next[s], pg.offset + pg.limit);
        r.more[s] = Boolean(pg?.hasMore);
      }
    }
  }

  /**
   * One search against the first client that answers. `onChunk` sees every chunk as it arrives; a
   * server that cannot be reached before its first chunk is passed over for the next.
   */
  async function stream(
    p: SearchParams,
    signal: AbortSignal,
    onChunk: (c: CatalogSearchChunk, client: CatalogClient) => void,
    legacy: boolean,
  ): Promise<{ resolve: string | null }> {
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
        if (got)
          throw new Refused(
            `The search stopped part way (${err instanceof Error ? err.message : 'connection lost'}); these are the answers that came.`,
          );
        // A hub from before the catalog still searches songs (NP-FIND-001).
        if (
          legacy &&
          c.kind === 'hub' &&
          err instanceof Unreachable &&
          err.status === 404 &&
          p.q &&
          !p.offset
        ) {
          const rows = await legacyHubSearch(p.q, signal).catch(() => null);
          if (rows && rows.length) {
            const query = {
              kind: 'text' as const,
              text: p.q,
              track: null,
              artist: null,
              album: null,
              isrc: null,
              url: null,
            };
            onChunk(
              {
                type: 'results',
                seq: 0,
                provider: null,
                query,
                tracks: rows,
                artists: [],
                albums: [],
                playlists: [],
                status: [],
              },
              { ...c, label: `${c.label} (songs only: it has no catalog yet)` },
            );
            onChunk(
              {
                type: 'done',
                seq: 1,
                query,
                status: [],
                page: {
                  tracks: { offset: 0, limit: rows.length, hasMore: false },
                  artists: null,
                  albums: null,
                  playlists: null,
                },
                totals: { tracks: rows.length, artists: 0, albums: 0, playlists: 0 },
                resolve: null,
                linkedOnly: [],
              },
              { ...c, label: `${c.label} (songs only: it has no catalog yet)` },
            );
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

  function params(
    q: string,
    adv: AdvFields | null,
    sections: readonly Section[],
    offset: number,
    limit: number,
  ): SearchParams {
    const providers = CATALOG_PROVIDERS.filter((p) => filter.providers[p]);
    const base = {
      sections,
      providers: providers.length ? providers : [...CATALOG_PROVIDERS],
      offset,
      limit,
    };
    if (adv && !adv.isrc)
      return {
        ...base,
        track: adv.track || undefined,
        artist: adv.artist || undefined,
        album: adv.album || undefined,
      };
    return { ...base, q: adv?.isrc ? adv.isrc : q };
  }

  let lastAdv: AdvFields | null = null;

  const labelOf = (q: string, adv: AdvFields | null): string =>
    adv
      ? adv.isrc
        ? `ISRC ${adv.isrc}`
        : [adv.track, adv.artist, adv.album].filter(Boolean).join(' · ')
      : q;

  function go(q: string, adv: AdvFields | null = null): void {
    people(adv ? '' : q);
    stopPreview();
    pop.classList.remove('is-stale');
    ctl?.abort();
    lastQ = q;
    lastAdv = adv;
    lastLabel = labelOf(q, adv);
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
    stream(
      params(q, adv, wanted(), 0, OVERVIEW_LIMIT),
      signal,
      (chunk, client) => {
        if (mine !== seq) return;
        upsert(r, chunk, client);
        if (top()?.kind === 'results') render();
      },
      true,
    )
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
    if (err instanceof Unreachable)
      return 'Couldn’t search: neither the hub, the companion nor the music services answered. Check the connection and try again.';
    return `Couldn’t search: ${err instanceof Error ? err.message : 'something went wrong'}.`;
  }

  async function readLink(
    v: Extract<View, { kind: 'link' }>,
    mine: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const { value, client } = await ask((c) => c.resolve(v.url, 0, 100, signal));
      if (mine !== seq) return;
      v.result = value;
      v.client = client;
    } catch (err) {
      if (mine !== seq || signal.aborted) return;
      v.error =
        err instanceof Refused
          ? err.message
          : `The link could not be read: ${err instanceof Error ? err.message : 'no answer'}.`;
    }
    if (top() === v) render();
  }

  /**
   * The next page of one section, fetched — not sliced from the first answer: the same query from the
   * section's next offset (offset/limit/hasMore, as the engine pages). A song a later page brings again
   * is not shown twice; a page that adds nothing new is followed by the next while there is more.
   */
  async function extend(
    r: Results,
    s: Section,
    q: string,
    adv: AdvFields | null,
    signal: AbortSignal,
    after: () => void,
  ): Promise<void> {
    if (r.pending.has(s) || !r.more[s]) return;
    r.pending.add(s);
    const limit = PAGE_ROWS[s];
    const offset = Math.max(r.next[s], limit);
    const mine = seq;
    const fresh = freshResults();
    after();
    try {
      await stream(
        params(q, adv, [s], offset, limit),
        signal,
        (chunk, client) => {
          if (mine !== seq) return;
          upsert(fresh, chunk, client);
          if (fresh.status.length) r.status = fresh.status;
          r.via = fresh.via;
        },
        false,
      );
      r.pending.delete(s);
      if (mine !== seq || signal.aborted) return;
      const got = bagOf(r, s).append(bagOf(fresh, s).list as never);
      r.next[s] = Math.max(fresh.next[s], offset + limit);
      r.more[s] = fresh.more[s] && r.next[s] <= OFFSET_MAX;
      r.error = null;
      if (!got && r.more[s]) return extend(r, s, q, adv, signal, after);
    } catch (err) {
      r.pending.delete(s);
      if (mine !== seq || signal.aborted) return;
      r.error = failureWords(err);
      r.more[s] = false;
    }
    after();
  }

  /* ------------------------------------------------------------- type pages */

  /**
   * One type on its own page (NP-FIND-004). From "See all" the page starts with what the overview
   * already has and reads on from its next offset; from the page's own field or the segmented
   * control it is a fresh search of that type alone (`sections=<type>`), a page at a time.
   */
  function openType(
    section: Section,
    source: { seed: true } | { seed: false; q: string; adv: AdvFields | null },
  ): void {
    stopPreview();
    const r = freshResults();
    const q = source.seed ? lastQ : source.q;
    const adv = source.seed ? lastAdv : source.adv;
    if (source.seed) {
      bagOf(r, section).upsert(bagOf(res, section).list as never);
      r.status = res.status;
      r.via = res.via;
      r.linkedOnly = res.linkedOnly;
      r.more[section] = res.more[section];
      r.next[section] = res.next[section];
      r.done = true;
    }
    const v: Extract<View, { kind: 'type' }> = {
      kind: 'type',
      section,
      res: r,
      ctl: new AbortController(),
      q,
      adv,
      label: labelOf(q, adv),
      page: 0,
    };
    const was = top();
    // Switching type replaces the page on show; "See all" stacks one over the overview.
    if (was?.kind === 'type') {
      was.ctl.abort();
      stack[stack.length - 1] = v;
      hot = -1;
    } else push(v);
    render();
    body.scrollTop = 0;
    if (source.seed) void loadMore(v);
    else void searchType(v);
  }

  /** A fresh search of the page's type alone, its first page. */
  async function searchType(v: Extract<View, { kind: 'type' }>): Promise<void> {
    const r = v.res;
    const s = v.section;
    r.pending.add(s);
    const mine = seq;
    render();
    try {
      await stream(
        params(v.q, v.adv, [s], 0, PAGE_ROWS[s]),
        v.ctl.signal,
        (chunk, client) => {
          if (mine !== seq || top() !== v) return;
          upsert(r, chunk, client);
          render();
        },
        false,
      );
      r.done = true;
    } catch (err) {
      if (v.ctl.signal.aborted) return;
      r.done = true;
      r.error = failureWords(err);
    }
    r.pending.delete(s);
    if (mine === seq && top() === v) render();
  }

  function loadMore(v: Extract<View, { kind: 'type' }>): Promise<void> {
    return extend(v.res, v.section, v.q, v.adv, v.ctl.signal, () => {
      if (top() === v) render();
    });
  }

  /** The first row of page `n`, scrolled to the top of the list and made the hot row. */
  function showPage(v: Extract<View, { kind: 'type' }>, n: number): boolean {
    const row = body.querySelector<HTMLElement>(`.srch__row[data-page="${n}"]`);
    if (!row) return false;
    body.scrollTop = row.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    v.page = n;
    hot = Number(row.dataset['i']);
    applyHot();
    paintPager(v);
    live.textContent = `Page ${n + 1} of ${pageCount(v).known}${v.res.more[v.section] ? ' or more' : ''}`;
    return true;
  }

  /** ‹ › and Page Up/Down: the previous or next page's first row, fetched first when it is not there yet. */
  function turnPage(delta: number): void {
    const v = top();
    if (v?.kind !== 'type') return;
    const to = v.page + delta;
    if (to < 0) return;
    stopPreview();
    if (showPage(v, to)) return;
    if (!pageCount(v).more) return;
    // Fetched first — or waited for, when a scroll already asked — then the page is shown.
    const settle = (tries: number): void => {
      if (top() !== v) return;
      if (v.res.pending.has(v.section)) {
        if (tries > 0) setTimeout(() => settle(tries - 1), 50);
        return;
      }
      void loadMore(v).then(() => {
        if (top() === v) showPage(v, to);
      });
    };
    settle(200);
  }

  body.addEventListener(
    'scroll',
    () => {
      const v = top();
      if (v?.kind !== 'type') return;
      pageFromScroll(v);
      // Infinite scroll: the next page is asked for as the list nears its end (NP-FIND-004).
      if (body.scrollTop + body.clientHeight > body.scrollHeight - 120) void loadMore(v);
    },
    { passive: true },
  );

  typeEl.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.srch__segbtn[data-type]');
    if (!b) return;
    const v = top();
    const s = b.dataset['type'] as Section;
    if (v?.kind !== 'type' || v.section === s) return;
    // The type's own words carry over to the next type; the overview's words are the fallback.
    openType(s, { seed: false, q: v.q, adv: v.adv });
    field().focus();
  });
  typeEl.addEventListener('keydown', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.srch__segbtn');
    if (!b || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const all = [...typeEl.querySelectorAll<HTMLButtonElement>('.srch__segbtn')];
    const i = all.indexOf(b);
    const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]!;
    next.focus();
    next.click();
  });
  typeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = top();
    if (v?.kind !== 'type') return;
    const q = typeQ.value.trim();
    if (!q) return;
    hot = -1;
    openType(v.section, { seed: false, q, adv: null });
  });
  typeQ.addEventListener('input', () => {
    if (hot >= 0) {
      hot = -1;
      applyHot();
    }
  });

  /* ---------------------------------------------------------------- details */

  function openAlbum(al: Pick<CatalogAlbum, 'id' | 'title'>): void {
    stopPreview();
    const v: Extract<View, { kind: 'album' }> = {
      kind: 'album',
      id: al.id,
      title: al.title,
      detail: null,
      error: null,
      client: null,
    };
    push(v);
    render();
    const mine = seq;
    ask((c) => c.album(al.id, 0, 100))
      .then(({ value, client }) => {
        v.detail = value;
        v.client = client;
      })
      .catch((err: unknown) => {
        v.error =
          err instanceof Refused ? err.message : 'The album could not be opened: nothing answered.';
      })
      .finally(() => {
        if (mine === seq && top() === v) render();
      });
  }

  function openArtist(a: Pick<CatalogArtist, 'id' | 'name'>): void {
    stopPreview();
    const v: Extract<View, { kind: 'artist' }> = {
      kind: 'artist',
      id: a.id,
      name: a.name,
      detail: null,
      error: null,
    };
    push(v);
    render();
    const mine = seq;
    ask((c) => c.artist(a.id))
      .then(({ value }) => {
        v.detail = value;
      })
      .catch((err: unknown) => {
        v.error =
          err instanceof Refused
            ? err.message
            : 'The artist could not be opened: nothing answered.';
      })
      .finally(() => {
        if (mine === seq && top() === v) render();
      });
  }

  /** Genre, label and year from enrichment; lyrics, synced or plain (NP-FIND-006). */
  function openSong(t: CatalogTrack): void {
    stopPreview();
    const v: Extract<View, { kind: 'song' }> = {
      kind: 'song',
      t,
      enrich: null,
      enrichSaid: null,
      lyrics: null,
      lyricsSaid: null,
    };
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
        v.enrichSaid =
          err instanceof Refused
            ? `MusicBrainz: ${err.message}`
            : 'Genre, label and year could not be looked up just now.';
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
        v.lyricsSaid =
          err instanceof Refused ? err.message : 'The lyrics could not be looked up just now.';
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
    if (v?.kind === 'type') v.ctl.abort();
    const now = top();
    hot = now ? (hotOf.get(now) ?? -1) : -1;
    render();
    if (document.activeElement === typeQ) input.focus();
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
    const byId =
      ref.kind === 'album' && (ref.platform === 'deezer' || ref.platform === 'apple-music');
    return async (offset) => {
      // Pages of up to 200 (the contract's page limit), however long the list: no cap here (owner, 2026-10-06).
      const { value } = await ask((c) =>
        byId
          ? c.album(`${ref.platform}:${ref.id}`, offset, LIST_PAGE).then((d) => d.page)
          : c.resolve(ref.url, offset, LIST_PAGE).then((r) => {
              if (!r.collection) throw new Refused(r.reason ?? 'The list could not be read again.');
              return r.collection.page;
            }),
      );
      return value;
    };
  }

  /** Opens an album or playlist in the music list the way an album opens (NP-FIND-007). */
  function showInList(
    c: Pick<CatalogCollection, 'ref' | 'artworkUrl' | 'covers'>,
    first: CatalogTrackPage | null,
  ): void {
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
        // Every page until the server says there is no more: a playlist of any length loads whole.
        return {
          rows: page.tracks.map(songFor),
          hasMore: page.hasMore && page.tracks.length > 0,
          total: page.total,
          capped: page.capped,
        };
      },
    };
    close();
    input.blur();
    list.showCollection(info);
  }

  /** A playlist from the search opens like an album: its songs are read through its link (NP-FIND-009). */
  function openPlaylist(p: CatalogPlaylist): void {
    const src = p.sources[0];
    if (!src || !/^https?:/.test(src.url)) {
      say('This playlist has no link to read its songs from');
      return;
    }
    showInList(
      {
        ref: {
          platform: src.platform,
          kind: 'playlist',
          id: src.id ?? p.id,
          url: src.url,
          title: p.title,
          owner: p.owner,
        },
        artworkUrl: p.pictureUrl,
        covers: p.covers,
      },
      null,
    );
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
    if (o.kind === 'more') openType(o.section, { seed: true });
    else if (o.kind === 'album') openAlbum(o.al);
    else if (o.kind === 'artist') {
      // A Spotify artist read from a link has no catalog id to open; its songs are the list beside it.
      if (/^(deezer|apple-music):/.test(o.a.id)) openArtist(o.a);
      else say('Only Deezer and Apple Music artists open here; the songs are listed beside it.');
    } else if (o.kind === 'collection') showInList(o.c, o.c.page);
    else if (o.kind === 'playlist') openPlaylist(o.p);
    else if (o.kind === 'saved') api.openSaved(o.s);
    else if (top()?.kind === 'song') {
      const el = body.querySelector<HTMLElement>(
        `.srch__row[data-i="${i}"] .srch__art[data-preview]`,
      );
      if (el) preview(i, el);
    } else openSong(o.t);
  }

  function addToLibrary(i: number): void {
    const o = options[i];
    if (!o || o.kind !== 'track' || added.has(o.t.id)) return;
    added.add(o.t.id);
    const s = songFor(o.t);
    document.dispatchEvent(
      new CustomEvent('library:add', {
        detail: {
          title: s.title,
          artist: s.artist,
          album: s.album,
          duration: s.duration,
          bpm: s.bpm,
          date: s.date,
          platform: s.platform,
          url: s.url,
        },
      }),
    );
    render();
  }

  /** Download as the player does: the song joins the library with its link, and the helper fetches it. */
  function download(t: CatalogTrack, sources: CatalogTrack['sources']): void {
    const dl = pickDownloadSource(sources);
    if (!dl) {
      say(
        'This song is only in stores (Apple Music, Deezer): there is no copy the helper can fetch.',
      );
      return;
    }
    if (!added.has(t.id)) {
      added.add(t.id);
      const s = songFor({ ...t, sources: [dl, ...t.sources] });
      document.dispatchEvent(
        new CustomEvent('library:add', {
          detail: {
            title: s.title,
            artist: s.artist,
            album: s.album,
            duration: s.duration,
            bpm: s.bpm,
            date: s.date,
            platform: s.platform,
            url: s.url,
          },
        }),
      );
    }
    const row = (w.LIBRARY ?? []).find(
      (x) => x.title.toLowerCase() === t.title.toLowerCase().slice(0, 120),
    );
    if (row && w.NP_FETCH) {
      if (!row.url) row.url = dl.url;
      close();
      w.NP_FETCH(row);
    } else say('Added to your library; the Download key fetches it.');
  }

  /* ------------------------------------------- the song's menu (NP-FIND-010) */

  /** What the shell's menu needs to know about a song row, and what it may ask the search to do. */
  function menuSubject(i: number, touch: boolean): SongMenuSubject | null {
    const o = options[i];
    if (!o || o.kind !== 'track') return null;
    const t = o.t;
    const s = songFor(t);
    return {
      song: {
        title: s.title,
        artist: s.artist,
        album: s.album,
        duration: s.duration,
        bpm: s.bpm,
        date: s.date,
        platform: s.platform,
        url: s.url,
        art: s.art,
      },
      inLibrary: added.has(t.id),
      canDownload: Boolean(pickDownloadSource(t.sources)),
      canAudition: Boolean(V.previewOf(t)),
      auditioning: playing === t,
      touch,
      back: field(),
      onAdd: () => addToLibrary(i),
      onDownload: () => download(t, t.sources),
      onAudition: () => {
        const el = body.querySelector<HTMLElement>(
          `.srch__row[data-i="${i}"] .srch__art[data-preview]`,
        );
        if (el && options[i] === o) preview(i, el);
      },
      // Filed into Up Next or a playlist: the song is in the library now, so the row's + says so.
      onFiled: () => {
        added.add(t.id);
        if (options[i] === o) render();
      },
    };
  }

  function openRowMenu(i: number, x: number, y: number, touch = false): void {
    const menu = w.NP_SONG_MENU;
    const c = menuSubject(i, touch);
    if (!c) return;
    if (!menu) {
      say('The menu is not ready yet');
      return;
    }
    hot = i;
    applyHot();
    disarm();
    menu.open(c, x, y);
  }

  /** Shift+Enter: the hot song to Up Next, without the menu. */
  function queueHot(i: number): void {
    const menu = w.NP_SONG_MENU;
    const c = menuSubject(i, false);
    if (!menu || !c) return;
    menu.run('cat-next', c);
  }

  body.addEventListener('contextmenu', (e) => {
    const row = (e.target as Element).closest<HTMLElement>('.srch__row[data-i]');
    if (!row) return;
    const i = Number(row.dataset['i']);
    if (options[i]?.kind !== 'track') return;
    e.preventDefault();
    // Shift+F10 and the Menu key fire at (0,0): anchor those on the row.
    const r = row.getBoundingClientRect();
    openRowMenu(i, e.clientX || r.left + 40, e.clientY || r.bottom - 4);
  });

  // A long press on a touch screen opens the same menu; a press that moves is a scroll.
  let pressTimer = 0;
  let pressAt: { x: number; y: number } | null = null;
  function cancelPress(): void {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = 0;
    pressAt = null;
  }
  body.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || e.button !== 0) return;
    const row = (e.target as Element).closest<HTMLElement>('.srch__row[data-i]');
    if (!row || (e.target as Element).closest('button')) return;
    const i = Number(row.dataset['i']);
    if (options[i]?.kind !== 'track') return;
    cancelPress();
    pressAt = { x: e.clientX, y: e.clientY };
    pressTimer = window.setTimeout(() => {
      pressTimer = 0;
      pressAt = null;
      openRowMenu(i, e.clientX, e.clientY, true);
    }, LONG_PRESS_MS);
  });
  body.addEventListener('pointermove', (e) => {
    if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 8) cancelPress();
  });
  body.addEventListener('pointerup', cancelPress);
  body.addEventListener('pointercancel', cancelPress);

  /* ----------------------------------------------- tempo, lent from Deezer */
  // A fallback (UX-CAT-006): the engine's hydration fills bpm on every server and in this browser;
  // this asks Deezer only for the rows still without one after `done` (an older hub's rows).

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
                return {
                  bpm: bpm && bpm > 0 ? Math.round(bpm) : null,
                  d: hit.duration && hit.duration > 0 ? Math.round(hit.duration) : null,
                };
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
          document.dispatchEvent(
            new CustomEvent('library:bpm', {
              detail: { title: t.title, artist: songFor(t).artist, bpm: m.bpm },
            }),
          );
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
    fetch(
      `https://itunes.apple.com/search?media=music&entity=song&limit=25&term=${encodeURIComponent(q)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          d: {
            results?: Array<{
              trackName?: string;
              artistName?: string;
              previewUrl?: string;
              trackTimeMillis?: number;
            }>;
          } | null,
        ) => {
          let changed = false;
          for (const r of wanting) {
            const m = (d?.results ?? []).find(
              (x) =>
                x.previewUrl &&
                (x.trackName ?? '').toLowerCase() === r.title.toLowerCase() &&
                (x.artistName ?? '').toLowerCase() === (r.artists[0] ?? '').toLowerCase() &&
                !(
                  r.durationMs &&
                  x.trackTimeMillis &&
                  Math.abs(r.durationMs - x.trackTimeMillis) > 3000
                ),
            );
            if (m?.previewUrl && /^https?:/.test(m.previewUrl)) {
              r.sources.push({
                platform: 'apple-music',
                id: null,
                url: '',
                previewUrl: m.previewUrl,
                matchedBy: 'metadata',
              });
              changed = true;
            }
          }
          if (changed && top()?.kind === 'results') render();
        },
      )
      .catch(() => undefined);
  }

  /* ------------------------------------------------- hold-to-hear (NP-FIND-001) */

  let armTimer = 0;
  let armedEl: HTMLElement | null = null;
  function canArm(): boolean {
    try {
      return (
        matchMedia('(hover: hover) and (pointer: fine)').matches &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches
      );
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
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (armedEl === el) el.style.setProperty('--p', '1');
        }),
      );
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
    for (const v of stack) if (v.kind === 'type') v.ctl.abort();
    res = freshResults();
    stack = [];
    lastQ = '';
    seq++;
    statusEl.hidden = true;
    close();
  }

  /* -------------------------------------------- advanced fields and ISRC */

  const advIn = (name: string): HTMLInputElement =>
    advForm.elements.namedItem(name) as HTMLInputElement;
  const advOpen = (): boolean => !advForm.hidden;
  function advValues(): AdvFields {
    return {
      track: advIn('track').value.trim(),
      artist: advIn('artist').value.trim(),
      album: advIn('album').value.trim(),
      isrc: advIn('isrc').value.trim().toUpperCase().replace(/[-\s]/g, ''),
    };
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
        else if (!advIn('track').value && !advIn('artist').value && !advIn('album').value)
          advIn('track').value = q;
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
      body.innerHTML = msg(
        'An ISRC is two letters, three letters or digits, then seven digits — like USQX91300108.',
      );
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
    const off =
      SECTIONS.filter((s) => !filter.sections[s]).length +
      CATALOG_PROVIDERS.filter((p) => !filter.providers[p]).length;
    filterBtn.classList.toggle('is-on', off > 0);
    filterBtn.setAttribute(
      'aria-label',
      off ? `Filter: ${off} switched off` : 'Filter sections and services',
    );
  }
  const secBox = (s: Section): HTMLInputElement | null =>
    dialog.querySelector<HTMLInputElement>(`input[name="sec"][value="${s}"]`);
  filterBtn.addEventListener('click', () => {
    for (const s of SECTIONS) {
      const box = secBox(s);
      if (box) box.checked = filter.sections[s];
    }
    for (const p of CATALOG_PROVIDERS)
      (dialog.querySelector(`input[name="pf"][value="${p}"]`) as HTMLInputElement).checked =
        filter.providers[p];
    $('srchFilterMsg').textContent = '';
    dialog.showModal();
  });
  $('srchFilterCancel').addEventListener('click', () => dialog.close());
  dialog.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const next: Filter = {
      sections: { tracks: false, artists: false, albums: false, playlists: false },
      providers: {
        itunes: false,
        deezer: false,
        musicbrainz: false,
        youtube: false,
        soundcloud: false,
      },
    };
    for (const s of SECTIONS) next.sections[s] = secBox(s)?.checked ?? filter.sections[s];
    for (const p of CATALOG_PROVIDERS)
      next.providers[p] = (
        dialog.querySelector(`input[name="pf"][value="${p}"]`) as HTMLInputElement
      ).checked;
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
    // On a type page the keys reaching the last rows ask for the next page (NP-FIND-004).
    if (v?.kind === 'type' && hot === n - 1 && (was === hot || delta > 1 || hot >= n - 3))
      void loadMore(v);
  }

  function onKeys(e: KeyboardEvent): void {
    const showing = !pop.hidden;
    if (e.key === 'Escape') {
      if (w.NP_SONG_MENU?.isOpen()) {
        e.preventDefault();
        w.NP_SONG_MENU.close();
      } else if (showing && stack.length > 1) {
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
    if ((e.key === 'PageDown' || e.key === 'PageUp') && showing) {
      e.preventDefault();
      const v = top();
      // A type page turns its pages; the overview has none (NP-FIND-003); a long list moves five rows.
      if (v?.kind === 'type') turnPage(e.key === 'PageDown' ? 1 : -1);
      else if (v?.kind !== 'results' && options.length) move(e.key === 'PageDown' ? 5 : -5);
      return;
    }
    if (e.key === 'Enter') {
      // Cmd/Ctrl+Enter files the hot song in the library (the row's +); Shift+Enter queues it to Up Next.
      if (showing && hot >= 0 && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        addToLibrary(hot);
        return;
      }
      if (showing && hot >= 0 && e.shiftKey && options[hot]?.kind === 'track') {
        e.preventDefault();
        queueHot(hot);
        return;
      }
      const o = hot >= 0 ? options[hot] : undefined;
      if (showing && o && !pop.classList.contains('is-stale')) {
        e.preventDefault();
        // A song with a clip plays it; one without opens its details.
        const el = body.querySelector<HTMLElement>(
          `.srch__row[data-i="${hot}"] .srch__art[data-preview]`,
        );
        if (o.kind === 'track' && el && top()?.kind !== 'song') preview(hot, el);
        else activate(hot);
        return;
      }
      if (e.target === typeQ) return; // the type page's form searches its type
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
  }
  input.addEventListener('keydown', onKeys);
  typeQ.addEventListener('keydown', onKeys);

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
    if (!(e.target as Element).closest('a, input, select, textarea, label, .srch__segbtn'))
      e.preventDefault();
  });
  /** Focus moving to the menu or a sheet the menu opened is not focus leaving the search. */
  const ours = (el: Element | null): boolean =>
    Boolean(el?.closest?.('.search, #srchFilter, #ctx, #sheet'));
  searchBox.addEventListener('focusout', (e) => {
    const to = (e as FocusEvent).relatedTarget as Element | null;
    if (to && ours(to)) return;
    if (dialog.open || w.NP_SONG_MENU?.isOpen()) return;
    // Focus can leave to nothing (relatedTarget null) when a menu takes it: wait a beat and look.
    setTimeout(() => {
      if (ours(document.activeElement) || dialog.open || w.NP_SONG_MENU?.isOpen()) return;
      if (document.getElementById('sheet')?.matches('[open]')) return;
      close();
    }, 0);
  });

  body.addEventListener('click', (e) => {
    const target = e.target as Element;
    const addBtn = target.closest<HTMLElement>('.srch__add[data-add]');
    if (addBtn) {
      e.preventDefault();
      addToLibrary(Number(addBtn.dataset['add']));
      return;
    }
    const menuBtn = target.closest<HTMLElement>('.srch__menu[data-menu]');
    if (menuBtn) {
      e.preventDefault();
      const r = menuBtn.getBoundingClientRect();
      openRowMenu(
        Number(menuBtn.dataset['menu']),
        r.left,
        r.bottom + 2,
        matchMedia('(pointer: coarse)').matches,
      );
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
      if (act.dataset['act'] === 'list' && v?.kind === 'album' && v.detail)
        showInList(
          {
            ref: v.detail.collection,
            artworkUrl: v.detail.album.artworkUrl,
            covers: v.detail.page.tracks
              .map((t) => t.artworkUrl)
              .filter((u): u is string => Boolean(u))
              .slice(0, 4),
          },
          v.detail.page,
        );
      if (act.dataset['act'] === 'add' && v?.kind === 'song') addToLibrary(0);
      if (act.dataset['act'] === 'download' && v?.kind === 'song')
        download(v.t, v.enrich ? [...v.t.sources, ...v.enrich.sources] : v.t.sources);
      return;
    }
    if (target.closest('a, .srch__add, .srch__menu')) return;
    const row = target.closest<HTMLElement>('.srch__row[data-i]');
    if (!row) return;
    hot = Number(row.dataset['i']);
    applyHot();
    activate(hot);
  });

  $('srchPrev').addEventListener('click', () => turnPage(-1));
  $('srchNext').addEventListener('click', () => turnPage(1));
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
    if (!pop.hidden && !ours(e.target as Element)) close();
  });

  /** Kept for the shell's "keep this song" (the radio's on-air menu): songs for a query, in the old row shape. */
  w.NP_FIND = async (q: string) => {
    const signal = AbortSignal.timeout(8000);
    const r = freshResults();
    await stream(
      params(q, null, ['tracks'], 0, OVERVIEW_LIMIT),
      signal,
      (chunk, client) => upsert(r, chunk, client),
      true,
    ).catch(() => undefined);
    return r.tracks.list.slice(0, 10).map((t) => {
      const s = songFor(t);
      return {
        t: t.title,
        a: t.artist,
        al: t.album ?? '',
        d: s.duration || null,
        bpm: s.bpm,
        p: s.platform,
        u: s.url || null,
      };
    });
  };

  paintFilterBtn();
  installed = api;
  return api;
}

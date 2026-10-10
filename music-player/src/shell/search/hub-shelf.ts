/**
 * The paired hub's shelf, from the player (DEC-041): its playlist folder and this player's starred
 * albums and playlists, kept in step.
 *
 * - **Filing (NP-FIND-013, `playlists:use`).** A song row's Add to Playlist ▸ gains a group "On <hub>":
 *   the hub's folder playlists, ticked where the song is already (`GET /api/v1/playlists?catalogId&isrc`,
 *   `hasTrack`), and "New Playlist on <hub>…". A catalog song is sent as its `CatalogTrack`; a library
 *   song by its catalog identity — its source link, else its ISRC (as its MusicBrainz ISRC page, which
 *   the hub matches to its own library by ISRC). The contract keeps every entry's link
 *   (`CatalogTrack.sources` holds at least one), so a song with neither cannot go to the hub, and the
 *   group says why. Without the scope the group says the hub has not allowed it, and how to fix it.
 * - **Hub playlists (NP-FIND-014).** The library menu's Playlists ▸ "On <hub>" lists the folder; one
 *   opens in the music list like an album, paged (NP-FIND-007). A library entry streams through the hub
 *   (`POST /library/stream-urls`); a link entry is a catalog visitor (NP-FIND-011). Rename, delete and
 *   reorder only where this player made the list; otherwise it is read-only, and says so.
 * - **Starred sync (NP-FIND-008, `library:sync`).** On start, and on every star or un-star, this
 *   player's SavedCollections are merged with its own on the hub (`mergeSaved`): a union by
 *   `{platform, kind, id}`, the later `savedAt` winning, and an un-star made here — kept as a tombstone
 *   until the hub has heard it — winning over the hub's older copy. Failures retry with backoff, quietly.
 *   The admin's starred lists come back as `shared` and show, read-only, under "Shared on <hub>".
 */
import type {
  CatalogCollectionRef,
  CatalogPlatform,
  CatalogTrack,
  FolderPlaylistEntry,
  FolderPlaylistPage,
  FolderPlaylistSummary,
  SavedCollection,
} from '@now-playing/contracts';
import { CATALOG_PLATFORM_LABELS, PLAYLIST_FOLDER_PAGE_MAX } from '@now-playing/contracts';
import { hubAccount, webUrl } from './client.js';
import { trackOf } from './visit.js';
import type { ListedCollection, ListSong } from './index.js';

/* ------------------------------------------------------------------ words */

export const PERMISSION_LABEL = 'File into the hub’s playlists';
export const noPlaylistsWhy = (hub: string): string =>
  `${hub} hasn’t allowed this player to use its playlists. To fix it, pair again (Settings ▸ Connections) and tick “${PERMISSION_LABEL}”.`;
export const NO_PLAYLISTS_SHORT = 'Your hub hasn’t allowed this player to use its playlists';
export const NO_LINK_WHY = 'The hub’s playlists keep each song’s link or ISRC, and this song has neither, so it can go only in this player’s playlists.';

/* ------------------------------------------------------------------ the merge (pure) */

export interface Tombstone {
  platform: CatalogPlatform;
  kind: 'album' | 'playlist';
  id: string;
  /** When it was un-starred here. */
  at: string;
}

type Keyed = Pick<CatalogCollectionRef, 'platform' | 'kind' | 'id'>;
export const savedKey = (r: Keyed): string => `${r.platform}\u0000${r.kind}\u0000${r.id}`;
const time = (iso: string | null | undefined): number => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : 0;
};

export interface MergeResult {
  /** What this player keeps now, in its order: its own first, then what only the hub had. */
  items: SavedCollection[];
  /** Saved here and missing or older on the hub: PUT. */
  put: SavedCollection[];
  /** Un-starred here and still on the hub: DELETE (each tombstone stays until the hub has heard it). */
  del: Tombstone[];
  /** The tombstones still owed to the hub. */
  tombstones: Tombstone[];
}

/**
 * Merges this player's starred lists with its own copy on the hub.
 *
 * - The union by `{platform, kind, id}`; when both hold one, the later `savedAt` is kept.
 * - A tombstone (an un-star made here, maybe offline) wins over a hub copy saved before it: the item is
 *   dropped and DELETE is owed. A hub copy saved *after* it (starred again since) wins instead, and the
 *   tombstone goes. A tombstone with nothing on the hub is settled.
 * - Anything here that the hub lacks, or holds an older copy of, is PUT.
 */
export function mergeSaved(local: readonly SavedCollection[], remote: readonly SavedCollection[], tombs: readonly Tombstone[]): MergeResult {
  const remoteBy = new Map(remote.map((r) => [savedKey(r.ref), r]));
  const tombBy = new Map<string, Tombstone>();
  for (const t of tombs) {
    const k = savedKey(t);
    const have = tombBy.get(k);
    if (!have || time(t.at) > time(have.at)) tombBy.set(k, t);
  }
  const del: Tombstone[] = [];
  const kept: Tombstone[] = [];
  const dropped = new Set<string>();
  for (const [k, t] of tombBy) {
    const r = remoteBy.get(k);
    if (!r) continue; // nothing left to delete: settled
    if (time(r.savedAt) > time(t.at)) continue; // starred again since: the hub's copy wins
    dropped.add(k);
    del.push(t);
    kept.push(t);
  }
  const items: SavedCollection[] = [];
  const at = new Map<string, number>();
  const put: SavedCollection[] = [];
  for (const l of local) {
    const k = savedKey(l.ref);
    if (dropped.has(k) || at.has(k)) continue;
    const r = remoteBy.get(k);
    const newer = r && time(r.savedAt) > time(l.savedAt) ? r : l;
    at.set(k, items.length);
    items.push(newer);
    if (!r || time(l.savedAt) > time(r.savedAt)) put.push(l);
  }
  const onlyHub = remote.filter((r) => !at.has(savedKey(r.ref)) && !dropped.has(savedKey(r.ref)));
  onlyHub.sort((a, b) => time(a.savedAt) - time(b.savedAt));
  for (const r of onlyHub) {
    // A hub copy older than a tombstone was dropped above; one starred again since clears it.
    at.set(savedKey(r.ref), items.length);
    items.push(r);
  }
  return { items, put, del, tombstones: kept };
}

/* ------------------------------------------------------------------ songs as the hub takes them */

/** A song as the shell's menus hold it: a library row, a visitor, a catalog row. */
export interface ShelfSong {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  bpm?: number | null;
  url?: string | null;
  /** A library row's own catalog identity (bridge.ts `rowOf`). */
  isrc?: string | null;
  link?: string | null;
  cat?: CatalogTrack | null;
}

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/** The song as the `CatalogTrack` the hub files, or why it cannot be one. */
export function shelfTrack(song: ShelfSong): { track: CatalogTrack } | { why: string } {
  if (song.cat && Array.isArray(song.cat.sources) && song.cat.sources.length) return { track: song.cat };
  const isrc = typeof song.isrc === 'string' && ISRC.test(song.isrc.toUpperCase()) ? song.isrc.toUpperCase() : null;
  for (const u of [song.link, song.url]) {
    const t = trackOf({ id: '', title: song.title, artist: song.artist, album: song.album, duration: song.duration, bpm: song.bpm ?? null, url: webUrl(u) });
    if (t) return { track: { ...t, isrc } };
  }
  if (isrc) {
    const url = `https://musicbrainz.org/isrc/${isrc}`;
    return {
      track: {
        id: `musicbrainz:isrc:${isrc}`,
        title: song.title.slice(0, 300) || 'Untitled',
        artist: song.artist.slice(0, 300),
        artists: song.artist ? [song.artist.slice(0, 300)] : [],
        album: song.album ? song.album.slice(0, 300) : null,
        albumArtist: null,
        durationMs: song.duration ? Math.round(song.duration * 1000) : null,
        isrc,
        artworkUrl: null,
        releaseDate: null,
        year: null,
        trackNumber: null,
        discNumber: null,
        bpm: song.bpm && song.bpm > 0 ? song.bpm : null,
        explicit: null,
        genre: null,
        label: null,
        sources: [{ platform: 'musicbrainz', id: isrc, url, previewUrl: null, matchedBy: 'isrc' }],
        rank: 0,
      },
    };
  }
  return { why: NO_LINK_WHY };
}

/** Where a hub playlist's song plays from, in words. */
export function entryPlatform(e: FolderPlaylistEntry, hub: string): string {
  if (e.locationKind === 'library') return hub;
  if (e.locationKind === 'missing') return 'Not found';
  const p = e.platforms[0] ?? e.sources[0]?.platform;
  return p ? CATALOG_PLATFORM_LABELS[p] : 'Link';
}

/* ------------------------------------------------------------------ the module */

interface Acct {
  base: string;
  credentialId: string;
  secret: string;
  hubName?: string;
  scopes?: string[];
  deviceId?: string;
}

/** A hub playlist on show, as the music list carries it (`ListedCollection.hub`). */
export interface HubListInfo {
  playlistId: string;
  name: string;
  editable: boolean;
  why: string | null;
}

/** What the shell's list (make-shell.py, "the hub's shelf") offers this module. */
interface ShellListApi {
  showCollection(info: ListedCollection): void;
  saved(): SavedCollection[];
  replaceSaved(items: SavedCollection[]): void;
  moveRow(id: string, to: number): void;
  close(): void;
}

type Win = Window & {
  kv: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> | void };
  say?: (s: string) => void;
  NP_LIST?: ShellListApi;
  NP_LIBRARY_LOADED?: boolean;
  NP_HUB_SHELF?: HubShelf;
};

export interface HubShelf {
  /** Sync: what the menus may show now. */
  status(): { paired: boolean; hubName: string; playlists: boolean; sync: boolean; noScope: string };
  /** Fills a menu's (or the touch sheet's) "On <hub>" group for a song. */
  paint(group: HTMLElement, song: ShelfSong, mode: 'menu' | 'sheet'): void;
  /** A hub command from a menu: hub-file, hub-new, hub-why, hub-rename, hub-delete, hub-up, hub-down. */
  run(act: string, el: HTMLElement | null, subject: { song?: ShelfSong; list?: { hub?: HubListInfo } | null; row?: { id: string } | null }): void;
  /** The bar's "…" menu for a hub playlist on show. */
  listMenu(list: { hub?: HubListInfo } | null, row: { id: string } | null): string;
  /** The library menu: the hub's playlists (null while they are asked for) and the admin's shared lists. */
  playlists(): FolderPlaylistSummary[] | null;
  shared(): SavedCollection[];
  refresh(): void;
  open(playlistId: string): Promise<void>;
  /** A hub library entry on show, by row id: what bridge.ts streams. */
  streamable(id: string): { trackId: string; title: string; artist: string; durationMs: number | null } | null;
  streamUrl(trackId: string): Promise<{ url: string } | { reason: string }>;
  /** Moves the selected row of an editable hub list (Alt+↑/↓). True when the key was used. */
  moveSelected(list: { hub?: HubListInfo } | null, row: { id: string } | null, by: -1 | 1): boolean;
  sync(): Promise<void>;
}

const SYNC_KEY = 'player:saved-sync';
const RETRY_MIN = 5_000;
const RETRY_MAX = 5 * 60_000;

function escape(t: unknown): string {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

class Problem extends Error {
  constructor(
    message: string,
    readonly offline: boolean,
  ) {
    super(message);
  }
}

export function installHubShelf(): HubShelf {
  const w = window as unknown as Win;
  if (w.NP_HUB_SHELF) return w.NP_HUB_SHELF;
  const say = (s: string): void => w.say?.(s);

  let acct: Acct | null = null;
  let lists: FolderPlaylistSummary[] | null = null;
  let listsAt = 0;
  let shared: SavedCollection[] = [];
  let tombs: Tombstone[] = [];
  let retryMs = RETRY_MIN;
  let retryTimer = 0;
  let syncing: Promise<void> | null = null;
  /** Rows of hub lists on show, by row id. */
  const rows = new Map<string, { entry: FolderPlaylistEntry; playlistId: string }>();
  const changed = (): void => void document.dispatchEvent(new CustomEvent('hub-shelf:change'));

  const has = (s: string): boolean => !!acct && Array.isArray(acct.scopes) && acct.scopes.includes(s);
  const hubName = (): string => acct?.hubName || 'the hub';
  const reload = async (): Promise<Acct | null> => {
    acct = (await hubAccount()) as Acct | null;
    return acct;
  };

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const a = acct ?? (await reload());
    if (!a) throw new Problem('No hub is paired.', false);
    let res: Response;
    try {
      res = await fetch(`${a.base.replace(/\/$/, '')}/api/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${a.credentialId}.${a.secret}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Problem(`${hubName()} did not answer. Check that it is on, and on this network.`, true);
    }
    if (!res.ok) {
      let said = `${hubName()} answered ${res.status}.`;
      try {
        const p = (await res.json()) as { detail?: unknown; message?: unknown; title?: unknown };
        const d = p.detail ?? p.message ?? p.title;
        if (typeof d === 'string' && d) said = d.slice(0, 300);
      } catch {
        /* no body worth reading */
      }
      throw new Problem(said, res.status >= 500 && res.status !== 501);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /* -------------------------------------------------------- playlists */

  async function fetchLists(probe?: { catalogId?: string; isrc?: string | null }): Promise<FolderPlaylistSummary[]> {
    const q = new URLSearchParams();
    if (probe?.catalogId) q.set('catalogId', probe.catalogId);
    if (probe?.isrc) q.set('isrc', probe.isrc);
    const got = await call<{ items: FolderPlaylistSummary[] }>('GET', `/playlists${q.size ? `?${q}` : ''}`);
    if (!probe) {
      lists = got.items;
      listsAt = Date.now();
      changed();
    }
    return got.items;
  }

  function refresh(): void {
    void reload().then((a) => {
      if (!a || !has('playlists:use')) {
        if (lists !== null) changed();
        lists = null;
        return;
      }
      if (Date.now() - listsAt < 3000) return;
      fetchLists().catch(() => {
        lists = lists ?? [];
        changed();
      });
    });
  }

  function hubGroupHead(mode: 'menu' | 'sheet', words: string): string {
    return mode === 'menu' ? `<div class="ctx__sep" role="separator"></div><div class="ctx__head" role="presentation">${escape(words)}</div>` : `<p class="sheet-act__title">${escape(words)}</p>`;
  }
  function item(mode: 'menu' | 'sheet', act: string, words: string, extra = ''): string {
    return mode === 'menu'
      ? `<button class="ctx__item" type="button" role="menuitem" data-act="${act}"${extra}>${words}</button>`
      : `<button class="sheet-act__btn" type="button" data-act="${act}"${extra}>${words}</button>`;
  }
  /** A line that is read and said, not run: focusable, so the keys reach it, but marked disabled. */
  const why = (mode: 'menu' | 'sheet', words: string, why: string): string => item(mode, 'hub-why', escape(words), ` aria-disabled="true" data-why="${escape(why)}" title="${escape(why)}"`);

  function paint(group: HTMLElement, song: ShelfSong, mode: 'menu' | 'sheet'): void {
    const local = group.parentElement?.querySelector<HTMLElement>('[data-hub-local]');
    if (!acct) {
      group.innerHTML = '';
      group.hidden = true;
      void reload().then((a) => a && group.isConnected && paint(group, song, mode));
      return;
    }
    if (local) local.hidden = false;
    group.hidden = false;
    const hub = hubName();
    group.setAttribute('aria-label', `On ${hub}`);
    const head = hubGroupHead(mode, `On ${hub}`);
    if (!has('playlists:use')) {
      group.innerHTML = head + why(mode, NO_PLAYLISTS_SHORT, noPlaylistsWhy(hub));
      return;
    }
    const filed = shelfTrack(song);
    if ('why' in filed) {
      group.innerHTML = head + why(mode, `Can’t file this song on ${hub}`, filed.why);
      return;
    }
    group.innerHTML = head + why(mode, `Checking ${hub}’s playlists…`, `Asking ${hub} for its playlists`);
    fetchLists({ catalogId: filed.track.id, isrc: filed.track.isrc }).then(
      (items) => {
        if (!group.isConnected) return;
        const listed = items
          .map((pl) => {
            const on = pl.hasTrack === true;
            return mode === 'menu'
              ? `<button class="ctx__item" type="button" role="menuitemcheckbox" aria-checked="${on}" data-act="hub-file" data-hpl="${escape(pl.id)}" data-name="${escape(pl.name)}"><span class="ctx__check" aria-hidden="true">${on ? '✓' : ''}</span>${escape(pl.name)}</button>`
              : `<button class="sheet-act__btn" type="button" role="checkbox" aria-checked="${on}" data-act="hub-file" data-hpl="${escape(pl.id)}" data-name="${escape(pl.name)}">${escape(pl.name)}</button>`;
          })
          .join('');
        group.innerHTML = head + listed + item(mode, 'hub-new', `New Playlist on ${escape(hub)}…`);
      },
      (err: unknown) => {
        if (!group.isConnected) return;
        const said = err instanceof Error ? err.message : `${hub} could not list its playlists.`;
        group.innerHTML = head + why(mode, `${hub}’s playlists can’t be read just now`, said);
      },
    );
  }

  async function file(playlistId: string, name: string, song: ShelfSong, ticked: boolean): Promise<void> {
    const filed = shelfTrack(song);
    if ('why' in filed) return say(filed.why);
    if (ticked) return say(`“${song.title}” is already in “${name}” on ${hubName()}`);
    try {
      const r = await call<{ added: number; skipped: number; playlist: FolderPlaylistSummary }>('POST', `/playlists/${encodeURIComponent(playlistId)}/entries`, { tracks: [filed.track] });
      say(r.added ? `Added “${song.title}” to “${r.playlist.name}” on ${hubName()}` : `“${song.title}” is already in “${r.playlist.name}” on ${hubName()}`);
      listsAt = 0;
      refresh();
    } catch (err) {
      say(err instanceof Error ? err.message : 'The hub could not file the song.');
    }
  }

  async function createWith(song: ShelfSong): Promise<void> {
    const filed = shelfTrack(song);
    if ('why' in filed) return say(filed.why);
    const name = await askSheet({ title: `New Playlist on ${hubName()}`, message: `A playlist in ${hubName()}’s playlist folder, starting with “${song.title}”.`, value: '', confirm: 'Create' });
    if (!name) return;
    try {
      const made = await call<FolderPlaylistSummary>('POST', '/playlists', { name, tracks: [filed.track] });
      say(`Added “${song.title}” to “${made.name}” on ${hubName()}`);
      listsAt = 0;
      refresh();
    } catch (err) {
      say(err instanceof Error ? err.message : 'The hub could not make the playlist.');
    }
  }

  /* -------------------------------------------------------- a hub playlist in the music list */

  function editability(pl: FolderPlaylistSummary): { editable: boolean; why: string | null } {
    if (pl.readOnly || pl.origin === 'hand-made') return { editable: false, why: 'Made outside Airwave: read-only here' };
    if (!acct?.deviceId || pl.createdBy !== acct.deviceId) return { editable: false, why: 'Made on another device: read-only here' };
    return { editable: true, why: null };
  }

  function rowOf(playlistId: string, e: FolderPlaylistEntry): ListSong & { remote?: boolean; hub?: boolean } {
    const id = `hub-${playlistId}-${e.id}`;
    rows.set(id, { entry: e, playlistId });
    const link = webUrl(e.location) ?? webUrl(e.sources[0]?.url);
    const preview = e.sources.map((s) => webUrl(s.previewUrl)).find(Boolean) ?? null;
    const base: ListSong & { remote?: boolean; hub?: boolean } = {
      id,
      kind: 'music',
      title: e.title.slice(0, 120) || 'Untitled',
      artist: e.artist.slice(0, 80),
      album: (e.album ?? '').slice(0, 80),
      duration: e.durationSec ?? 0,
      bpm: null,
      date: null,
      platform: entryPlatform(e, hubName()),
      url: e.locationKind === 'library' ? '' : (link ?? ''),
      art: webUrl(e.artworkUrl),
      preview,
    };
    if (e.locationKind === 'library' && e.trackId) return { ...base, remote: true, hub: true };
    if (link && e.sources.length) {
      base.cat = {
        id: e.catalogId ?? `${e.sources[0]!.platform}:${link}`.slice(0, 260),
        title: e.title,
        artist: e.artist,
        artists: e.artists,
        album: e.album,
        albumArtist: null,
        durationMs: e.durationSec ? e.durationSec * 1000 : null,
        isrc: e.isrc && ISRC.test(e.isrc) ? e.isrc : null,
        artworkUrl: e.artworkUrl,
        releaseDate: null,
        year: null,
        trackNumber: null,
        discNumber: null,
        bpm: null,
        explicit: null,
        genre: null,
        label: null,
        sources: e.sources,
        rank: 0,
      };
    }
    return base;
  }

  async function open(playlistId: string): Promise<void> {
    const list = w.NP_LIST;
    if (!list) return say('The music list is not ready yet');
    let first: FolderPlaylistPage;
    try {
      first = await call<FolderPlaylistPage>('GET', `/playlists/${encodeURIComponent(playlistId)}?offset=0&limit=${PLAYLIST_FOLDER_PAGE_MAX}`);
    } catch (err) {
      return say(err instanceof Error ? err.message : 'The hub could not open the playlist.');
    }
    const pl = first.playlist;
    const ed = editability(pl);
    let offset = first.offset + first.items.length;
    const info: ListedCollection & { hub: HubListInfo; note: string | null } = {
      ref: { platform: 'hub', kind: 'playlist', id: pl.id, url: '', title: pl.name, owner: null },
      platformLabel: hubName(),
      artworkUrl: null,
      covers: pl.covers.slice(0, 4),
      trackCount: first.total,
      rows: first.items.map((e) => rowOf(pl.id, e)),
      capped: false,
      hasMore: first.hasMore,
      loading: false,
      error: null,
      hub: { playlistId: pl.id, name: pl.name, editable: ed.editable, why: ed.why },
      note: ed.why ? ed.why.replace(': read-only here', ' — read-only') : null,
      async more() {
        const page = await call<FolderPlaylistPage>('GET', `/playlists/${encodeURIComponent(pl.id)}?offset=${offset}&limit=${PLAYLIST_FOLDER_PAGE_MAX}`);
        offset = page.offset + page.items.length;
        return { rows: page.items.map((e) => rowOf(pl.id, e)), hasMore: page.hasMore && page.items.length > 0, total: page.total, capped: false };
      },
    };
    list.showCollection(info);
  }

  function listMenu(list: { hub?: HubListInfo } | null, row: { id: string } | null): string {
    const h = list?.hub;
    if (!h) return '';
    const off = h.editable ? '' : ` disabled title="${escape(h.why ?? '')}"`;
    const noRow = !row || !rows.has(row.id);
    return (
      `<div class="ctx__head" role="presentation">${escape(h.name)} · ${escape(hubName())}</div>` +
      (h.editable ? '' : `<div class="ctx__head" role="presentation">${escape(h.why ?? '')}</div>`) +
      `<button class="ctx__item" type="button" role="menuitem" data-act="hub-rename"${off}>Rename…</button>` +
      `<button class="ctx__item" type="button" role="menuitem" data-act="hub-up"${h.editable && !noRow ? '' : ' disabled'}>Move Song Up</button>` +
      `<button class="ctx__item" type="button" role="menuitem" data-act="hub-down"${h.editable && !noRow ? '' : ' disabled'}>Move Song Down</button>` +
      `<div class="ctx__sep" role="separator"></div>` +
      `<button class="ctx__item" type="button" role="menuitem" data-act="hub-delete"${off}>Delete Playlist…</button>`
    );
  }

  /** The row's place in the list on show, and the list's rows, from the DOM the shell drew. */
  function placeOf(id: string): { at: number; n: number } {
    const ids = Array.from(document.querySelectorAll<HTMLElement>('#libraryRows tr[data-id]')).map((tr) => tr.dataset['id']);
    return { at: ids.indexOf(id), n: ids.length };
  }

  async function move(h: HubListInfo, rowId: string, by: -1 | 1): Promise<void> {
    const r = rows.get(rowId);
    if (!r) return;
    const { at, n } = placeOf(rowId);
    const to = at + by;
    if (at < 0 || to < 0 || to >= n) return;
    try {
      await call('POST', `/playlists/${encodeURIComponent(h.playlistId)}/entries/move`, { entryId: r.entry.id, to });
      w.NP_LIST?.moveRow(rowId, to);
      say(`Moved “${r.entry.title}” ${by < 0 ? 'up' : 'down'} to ${to + 1} of ${n}`);
    } catch (err) {
      say(err instanceof Error ? err.message : 'The hub could not move the song.');
    }
  }

  async function rename(h: HubListInfo): Promise<void> {
    const name = await askSheet({ title: 'Rename Playlist', message: `A new name for “${h.name}” on ${hubName()}. Its files are renamed too.`, value: h.name, confirm: 'Rename' });
    if (!name || name === h.name) return;
    try {
      const done = await call<FolderPlaylistSummary>('PATCH', `/playlists/${encodeURIComponent(h.playlistId)}`, { name });
      listsAt = 0;
      refresh();
      await open(h.playlistId);
      say(`Renamed to “${done.name}”`);
    } catch (err) {
      say(err instanceof Error ? err.message : 'The hub could not rename the playlist.');
    }
  }

  async function remove(h: HubListInfo): Promise<void> {
    const ok = await askSheet({ title: 'Delete Playlist', message: `Delete “${h.name}” from ${hubName()}? Its songs stay in the hub’s library and at their sources.`, confirm: 'Delete' });
    if (ok === null) return;
    try {
      await call('DELETE', `/playlists/${encodeURIComponent(h.playlistId)}`);
      w.NP_LIST?.close();
      say(`Deleted “${h.name}” from ${hubName()}`);
      listsAt = 0;
      refresh();
    } catch (err) {
      say(err instanceof Error ? err.message : 'The hub could not delete the playlist.');
    }
  }

  /* -------------------------------------------------------- a small sheet: a name, or yes */

  let sheet: HTMLDialogElement | null = null;
  function askSheet(o: { title: string; message: string; value?: string; confirm: string }): Promise<string | null> {
    if (!sheet) {
      sheet = document.createElement('dialog');
      sheet.className = 'sheet';
      sheet.id = 'hubSheet';
      sheet.setAttribute('aria-labelledby', 'hubSheetTitle');
      sheet.innerHTML =
        '<form method="dialog" class="sheet__form"><div class="sheet__body">' +
        '<p class="sheet__title" id="hubSheetTitle"></p><p class="sheet__msg" id="hubSheetMsg"></p>' +
        '<input class="sheet__input" id="hubSheetInput" type="text" maxlength="120" autocomplete="off" aria-labelledby="hubSheetTitle">' +
        '</div><div class="sheet__actions"><button class="sheet__btn" type="button" id="hubSheetCancel">Cancel</button>' +
        '<button class="sheet__btn sheet__btn--default" type="submit" id="hubSheetGo" value="go">OK</button></div></form>';
      document.body.appendChild(sheet);
      sheet.querySelector('#hubSheetCancel')!.addEventListener('click', () => sheet!.close('cancel'));
    }
    const s = sheet;
    const input = s.querySelector<HTMLInputElement>('#hubSheetInput')!;
    s.querySelector('#hubSheetTitle')!.textContent = o.title;
    s.querySelector('#hubSheetMsg')!.textContent = o.message;
    s.querySelector('#hubSheetGo')!.textContent = o.confirm;
    const asks = o.value !== undefined;
    input.hidden = !asks;
    input.value = o.value ?? '';
    input.placeholder = 'Playlist';
    return new Promise((resolve) => {
      s.returnValue = '';
      s.addEventListener(
        'close',
        () => {
          if (s.returnValue !== 'go') return resolve(null);
          resolve(asks ? input.value.trim() || null : 'yes');
        },
        { once: true },
      );
      s.showModal();
      if (asks) {
        input.focus();
        input.select();
      } else s.querySelector<HTMLButtonElement>('#hubSheetCancel')!.focus();
    });
  }

  /* -------------------------------------------------------- starred sync */

  const loaded = new Promise<void>((resolve) => {
    if (w.NP_LIBRARY_LOADED) resolve();
    else document.addEventListener('library:loaded', () => resolve(), { once: true });
  });

  async function saveTombs(): Promise<void> {
    try {
      await w.kv.set(SYNC_KEY, { tombstones: tombs });
    } catch {
      /* the next un-star tries again */
    }
  }
  const tombsLoaded = Promise.resolve(w.kv.get(SYNC_KEY))
    .then((v) => {
      const list = (v as { tombstones?: unknown } | null)?.tombstones;
      if (Array.isArray(list)) tombs = list.filter((t): t is Tombstone => !!t && typeof t === 'object' && typeof (t as Tombstone).id === 'string' && typeof (t as Tombstone).at === 'string');
    })
    .catch(() => undefined);

  function retryLater(): void {
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => void sync(), retryMs);
    retryMs = Math.min(RETRY_MAX, retryMs * 2);
  }

  function sync(): Promise<void> {
    syncing ??= (async () => {
      await Promise.all([loaded, tombsLoaded]);
      const a = await reload();
      if (!a || !has('library:sync')) {
        if (shared.length) changed();
        shared = [];
        return;
      }
      const list = w.NP_LIST;
      if (!list) return;
      try {
        const remote = await call<{ items: SavedCollection[]; shared?: SavedCollection[] }>('GET', '/catalog/saved');
        const m = mergeSaved(list.saved(), remote.items, tombs);
        const before = JSON.stringify(list.saved());
        if (JSON.stringify(m.items) !== before) list.replaceSaved(m.items);
        shared = remote.shared ?? [];
        tombs = m.tombstones;
        await saveTombs();
        changed();
        for (const s of m.put) await call('PUT', '/catalog/saved', s);
        for (const t of m.del) {
          await call('DELETE', `/catalog/saved?${new URLSearchParams({ platform: t.platform, kind: t.kind, id: t.id })}`);
          tombs = tombs.filter((x) => savedKey(x) !== savedKey(t));
          await saveTombs();
        }
        retryMs = RETRY_MIN;
      } catch (err) {
        // Quiet: a hub that is away is asked again later, with backoff; nothing is said.
        if (err instanceof Problem && !err.offline) return;
        retryLater();
      }
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  document.addEventListener('library:collections', (e) => {
    const d = (e as CustomEvent<{ ref: CatalogCollectionRef; saved: SavedCollection | null }>).detail;
    if (!d?.ref) return;
    void (async () => {
      await tombsLoaded;
      const k = savedKey(d.ref);
      tombs = tombs.filter((t) => savedKey(t) !== k);
      if (!d.saved) tombs.push({ platform: d.ref.platform, kind: d.ref.kind, id: d.ref.id, at: new Date().toISOString() });
      await reload();
      if (!has('library:sync')) {
        tombs = [];
        return;
      }
      await saveTombs();
      try {
        if (d.saved) await call('PUT', '/catalog/saved', d.saved);
        else {
          await call('DELETE', `/catalog/saved?${new URLSearchParams({ platform: d.ref.platform, kind: d.ref.kind, id: d.ref.id })}`);
          tombs = tombs.filter((t) => savedKey(t) !== k);
          await saveTombs();
        }
      } catch (err) {
        if (!(err instanceof Problem) || err.offline) retryLater();
      }
    })();
  });
  window.addEventListener('online', () => void sync());

  /* -------------------------------------------------------- the API */

  const api: HubShelf = {
    status: () => ({ paired: !!acct, hubName: hubName(), playlists: has('playlists:use'), sync: has('library:sync'), noScope: noPlaylistsWhy(hubName()) }),
    paint,
    run(act, el, subject) {
      const h = subject.list?.hub;
      if (act === 'hub-why') return say(el?.dataset['why'] ?? NO_PLAYLISTS_SHORT);
      if (act === 'hub-file' && el && subject.song) return void file(el.dataset['hpl'] ?? '', el.dataset['name'] ?? '', subject.song, el.getAttribute('aria-checked') === 'true');
      if (act === 'hub-new' && subject.song) return void createWith(subject.song);
      if (!h) return;
      if (!h.editable && act !== 'hub-why') return say(h.why ?? 'Read-only here');
      if (act === 'hub-rename') return void rename(h);
      if (act === 'hub-delete') return void remove(h);
      if ((act === 'hub-up' || act === 'hub-down') && subject.row) return void move(h, subject.row.id, act === 'hub-up' ? -1 : 1);
    },
    listMenu,
    playlists: () => lists,
    shared: () => shared.slice(),
    refresh,
    open,
    streamable(id) {
      const r = rows.get(id);
      if (!r || r.entry.locationKind !== 'library' || !r.entry.trackId) return null;
      return { trackId: r.entry.trackId, title: r.entry.title, artist: r.entry.artist, durationMs: r.entry.durationSec ? r.entry.durationSec * 1000 : null };
    },
    async streamUrl(trackId) {
      try {
        const signed = await call<{ items: Array<{ trackId: string; url: string }> }>('POST', '/library/stream-urls', { trackIds: [trackId] });
        const url = webUrl(signed.items.find((i) => i.trackId === trackId)?.url);
        return url ? { url } : { reason: `${hubName()} has no stream for that song.` };
      } catch (err) {
        return { reason: err instanceof Error ? err.message : `${hubName()} could not stream it.` };
      }
    },
    moveSelected(list, row, by) {
      const h = list?.hub;
      if (!h || !row || !rows.has(row.id)) return false;
      if (!h.editable) {
        say(h.why ?? 'Read-only here');
        return true;
      }
      void move(h, row.id, by);
      return true;
    },
    sync,
  };
  w.NP_HUB_SHELF = api;
  void reload().then(() => {
    refresh();
    void sync();
  });
  return api;
}

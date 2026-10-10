/**
 * Search: the music catalog in the companion's window (DEC-039; rules UX-SEARCH-001…012, UX-CAT-001…006).
 *
 * The same search the hub's Search tab is, with the same rules, on this PC: one field finds songs,
 * artists, albums and playlists across iTunes, Deezer, MusicBrainz, YouTube and SoundCloud, or reads
 * a pasted link from any platform, Spotify included. The answers stream in from the embedded helper
 * (through the main process, `catalog.ts`) and are folded by id.
 *
 * The owner's shape (2026-10-07, the player's NP-FIND-003…010 carried here): one centred column
 * under the field (UX-SEARCH-011). After a search, a calm overview — Songs (five), Artists, Albums
 * and Playlists (three each), each with "See all N", the services' line under them, and no pager
 * (UX-SEARCH-007). "See all" opens one type's own page — its field, the segmented control, the
 * services' line and a list that scrolls on by itself while ‹ › and "Page N of M" move it a page at
 * a time (UX-SEARCH-009). Playlists are a type, the starred ones first (UX-SEARCH-010). Every song
 * row has a "…" (and a right-click) menu (UX-SEARCH-012): Add to Up Next (the companion has no queue
 * of its own, so a paired hub's group), Add to Playlist and Add to Library (this PC's library,
 * through the helper's download path), Download…, Audition and Open Details. Opening a row stacks a
 * page with Back (Escape); an album or a playlist has a star that keeps it in this PC's library; a
 * song shows genre, label, year and lyrics, and downloads through the helper as every download on
 * this PC does. The behaviour both apps share is `@now-playing/domain/catalog` (view.ts); this file
 * is the hub's view with the companion's kit (`search-kit.tsx`, DEC-026) and transport.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { CatalogAlbum, CatalogAlbumDetail, CatalogArtist, CatalogArtistDetail, CatalogCollection, CatalogEnrichment, CatalogLyrics, CatalogPlaylist, CatalogResolveResult, CatalogSearchSection, CatalogSource, CatalogSourceStatus, CatalogTrack, DownloadAuthorizationBasis, FolderPlaylistSummary, OutputFormat, SavedCollection } from '@now-playing/contracts';
import { CATALOG_COLLECTION_CAP, CATALOG_PROVIDERS } from '@now-playing/contracts';
import {
  albumLine,
  appendPage,
  appendTracks,
  byRank,
  CATALOG_PROVIDER_LABELS,
  CATALOG_SEARCH_SECTION_LABELS,
  collapseFields,
  collectionLine,
  coverArt,
  creditLine,
  EMPTY_FIELDS,
  EMPTY_RESULTS,
    foldCatalogChunk,
  formatDuration,
  hasQuery,
  OVERVIEW_ROWS,
  parseLrc,
  pickDownloadSource,
  platformLabel,
  platformsOf,
  playlistLine,
  PLAYS_FROM_SPOTDL,
  playsThroughSpotdl,
  previewOf,
  savedCollectionOf,
  savedMatching,
  SEARCH_TYPES,
  seeAllText,
  sectionPages,
  sourceDot,
  sourceStateText,
  statusSummary,
  thatsAllText,
  TYPE_PAGE_ROWS,
  typeCount,
  type CatalogFields,
  type CatalogResults,
} from '@now-playing/domain/catalog';
import { invoke } from '../bridge.js';
import { ALL_SECTIONS, catalogError, companionCatalog, useCatalogFilter, useLiveSearch, usePreview, useSavedCollections, type CatalogClient, type CatalogFilter, type CatalogSearchParams, type LiveSearch, type Preview, type SavedCollections } from '../catalog.js';
import { Menu, type MenuAt, type MenuEntry } from '../menu.js';
import { useLongPress } from '../long-press.js';
import { companionPlaylists } from '../playlists.js';
import { ActionError, Check, errorSentence, Field, Group, Note, Pop, Push, Sdot, Sheet, SearchUiProvider, useNow, useSearchUi } from '../search-kit.js';
import type { HubGroupChoice } from '../../shared/ipc.js';

/** Why this download is allowed: the same bases the hub and the helper record (DownloadAuthorizationBasis). */
const BASIS_LABELS: Record<string, string> = {
  'user-owned': 'I own it',
  'creator-download': 'The artist allows downloads',
  'purchased-export': 'Exported from a purchase',
  'public-domain': 'Public domain',
  licensed: 'Licensed',
};

/** Rows an album, a playlist or an artist's albums ask for at a time. */
const LIST_PAGE = 50;
/** The services page a search to this offset at most (the contract's bound). */
const OFFSET_MAX = 1000;

type Row = CatalogTrack | CatalogArtist | CatalogAlbum | CatalogPlaylist;

type Page =
  | { kind: 'results' }
  /** A type's own page: `seed` starts it from the overview's rows; `focus` says what takes the keys. */
  | { kind: 'type'; section: CatalogSearchSection; fields: CatalogFields; seed: boolean; n: number; focus?: 'tab' | 'field' }
  | { kind: 'album'; album: CatalogAlbum }
  | { kind: 'artist'; artist: CatalogArtist }
  | { kind: 'song'; track: CatalogTrack }
  | { kind: 'list'; url: string; first: CatalogResolveResult | null; title: string };

function pageTitle(page: Page): string {
  switch (page.kind) {
    case 'results':
      return 'Results';
    case 'type':
      return CATALOG_SEARCH_SECTION_LABELS[page.section];
    case 'album':
      return page.album.title;
    case 'artist':
      return page.artist.name;
    case 'song':
      return page.track.title;
    case 'list':
      return page.title;
  }
}

/** An album row opens its detail by `platform:id` where the catalog has one, else by resolving its link. */
function albumPage(album: CatalogAlbum): Page {
  if (/^(deezer|apple-music):/.test(album.id)) return { kind: 'album', album };
  return { kind: 'list', url: album.sources[0]!.url, first: null, title: album.title };
}

/** A playlist opens like an album: its link resolved, page by page (UX-SEARCH-004, UX-SEARCH-010). */
function playlistPage(playlist: CatalogPlaylist): Page {
  return { kind: 'list', url: playlist.sources[0]!.url, first: null, title: playlist.title };
}

function rowsOf(results: CatalogResults, section: CatalogSearchSection): Row[] {
  return section === 'tracks' ? byRank(results.tracks) : byRank<Row>(results[section]);
}

function sameFields(a: CatalogFields, b: CatalogFields): boolean {
  return a.q === b.q && a.track === b.track && a.artist === b.artist && a.album === b.album;
}

/** Opens a song row's menu; given to every list of songs through context (UX-SEARCH-012). */
type OpenSongMenu = (track: CatalogTrack, at: MenuAt, returnTo: HTMLElement | null) => void;
const SongMenuContext = createContext<OpenSongMenu | null>(null);

/* ------------------------------------------------------------------ the tab */

/** The Search tool: its pane, with the tool's own status line and sheet. */
/** `initialQuery`: a search to run as the tool opens (the style guide's specimen). */
export function SearchView({ client = companionCatalog, initialQuery }: { client?: CatalogClient; initialQuery?: string }) {
  return (
    <SearchUiProvider>
      <SearchPane client={client} {...(initialQuery ? { initialQuery } : {})} />
    </SearchUiProvider>
  );
}

function SearchPane({ client, initialQuery }: { client: CatalogClient; initialQuery?: string }) {
  const [fields, setFields] = useState<CatalogFields>(() => ({ ...EMPTY_FIELDS, q: initialQuery ?? '' }));
  const [advanced, setAdvanced] = useState(false);
  const [filter, setFilter] = useCatalogFilter();
  const live = useLiveSearch(client);
  const preview = usePreview();
  const saved = useSavedCollections();
  const { present, say } = useSearchUi();
  const [stack, setStack] = useState<Page[]>([{ kind: 'results' }]);
  const heading = useRef<HTMLHeadingElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const pages = useRef(0);

  const page = stack[stack.length - 1]!;
  const open = useCallback((next: Page) => setStack((s) => [...s, next]), []);
  const replace = useCallback((next: Page) => setStack((s) => [...s.slice(0, -1), next]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const seeAll = useCallback((section: CatalogSearchSection, words: CatalogFields) => open({ kind: 'type', section, fields: words, seed: true, n: (pages.current += 1) }), [open]);

  // A page that opens takes the focus to its heading, so a screen reader hears where it is; a type
  // switched or searched from its own page keeps the keys where they were.
  const depth = stack.length;
  useEffect(() => {
    if (depth > 1 && !(page.kind === 'type' && page.focus)) heading.current?.focus();
  }, [depth, page]);

  const search = (params: Omit<CatalogSearchParams, 'sections' | 'providers'>, using: CatalogFilter = filter): void => {
    preview.stop();
    setStack([{ kind: 'results' }]);
    live.run({ ...params, sections: using.sections, providers: using.providers });
  };

  // Started from a microtask: the first render has drawn the field, and the search sets state as it goes.
  const started = useRef(false);
  const latestSearch = useRef(search);
  useEffect(() => {
    latestSearch.current = search;
  });
  useEffect(() => {
    if (started.current || !initialQuery?.trim()) return;
    started.current = true;
    queueMicrotask(() => latestSearch.current({ fields: { ...EMPTY_FIELDS, q: initialQuery } }));
  }, [initialQuery]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!hasQuery(fields)) return;
    search({ fields });
  };

  const toggleAdvanced = (): void => {
    // Put away, the fields fold back into the line so nothing typed is lost (UX-SEARCH-001).
    if (advanced) setFields(collapseFields(fields));
    setAdvanced(!advanced);
  };

  const openFilter = (): void => {
    present(
      <FilterSheet
        filter={filter}
        onCancel={() => present(null)}
        onDone={(next) => {
          present(null);
          setFilter(next);
          if (live.asked) search({ fields: live.asked.fields }, next);
        }}
      />,
    );
  };

  const songMenu = useSongMenu({ preview, present, say, open });

  const now = useNow(5_000);
  const { results } = live;
  const summary = live.error ? errorSentence(live.error) : statusSummary(results.status, Boolean(results.done) && !live.running, results.done?.totals);
  const filtered = filter.sections.length < ALL_SECTIONS.length || filter.providers.length < CATALOG_PROVIDERS.length;

  // Escape walks back a page, then puts the results away (UX-SEARCH-008); never from a field being typed in.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.target instanceof HTMLInputElement) return;
    if (stack.length > 1) {
      event.preventDefault();
      back();
    } else if (live.asked) {
      event.preventDefault();
      preview.stop();
      live.clear();
      field.current?.focus();
    }
  };

  return (
    <SongMenuContext.Provider value={songMenu.open}>
      {/* Escape belongs to the column as a whole, the way it does to the player's card. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div className="srch" onKeyDown={onKeyDown}>
        <Group title="Find music" hint="Songs, artists, albums and playlists from iTunes, Deezer, MusicBrainz, YouTube and SoundCloud — or paste a link from any of them, Spotify included." className="srch__find">
          <form className="barrow srch__bar" role="search" aria-label="Music" onSubmit={submit} noValidate>
            <Field
              ref={field}
              type="search"
              className="srch__q"
              aria-label="Search for music"
              placeholder="A song, an artist, an album, an ISRC or a link"
              value={fields.q}
              onChange={(event) => setFields({ ...fields, q: event.currentTarget.value })}
            />
            <Push type="submit" primary disabled={!hasQuery(fields)} reason="Type what to look for first.">
              Search
            </Push>
            <Push aria-expanded={advanced} aria-controls="srch-fields" onClick={toggleAdvanced}>
              Track, Artist, Album
            </Push>
            <Push onClick={openFilter} aria-describedby={filtered ? 'srch-filtered' : undefined}>
              Filter…
            </Push>
          </form>
          {advanced ? (
            <div className="pref srch__fields" id="srch-fields">
              {(['track', 'artist', 'album'] as const).map((key) => (
                <FieldRow key={key} label={{ track: 'Track:', artist: 'Artist:', album: 'Album:' }[key]} value={fields[key]} onChange={(value) => setFields({ ...fields, [key]: value })} onEnter={() => hasQuery(fields) && search({ fields })} />
              ))}
            </div>
          ) : null}
          {filtered ? (
            <p className="note" id="srch-filtered">
              Showing {filter.sections.map((s) => CATALOG_SEARCH_SECTION_LABELS[s]).join(', ')} from {filter.providers.length === CATALOG_PROVIDERS.length ? 'every service' : filter.providers.map((p) => CATALOG_PROVIDER_LABELS[p]).join(', ')}.
            </p>
          ) : null}
          <p className="sr" role="status" aria-live="polite">
            {summary}
          </p>
          {live.error ? <Note bad>{errorSentence(live.error)}</Note> : null}
        </Group>

        {page.kind === 'results' ? (
          <Overview results={results} running={live.running} asked={live.asked} filter={filter} client={client} preview={preview} open={open} seeAll={seeAll} now={now} />
        ) : (
          <section className="srch__page" aria-labelledby="srch-page-h">
            <div className="barrow barrow--above srch__nav">
              <Push onClick={back} aria-label={`Back to ${pageTitle(stack[stack.length - 2]!)}`}>
                ‹ Back
              </Push>
              <h2 id="srch-page-h" className="srch__h" tabIndex={-1} ref={heading}>
                {pageTitle(page)}
              </h2>
            </div>
            <div>
              {page.kind === 'type' ? <TypePage key={`type-${page.n}`} page={page} live={live} filter={filter} client={client} preview={preview} saved={saved} open={open} replace={replace} now={now} next={() => (pages.current += 1)} /> : null}
              {page.kind === 'album' ? <AlbumPage key={`album-${page.album.id}`} album={page.album} client={client} preview={preview} saved={saved} open={open} say={say} /> : null}
              {page.kind === 'artist' ? <ArtistPage key={`artist-${page.artist.id}`} artist={page.artist} client={client} preview={preview} open={open} /> : null}
              {page.kind === 'song' ? <SongPage key={`song-${page.track.id}`} track={page.track} client={client} preview={preview} say={say} /> : null}
              {page.kind === 'list' ? <ListPage key={`list-${page.url}`} url={page.url} first={page.first} client={client} preview={preview} saved={saved} open={open} say={say} /> : null}
            </div>
          </section>
        )}
        {songMenu.menu}
      </div>
    </SongMenuContext.Provider>
  );
}

function FieldRow({ label, value, onChange, onEnter }: { label: string; value: string; onChange: (value: string) => void; onEnter: () => void }) {
  const id = useId();
  return (
    <>
      <label className="k" htmlFor={id}>
        {label}
      </label>
      <div className="v">
        <Field
          id={id}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onEnter();
            }
          }}
        />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ the filter sheet */

function FilterSheet({ filter, onDone, onCancel }: { filter: CatalogFilter; onDone: (next: CatalogFilter) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<CatalogFilter>(filter);
  const flip = <K extends keyof CatalogFilter>(key: K, value: CatalogFilter[K][number], on: boolean): void => {
    const list = draft[key] as string[];
    setDraft({ ...draft, [key]: on ? [...list, value].filter((v, i, all) => all.indexOf(v) === i) : list.filter((v) => v !== value) });
  };
  const reason = !draft.sections.length ? 'Show at least one kind of result.' : !draft.providers.length ? 'Ask at least one service.' : null;
  // Kept in the order the window shows them, whatever order they were ticked in.
  const ordered = (next: CatalogFilter): CatalogFilter => ({ sections: ALL_SECTIONS.filter((s) => next.sections.includes(s)), providers: CATALOG_PROVIDERS.filter((p) => next.providers.includes(p)) });
  return (
    <Sheet title="Filter the search" onCancel={onCancel}>
      <p>Kept on this PC. Changing it searches again.</p>
      <div className="srch__filter">
        <fieldset>
          <legend>Show</legend>
          {ALL_SECTIONS.map((s) => (
            <Check key={s} checked={draft.sections.includes(s)} onChange={(on) => flip('sections', s, on)}>
              {CATALOG_SEARCH_SECTION_LABELS[s]}
            </Check>
          ))}
        </fieldset>
        <fieldset>
          <legend>Ask</legend>
          {CATALOG_PROVIDERS.map((p) => (
            <Check key={p} checked={draft.providers.includes(p)} onChange={(on) => flip('providers', p, on)}>
              {CATALOG_PROVIDER_LABELS[p]}
            </Check>
          ))}
        </fieldset>
      </div>
      {reason ? <Note bad>{reason}</Note> : null}
      <div className="sheet__acts">
        <Push onClick={onCancel}>Cancel</Push>
        <Push primary disabled={Boolean(reason)} reason={reason} onClick={() => onDone(ordered(draft))}>
          Done
        </Push>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ the services' line */

/** Every service with its lamp and its state in words, and the platforms that only gave links (UX-SEARCH-002). */
function ServiceLine({ status, linkedOnly, now }: { status: readonly CatalogSourceStatus[]; linkedOnly: readonly CatalogSource['platform'][] | undefined; now: number }) {
  if (!status.length) return null;
  return (
    <div className="srch__services">
      <ul className="srcs" aria-label="Services asked">
        {status.map((s) => (
          <li key={s.provider} title={s.error ?? undefined}>
            <Sdot kind={sourceDot(s.state)} inline />
            <b>{CATALOG_PROVIDER_LABELS[s.provider]}</b> <span className="srcs__state">{sourceStateText(s, now)}</span>
            {s.error ? <span className="sr">: {s.error}</span> : null}
          </li>
        ))}
      </ul>
      {linkedOnly?.length ? <p className="note srcs__links">Linked, not searched: {linkedOnly.map(platformLabel).join(', ')}.</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ the overview */

/**
 * The calm overview (UX-SEARCH-007): a few of each kind, "See all N" into each type's own page, the
 * services' line under them, and no pager. Rows still fold in by id as each service answers.
 */
function Overview({ results, running, asked, filter, client, preview, open, seeAll, now }: { results: CatalogResults; running: boolean; asked: CatalogSearchParams | null; filter: CatalogFilter; client: CatalogClient; preview: Preview; open: (page: Page) => void; seeAll: (section: CatalogSearchSection, fields: CatalogFields) => void; now: number }) {
  const link = results.done?.resolve ?? null;
  if (!asked) return null;
  if (link) return <LinkResult key={link} url={link} client={client} preview={preview} open={open} />;
  const shown = filter.sections.filter((s) => results.done === null || results.done.page[s] !== null || results[s].length > 0);
  return (
    <>
      {shown.map((section) => {
        const rows = rowsOf(results, section);
        const more = Boolean(results.done?.page[section]?.hasMore);
        const few = rows.slice(0, OVERVIEW_ROWS[section]);
        const empty = running && !rows.length ? 'Asking…' : `No ${CATALOG_SEARCH_SECTION_LABELS[section].toLowerCase()}.`;
        const label = CATALOG_SEARCH_SECTION_LABELS[section];
        return (
          <Group key={section} title={label}>
            <RowList section={section} label={label} rows={few} preview={preview} open={open} empty={empty} />
            {rows.length ? (
              <div className="barrow srch__seeall">
                <Push onClick={() => seeAll(section, asked.fields)}>{seeAllText(section, rows.length, more)}</Push>
              </div>
            ) : null}
          </Group>
        );
      })}
      <ServiceLine status={results.status} linkedOnly={results.done?.linkedOnly} now={now} />
    </>
  );
}

/** A list of one kind of row: songs, artists, albums or playlists. */
function RowList({ section, label, rows, preview, open, empty, pageSize, focusRequest, onPageKey, onActive }: { section: CatalogSearchSection; label: string; rows: readonly Row[]; preview: Preview; open: (page: Page) => void; empty: string; pageSize?: number; focusRequest?: FocusRequest | null; onPageKey?: (step: 1 | -1, index: number) => void; onActive?: (index: number) => void }) {
  const paging = { ...(pageSize ? { pageSize } : {}), ...(focusRequest ? { focusRequest } : {}), ...(onPageKey ? { onPageKey } : {}), ...(onActive ? { onActive } : {}) };
  if (section === 'tracks') return <TrackList label={label} tracks={rows as CatalogTrack[]} preview={preview} onOpen={(t) => open({ kind: 'song', track: t })} empty={empty} {...paging} />;
  if (section === 'artists') return <ArtistList label={label} artists={rows as CatalogArtist[]} onOpen={(a) => open({ kind: 'artist', artist: a })} empty={empty} {...paging} />;
  if (section === 'albums') return <AlbumList label={label} albums={rows as CatalogAlbum[]} onOpen={(a) => open(albumPage(a))} empty={empty} {...paging} />;
  return <PlaylistList label={label} playlists={rows as CatalogPlaylist[]} onOpen={(p) => open(playlistPage(p))} empty={empty} {...paging} />;
}

/** A pasted link: resolved, not searched (UX-CAT-003, UX-SEARCH-004). */
function LinkResult({ url, client, preview, open }: { url: string; client: CatalogClient; preview: Preview; open: (page: Page) => void }) {
  const [result, setResult] = useState<CatalogResolveResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        setResult(await client.resolve(url, 0, LIST_PAGE, controller.signal));
      } catch (err) {
        if (!controller.signal.aborted) setError(catalogError(err));
      }
    };
    void load();
    return () => controller.abort();
  }, [client, url]);

  return (
    <Group title="From the link" hint={<span className="path">{url}</span>}>
      {error ? <Note bad>{errorSentence(error)}</Note> : null}
      {!result && !error ? <Note>Reading the link…</Note> : null}
      {result?.kind === 'track' && result.track ? <TrackList label="The song" tracks={[result.track]} preview={preview} onOpen={(t) => open({ kind: 'song', track: t })} empty="" /> : null}
      {(result?.kind === 'album' || result?.kind === 'playlist' || result?.kind === 'artist') && result.collection ? (
        <CollectionList label={result.kind === 'artist' ? 'The artist' : `The ${result.kind}`} collections={[result.collection]} onOpen={(c) => open({ kind: 'list', url, first: result, title: result.artist?.name ?? c.ref.title })} />
      ) : null}
      {result?.kind === 'unavailable' || result?.kind === 'unsupported' ? <Note bad>{result.reason ?? 'That link can’t be read.'}</Note> : null}
    </Group>
  );
}

/* ------------------------------------------------------------------ a type's own page */

interface FocusRequest {
  index: number;
  n: number;
}

/**
 * One type's page (UX-SEARCH-009): its own field and the segmented control over the services' line
 * and the list. The list scrolls on by itself — near its end, or when the keys reach its last rows,
 * the next offset is asked for — and the footer's ‹ › (or Page Up/Down) move a page at a time,
 * fetching that page first when it has not arrived, landing on its first row with the keys on it.
 * The count follows the scroll. Pages are 25 songs, or 12 artists, albums or playlists.
 */
function TypePage({ page, live, filter, client, preview, saved, open, replace, now, next }: { page: Extract<Page, { kind: 'type' }>; live: LiveSearch; filter: CatalogFilter; client: CatalogClient; preview: Preview; saved: SavedCollections; open: (page: Page) => void; replace: (page: Page) => void; now: number; next: () => number }) {
  const { section, fields } = page;
  const size = TYPE_PAGE_ROWS[section];
  const label = CATALOG_SEARCH_SECTION_LABELS[section];
  const noun = label.toLowerCase();
  const words = collapseFields(fields).q;
  // Seeded from the overview only when it has finished answering the same words; else a search of its own.
  const seeded = page.seed && live.asked !== null && !live.running && sameFields(live.asked.fields, fields) && live.asked.sections.includes(section);
  const base = useMemo<CatalogSearchParams>(() => ({ fields, sections: [section], providers: filter.providers }), [fields, filter.providers, section]);

  const [rows, setRows] = useState<Row[]>(() => (seeded ? rowsOf(live.results, section) : []));
  const [status, setStatus] = useState<CatalogSourceStatus[]>(() => (seeded ? live.results.status : []));
  const [linkedOnly, setLinkedOnly] = useState(() => (seeded ? live.results.done?.linkedOnly : undefined));
  const [more, setMore] = useState(() => (seeded ? Boolean(live.results.done?.page[section]?.hasMore) : false));
  const [running, setRunning] = useState(!seeded);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [shownPage, setShownPage] = useState(0);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [typed, setTyped] = useState(words);

  // Where the next ask starts and how big a step is: the overview's page, or this page's own.
  const cursor = useRef({ offset: seeded ? (live.asked?.offset ?? 0) : 0, step: seeded ? (live.asked?.limit ?? 25) : size });
  // What the async paging reads: kept in step with every change of the rows, not a render later.
  const latest = useRef({ rows, more });
  const inFlight = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const append = useCallback(
    (found: CatalogResults) => {
      const fresh = rowsOf(found, section);
      const current = latest.current.rows;
      const after = section === 'tracks' ? appendTracks(current as CatalogTrack[], fresh as CatalogTrack[]) : appendPage(current, fresh);
      latest.current.rows = after;
      setRows(after);
    },
    [section],
  );

  /** The next offset of this type alone, once at a time; a second ask waits for the first. */
  const fetchMore = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    if (!latest.current.more) return Promise.resolve();
    const offset = cursor.current.offset + cursor.current.step;
    if (offset > OFFSET_MAX) {
      setMore(false);
      return Promise.resolve();
    }
    setBusy(true);
    setError(null);
    let found: CatalogResults = EMPTY_RESULTS;
    const work = client
      .search({ ...base, offset, limit: cursor.current.step }, (chunk) => (found = foldCatalogChunk(found, chunk)), new AbortController().signal)
      .then(() => {
        if (!alive.current) return;
        append(found);
        cursor.current.offset = offset;
        const after = Boolean(found.done?.page[section]?.hasMore) && offset + cursor.current.step <= OFFSET_MAX;
        latest.current.more = after;
        setMore(after);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        setError(catalogError(err));
        latest.current.more = false;
        setMore(false);
      })
      .finally(() => {
        inFlight.current = null;
        if (alive.current) setBusy(false);
      });
    inFlight.current = work;
    return work;
  }, [append, base, client, section]);

  // A search of its own (the type's field, the control), or — seeded — the next page at once.
  useEffect(() => {
    if (seeded) {
      if (latest.current.more) void fetchMore();
      return undefined;
    }
    const controller = new AbortController();
    let found: CatalogResults = EMPTY_RESULTS;
    client
      .search(
        { ...base, offset: 0, limit: size },
        (chunk) => {
          found = foldCatalogChunk(found, chunk);
          latest.current.rows = rowsOf(found, section);
          setRows(latest.current.rows);
          setStatus(found.status);
          if (found.done) {
            setLinkedOnly(found.done.linkedOnly);
            const after = Boolean(found.done.page[section]?.hasMore);
            latest.current.more = after;
            setMore(after);
          }
        },
        controller.signal,
      )
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(catalogError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setRunning(false);
      });
    return () => controller.abort();
    // Once, as the page opens: its words and type are fixed for its life (a new search is a new page).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Page `target` (0-based): fetched first while it has not arrived, then its first row takes the keys. */
  const goTo = useCallback(
    async (target: number): Promise<void> => {
      if (target < 0) return;
      let have = latest.current.rows.length;
      while (target * size >= have && latest.current.more) {
        await fetchMore();
        if (latest.current.rows.length === have) break;
        have = latest.current.rows.length;
      }
      const last = Math.max(0, Math.ceil(latest.current.rows.length / size) - 1);
      const to = Math.min(target, last);
      setShownPage(to);
      setFocusRequest({ index: to * size, n: Date.now() });
    },
    [fetchMore, size],
  );

  // The count follows the scroll: the page of the first row in view; at the very end, the last one.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pane = box.current?.closest('.pane');
    if (!pane) return undefined;
    let frame = 0;
    const follow = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const items = box.current ? Array.from(box.current.querySelectorAll<HTMLElement>('[role="tabpanel"] [data-index]')) : [];
        if (!items.length) return;
        const top = pane.getBoundingClientRect().top;
        if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) return setShownPage(Math.ceil(items.length / size) - 1);
        const first = items.findIndex((el) => el.getBoundingClientRect().bottom > top + 4);
        if (first >= 0) setShownPage(Math.floor(first / size));
      });
    };
    pane.addEventListener('scroll', follow, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      pane.removeEventListener('scroll', follow);
    };
  }, [size]);

  // Infinite scroll: the end of the list coming near asks for the next page.
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = end.current;
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void fetchMore();
    }, { root: node.closest('.pane'), rootMargin: '240px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchMore]);

  // What takes the keys as the page opens: the control or the field, when the page was made from them.
  const tabs = useRef<HTMLDivElement>(null);
  const typeField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (page.focus === 'tab') tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    if (page.focus === 'field') typeField.current?.focus();
  }, [page.focus]);

  const state = sectionPages(rows.length, size, shownPage, more);
  const tabId = useId();
  const panelId = useId();
  const kept = section === 'playlists' ? savedMatching(saved.items, 'playlist', words) : [];

  const switchTo = (to: CatalogSearchSection): void => {
    if (to !== section) replace({ kind: 'type', section: to, fields: { ...EMPTY_FIELDS, q: words }, seed: false, n: next(), focus: 'tab' });
  };
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = SEARCH_TYPES.indexOf(section);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: SEARCH_TYPES.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    switchTo(SEARCH_TYPES[(to + SEARCH_TYPES.length) % SEARCH_TYPES.length]!);
  };
  const searchType = (event: FormEvent): void => {
    event.preventDefault();
    if (!typed.trim()) return;
    replace({ kind: 'type', section, fields: { ...EMPTY_FIELDS, q: typed.trim() }, seed: false, n: next(), focus: 'field' });
  };

  return (
    <div className="srch__type" ref={box}>
      <p className="srch__sub">
        {running && !rows.length ? `Asking for ${noun}…` : `${typeCount(section, rows.length, more)} for “${words}”`}
      </p>
      <form className="barrow srch__typebar" role="search" aria-label={`Search ${noun}`} onSubmit={searchType} noValidate>
        <Field
          ref={typeField}
          type="search"
          className="srch__q"
          aria-label={`Search ${noun}`}
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Page Up/Down turn the list's pages from the field too.
            if (event.key === 'PageDown' || event.key === 'PageUp') {
              event.preventDefault();
              void goTo(state.page + (event.key === 'PageDown' ? 1 : -1));
            }
          }}
        />
        <Push type="submit" aria-label={`Search ${label}`} disabled={!typed.trim()} reason="Type what to look for first.">
          Search
        </Push>
      </form>
      {/* The arrows move along the control, as along any tab list. */}
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus */}
      <div className="seg srch__seg" role="tablist" aria-label="Kind of music" ref={tabs} onKeyDown={onTabKey}>
        {SEARCH_TYPES.map((t) => (
          <button key={t} type="button" role="tab" className="seg__btn" id={t === section ? tabId : undefined} aria-selected={t === section} aria-controls={t === section ? panelId : undefined} tabIndex={t === section ? 0 : -1} onClick={() => switchTo(t)}>
            {CATALOG_SEARCH_SECTION_LABELS[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={tabId}>
        <ServiceLine status={status} linkedOnly={linkedOnly} now={now} />
        {kept.length ? (
          <>
            <h3 className="srch__subh">In your library</h3>
            <SavedList label="Your playlists" items={kept} onOpen={(s) => open({ kind: 'list', url: s.ref.url, first: null, title: s.ref.title })} />
            <h3 className="srch__subh">From the catalog</h3>
          </>
        ) : null}
        <RowList
          section={section}
          label={kept.length ? `${label} from the catalog` : `All ${noun}`}
          rows={rows}
          preview={preview}
          open={open}
          empty={running ? 'Asking…' : `No ${noun} for “${words}”.`}
          pageSize={size}
          focusRequest={focusRequest}
          onPageKey={(step, index) => void goTo(Math.floor(index / size) + step)}
          onActive={(index) => {
            setShownPage(Math.floor(index / size));
            if (index >= latest.current.rows.length - 3) void fetchMore();
          }}
        />
        <ActionError error={error} />
        <div className="srch__end" ref={end}>
          {busy ? <Note>Loading more…</Note> : !more && rows.length && !running ? <Note>{thatsAllText(section, rows.length)}</Note> : null}
        </div>
        <nav className="srch__foot" aria-label={`${label} pages`}>
          <Push className="srch__step" disabled={!state.canPrev} onClick={() => void goTo(state.page - 1)} aria-label={`Previous page of ${noun}`}>
            ‹
          </Push>
          <span className="srch__pageof" aria-live="polite">
            {state.label}
          </span>
          <Push className="srch__step" disabled={!state.canNext || busy} onClick={() => void goTo(state.page + 1)} aria-label={`Next page of ${noun}`}>
            ›
          </Push>
        </nav>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ album, playlist, artist */

/** The heading of a list or a song: its cover (or mosaic), what it is, and its platforms. */
function DetailHead({ art, title, lines, sources, star }: { art: ReactNode; title: string; lines: Array<ReactNode | null>; sources: readonly CatalogSource[]; star?: ReactNode }) {
  return (
    <div className="mhead">
      {art}
      <div className="mhead__text">
        <b className="mhead__title">{title}</b>
        {lines.filter(Boolean).map((line, i) => (
          <span key={i} className="mhead__line">
            {line}
          </span>
        ))}
        <Platforms sources={sources} />
        {star ? <div className="barrow">{star}</div> : null}
      </div>
    </div>
  );
}

function Star({ collection, saved, say }: { collection: CatalogCollection; saved: SavedCollections; say: (text: string) => void }) {
  const on = saved.isSaved(collection.ref);
  const kind = collection.ref.kind === 'album' ? 'album' : 'playlist';
  return (
    <>
      <Push
        className="star"
        aria-pressed={on}
        busy={saved.busy}
        onClick={() =>
          void saved.toggle(savedCollectionOf(collection, new Date().toISOString())).then((ok) => {
            if (ok) say(on ? `“${collection.ref.title}” is no longer in your library.` : `“${collection.ref.title}” is in your library.`);
          })
        }
      >
        <span aria-hidden="true">{on ? '★' : '☆'}</span> {on ? `Starred ${kind}` : `Star this ${kind}`}
      </Push>
      <ActionError error={saved.error} />
    </>
  );
}

/** Infinite scroll: the next page loads as this comes into view, and the button does the same by hand. */
function MoreRows({ label, busy, onMore }: { label: string; busy: boolean; onMore: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ onMore, busy });
  useEffect(() => {
    latest.current = { onMore, busy };
  }, [onMore, busy]);
  useEffect(() => {
    const node = box.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !latest.current.busy) latest.current.onMore();
    }, { root: node.closest('.pane'), rootMargin: '160px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="barrow" ref={box}>
      <Push busy={busy} onClick={onMore}>
        {label}
      </Push>
    </div>
  );
}

/** Busy while a further page loads: set from the event that asked, never from an effect. */
function busyWhile(setBusy: (on: boolean) => void, work: Promise<void>): void {
  setBusy(true);
  void work.finally(() => setBusy(false));
}

function AlbumPage({ album, client, preview, saved, open, say }: { album: CatalogAlbum; client: CatalogClient; preview: Preview; saved: SavedCollections; open: (page: Page) => void; say: (text: string) => void }) {
  const [detail, setDetail] = useState<{ album: CatalogAlbum; collection: CatalogCollection | null; tracks: CatalogTrack[]; total: number | null; hasMore: boolean; capped: boolean } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((answer: CatalogAlbumDetail) => {
    const collection: CatalogCollection = { ref: answer.collection, artworkUrl: answer.album.artworkUrl, covers: answer.album.artworkUrl ? [answer.album.artworkUrl] : [], releaseDate: null, page: answer.page };
    setDetail((current) => ({ album: answer.album, collection, tracks: appendPage(current?.tracks ?? [], answer.page.tracks), total: answer.page.total, hasMore: answer.page.hasMore, capped: answer.page.capped }));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const first = async (): Promise<void> => {
      try {
        apply(await client.album(album.id, 0, LIST_PAGE, controller.signal));
      } catch (err) {
        if (!controller.signal.aborted) setError(catalogError(err));
      }
    };
    void first();
    return () => controller.abort();
  }, [album.id, apply, client]);
  const load = (offset: number): Promise<void> => client.album(album.id, offset, LIST_PAGE).then(apply, (err: unknown) => setError(catalogError(err)));

  const shown = detail?.album ?? album;
  return (
    <>
      <DetailHead
        art={<Art url={shown.artworkUrl} size="big" />}
        title={shown.title}
        lines={[shown.artist, [shown.label, shown.releaseDate ?? shown.year, detail?.total ?? shown.trackCount ? `${detail?.total ?? shown.trackCount} songs` : null].filter(Boolean).join(' · ') || null]}
        sources={shown.sources}
        star={detail?.collection ? <Star collection={detail.collection} saved={saved} say={say} /> : null}
      />
      {error ? <Note bad>{errorSentence(error)}</Note> : null}
      {detail ? <TrackList label={`Songs on ${shown.title}`} tracks={detail.tracks} preview={preview} numbered onOpen={(t) => open({ kind: 'song', track: t })} empty="This album lists no songs." /> : !error ? <Note>Loading the songs…</Note> : null}
      {detail?.hasMore ? <MoreRows label="More Songs" busy={busy} onMore={() => busyWhile(setBusy, load(detail.tracks.length))} /> : null}
      {detail?.capped ? <Note>Only the first {CATALOG_COLLECTION_CAP} songs of a list can be opened.</Note> : null}
    </>
  );
}

/** An album or playlist read from its link (pasted, a playlist row, or a platform without a detail route). */
function ListPage({ url, first, client, preview, saved, open, say }: { url: string; first: CatalogResolveResult | null; client: CatalogClient; preview: Preview; saved: SavedCollections; open: (page: Page) => void; say: (text: string) => void }) {
  const [result, setResult] = useState<CatalogResolveResult | null>(first);
  const [tracks, setTracks] = useState<CatalogTrack[]>(first?.collection?.page.tracks ?? []);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((answer: CatalogResolveResult, offset: number) => {
    setResult(answer);
    setTracks((current) => appendPage(offset ? current : [], answer.collection?.page.tracks ?? []));
  }, []);
  const haveFirst = first !== null;
  useEffect(() => {
    if (haveFirst) return undefined;
    const controller = new AbortController();
    const read = async (): Promise<void> => {
      try {
        apply(await client.resolve(url, 0, LIST_PAGE, controller.signal), 0);
      } catch (err) {
        if (!controller.signal.aborted) setError(catalogError(err));
      }
    };
    void read();
    return () => controller.abort();
  }, [apply, client, haveFirst, url]);
  const load = (offset: number): Promise<void> => client.resolve(url, offset, LIST_PAGE).then((answer) => apply(answer, offset), (err: unknown) => setError(catalogError(err)));

  const collection = result?.collection ?? null;
  if (result && !collection) return <Note bad>{result.reason ?? 'That link holds no list of songs.'}</Note>;
  return (
    <>
      {collection ? (
        <DetailHead
          art={<CollectionArt collection={collection} size="big" />}
          title={collection.ref.title}
          lines={[collection.ref.owner, collectionLine(collection), collection.releaseDate]}
          sources={[{ platform: collection.ref.platform, id: collection.ref.id, url: collection.ref.url, previewUrl: null, matchedBy: 'link' }]}
          star={result?.kind === 'artist' ? null : <Star collection={collection} saved={saved} say={say} />}
        />
      ) : null}
      {error ? <Note bad>{errorSentence(error)}</Note> : null}
      {collection ? <TrackList label={`Songs in ${collection.ref.title}`} tracks={tracks} preview={preview} numbered onOpen={(t) => open({ kind: 'song', track: t })} empty="This list holds no songs." /> : !error ? <Note>Reading the list…</Note> : null}
      {collection?.page.hasMore ? <MoreRows label="More Songs" busy={busy} onMore={() => busyWhile(setBusy, load(tracks.length))} /> : null}
      {collection?.page.capped ? <Note>Only the first {CATALOG_COLLECTION_CAP} songs of a list can be opened.</Note> : null}
    </>
  );
}

function ArtistPage({ artist, client, preview, open }: { artist: CatalogArtist; client: CatalogClient; preview: Preview; open: (page: Page) => void }) {
  const [detail, setDetail] = useState<CatalogArtistDetail | null>(null);
  const [albums, setAlbums] = useState<CatalogAlbum[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((answer: CatalogArtistDetail, albumsOffset: number) => {
    setDetail(answer);
    setAlbums((current) => appendPage(albumsOffset ? current : [], answer.albums));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const first = async (): Promise<void> => {
      try {
        apply(await client.artist(artist.id, 0, controller.signal), 0);
      } catch (err) {
        if (!controller.signal.aborted) setError(catalogError(err));
      }
    };
    void first();
    return () => controller.abort();
  }, [apply, artist.id, client]);
  const load = (albumsOffset: number): Promise<void> => client.artist(artist.id, albumsOffset).then((answer) => apply(answer, albumsOffset), (err: unknown) => setError(catalogError(err)));

  const shown = detail?.artist ?? artist;
  return (
    <>
      <DetailHead art={<Art url={shown.pictureUrl} size="big" round />} title={shown.name} lines={[[shown.genre, shown.albumCount ? `${shown.albumCount} albums` : null, shown.fans ? `${shown.fans.toLocaleString('en-US')} fans` : null].filter(Boolean).join(' · ') || null]} sources={shown.sources} />
      {error ? <Note bad>{errorSentence(error)}</Note> : null}
      {!detail && !error ? <Note>Loading the artist…</Note> : null}
      {detail ? (
        <>
          <Group title="Top songs">
            <TrackList label={`Top songs by ${shown.name}`} tracks={detail.topTracks} preview={preview} onOpen={(t) => open({ kind: 'song', track: t })} empty="No top songs listed." />
          </Group>
          <Group title="Albums" last>
            <AlbumList label={`Albums by ${shown.name}`} albums={albums} onOpen={(a) => open(albumPage(a))} empty="No albums listed." />
            {detail.albumsPage.hasMore ? <MoreRows label="More Albums" busy={busy} onMore={() => busyWhile(setBusy, load(albums.length))} /> : null}
          </Group>
        </>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ a song */

const FORMATS: ReadonlyArray<{ value: OutputFormat; label: string }> = [
  { value: 'original', label: 'As the site sends it' },
  { value: 'mp3', label: 'MP3' },
  { value: 'aac', label: 'AAC' },
  { value: 'opus', label: 'Opus' },
  { value: 'flac', label: 'FLAC' },
];

/** The bases a person can state for a download from Search. */
const SEARCH_BASES = Object.entries(BASIS_LABELS);

function SongPage({ track, client, preview, say }: { track: CatalogTrack; client: CatalogClient; preview: Preview; say: (text: string) => void }) {
  const [about, setAbout] = useState<CatalogEnrichment | null>(null);
  const [aboutError, setAboutError] = useState<Error | null>(null);
  const [lyrics, setLyrics] = useState<CatalogLyrics | null>(null);
  const [lyricsError, setLyricsError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      // Genre, label and year are looked up for the song that is opened, never for every row.
      const [enriched, words] = await Promise.allSettled([client.enrich(track, controller.signal), client.lyrics(track, controller.signal)]);
      if (controller.signal.aborted) return;
      if (enriched.status === 'fulfilled') setAbout(enriched.value);
      else setAboutError(catalogError(enriched.reason));
      if (words.status === 'fulfilled') setLyrics(words.value);
      else setLyricsError(catalogError(words.reason));
    };
    void load();
    return () => controller.abort();
  }, [client, track]);

  const clip = previewOf(track.sources);
  const genre = about?.genre ?? track.genre;
  const label = about?.label ?? track.label;
  const year = about?.year ?? track.year;
  return (
    <>
      <DetailHead
        art={<Art url={track.artworkUrl} size="big" />}
        title={track.title}
        lines={[creditLine(track), albumLine(track) || null, [formatDuration(track.durationMs), track.bpm ? `${Math.round(track.bpm)} BPM` : null, track.explicit ? 'Explicit' : null].filter(Boolean).join(' · ') || null]}
        sources={track.sources}
        star={
          clip ? (
            <Push aria-pressed={preview.playing === clip.url} onClick={() => preview.toggle(clip.url)}>
              {preview.playing === clip.url ? 'Stop Preview' : `Play Preview (${platformLabel(clip.platform)})`}
            </Push>
          ) : null
        }
      />
      {clip && preview.failed === clip.url ? <Note bad>This preview has expired. Search again for a fresh one.</Note> : null}
      <Group title="About this song">
        <dl className="kv">
          <dt>Genre</dt>
          <dd>{genre ?? (about || aboutError ? '—' : 'Looking it up…')}</dd>
          <dt>Label</dt>
          <dd>{label ?? (about || aboutError ? '—' : 'Looking it up…')}</dd>
          <dt>Year</dt>
          <dd>{year ?? (about || aboutError ? '—' : 'Looking it up…')}</dd>
          {track.isrc ?? about?.isrc ? (
            <>
              <dt>ISRC</dt>
              <dd className="mono">{track.isrc ?? about?.isrc}</dd>
            </>
          ) : null}
        </dl>
        {aboutError ? <Note>MusicBrainz didn’t answer: {errorSentence(aboutError)}</Note> : null}
      </Group>
      <Group title="Lyrics">
        <Lyrics lyrics={lyrics} error={lyricsError} />
      </Group>
      <DownloadGroup track={track} say={say} />
    </>
  );
}

function Lyrics({ lyrics, error }: { lyrics: CatalogLyrics | null; error: Error | null }) {
  const lines = useMemo(() => (lyrics?.synced ? parseLrc(lyrics.synced) : []), [lyrics]);
  if (error) return <Note bad>{errorSentence(error)}</Note>;
  if (!lyrics) return <Note>Looking for lyrics…</Note>;
  if (lyrics.instrumental) return <Note>Instrumental: no words to show.</Note>;
  if (!lyrics.found) return <Note>No lyrics found for this song.</Note>;
  return (
    // A scrolling region takes the keyboard so its words can be scrolled without a mouse (WCAG 2.1.1).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="well well--scroll lyrics" role="region" aria-label={lines.length ? 'Lyrics, timed' : 'Lyrics'} tabIndex={0}>
      {lines.length ? (
        <ol className="lyrics__lines">
          {lines.map((line, i) => (
            <li key={i}>
              <span className="lyrics__at">{formatDuration(line.at) || '0:00'}</span> {line.text || '♪'}
            </li>
          ))}
        </ol>
      ) : (
        <p className="lyrics__plain">{lyrics.plain}</p>
      )}
      <p className="note lyrics__src">{lines.length ? 'Synced lyrics' : 'Lyrics'} from LRCLIB.</p>
    </div>
  );
}

/** A song through the helper's own download path (`catalog:download`), as every download on this PC is. */
async function downloadToPc(track: CatalogTrack, basis: DownloadAuthorizationBasis, format: OutputFormat): Promise<string> {
  const answer = await invoke('catalog:download', { track, basis, ...(format !== 'original' ? { format } : {}) });
  if (!answer.job || !answer.source) throw new Error(answer.reason ?? 'The helper could not start that download.');
  return `Downloading from ${platformLabel(answer.source.platform)}${answer.source.platform === 'spotify' ? ' through spotDL (its YouTube Music match)' : ''}. It is saved where Settings ▸ Downloads says, with its tags and cover.`;
}

function DownloadGroup({ track, say }: { track: CatalogTrack; say: (text: string) => void }) {
  const [basis, setBasis] = useState<DownloadAuthorizationBasis>('user-owned');
  const [format, setFormat] = useState<OutputFormat>('original');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const download = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setDone(await downloadToPc(track, basis, format));
      say(`“${track.title}” is downloading.`);
    } catch (err) {
      setError(catalogError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group title="Download to this PC" hint="The helper fetches it from the best place it can — YouTube Music, YouTube, SoundCloud or Bandcamp, or through spotDL for a Spotify song — as every download on this PC does." last>
      <BasisAndFormat basis={basis} setBasis={setBasis} format={format} setFormat={setFormat} />
      <div className="barrow">
        <Push primary busy={busy} onClick={() => void download()}>
          Download
        </Push>
      </div>
      {done ? <Note>{done}</Note> : <ActionError error={error} />}
    </Group>
  );
}

/** "Allowed because:" (the rights basis every download states, DEC-036) and, when asked, "Save as:". */
function BasisAndFormat({ basis, setBasis, format, setFormat }: { basis: DownloadAuthorizationBasis; setBasis: (basis: DownloadAuthorizationBasis) => void; format?: OutputFormat; setFormat?: (format: OutputFormat) => void }) {
  const basisId = useId();
  const formatId = useId();
  return (
    <div className="pref">
      <label className="k" htmlFor={basisId}>
        Allowed because:
      </label>
      <div className="v">
        <Pop id={basisId} value={basis} onChange={(event) => setBasis(event.currentTarget.value as DownloadAuthorizationBasis)}>
          {SEARCH_BASES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Pop>
      </div>
      {format && setFormat ? (
        <>
          <label className="k" htmlFor={formatId}>
            Save as:
          </label>
          <div className="v">
            <Pop id={formatId} value={format} onChange={(event) => setFormat(event.currentTarget.value as OutputFormat)}>
              {FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Pop>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ a song row's menu (UX-SEARCH-012) */

type AddWhy = 'library' | 'download';

/** Add to the library, or Download…: a song through the helper's download path with its rights basis, into this PC's library. */
function AddSheet({ track, why, onDone, onCancel }: { track: CatalogTrack; why: AddWhy; onDone: (text: string) => void; onCancel: () => void }) {
  const [basis, setBasis] = useState<DownloadAuthorizationBasis>('user-owned');
  const [format, setFormat] = useState<OutputFormat>('original');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const from = pickDownloadSource(track.sources);
  const go = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const said = await downloadToPc(track, basis, why === 'download' ? format : 'original');
      onDone(why === 'download' ? `“${track.title}” is downloading. ${said}` : `“${track.title}” is joining this PC’s library. ${said}`);
    } catch (err) {
      setError(catalogError(err));
      setBusy(false);
    }
  };
  const title = why === 'download' ? `Download “${track.title}”` : `Add “${track.title}” to the library`;
  return (
    <Sheet title={title} onCancel={onCancel}>
      <p>
        The helper fetches it{from ? ` from ${platformLabel(from.platform)}` : ''} with its tags and cover, into the folder Settings ▸ Downloads names.
      </p>
      <BasisAndFormat basis={basis} setBasis={setBasis} {...(why === 'download' ? { format, setFormat } : {})} />
      <ActionError error={error} />
      <div className="sheet__acts">
        <Push onClick={onCancel}>Cancel</Push>
        <Push primary busy={busy} onClick={() => void go()}>
          {why === 'download' ? 'Download' : 'Add to Library'}
        </Push>
      </div>
    </Sheet>
  );
}

/**
 * Filing a song into a playlist from Add to Playlist ▸ (UX-SEARCH-012, CMP-PL-004): into the one
 * chosen, or a new one named here. The entry is written whatever happens next — a song the library
 * has as its file, any other by its source — and "Also add to Library", on by default, queues the
 * download too, with the rights basis every download states (DEC-036).
 */
function FileSheet({ track, playlist, onDone, onCancel }: { track: CatalogTrack; playlist: FolderPlaylistSummary | null; onDone: (text: string) => void; onCancel: () => void }) {
  const fetchable = pickDownloadSource(track.sources) !== null;
  const [name, setName] = useState('');
  const [also, setAlso] = useState(fetchable);
  const [basis, setBasis] = useState<DownloadAuthorizationBasis>('user-owned');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const nameId = useId();
  const go = async (): Promise<void> => {
    if (!playlist && !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const into = playlist ? (await companionPlaylists.add(playlist.id, [track])).playlist : await companionPlaylists.create(name.trim(), [track]);
      let said = playlist ? `“${track.title}” is in “${into.name}” now.` : `Made “${into.name}” with “${track.title}” in it.`;
      if (also && fetchable) {
        try {
          said += ` It is joining this PC’s library too. ${await downloadToPc(track, basis, 'original')}`;
        } catch (err) {
          said += ` It couldn’t join this PC’s library: ${errorSentence(catalogError(err))}`;
        }
      }
      onDone(said);
    } catch (err) {
      setError(catalogError(err));
      setBusy(false);
    }
  };
  return (
    <Sheet title={playlist ? `Add “${track.title}” to “${playlist.name}”` : 'New Playlist'} onCancel={onCancel}>
      {playlist ? null : (
        <div className="pref">
          <label className="k" htmlFor={nameId}>
            Name:
          </label>
          <div className="v">
            <Field id={nameId} value={name} maxLength={120} onChange={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && void go()} />
          </div>
        </div>
      )}
      <p>{fetchable ? `The playlist keeps the song’s link, so it plays even before it is in the library.` : `“${track.title}” is only in a store, so the playlist keeps its store link; there is nothing to fetch.`}</p>
      <Check checked={also && fetchable} disabled={!fetchable} onChange={setAlso}>
        Also add to Library
      </Check>
      {also && fetchable ? <BasisAndFormat basis={basis} setBasis={setBasis} /> : null}
      <ActionError error={error} />
      <div className="sheet__acts">
        <Push onClick={onCancel}>Cancel</Push>
        <Push primary busy={busy} disabled={!playlist && !name.trim()} reason="Name the playlist first." onClick={() => void go()}>
          {playlist ? 'Add to Playlist' : 'Create'}
        </Push>
      </div>
    </Sheet>
  );
}

/**
 * The menu a song row opens (UX-SEARCH-012): Add to Up Next (the companion has no queue of its own,
 * so a paired hub's group, through `hub:groups` and `hub:request`; a submenu when there are several),
 * Add to Playlist, Add to Library, Download…, Audition and Open Details. Every action says what
 * happened in the tool's status line, which is a live region.
 */
function useSongMenu({ preview, present, say, open }: { preview: Preview; present: (sheet: ReactNode | null) => void; say: (text: string) => void; open: (page: Page) => void }) {
  const [shown, setShown] = useState<{ track: CatalogTrack; at: MenuAt; returnTo: HTMLElement | null } | null>(null);
  const [groups, setGroups] = useState<HubGroupChoice[] | null>(null);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const asked = useRef(false);
  const [playlists, setPlaylists] = useState<{ trackId: string; items: FolderPlaylistSummary[]; reason: string | null } | null>(null);

  // The groups are read once the tab opens, so the menu knows where Up Next goes when it opens;
  // a failed read is tried again on the next menu.
  const loadGroups = useCallback(() => {
    if (asked.current) return;
    asked.current = true;
    invoke('hub:groups', undefined)
      .then((answer) => {
        setGroups(answer.items);
        setGroupsError(answer.reason);
        // Asked again next time when there was nothing to offer: a hub may be paired by then.
        if (!answer.items.length) asked.current = false;
      })
      .catch((err: unknown) => {
        asked.current = false;
        setGroups([]);
        setGroupsError(errorSentence(catalogError(err)));
      });
  }, []);
  useEffect(loadGroups, [loadGroups]);

  const openMenu = useCallback<OpenSongMenu>(
    (track, at, returnTo) => {
      setShown({ track, at, returnTo });
      loadGroups();
      // Ticks need the song: the folder is read again for each menu (UX-SEARCH-012).
      setPlaylists(null);
      companionPlaylists
        .list({ catalogId: track.id, ...(track.isrc ? { isrc: track.isrc } : {}) })
        .then((answer) => setPlaylists({ trackId: track.id, items: answer.items, reason: answer.folder.available ? null : answer.folder.reason }))
        .catch((err: unknown) => setPlaylists({ trackId: track.id, items: [], reason: errorSentence(catalogError(err)) }));
    },
    [loadGroups],
  );

  const queue = async (track: CatalogTrack, group: HubGroupChoice): Promise<void> => {
    const source = pickDownloadSource(track.sources);
    if (!source) return say(storeOnly(track, 'queue'));
    try {
      const answer = await invoke('hub:request', { groupId: group.id, query: source.url });
      say(answer.queued ? `Up Next in ${group.name}: “${answer.title ?? track.title}”${answer.position ? `, number ${answer.position}` : ''}.` : `${group.name} didn’t queue “${track.title}”: ${answer.reason ?? 'nothing that plays here matched it'}.`);
    } catch (err) {
      say(`“${track.title}” couldn’t be queued: ${errorSentence(catalogError(err))}`);
    }
  };

  const add = (track: CatalogTrack, why: AddWhy): void => {
    if (!pickDownloadSource(track.sources)) return say(storeOnly(track, why === 'download' ? 'download' : 'library'));
    present(
      <AddSheet
        track={track}
        why={why}
        onCancel={() => present(null)}
        onDone={(text) => {
          present(null);
          say(text);
        }}
      />,
    );
  };

  const file = (track: CatalogTrack, playlist: FolderPlaylistSummary | null): void => {
    if (playlist?.hasTrack) return say(`“${track.title}” is in “${playlist.name}” already.`);
    present(
      <FileSheet
        track={track}
        playlist={playlist}
        onCancel={() => present(null)}
        onDone={(text) => {
          present(null);
          say(text);
        }}
      />,
    );
  };

  const toPlaylist = (track: CatalogTrack): MenuEntry => {
    const known = playlists?.trackId === track.id ? playlists : null;
    const chosen: MenuEntry[] = !known
      ? [{ kind: 'item', label: 'Looking for playlists…', disabled: true, onSelect: () => undefined }]
      : known.reason
        ? [{ kind: 'item', label: 'The playlist folder can’t be read', disabled: true, note: known.reason, onSelect: () => undefined }]
        : known.items.map((p) => ({ kind: 'item', label: p.name, checked: p.hasTrack === true, onSelect: () => file(track, p) }));
    return { kind: 'sub', label: 'Add to Playlist', items: [...chosen, { kind: 'sep' }, { kind: 'item', label: 'New Playlist…', onSelect: () => file(track, null) }] };
  };

  const entries = (track: CatalogTrack): MenuEntry[] => {
    const clip = previewOf(track.sources);
    const playing = clip !== null && preview.playing === clip.url;
    const fetchable = pickDownloadSource(track.sources) !== null;
    const upNext: MenuEntry =
      groups === null
        ? { kind: 'item', label: 'Add to Up Next', disabled: true, note: 'Looking for groups…', onSelect: () => undefined }
        : !groups.length
          ? { kind: 'item', label: 'Add to Up Next', onSelect: () => say(groupsError ?? 'Queueing needs a group on a hub: this companion has no queue of its own.') }
          : groups.length === 1 || !fetchable
            ? { kind: 'item', label: groups.length === 1 ? `Add to Up Next (${groups[0]!.name})` : 'Add to Up Next', onSelect: () => void queue(track, groups[0]!) }
            : { kind: 'sub', label: 'Add to Up Next', items: groups.map((g) => ({ kind: 'item', label: g.name, onSelect: () => void queue(track, g) })) };
    return [
      upNext,
      toPlaylist(track),
      { kind: 'item', label: 'Add to Library…', onSelect: () => add(track, 'library') },
      { kind: 'sep' },
      { kind: 'item', label: 'Download…', onSelect: () => add(track, 'download') },
      clip ? { kind: 'item', label: playing ? 'Stop Audition' : 'Audition', onSelect: () => preview.toggle(clip.url) } : { kind: 'item', label: 'Audition', disabled: true, note: 'No 30-second clip', onSelect: () => undefined },
      { kind: 'item', label: 'Open Details', onSelect: () => open({ kind: 'song', track }) },
    ];
  };

  const menu = shown ? (
    <Menu
      label={`“${shown.track.title}”`}
      at={shown.at}
      entries={entries(shown.track)}
      onClose={(refocus) => {
        if (refocus) shown.returnTo?.focus();
        setShown(null);
      }}
    />
  ) : null;
  return { open: openMenu, menu };
}

/** A song only a store has: nothing to queue, fetch or keep, said plainly. */
function storeOnly(track: CatalogTrack, what: 'queue' | 'library' | 'download'): string {
  const where = platformsOf(track.sources).map(platformLabel).join(', ');
  return what === 'queue' ? `“${track.title}” is only in a store (${where}), so there is nothing to queue.` : `“${track.title}” is only in a store (${where}), so there is nothing the helper can fetch.`;
}

/* ------------------------------------------------------------------ rows */

function Art({ url, size, round }: { url: string | null | undefined; size?: 'big'; round?: boolean }) {
  const cls = ['art', size === 'big' && 'art--big', round && 'art--round'].filter(Boolean).join(' ');
  return <span className={cls}>{url ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}</span>;
}

function CollectionArt({ collection, size }: { collection: Pick<CatalogCollection, 'artworkUrl' | 'covers'>; size?: 'big' }) {
  const art = coverArt(collection);
  if (art.kind !== 'mosaic') return <Art url={art.kind === 'single' ? art.url : null} {...(size ? { size } : {})} />;
  return (
    <span className={['art', 'art--mosaic', size === 'big' && 'art--big'].filter(Boolean).join(' ')}>
      {art.covers.map((cover, i) => (
        <img key={i} src={cover} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ))}
    </span>
  );
}

/** Where it is: one chip per platform, and a Spotify song's "plays from YouTube Music" (UX-SEARCH-003). */
function Platforms({ sources }: { sources: readonly CatalogSource[] }) {
  const plays = playsThroughSpotdl(sources);
  return (
    <span className="mrow__plat">
      <span className="caps" role="img" aria-label={`On ${platformsOf(sources).map(platformLabel).join(', ')}`}>
        {platformsOf(sources).map((p) => (
          <span key={p} className={`cap cap--${p}`} aria-hidden="true">
            {platformLabel(p)}
          </span>
        ))}
      </span>
      {plays ? <span className="mrow__plays">{PLAYS_FROM_SPOTDL}</span> : null}
    </span>
  );
}

interface ListboxPaging {
  /** Rows a page holds: each row says its page (`data-page`), and Page Up/Down turn pages. */
  pageSize?: number;
  /** A row to land on: it takes the highlight, scrolls to the top and the list takes the keys. */
  focusRequest?: FocusRequest | null;
  onPageKey?: (step: 1 | -1, index: number) => void;
  /** The highlight moved (the keys or a click). */
  onActive?: (index: number) => void;
}

/**
 * A list box of music (UX-KEY-001, UX-SEARCH-008): one tab stop, the arrows, Home and End move the
 * highlight, Page Up/Down move eight rows (or turn a type page's pages), Enter opens, Space plays a
 * song's preview; a click opens (a click on ▶ plays). A song list's rows have a menu
 * (UX-SEARCH-012): their "…", a right-click, Shift+F10 and the Menu key on the highlighted row, or
 * (on touch) a long press (CMP-PL-006).
 */
function Listbox<T>({ label, items, render, onOpen, onSpace, onMenu, empty, hint, pageSize, focusRequest, onPageKey, onActive }: { label: string; items: readonly T[]; render: (item: T, index: number) => ReactNode; onOpen: (item: T) => void; onSpace?: (item: T) => void; onMenu?: (item: T, at: MenuAt, list: HTMLElement) => void; empty: string; hint?: string } & ListboxPaging) {
  const [active, setActive] = useState(0);
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const at = Math.min(active, Math.max(0, items.length - 1));

  // On a touch screen a long press on a row opens its menu, as a right-click does (CMP-PL-006).
  const press = useLongPress<HTMLUListElement>((target, point) => {
    const row = target.closest<HTMLElement>('[data-index]');
    if (!row || !onMenu || !list.current) return;
    const index = Number(row.dataset['index']);
    setActive(index);
    onMenu(items[index]!, point, list.current);
  });

  // A page turned from the footer or the keys: its first row takes the highlight and the keys.
  const request = focusRequest?.n;
  useEffect(() => {
    if (!focusRequest || !list.current) return;
    setActive(focusRequest.index);
    list.current.querySelector(`#${CSS.escape(`${id}-${focusRequest.index}`)}`)?.scrollIntoView?.({ block: 'start' });
    list.current.focus({ preventScroll: true });
    // Only when a new request is made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (!items.length) {
    return empty ? (
      <div className="well">
        <ul className="rows" aria-label={label}>
          <li>
            <span className="empty">{empty}</span>
          </li>
        </ul>
      </div>
    ) : null;
  }

  const move = (to: number): void => {
    const next = Math.max(0, Math.min(items.length - 1, to));
    setActive(next);
    onActive?.(next);
    list.current?.querySelector(`#${CSS.escape(`${id}-${next}`)}`)?.scrollIntoView?.({ block: 'nearest' });
  };
  const menuAt = (index: number, event?: { clientX: number; clientY: number }): void => {
    if (!onMenu || !list.current) return;
    const row = list.current.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${index}`)}`);
    const rect = row?.getBoundingClientRect();
    // Shift+F10 and the Menu key come at (0, 0): anchor those on the row.
    const point = event && (event.clientX || event.clientY) ? { x: event.clientX, y: event.clientY } : { x: (rect?.left ?? 0) + 40, y: (rect?.bottom ?? 0) - 4 };
    onMenu(items[index]!, point, list.current);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if ((event.key === 'PageDown' || event.key === 'PageUp') && onPageKey) onPageKey(event.key === 'PageDown' ? 1 : -1, at);
    else if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      if (!onMenu) return;
      menuAt(at);
    } else {
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[event.key];
      if (step) move(at + step);
      else if (event.key === 'Home') move(0);
      else if (event.key === 'End') move(items.length - 1);
      else if (event.key === 'Enter') onOpen(items[at]!);
      else if (event.key === ' ' && onSpace) onSpace(items[at]!);
      else return;
    }
    event.preventDefault();
  };
  const rowOf = (event: MouseEvent<HTMLUListElement>): number | null => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
    return row ? Number(row.dataset['index']) : null;
  };
  const onClick = (event: MouseEvent<HTMLUListElement>): void => {
    const index = rowOf(event);
    if (index === null) return;
    setActive(index);
    onActive?.(index);
    const target = event.target as HTMLElement;
    if (target.closest('[data-menu]') && onMenu) {
      const rect = target.closest('[data-menu]')!.getBoundingClientRect();
      onMenu(items[index]!, { x: rect.right - 8, y: rect.bottom + 2 }, event.currentTarget);
    } else if (target.closest('[data-preview]') && onSpace) onSpace(items[index]!);
    else onOpen(items[index]!);
  };
  const onContextMenu = (event: MouseEvent<HTMLUListElement>): void => {
    if (!onMenu) return;
    const index = rowOf(event) ?? at;
    event.preventDefault();
    setActive(index);
    menuAt(index, event);
  };

  return (
    <div className="well">
      <ul ref={list} className="rows mrows" role="listbox" aria-label={label} tabIndex={0} aria-activedescendant={`${id}-${at}`} aria-describedby={hint ? `${id}-hint` : undefined} onKeyDown={onKeyDown} onClick={onClick} onContextMenu={onContextMenu} {...(onMenu ? press : {})}>
        {items.map((item, i) => (
          <li key={i} id={`${id}-${i}`} role="option" aria-selected={i === at} data-index={i} data-page={pageSize ? Math.floor(i / pageSize) + 1 : undefined}>
            {render(item, i)}
          </li>
        ))}
      </ul>
      {hint ? (
        <span className="sr" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function TrackList({ label, tracks, preview, onOpen, empty, numbered, ...paging }: { label: string; tracks: readonly CatalogTrack[]; preview: Preview; onOpen: (track: CatalogTrack) => void; empty: string; numbered?: boolean } & ListboxPaging) {
  const openMenu = useContext(SongMenuContext);
  return (
    <Listbox
      label={label}
      items={tracks}
      empty={empty}
      onOpen={onOpen}
      onSpace={(t) => {
        const clip = previewOf(t.sources);
        if (clip) preview.toggle(clip.url);
      }}
      {...(openMenu ? { onMenu: (t: CatalogTrack, at: MenuAt, list: HTMLElement) => openMenu(t, at, list) } : {})}
      hint={`Enter opens the song. Space plays its 30-second preview, where it has one.${openMenu ? ' Shift+F10 or the Menu key opens its menu: Up Next, a playlist, the library.' : ''}`}
      {...paging}
      render={(t, i) => {
        const clip = previewOf(t.sources);
        const playing = clip !== null && preview.playing === clip.url;
        return (
          <>
            {numbered ? <span className="mrow__n">{t.trackNumber ?? i + 1}</span> : null}
            <Art url={t.artworkUrl} />
            <span className="mrow__main">
              <span className="mrow__title">
                {t.title}
                {t.explicit ? (
                  <span className="cap cap--x" title="Explicit">
                    <span aria-hidden="true">E</span>
                    <span className="sr">, explicit</span>
                  </span>
                ) : null}
              </span>
              <span className="mrow__sub">{[creditLine(t), t.album].filter(Boolean).join(' · ')}</span>
              <Platforms sources={t.sources} />
            </span>
            <span className="mrow__meta">
              {t.bpm ? <span className="mrow__bpm">{Math.round(t.bpm)} BPM</span> : null}
              <span className="mrow__time">{formatDuration(t.durationMs)}</span>
            </span>
            {clip ? (
              <span className={`mrow__play${playing ? ' is-playing' : ''}`} data-preview title={playing ? 'Stop the preview' : 'Play the 30-second preview'}>
                <span aria-hidden="true">{playing ? '■' : '▶'}</span>
                <span className="sr">{playing ? ', preview playing' : ', preview'}</span>
              </span>
            ) : null}
            {openMenu ? (
              <span className="mrow__more" data-menu title="More: Up Next, a playlist, the library (Shift+F10)" aria-hidden="true">
                …
              </span>
            ) : null}
          </>
        );
      }}
    />
  );
}

function ArtistList({ label, artists, onOpen, empty, ...paging }: { label: string; artists: readonly CatalogArtist[]; onOpen: (artist: CatalogArtist) => void; empty: string } & ListboxPaging) {
  return (
    <Listbox
      label={label}
      items={artists}
      empty={empty}
      onOpen={onOpen}
      {...paging}
      render={(a) => (
        <>
          <Art url={a.pictureUrl} round />
          <span className="mrow__main">
            <span className="mrow__title">{a.name}</span>
            <span className="mrow__sub">{[a.genre, a.albumCount ? `${a.albumCount} albums` : null, a.fans ? `${a.fans.toLocaleString('en-US')} fans` : null].filter(Boolean).join(' · ') || 'Artist'}</span>
            <Platforms sources={a.sources} />
          </span>
        </>
      )}
    />
  );
}

function AlbumList({ label, albums, onOpen, empty, ...paging }: { label: string; albums: readonly CatalogAlbum[]; onOpen: (album: CatalogAlbum) => void; empty: string } & ListboxPaging) {
  return (
    <Listbox
      label={label}
      items={albums}
      empty={empty}
      onOpen={onOpen}
      {...paging}
      render={(a) => (
        <>
          <Art url={a.artworkUrl} />
          <span className="mrow__main">
            <span className="mrow__title">
              {a.title}
              {a.explicit ? (
                <span className="cap cap--x" title="Explicit">
                  <span aria-hidden="true">E</span>
                  <span className="sr">, explicit</span>
                </span>
              ) : null}
            </span>
            <span className="mrow__sub">{[a.artist, a.year, a.trackCount ? `${a.trackCount} songs` : null].filter(Boolean).join(' · ')}</span>
            <Platforms sources={a.sources} />
          </span>
        </>
      )}
    />
  );
}

/** Public playlists (UX-SEARCH-010): the picture (or a mosaic), the title, "Playlist on Deezer · owner · N songs". */
function PlaylistList({ label, playlists, onOpen, empty, ...paging }: { label: string; playlists: readonly CatalogPlaylist[]; onOpen: (playlist: CatalogPlaylist) => void; empty: string } & ListboxPaging) {
  return (
    <Listbox
      label={label}
      items={playlists}
      empty={empty}
      onOpen={onOpen}
      {...paging}
      render={(p) => (
        <>
          <CollectionArt collection={{ artworkUrl: p.pictureUrl, covers: p.covers }} />
          <span className="mrow__main">
            <span className="mrow__title">{p.title}</span>
            <span className="mrow__sub">{playlistLine(p)}</span>
            <Platforms sources={p.sources} />
          </span>
        </>
      )}
    />
  );
}

/** The playlists starred on this PC, "In your library", first on the Playlists page (UX-SEARCH-010). */
function SavedList({ label, items, onOpen }: { label: string; items: readonly SavedCollection[]; onOpen: (saved: SavedCollection) => void }) {
  return (
    <Listbox
      label={label}
      items={items}
      empty=""
      onOpen={onOpen}
      render={(s) => (
        <>
          <CollectionArt collection={{ artworkUrl: s.artworkUrl, covers: s.covers }} />
          <span className="mrow__main">
            <span className="mrow__title">
              <span aria-hidden="true">★ </span>
              {s.ref.title}
            </span>
            <span className="mrow__sub">{collectionLine({ ref: s.ref, page: { total: s.trackCount } as CatalogCollection['page'] })}</span>
          </span>
        </>
      )}
    />
  );
}

/** An album or playlist read from a link: its mosaic, its name and where it is from (UX-SEARCH-004). */
function CollectionList({ label, collections, onOpen }: { label: string; collections: readonly CatalogCollection[]; onOpen: (collection: CatalogCollection) => void }) {
  return (
    <Listbox
      label={label}
      items={collections}
      empty=""
      onOpen={onOpen}
      render={(c) => (
        <>
          <CollectionArt collection={c} />
          <span className="mrow__main">
            <span className="mrow__title">{c.ref.title}</span>
            <span className="mrow__sub">{[collectionLine(c), c.ref.owner ? `by ${c.ref.owner}` : null].filter(Boolean).join(' · ')}</span>
          </span>
        </>
      )}
    />
  );
}

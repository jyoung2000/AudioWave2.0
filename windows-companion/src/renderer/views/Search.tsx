/**
 * Search: the music catalog in the companion's window (DEC-039; rules UX-SEARCH-001…008, UX-CAT-001…004).
 *
 * The same search the hub's Search tab is, with the same rules, on this PC: one field finds songs,
 * artists and albums across iTunes, Deezer, MusicBrainz, YouTube and SoundCloud, or reads a pasted
 * link from any platform, Spotify included. The answers stream in from the embedded helper (through
 * the main process, `catalog.ts`) and are folded by id; every service's state is on one line; Songs,
 * Artists and Albums page with numbers and Previous/Next, and See All scrolls on; opening a row stacks
 * a page with Back (Escape); an album or a pasted playlist has a star that keeps it in this PC's
 * library; a song shows genre, label, year and lyrics, and downloads through the helper as every
 * download on this PC does. The behaviour both apps share is `@now-playing/domain/catalog` (view.ts);
 * this file is the hub's view with the companion's kit (`search-kit.tsx`, DEC-026) and transport.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { CatalogAlbum, CatalogAlbumDetail, CatalogArtist, CatalogArtistDetail, CatalogCollection, CatalogEnrichment, CatalogLyrics, CatalogResolveResult, CatalogSection, CatalogSource, CatalogTrack, DownloadAuthorizationBasis, OutputFormat } from '@now-playing/contracts';
import { CATALOG_COLLECTION_CAP, CATALOG_PROVIDERS } from '@now-playing/contracts';
import {
  albumLine,
  appendPage,
  creditLine,
  appendTracks,
  byRank,
  CATALOG_PROVIDER_LABELS,
  CATALOG_SECTION_LABELS,
  collapseFields,
  collectionLine,
  coverArt,
  EMPTY_FIELDS,
  EMPTY_RESULTS,
  foldCatalogChunk,
  formatDuration,
  hasQuery,
  parseLrc,
  platformLabel,
  platformsOf,
  PLAYS_FROM_SPOTDL,
  playsThroughSpotdl,
  previewOf,
  savedCollectionOf,
  sourceDot,
  sectionPages,
  sourceStateText,
  statusSummary,
  type SectionPages,
  type CatalogFields,
  type CatalogResults,
} from '@now-playing/domain/catalog';
import { invoke } from '../bridge.js';
import { catalogError, companionCatalog, useCatalogFilter, useLiveSearch, usePreview, useSavedCollections, type CatalogClient, type CatalogFilter, type CatalogSearchParams, type Preview, type SavedCollections } from '../catalog.js';
import { ActionError, Check, errorSentence, Field, Group, Note, Pop, Push, Sdot, Sheet, SearchUiProvider, useNow, useSearchUi } from '../search-kit.js';
/** Why this download is allowed: the same bases the hub and the helper record (DownloadAuthorizationBasis). */
const BASIS_LABELS: Record<string, string> = {
  'user-owned': 'I own it',
  'creator-download': 'The artist allows downloads',
  'purchased-export': 'Exported from a purchase',
  'public-domain': 'Public domain',
  licensed: 'Licensed',
};

/** Rows a page of a section shows on the results (UX-SEARCH-007); See All scrolls through them all. */
const SECTION_PAGE = 8;
/** Rows a See All page or a list asks for at a time. */
const PAGE = 25;
const LIST_PAGE = 50;

type Page =
  | { kind: 'results' }
  | { kind: 'all'; section: CatalogSection }
  | { kind: 'album'; album: CatalogAlbum }
  | { kind: 'artist'; artist: CatalogArtist }
  | { kind: 'song'; track: CatalogTrack }
  | { kind: 'list'; url: string; first: CatalogResolveResult | null; title: string };

function pageTitle(page: Page): string {
  switch (page.kind) {
    case 'results':
      return 'Results';
    case 'all':
      return `All ${CATALOG_SECTION_LABELS[page.section]}`;
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

  const page = stack[stack.length - 1]!;
  const open = useCallback((next: Page) => setStack((s) => [...s, next]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);

  // A page that opens takes the focus to its heading, so a screen reader hears where it is.
  const depth = stack.length;
  useEffect(() => {
    if (depth > 1) heading.current?.focus();
  }, [depth, page]);

  // Each section's pager, kept here so a page survives opening a row and coming Back (UX-SEARCH-007).
  const [pagers, setPagers] = useState<Pagers>(FRESH_PAGERS);

  const search = (params: Omit<CatalogSearchParams, 'sections' | 'providers'>, using: CatalogFilter = filter): void => {
    preview.stop();
    setStack([{ kind: 'results' }]);
    setPagers(FRESH_PAGERS);
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

  const now = useNow(5_000);
  const { results } = live;
  const summary = live.error ? errorSentence(live.error) : statusSummary(results.status, Boolean(results.done) && !live.running, results.done?.totals);
  const filtered = filter.sections.length < 3 || filter.providers.length < CATALOG_PROVIDERS.length;

  return (
    <div className="srch">
      <Group title="Find music" hint="Songs, artists and albums from iTunes, Deezer, MusicBrainz, YouTube and SoundCloud — or paste a link from any of them, Spotify included." className="srch__find">
        <form className="barrow srch__bar" role="search" aria-label="Music" onSubmit={submit} noValidate>
          <Field
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
            Showing {filter.sections.map((s) => CATALOG_SECTION_LABELS[s]).join(', ')} from {filter.providers.length === CATALOG_PROVIDERS.length ? 'every service' : filter.providers.map((p) => CATALOG_PROVIDER_LABELS[p]).join(', ')}.
          </p>
        ) : null}
        {results.status.length ? (
          <ul className="srcs" aria-label="Services asked">
            {results.status.map((s) => (
              <li key={s.provider} title={s.error ?? undefined}>
                <Sdot kind={sourceDot(s.state)} inline />
                <b>{CATALOG_PROVIDER_LABELS[s.provider]}</b> <span className="srcs__state">{sourceStateText(s, now)}</span>
                {s.error ? <span className="sr">: {s.error}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {results.done?.linkedOnly.length ? <p className="note srcs__links">Linked, not searched: {results.done.linkedOnly.map(platformLabel).join(', ')}.</p> : null}
        <p className="sr" role="status" aria-live="polite">
          {summary}
        </p>
        {live.error ? <Note bad>{errorSentence(live.error)}</Note> : null}
      </Group>

      {page.kind === 'results' ? (
        <ResultsPage results={results} running={live.running} asked={live.asked} filter={filter} client={client} preview={preview} open={open} pagers={pagers} setPagers={setPagers} />
      ) : (
        // Escape goes back a page, as Back does, from anywhere in it but a field being typed in.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
        <section
          className="srch__page"
          aria-labelledby="srch-page-h"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement)) {
              event.preventDefault();
              back();
            }
          }}
        >
          <div className="barrow barrow--above srch__nav">
            <Push onClick={back} aria-label={`Back to ${pageTitle(stack[stack.length - 2]!)}`}>
              ‹ Back
            </Push>
            <h2 id="srch-page-h" className="srch__h" tabIndex={-1} ref={heading}>
              {pageTitle(page)}
            </h2>
          </div>
          <div>
            {page.kind === 'all' && live.asked ? <SeeAllPage key={`all-${page.section}`} section={page.section} results={results} asked={live.asked} client={client} preview={preview} open={open} /> : null}
            {page.kind === 'album' ? <AlbumPage key={`album-${page.album.id}`} album={page.album} client={client} preview={preview} saved={saved} open={open} say={say} /> : null}
            {page.kind === 'artist' ? <ArtistPage key={`artist-${page.artist.id}`} artist={page.artist} client={client} preview={preview} open={open} /> : null}
            {page.kind === 'song' ? <SongPage key={`song-${page.track.id}`} track={page.track} client={client} preview={preview} say={say} /> : null}
            {page.kind === 'list' ? <ListPage key={`list-${page.url}`} url={page.url} first={page.first} client={client} preview={preview} saved={saved} open={open} say={say} /> : null}
          </div>
        </section>
      )}
    </div>
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
  const ordered = (next: CatalogFilter): CatalogFilter => ({ sections: (['tracks', 'artists', 'albums'] as const).filter((s) => next.sections.includes(s)), providers: CATALOG_PROVIDERS.filter((p) => next.providers.includes(p)) });
  return (
    <Sheet title="Filter the search" onCancel={onCancel}>
      <p>Kept on this PC. Changing it searches again.</p>
      <div className="srch__filter">
        <fieldset>
          <legend>Show</legend>
          {(['tracks', 'artists', 'albums'] as const).map((s) => (
            <Check key={s} checked={draft.sections.includes(s)} onChange={(on) => flip('sections', s, on)}>
              {CATALOG_SECTION_LABELS[s]}
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

/* ------------------------------------------------------------------ the results */

/** One section's pager: the page shown, rows loaded past the first answer, and where the next ask starts. */
interface PagerState {
  page: number;
  extra: { tracks: CatalogTrack[]; artists: CatalogArtist[]; albums: CatalogAlbum[] };
  /** The offset of the last page the server was asked for. */
  offset: number;
  /** The services' `hasMore` for that page; null until a further page was asked for. */
  more: boolean | null;
  busy: boolean;
  error: Error | null;
}
type Pagers = Record<CatalogSection, PagerState>;
const FRESH_PAGER: PagerState = { page: 0, extra: { tracks: [], artists: [], albums: [] }, offset: 0, more: null, busy: false, error: null };
const FRESH_PAGERS: Pagers = { tracks: FRESH_PAGER, artists: FRESH_PAGER, albums: FRESH_PAGER };

function sectionRows(section: CatalogSection, results: CatalogResults, extra: PagerState['extra']): Array<CatalogTrack | CatalogArtist | CatalogAlbum> {
  if (section === 'tracks') return appendTracks(byRank(results.tracks), extra.tracks);
  if (section === 'artists') return appendPage(byRank(results.artists), extra.artists);
  return appendPage(byRank(results.albums), extra.albums);
}

function ResultsPage({ results, running, asked, filter, client, preview, open, pagers, setPagers }: { results: CatalogResults; running: boolean; asked: CatalogSearchParams | null; filter: CatalogFilter; client: CatalogClient; preview: Preview; open: (page: Page) => void; pagers: Pagers; setPagers: (update: (current: Pagers) => Pagers) => void }) {
  const link = results.done?.resolve ?? null;
  if (!asked) return null;
  if (link) return <LinkResult key={link} url={link} client={client} preview={preview} open={open} />;
  const shown = filter.sections.filter((s) => results.done === null || results.done.page[s] !== null || results[s].length > 0);
  const patch = (section: CatalogSection, next: Partial<PagerState>): void => setPagers((current) => ({ ...current, [section]: { ...current[section], ...next } }));

  /** A page: drawn from what is loaded, or — past it, while the services have more — asked for first. */
  const goTo = async (section: CatalogSection, target: number, state: SectionPages, pager: PagerState): Promise<void> => {
    if (target <= state.known - 1 || !state.more) return patch(section, { page: Math.max(0, Math.min(target, state.known - 1)) });
    const size = asked.limit ?? PAGE;
    const offset = (pager.more === null ? (asked.offset ?? 0) : pager.offset) + size;
    patch(section, { busy: true, error: null });
    let page: CatalogResults = EMPTY_RESULTS;
    try {
      await client.search({ ...asked, sections: [section], offset, limit: size }, (chunk) => (page = foldCatalogChunk(page, chunk)), new AbortController().signal);
      setPagers((current) => {
        const before = current[section];
        const extra = { ...before.extra, [section]: section === 'tracks' ? appendTracks(before.extra.tracks, byRank(page.tracks)) : appendPage(before.extra[section] as Array<{ id: string; rank: number }>, byRank(page[section] as Array<{ id: string; rank: number }>)) } as PagerState['extra'];
        const loaded = sectionRows(section, results, extra).length;
        return { ...current, [section]: { ...before, extra, offset, more: Boolean(page.done?.page[section]?.hasMore) && offset + size <= 1000, busy: false, page: Math.min(target, Math.max(0, Math.ceil(loaded / SECTION_PAGE) - 1)) } };
      });
    } catch (err) {
      patch(section, { busy: false, error: catalogError(err) });
    }
  };

  return (
    <>
      {shown.map((section) => {
        const pager = pagers[section];
        const rows = sectionRows(section, results, pager.extra);
        const more = pager.more ?? Boolean(results.done?.page[section]?.hasMore);
        const state = sectionPages(rows.length, SECTION_PAGE, pager.page, more);
        const slice = rows.slice(state.page * SECTION_PAGE, state.page * SECTION_PAGE + SECTION_PAGE);
        const waiting = running && !rows.length;
        const label = CATALOG_SECTION_LABELS[section];
        return (
          <Group key={section} title={label} tag={rows.length ? <span className="sub srch__count">{` ${rows.length}${more ? '+' : ''}`}</span> : null}>
            {section === 'tracks' ? <TrackList label="Songs" tracks={slice as CatalogTrack[]} preview={preview} onOpen={(t) => open({ kind: 'song', track: t })} empty={waiting ? 'Asking…' : 'No songs.'} /> : null}
            {section === 'artists' ? <ArtistList label="Artists" artists={slice as CatalogArtist[]} onOpen={(a) => open({ kind: 'artist', artist: a })} empty={waiting ? 'Asking…' : 'No artists.'} /> : null}
            {section === 'albums' ? <AlbumList label="Albums" albums={slice as CatalogAlbum[]} onOpen={(a) => open(albumPage(a))} empty={waiting ? 'Asking…' : 'No albums.'} /> : null}
            <div className="barrow srch__pagerow">
              {state.known > 1 || state.more ? <Pager label={label} state={state} busy={pager.busy} onPage={(n) => void goTo(section, n, state, pager)} /> : null}
              {rows.length > SECTION_PAGE || more ? <Push onClick={() => open({ kind: 'all', section })}>See All {label}</Push> : null}
            </div>
            <ActionError error={pager.error} />
          </Group>
        );
      })}
    </>
  );
}

/**
 * A section's pages (UX-SEARCH-007): Previous, the page numbers, Next, and the count in words. The
 * arrow keys move a page from anywhere in it, Home and End go to the first and the last loaded.
 */
function Pager({ label, state, busy, onPage }: { label: string; state: SectionPages; busy: boolean; onPage: (page: number) => void }) {
  const first = Math.max(0, Math.min(state.page - 3, state.known - 7));
  const numbers = Array.from({ length: Math.min(7, state.known) }, (_, i) => first + i);
  return (
    // The arrow keys belong to the pager as a whole, as they do to a tab strip.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <nav
      className="pager"
      aria-label={`${label} pages`}
      onKeyDown={(event) => {
        const to = { ArrowLeft: state.canPrev ? state.page - 1 : null, ArrowRight: state.canNext ? state.page + 1 : null, Home: 0, End: state.known - 1 }[event.key];
        if (to === undefined) return;
        event.preventDefault();
        if (to !== null && !busy) onPage(to);
      }}
    >
      <Push className="pager__step" disabled={!state.canPrev} onClick={() => onPage(state.page - 1)} aria-label={`Previous page of ${label.toLowerCase()}`}>
        ‹ Previous
      </Push>
      {numbers.map((n) => (
        <Push key={n} className="pager__n" aria-current={n === state.page ? 'page' : undefined} aria-label={`${label}, page ${n + 1}`} onClick={() => onPage(n)}>
          {n + 1}
        </Push>
      ))}
      <Push className="pager__step" disabled={!state.canNext} busy={busy} onClick={() => onPage(state.page + 1)} aria-label={`Next page of ${label.toLowerCase()}`}>
        Next ›
      </Push>
      <span className="pager__count" aria-live="polite">
        {state.label}
      </span>
    </nav>
  );
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

/* ------------------------------------------------------------------ See All */

function SeeAllPage({ section, results, asked, client, preview, open }: { section: CatalogSection; results: CatalogResults; asked: CatalogSearchParams; client: CatalogClient; preview: Preview; open: (page: Page) => void }) {
  const [rows, setRows] = useState<{ tracks: CatalogTrack[]; artists: CatalogArtist[]; albums: CatalogAlbum[] }>(() => ({ tracks: byRank(results.tracks), artists: byRank(results.artists), albums: byRank(results.albums) }));
  const [offset, setOffset] = useState(asked.offset ?? 0);
  const [hasMore, setHasMore] = useState(Boolean(results.done?.page[section]?.hasMore));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const inFlight = useRef(false);

  const more = useCallback(async (): Promise<void> => {
    if (inFlight.current || !hasMore) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const next = offset + (asked.limit ?? PAGE);
    let page: CatalogResults = EMPTY_RESULTS;
    try {
      await client.search({ ...asked, sections: [section], offset: next, limit: asked.limit ?? PAGE }, (chunk) => (page = foldCatalogChunk(page, chunk)), new AbortController().signal);
      setRows((current) => ({ tracks: appendTracks(current.tracks, byRank(page.tracks)), artists: appendPage(current.artists, byRank(page.artists)), albums: appendPage(current.albums, byRank(page.albums)) }));
      setOffset(next);
      setHasMore(Boolean(page.done?.page[section]?.hasMore) && next + (asked.limit ?? PAGE) <= 1000);
    } catch (err) {
      setError(catalogError(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [asked, client, hasMore, offset, section]);

  return (
    <>
      {section === 'tracks' ? <TrackList label="All songs" tracks={rows.tracks} preview={preview} onOpen={(t) => open({ kind: 'song', track: t })} empty="No songs." /> : null}
      {section === 'artists' ? <ArtistList label="All artists" artists={rows.artists} onOpen={(a) => open({ kind: 'artist', artist: a })} empty="No artists." /> : null}
      {section === 'albums' ? <AlbumList label="All albums" albums={rows.albums} onOpen={(a) => open(albumPage(a))} empty="No albums." /> : null}
      <ActionError error={error} />
      {hasMore ? <MoreRows label={`More ${CATALOG_SECTION_LABELS[section]}`} busy={busy} onMore={more} /> : <p className="note">That’s everything the services found.</p>}
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

/** An album or playlist read from its link (pasted, or a row from a platform without a detail route). */
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

function DownloadGroup({ track, say }: { track: CatalogTrack; say: (text: string) => void }) {
  const [basis, setBasis] = useState<DownloadAuthorizationBasis>('user-owned');
  const [format, setFormat] = useState<OutputFormat>('original');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const basisId = useId();
  const formatId = useId();

  const download = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const answer = await invoke('catalog:download', { track, basis, ...(format !== 'original' ? { format } : {}) });
      if (!answer.job || !answer.source) throw new Error(answer.reason ?? 'The helper could not start that download.');
      setDone(`Downloading from ${platformLabel(answer.source.platform)}${answer.source.platform === 'spotify' ? ' through spotDL (its YouTube Music match)' : ''}. It is saved where Settings ▸ Downloads says, with its tags and cover.`);
      say(`“${track.title}” is downloading.`);
    } catch (err) {
      setError(catalogError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group title="Download to this PC" hint="The helper fetches it from the best place it can — YouTube Music, YouTube, SoundCloud or Bandcamp, or through spotDL for a Spotify song — as every download on this PC does." last>
      <div className="pref">
        <label className="k" htmlFor={basisId}>
          Allowed because:
        </label>
        <div className="v">
          <Pop id={basisId} value={basis} onChange={(event) => setBasis(event.currentTarget.value as DownloadAuthorizationBasis)}>
            {Object.entries(BASIS_LABELS)
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </Pop>
        </div>
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
      </div>
      <div className="barrow">
        <Push primary busy={busy} onClick={() => void download()}>
          Download
        </Push>
      </div>
      {done ? <Note>{done}</Note> : <ActionError error={error} />}
    </Group>
  );
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

/**
 * A list box of music (UX-KEY-001, UX-SEARCH-008): one tab stop, the arrows, Home and End move the
 * highlight, Enter opens, Space plays a song's preview; a click opens (a click on ▶ plays).
 */
function Listbox<T>({ label, items, render, onOpen, onSpace, empty, hint }: { label: string; items: readonly T[]; render: (item: T, index: number) => ReactNode; onOpen: (item: T) => void; onSpace?: (item: T) => void; empty: string; hint?: string }) {
  const [active, setActive] = useState(0);
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const at = Math.min(active, Math.max(0, items.length - 1));

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
    list.current?.querySelector(`#${CSS.escape(`${id}-${next}`)}`)?.scrollIntoView?.({ block: 'nearest' });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[event.key];
    if (step) move(at + step);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Enter') onOpen(items[at]!);
    else if (event.key === ' ' && onSpace) onSpace(items[at]!);
    else return;
    event.preventDefault();
  };
  const onClick = (event: MouseEvent<HTMLUListElement>): void => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
    if (!row) return;
    const index = Number(row.dataset['index']);
    setActive(index);
    if ((event.target as HTMLElement).closest('[data-preview]') && onSpace) onSpace(items[index]!);
    else onOpen(items[index]!);
  };

  return (
    <div className="well">
      <ul ref={list} className="rows mrows" role="listbox" aria-label={label} tabIndex={0} aria-activedescendant={`${id}-${at}`} aria-describedby={hint ? `${id}-hint` : undefined} onKeyDown={onKeyDown} onClick={onClick}>
        {items.map((item, i) => (
          <li key={i} id={`${id}-${i}`} role="option" aria-selected={i === at} data-index={i}>
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

function TrackList({ label, tracks, preview, onOpen, empty, numbered }: { label: string; tracks: readonly CatalogTrack[]; preview: Preview; onOpen: (track: CatalogTrack) => void; empty: string; numbered?: boolean }) {
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
      hint="Enter opens the song. Space plays its 30-second preview, where it has one."
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
          </>
        );
      }}
    />
  );
}

function ArtistList({ label, artists, onOpen, empty }: { label: string; artists: readonly CatalogArtist[]; onOpen: (artist: CatalogArtist) => void; empty: string }) {
  return (
    <Listbox
      label={label}
      items={artists}
      empty={empty}
      onOpen={onOpen}
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

function AlbumList({ label, albums, onOpen, empty }: { label: string; albums: readonly CatalogAlbum[]; onOpen: (album: CatalogAlbum) => void; empty: string }) {
  return (
    <Listbox
      label={label}
      items={albums}
      empty={empty}
      onOpen={onOpen}
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


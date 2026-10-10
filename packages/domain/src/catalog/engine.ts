/**
 * The catalog engine: one object a server (or the player) builds once and asks everything.
 *
 *   search   — every enabled service at once; a chunk as each answers (the "live track feed"),
 *              rows merged across services as they arrive, every service's state on every chunk.
 *   album / artist — details by `platform:id`.
 *   resolve  — what a pasted link is, with every song of an album or playlist.
 *   lyrics, enrich — LRCLIB; MusicBrainz genre, label, year and the song's other homes.
 *
 * Nothing here throws past the fan-out: a service that fails is a status, not an error.
 */
import type {
  CatalogAlbum,
  CatalogAlbumDetail,
  CatalogArtist,
  CatalogArtistDetail,
  CatalogCollection,
  CatalogEnrichment,
  CatalogLyrics,
  CatalogPlatform,
  CatalogProviderId,
  CatalogQuery,
  CatalogResolveResult,
  CatalogSearchAggregate,
  CatalogSearchChunk,
  CatalogSearchDoneChunk,
  CatalogPlaylist,
  CatalogSearchSection,
  CatalogSource,
  CatalogSourceStatus,
  CatalogTrack,
} from '@now-playing/contracts';
import { CATALOG_COLLECTION_CAP, CATALOG_PAGE_MAX, CATALOG_PLATFORM_LABELS } from '@now-playing/contracts';
import { DomainError } from '../errors.js';
import { CatalogHttpError, type CatalogFetch } from './http.js';
import { ProviderHealth, TtlCache, describeError, statusFor, type Now, type Sleep } from './limits.js';
import { CatalogMerger, mergeSources, mergeTrack, sameRecording } from './merge.js';
import { HYDRATE_BUDGET_MS, HYDRATE_CONCURRENCY, HYDRATE_MAX_ROWS, fillTrack, needsFacts, runPool, trackChanged } from './hydrate.js';
import { headLike } from './http.js';
import { ProviderResting, type CatalogProvider, type ProviderResult } from './provider.js';
import { ApplePageChanged, fetchApplePlaylistPage, type ApplePlaylistPage } from './providers/applemusic-page.js';
import { DeezerClient, DeezerProvider, deezerTrack } from './providers/deezer.js';
import { ItunesClient, ItunesProvider } from './providers/itunes.js';
import { MusicBrainzClient, MusicBrainzProvider, releaseOfRecording } from './providers/musicbrainz.js';
import { ToolSearchProvider, type ToolSearchRunner } from './providers/ytdlp.js';
import { parseCatalogQuery, parseMusicLink, type MusicLink } from './query.js';
import { LinkReadError, TOOL_PLATFORMS, collectAllPages, collectionRef, coversOf, pageOf, pickDownloadSource, trackFromLink, type CollectedList, type LinkRead, type LinkReader, type LinkTrack } from './links.js';
import { LrclibClient, OdesliClient } from './services.js';

/** Every section a search can be asked for; `playlists` is listed by Deezer alone (UX-CAT-005). */
export const ALL_SECTIONS: readonly CatalogSearchSection[] = ['tracks', 'artists', 'albums', 'playlists'];
const ALL_PROVIDERS: readonly CatalogProviderId[] = ['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud'];
/** The platforms a service's search finds songs on; any other platform on a row only came as a link. */
const PROVIDER_PLATFORMS: Record<CatalogProviderId, CatalogPlatform[]> = { itunes: ['apple-music'], deezer: ['deezer'], musicbrainz: ['musicbrainz'], youtube: ['youtube', 'youtube-music'], soundcloud: ['soundcloud'] };
/** How long a query's rows are kept so its later pages never repeat them. */
const SESSION_TTL_MS = 15 * 60_000;
const SESSION_MAX = 200;

export interface CatalogEngineOptions {
  fetch: CatalogFetch;
  /** Sent to MusicBrainz and LRCLIB, which ask applications to name themselves. */
  userAgent: string;
  /** Runs yt-dlp searches; without it YouTube and SoundCloud are reported as not available here. */
  toolSearch?: ToolSearchRunner | undefined;
  /** Reads YouTube, SoundCloud, Bandcamp and Spotify links with the server's tools. */
  linkReader?: LinkReader | undefined;
  /** Which services are switched on (absent: all). Read on every search. */
  enabled?: (() => Partial<Record<CatalogProviderId, boolean>>) | undefined;
  /** A SongLink key, when an administrator set one. Read on every use. */
  odesliKey?: (() => string | null) | undefined;
  /** The Apple storefront. */
  country?: string | undefined;
  now?: Now | undefined;
  sleep?: Sleep | undefined;
  /** How many of a search's best rows get their other homes looked up before `done` (default 2). */
  crossLinkTop?: number | undefined;
  /** And how long that may take in all (default 5 s). */
  crossLinkBudgetMs?: number | undefined;
  /**
   * Whether a page's rows are filled in with their facts before `done` (UX-CAT-006; default on):
   * bpm, contributors, ISRC, explicit, the full date and cover from Deezer's detail, a MusicBrainz
   * row's cover from the Cover Art Archive. `hydrateBudgetMs` bounds the whole page (default 6 s).
   */
  hydrate?: boolean | undefined;
  hydrateBudgetMs?: number | undefined;
  /**
   * How long a Spotify song's read may spend on spotDL's YouTube Music match (`--preload`) before the
   * song is read without it (default 60 s). A failing match ran 26 s and 176 s on 2026-10-10; a read
   * without it, 18 s.
   */
  matchBudgetMs?: number | undefined;
  /** Per-call timeouts, shortened by tests. */
  timeouts?: Partial<Record<'itunes' | 'deezer' | 'musicbrainz' | 'tools' | 'lrclib' | 'odesli', number>> | undefined;
}

export interface CatalogSearchInput {
  q?: string | undefined;
  track?: string | undefined;
  artist?: string | undefined;
  album?: string | undefined;
  sections?: readonly CatalogSearchSection[] | undefined;
  providers?: readonly CatalogProviderId[] | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

interface Outcome {
  provider: CatalogProvider;
  result: ProviderResult | null;
  status: CatalogSourceStatus;
}

const MATCH_BUDGET_MS = 60_000;

/**
 * `run` with a signal that aborts when `parent` does or after `ms`, whichever is first; the timer is
 * cleared when `run` settles. (Not `AbortSignal.any`, which older WebViews lack.)
 */
async function withBudget<T>(parent: AbortSignal | undefined, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) stop();
  parent?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms);
  // Stop waiting when the budget ends even if `run` does not listen to its signal.
  const ended = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(controller.signal.reason);
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  try {
    return await Promise.race([run(controller.signal), ended]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', stop);
  }
}

/**
 * A list entry once the tool has described it: the page it named replaces the address the listing
 * gave on that platform. A SoundCloud set lists most songs as `api-v2.soundcloud.com/tracks/<n>`,
 * an address no one can open and the hub's tool may not reach; keeping it beside the song's page
 * would show the song twice on SoundCloud and could be picked for a download.
 */
function describedSources(listed: readonly CatalogSource[], described: readonly CatalogSource[]): CatalogSource[] {
  const platforms = new Set(described.filter((s) => s.matchedBy === 'link').map((s) => s.platform));
  return mergeSources(
    described,
    listed.filter((s) => !platforms.has(s.platform)),
  );
}

export class CatalogEngine {
  readonly itunes: ItunesClient;
  readonly deezer: DeezerClient;
  readonly musicbrainz: MusicBrainzClient;
  readonly lrclib: LrclibClient;
  readonly odesli: OdesliClient;
  readonly health: ProviderHealth;
  private readonly providers = new Map<CatalogProviderId, CatalogProvider>();
  private readonly now: Now;
  private readonly lyricsCache: TtlCache<CatalogLyrics>;
  private readonly enrichCache: TtlCache<CatalogEnrichment>;
  private readonly resolveCache: TtlCache<LinkRead>;
  private readonly searchCache: TtlCache<ProviderResult>;
  private readonly linksCache: TtlCache<CatalogSource[]>;
  private readonly applePageCache: TtlCache<ApplePlaylistPage | null>;
  /** Deezer's full record of a song, by `deezer:<id>`, `isrc:<ISRC>` and the name it was found by. */
  private readonly factsCache: TtlCache<CatalogTrack | null>;
  /** The Cover Art Archive's front image for a release, by release id (null: none listed). */
  private readonly coverCache: TtlCache<string | null>;
  private readonly sessions = new Map<string, { at: number; rows: Array<{ track: CatalogTrack; offset: number }> }>();

  constructor(private readonly options: CatalogEngineOptions) {
    this.now = options.now ?? Date.now;
    const t = options.timeouts ?? {};
    this.itunes = new ItunesClient({ fetch: options.fetch, country: options.country, now: this.now, timeoutMs: t.itunes ?? 8000 });
    this.deezer = new DeezerClient(options.fetch, t.deezer ?? 8000);
    this.musicbrainz = new MusicBrainzClient({ fetch: options.fetch, userAgent: options.userAgent, now: this.now, ...(options.sleep ? { sleep: options.sleep } : {}), timeoutMs: t.musicbrainz ?? 10_000 });
    this.lrclib = new LrclibClient(options.fetch, options.userAgent, t.lrclib ?? 10_000);
    this.odesli = new OdesliClient(options.fetch, options.odesliKey ?? (() => null), this.now, t.odesli ?? 10_000);
    this.health = new ProviderHealth(this.now);
    this.lyricsCache = new TtlCache(24 * 3600_000, 500, this.now);
    this.enrichCache = new TtlCache(24 * 3600_000, 1000, this.now);
    this.resolveCache = new TtlCache(10 * 60_000, 100, this.now);
    this.searchCache = new TtlCache(5 * 60_000, 300, this.now);
    this.linksCache = new TtlCache(24 * 3600_000, 1000, this.now);
    this.applePageCache = new TtlCache(10 * 60_000, 50, this.now);
    this.factsCache = new TtlCache(24 * 3600_000, 3000, this.now);
    this.coverCache = new TtlCache(24 * 3600_000, 1000, this.now);
    this.register(new ItunesProvider(this.itunes));
    this.register(new DeezerProvider(this.deezer));
    this.register(new MusicBrainzProvider(this.musicbrainz));
    if (options.toolSearch) {
      this.register(new ToolSearchProvider('youtube', options.toolSearch, t.tools ?? 30_000));
      this.register(new ToolSearchProvider('soundcloud', options.toolSearch, t.tools ?? 30_000));
    }
  }

  /** Add or replace a provider (tests, or a server with a provider of its own). */
  register(provider: CatalogProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Every service's standing right now, for a settings page. */
  standing(): CatalogSourceStatus[] {
    const enabled = this.options.enabled?.() ?? {};
    return ALL_PROVIDERS.map((id) => {
      if (!this.providers.has(id)) return statusFor(id, { state: 'skipped', error: 'yt-dlp is not available here' });
      if (enabled[id] === false) return statusFor(id, { state: 'skipped', error: 'Switched off' });
      const until = this.health.coolingUntil(id);
      if (until) return statusFor(id, { state: 'cooling-down', retryAt: new Date(until).toISOString(), error: this.health.lastError(id) });
      return statusFor(id, { state: 'ok', error: this.health.lastError(id) });
    });
  }

  /* ------------------------------------------------------------------ search */

  /**
   * The live feed. First chunk: every service's starting state (pending, skipped, cooling down).
   * Then one `results` chunk per service as it answers, carrying the rows it added or changed.
   * Then, for the best rows, a merge-only chunk with their other homes. Last, `done`.
   */
  async *search(input: CatalogSearchInput, signal?: AbortSignal): AsyncGenerator<CatalogSearchChunk> {
    const query = parseCatalogQuery(input);
    const sections = input.sections?.length ? [...new Set(input.sections)] : [...ALL_SECTIONS];
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(Math.max(1, input.limit ?? 25), 50);
    let seq = 0;
    const statuses = new Map<CatalogProviderId, CatalogSourceStatus>();
    const list = (): CatalogSourceStatus[] => ALL_PROVIDERS.filter((id) => statuses.has(id)).map((id) => statuses.get(id)!);

    if (query.kind === 'url') {
      yield { type: 'done', seq, query, status: [], page: { tracks: null, artists: null, albums: null, playlists: null }, totals: { tracks: 0, artists: 0, albums: 0, playlists: 0 }, resolve: query.url, linkedOnly: [] };
      return;
    }

    const wanted = new Set(input.providers?.length ? input.providers : ALL_PROVIDERS);
    const enabled = this.options.enabled?.() ?? {};
    const running: Array<Promise<Outcome>> = [];
    const askedSections = new Set<CatalogSearchSection>();
    for (const id of ALL_PROVIDERS) {
      if (!wanted.has(id)) continue;
      const provider = this.providers.get(id);
      if (!provider) {
        statuses.set(id, statusFor(id, { state: 'skipped', error: 'yt-dlp is not available here, so this service cannot be searched' }));
        continue;
      }
      if (enabled[id] === false) {
        statuses.set(id, statusFor(id, { state: 'skipped', error: 'Switched off in the catalog settings' }));
        continue;
      }
      const canSections = sections.filter((s) => provider.sections.includes(s));
      if (!canSections.length || !provider.supports(query)) {
        statuses.set(id, statusFor(id, { state: 'skipped', error: query.kind === 'isrc' ? 'It cannot look up an ISRC' : 'It has nothing in the sections asked for' }));
        continue;
      }
      const until = this.health.coolingUntil(id);
      if (until) {
        statuses.set(id, statusFor(id, { state: 'cooling-down', retryAt: new Date(until).toISOString(), error: this.health.lastError(id) }));
        continue;
      }
      statuses.set(id, statusFor(id, { state: 'pending' }));
      canSections.forEach((s) => askedSections.add(s));
      const tagged = this.ask(provider, query, { offset, limit, sections: canSections }, signal);
      running.push(tagged);
    }

    yield { type: 'results', seq: seq++, provider: null, query, tracks: [], artists: [], albums: [], playlists: [], status: list() };

    const merger = new CatalogMerger(query);
    const full: Partial<Record<CatalogSearchSection, boolean>> = {};
    // One song is one row across pages too: a later page's copy of a song an earlier page sent comes
    // back with that row's id (an upsert), never as a new row.
    const sessionKey = JSON.stringify([query.kind, query.text, query.track, query.artist, query.album, query.isrc, [...wanted].sort()]);
    const session = this.sessionFor(sessionKey, offset);
    const alias = new Map<string, string>();
    const canonical = (rows: CatalogTrack[]): CatalogTrack[] =>
      rows.map((row) => {
        if (!session || offset === 0) return row;
        const known = alias.get(row.id);
        const earlier = known ? session.rows.find((s) => s.track.id === known) : session.rows.find((s) => s.offset < offset && sameRecording(s.track, row));
        if (!earlier) return row;
        alias.set(row.id, earlier.track.id);
        earlier.track = mergeTrack(earlier.track, row);
        return earlier.track;
      });
    const pending = new Map(running.map((p, i) => [i, p.then((o) => ({ o, i }))]));
    while (pending.size) {
      const { o, i } = await Promise.race(pending.values());
      pending.delete(i);
      statuses.set(o.provider.id, o.status);
      const changed = o.result ? merger.add(o.result) : { tracks: [], artists: [], albums: [], playlists: [] };
      for (const [section, more] of Object.entries(o.result?.full ?? {})) if (more) full[section as CatalogSearchSection] = true;
      yield { type: 'results', seq: seq++, provider: o.provider.id, query, ...changed, tracks: canonical(changed.tracks), status: list() };
    }

    // The best rows' other homes, within a small budget: MusicBrainz is paced at one call a second.
    const top = this.options.crossLinkTop ?? 2;
    if (top > 0 && !signal?.aborted && sections.includes('tracks')) {
      const deadline = this.now() + (this.options.crossLinkBudgetMs ?? 5000);
      const candidates = merger
        .snapshot()
        .tracks.filter((t) => t.isrc && !t.sources.some((s) => s.platform === 'spotify'))
        .slice(0, top);
      for (const track of candidates) {
        if (this.now() >= deadline || signal?.aborted) break;
        const found = await this.withDeadline(this.crossLinks(track, signal), deadline - this.now()).catch(() => [] as CatalogSource[]);
        if (!found.length) continue;
        const patched = merger.patchTrack(track.id, (t) => ({ ...t, sources: mergeSources(t.sources, found) }));
        if (patched) yield { type: 'results', seq: seq++, provider: null, query, tracks: canonical([patched]), artists: [], albums: [], playlists: [], status: list() };
      }
    }

    // Every result carries its facts (UX-CAT-006): the page's rows, filled in from Deezer's detail and
    // the Cover Art Archive within a budget, sent as one last merge-only chunk the clients upsert by id.
    if (this.options.hydrate !== false && !signal?.aborted && sections.includes('tracks')) {
      const filled = await this.hydrateTracks(merger.snapshot().tracks, { signal, askDeezer: wanted.has('deezer') && statuses.get('deezer')?.state !== 'skipped' });
      const patched = filled.map((t) => merger.patchTrack(t.id, () => t)).filter((t): t is CatalogTrack => t !== null);
      if (patched.length) yield { type: 'results', seq: seq++, provider: null, query, tracks: canonical(patched), artists: [], albums: [], playlists: [], status: list() };
    }

    const snapshot = merger.snapshot();
    if (session) {
      for (const row of snapshot.tracks) {
        if (alias.has(row.id)) continue;
        const again = session.rows.findIndex((s) => s.offset === offset && (s.track.id === row.id || sameRecording(s.track, row)));
        if (again === -1) session.rows.push({ track: row, offset });
        else session.rows[again] = { track: row, offset };
      }
    }
    const searched = new Set<CatalogPlatform>(ALL_PROVIDERS.filter((id) => statuses.get(id) && statuses.get(id)!.state !== 'skipped').flatMap((id) => PROVIDER_PLATFORMS[id]));
    const linkedOnly: CatalogPlatform[] = [];
    for (const row of [...snapshot.tracks, ...snapshot.artists, ...snapshot.albums, ...snapshot.playlists]) for (const s of row.sources) if (!searched.has(s.platform) && !linkedOnly.includes(s.platform)) linkedOnly.push(s.platform);
    const page = (section: CatalogSearchSection) => (sections.includes(section) && askedSections.has(section) ? { offset, limit, hasMore: Boolean(full[section]) } : null);
    const done: CatalogSearchDoneChunk = {
      type: 'done',
      seq,
      query,
      status: list(),
      page: { tracks: page('tracks'), artists: page('artists'), albums: page('albums'), playlists: page('playlists') },
      totals: { tracks: snapshot.tracks.length, artists: snapshot.artists.length, albums: snapshot.albums.length, playlists: snapshot.playlists.length },
      resolve: null,
      linkedOnly,
    };
    yield done;
  }

  /**
   * The rows a query has sent so far, by page, for 15 minutes: page 0 starts afresh; a later page
   * finds the session its first page made (or none, after a restart — then only ids dedupe).
   */
  private sessionFor(key: string, offset: number): { rows: Array<{ track: CatalogTrack; offset: number }> } | null {
    const now = this.now();
    for (const [k, s] of this.sessions) if (now - s.at > SESSION_TTL_MS) this.sessions.delete(k);
    if (offset === 0) {
      const fresh = { at: now, rows: [] as Array<{ track: CatalogTrack; offset: number }> };
      this.sessions.delete(key);
      while (this.sessions.size >= SESSION_MAX) this.sessions.delete(this.sessions.keys().next().value!);
      this.sessions.set(key, fresh);
      return fresh;
    }
    const found = this.sessions.get(key) ?? null;
    if (found) found.at = now;
    return found;
  }

  /** The whole search as one answer (`?stream=0`): the feed, folded. */
  async searchAll(input: CatalogSearchInput, signal?: AbortSignal): Promise<CatalogSearchAggregate> {
    const tracks = new Map<string, CatalogTrack>();
    const artists = new Map<string, CatalogArtist>();
    const albums = new Map<string, CatalogAlbum>();
    const playlists = new Map<string, CatalogPlaylist>();
    let last: CatalogSearchChunk | null = null;
    for await (const chunk of this.search(input, signal)) {
      last = chunk;
      if (chunk.type !== 'results') continue;
      for (const t of chunk.tracks) tracks.set(t.id, t);
      for (const a of chunk.artists) artists.set(a.id, a);
      for (const a of chunk.albums) albums.set(a.id, a);
      for (const p of chunk.playlists) playlists.set(p.id, p);
    }
    const done = last?.type === 'done' ? last : null;
    const byRank = <T extends { rank: number }>(rows: T[]): T[] => rows.map((row, i) => ({ row, i })).sort((a, b) => b.row.rank - a.row.rank || a.i - b.i).map(({ row }) => row);
    return {
      query: done?.query ?? parseCatalogQuery(input),
      tracks: byRank([...tracks.values()]),
      artists: byRank([...artists.values()]),
      albums: byRank([...albums.values()]),
      playlists: byRank([...playlists.values()]),
      status: done?.status ?? [],
      page: done?.page ?? { tracks: null, artists: null, albums: null, playlists: null },
      resolve: done?.resolve ?? null,
    };
  }

  private async ask(provider: CatalogProvider, query: CatalogQuery, page: { offset: number; limit: number; sections: CatalogSearchSection[] }, outer?: AbortSignal): Promise<Outcome> {
    const started = this.now();
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    outer?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = JSON.stringify([provider.id, query.kind, query.text, query.track, query.artist, query.album, query.isrc, page.offset, page.limit, [...page.sections].sort()]);
    try {
      const work = this.searchCache.get(key, () => provider.search(query, { ...page, signal: controller.signal }));
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new CatalogHttpError(`${provider.id} did not answer within ${Math.round(provider.timeoutMs / 1000)} s`, 'timeout'));
        }, provider.timeoutMs);
      });
      const result = await Promise.race([work, deadline]);
      this.health.success(provider.id);
      const count = result.tracks.length + result.artists.length + result.albums.length + result.playlists.length;
      return { provider, result, status: statusFor(provider.id, { state: count ? 'ok' : 'empty', count, latencyMs: this.now() - started }) };
    } catch (error) {
      const latencyMs = this.now() - started;
      if (error instanceof ProviderResting) {
        this.health.restUntil(provider.id, error.retryAt, error.message);
        return { provider, result: null, status: statusFor(provider.id, { state: 'cooling-down', latencyMs, error: error.message, retryAt: new Date(error.retryAt).toISOString() }) };
      }
      if (error instanceof CatalogHttpError && error.kind === 'aborted') {
        return { provider, result: null, status: statusFor(provider.id, { state: 'failed', latencyMs, error: 'The search was cancelled' }) };
      }
      this.health.failure(provider.id, error);
      const until = this.health.coolingUntil(provider.id);
      const timedOut = error instanceof CatalogHttpError && error.kind === 'timeout';
      return { provider, result: null, status: statusFor(provider.id, { state: timedOut ? 'timeout' : 'failed', latencyMs, error: describeError(error), retryAt: until ? new Date(until).toISOString() : null }) };
    } finally {
      if (timer) clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  private withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new CatalogHttpError('Out of time', 'timeout')), Math.max(ms, 0))))]).finally(() => clearTimeout(timer));
  }

  /* ------------------------------------------------------------- the facts */

  /**
   * The rows' nulls filled in (UX-CAT-006): a Deezer source's `/track/{id}`, else the ISRC's
   * `/track/isrc:`, else one exact Deezer search taken only for the same recording; and a
   * MusicBrainz-only row's cover from the Cover Art Archive. At most `HYDRATE_CONCURRENCY` lookups in
   * flight, nothing started past the budget, every answer cached for a day (by Deezer id, by ISRC and
   * by the name it was found by). Deezer's quota (code 4) and its cooldown are respected: the first
   * refusal ends this page's Deezer lookups and rests the service as a search would.
   * Returns only the rows that changed, with their ids as given, so a chunk can upsert them.
   */
  async hydrateTracks(tracks: readonly CatalogTrack[], options: { signal?: AbortSignal | undefined; budgetMs?: number | undefined; max?: number | undefined; askDeezer?: boolean | undefined } = {}): Promise<CatalogTrack[]> {
    const deadline = this.now() + (options.budgetMs ?? this.options.hydrateBudgetMs ?? HYDRATE_BUDGET_MS);
    const rows = tracks.filter(needsFacts).slice(0, options.max ?? HYDRATE_MAX_ROWS);
    if (!rows.length) return [];
    const deezer = { on: (options.askDeezer ?? true) && this.options.enabled?.()?.deezer !== false && !this.health.coolingUntil('deezer') };
    const results = await runPool(rows, (row) => this.hydrateOne(row, deezer, deadline, options.signal), { concurrency: HYDRATE_CONCURRENCY, deadline, now: this.now, ...(options.signal ? { signal: options.signal } : {}) });
    const out: CatalogTrack[] = [];
    rows.forEach((row, i) => {
      const filled = results.get(i);
      if (filled && trackChanged(row, filled)) out.push(filled);
    });
    return out;
  }

  private async hydrateOne(row: CatalogTrack, deezer: { on: boolean }, deadline: number, signal?: AbortSignal): Promise<CatalogTrack> {
    let out = row;
    if (deezer.on) {
      const detail = await this.deezerDetail(row, deezer, deadline, signal);
      if (detail) out = fillTrack(out, detail.track, detail.matchedBy);
    }
    if (!out.artworkUrl && out.sources.length && out.sources.every((s) => s.platform === 'musicbrainz')) {
      const recording = out.sources[0]!.id;
      const release = recording ? releaseOfRecording(recording) : null;
      if (release) {
        const cover = await this.withDeadline(this.coverCache.get(release, () => this.coverArtFront(release, signal)), deadline - this.now()).catch(() => null);
        if (cover) out = { ...out, artworkUrl: cover };
      }
    }
    return out;
  }

  /** Deezer's full record of the row's recording, and how it was tied to the row. */
  private async deezerDetail(row: CatalogTrack, deezer: { on: boolean }, deadline: number, signal?: AbortSignal): Promise<{ track: CatalogTrack; matchedBy: CatalogSource['matchedBy'] } | null> {
    const guard = <T>(work: Promise<T>): Promise<T | null> =>
      this.withDeadline(work, deadline - this.now()).catch((error: unknown) => {
        if (error instanceof CatalogHttpError && error.kind === 'rate-limited') {
          deezer.on = false;
          this.health.restUntil('deezer', this.now() + Math.max(1000, error.retryAfterMs ?? 5000), error.message);
        }
        return null;
      });
    // What a detail says is kept under its own id and its ISRC too, so the next row or page that
    // reaches the same song asks nothing.
    const keep = (detail: CatalogTrack | null): CatalogTrack | null => {
      if (detail) {
        const id = detail.sources[0]?.id;
        if (id) this.factsCache.put(`deezer:${id}`, detail);
        if (detail.isrc) this.factsCache.put(`isrc:${detail.isrc}`, detail);
      }
      return detail;
    };
    const own = row.sources.find((s) => s.platform === 'deezer' && s.id);
    if (own?.id) {
      const id = own.id;
      const track = await guard(this.factsCache.get(`deezer:${id}`, () => this.deezer.track(id, signal).then(keep)));
      return track ? { track, matchedBy: 'search' } : null;
    }
    if (row.isrc) {
      const isrc = row.isrc;
      const track = await guard(this.factsCache.get(`isrc:${isrc}`, () => this.deezer.byIsrc(isrc, signal).then(keep)));
      return track ? { track, matchedBy: 'isrc' } : null;
    }
    const words = `${row.artists[0] ?? row.artist} ${row.title}`.replace(/\s+/g, ' ').trim();
    if (!words || !row.title) return null;
    const key = `name:${words.toLowerCase()}|${row.durationMs ? Math.round(row.durationMs / 5000) : ''}`;
    const track = await guard(
      this.factsCache.get(key, async () => {
        const found = await this.deezer.list(`/search/track?q=${encodeURIComponent(words)}&limit=5`, signal);
        const hit = found.rows.map((r) => deezerTrack(r)).find((c): c is CatalogTrack => c !== null && sameRecording(row, c));
        const id = hit?.sources[0]?.id;
        if (!id) return null;
        return this.factsCache.get(`deezer:${id}`, () => this.deezer.track(id, signal).then(keep));
      }),
    );
    return track ? { track, matchedBy: 'metadata' } : null;
  }

  /**
   * The Cover Art Archive's front image for a release, keylessly: `/release/{id}/front-500` answers
   * 307 to the archive when the release has a front cover (an <img> follows that), 404 when it has
   * none. Asked with redirects unfollowed (measured 2026-10-07; the hop is to archive.org, which the
   * servers' allowlists do not reach and need not). Null when there is no cover.
   */
  private async coverArtFront(releaseId: string, signal?: AbortSignal): Promise<string | null> {
    const url = `https://coverartarchive.org/release/${encodeURIComponent(releaseId)}/front-500`;
    const { found } = await headLike(this.options.fetch, url, { timeoutMs: this.options.timeouts?.musicbrainz ?? 8000, signal });
    return found ? url : null;
  }

  /* ----------------------------------------------------------- cross-links */

  /**
   * A song's other homes, keylessly: MusicBrainz's links for its ISRC (Spotify, YouTube Music,
   * Apple Music, Deezer, Tidal, Qobuz… as editors recorded them), Deezer's own ISRC lookup, and —
   * only with a key — SongLink.
   */
  async crossLinks(track: Pick<CatalogTrack, 'isrc' | 'title' | 'artist' | 'durationMs' | 'sources'>, signal?: AbortSignal): Promise<CatalogSource[]> {
    const found: CatalogSource[] = [];
    if (track.isrc) {
      const isrc = track.isrc;
      found.push(...(await this.linksCache.get(isrc, () => this.musicbrainz.linksByIsrc(isrc, signal)).catch(() => [] as CatalogSource[])));
      if (!track.sources.some((s) => s.platform === 'deezer') && !found.some((s) => s.platform === 'deezer')) {
        const dz = await this.deezer.byIsrc(track.isrc, signal).catch(() => null);
        const source = dz?.sources[0];
        if (source) found.push({ ...source, matchedBy: 'isrc' });
      }
    }
    if (this.odesli.configured) {
      const from = track.sources.find((s) => s.platform !== 'musicbrainz') ?? found.find((s) => s.platform !== 'musicbrainz');
      if (from) {
        const answer = await this.odesli.links(from.url, signal).catch(() => null);
        if (answer) found.push(...answer.sources);
      }
    }
    return mergeSources([], found);
  }

  /**
   * Where to fetch a song's audio: a downloadable source it already has; else one of its other homes
   * (MusicBrainz's links, SongLink with a key); else YouTube's own search for "artist - title",
   * taking only a result that is the same recording (same artist and title, within three seconds).
   * Null when none is found: the song is in a store, and nowhere it can be fetched from.
   */
  async findDownloadSource(track: CatalogTrack, signal?: AbortSignal): Promise<CatalogSource | null> {
    const own = pickDownloadSource(track.sources);
    if (own) return own;
    const linked = pickDownloadSource(await this.crossLinks(track, signal).catch(() => [] as CatalogSource[]));
    if (linked) return linked;
    const youtube = this.providers.get('youtube');
    if (!youtube || this.health.coolingUntil('youtube')) return null;
    const query = parseCatalogQuery({ q: `${track.artists[0] ?? track.artist} - ${track.title}` });
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const found = await this.withDeadline(youtube.search(query, { offset: 0, limit: 5, sections: ['tracks'], signal: controller.signal }), youtube.timeoutMs);
      const same = found.tracks.find((t) => sameRecording(track, t));
      return same?.sources[0] ? { ...same.sources[0], matchedBy: 'metadata' } : null;
    } catch {
      controller.abort();
      return null;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /* --------------------------------------------------------------- details */

  private split(id: string): { platform: string; native: string } {
    const at = id.indexOf(':');
    if (at <= 0) throw new DomainError('validation', 'Say which platform: an id is “platform:id”, as a result’s id is');
    return { platform: id.slice(0, at), native: id.slice(at + 1) };
  }

  async album(id: string, offset = 0, limit = 100, signal?: AbortSignal): Promise<CatalogAlbumDetail> {
    const { platform, native } = this.split(id);
    if (platform === 'deezer') {
      const found = await this.upstream(() => this.deezer.album(native, offset, Math.min(limit, CATALOG_COLLECTION_CAP - offset), signal), 'Deezer');
      if (!found) throw new DomainError('not-found', 'Deezer has no album with that id');
      const total = found.total ?? found.album.trackCount;
      const link: MusicLink = { platform: 'deezer', kind: 'album', id: native, url: `https://www.deezer.com/album/${native}` };
      return {
        album: found.album,
        page: { tracks: await this.withFacts(found.tracks.slice(0, limit), signal), offset, limit, total, hasMore: offset + Math.min(found.tracks.length, limit) < Math.min(total ?? 0, CATALOG_COLLECTION_CAP), capped: (total ?? 0) > CATALOG_COLLECTION_CAP },
        collection: collectionRef(link, 'album', found.album.title, found.album.artist),
      };
    }
    if (platform === 'apple-music') {
      const found = await this.upstream(() => this.itunes.album(native, signal), 'Apple Music');
      if (!found) throw new DomainError('not-found', 'Apple Music has no album with that id');
      const url = found.album.sources[0]?.url ?? `https://music.apple.com/album/${native}`;
      const link: MusicLink = { platform: 'apple-music', kind: 'album', id: native, url };
      const page = pageOf(found.tracks, offset, limit, found.album.trackCount ?? found.tracks.length, false);
      page.tracks = await this.withFacts(page.tracks, signal);
      return { album: found.album, page, collection: collectionRef(link, 'album', found.album.title, found.album.artist) };
    }
    throw new DomainError('unsupported', `Albums are opened from Deezer or Apple Music; ${platform} albums are opened by pasting their link`);
  }

  /** A detail page's songs with their facts filled in (UX-CAT-006), within a shorter budget than a search's. */
  private async withFacts(tracks: CatalogTrack[], signal?: AbortSignal): Promise<CatalogTrack[]> {
    if (this.options.hydrate === false || !tracks.length) return tracks;
    const filled = await this.hydrateTracks(tracks, { signal, budgetMs: Math.min(this.options.hydrateBudgetMs ?? HYDRATE_BUDGET_MS, 4000) });
    if (!filled.length) return tracks;
    const byId = new Map(filled.map((t) => [t.id, t]));
    return tracks.map((t) => byId.get(t.id) ?? t);
  }

  async artist(id: string, input: { albumsOffset?: number; albumsLimit?: number; topLimit?: number } = {}, signal?: AbortSignal): Promise<CatalogArtistDetail> {
    const { platform, native } = this.split(id);
    const albumsOffset = input.albumsOffset ?? 0;
    const albumsLimit = input.albumsLimit ?? 25;
    const topLimit = input.topLimit ?? 10;
    if (platform === 'deezer') {
      const found = await this.upstream(() => this.deezer.artist(native, albumsOffset, albumsLimit, topLimit, signal), 'Deezer');
      if (!found) throw new DomainError('not-found', 'Deezer has no artist with that id');
      return { artist: found.artist, topTracks: await this.withFacts(found.topTracks, signal), albums: found.albums, albumsPage: { offset: albumsOffset, limit: albumsLimit, hasMore: found.albumsTotal !== null ? albumsOffset + found.albums.length < found.albumsTotal : found.albums.length >= albumsLimit } };
    }
    if (platform === 'apple-music') {
      const found = await this.upstream(() => this.itunes.artist(native, albumsOffset + albumsLimit, topLimit, signal), 'Apple Music');
      if (!found) throw new DomainError('not-found', 'Apple Music has no artist with that id');
      const albums = found.albums.slice(albumsOffset, albumsOffset + albumsLimit);
      return { artist: found.artist, topTracks: await this.withFacts(found.topTracks.slice(0, topLimit), signal), albums, albumsPage: { offset: albumsOffset, limit: albumsLimit, hasMore: found.albums.length >= albumsOffset + albumsLimit } };
    }
    throw new DomainError('unsupported', `Artists are opened from Deezer or Apple Music, not ${platform}`);
  }

  private async upstream<T>(work: () => Promise<T>, name: string): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof ProviderResting) throw new DomainError('rate-limited', error.message, { retryAfterSeconds: Math.max(1, Math.ceil((error.retryAt - this.now()) / 1000)) });
      if (error instanceof CatalogHttpError && error.kind === 'rate-limited') throw new DomainError('rate-limited', `${name} asked to slow down`, { retryAfterSeconds: Math.max(1, Math.ceil((error.retryAfterMs ?? 5000) / 1000)) });
      throw new DomainError('unavailable', `${name} could not be read: ${describeError(error)}`);
    }
  }

  /* --------------------------------------------------------------- resolve */

  /** What a pasted link is. Never throws for a link it cannot read: it says why, in `reason`. */
  async resolve(input: string, offset = 0, limit = 100, signal?: AbortSignal): Promise<CatalogResolveResult> {
    const resolvedAt = new Date(this.now()).toISOString();
    const link = parseMusicLink(input);
    const base = { track: null, collection: null, artist: null, reason: null, resolvedAt };
    if (!link) return { ...base, url: input.slice(0, 2048), platform: null, kind: 'unsupported', reason: 'That is not a link to music on a platform the catalog reads.' };
    const answer = (patch: Partial<CatalogResolveResult> & Pick<CatalogResolveResult, 'kind'>): CatalogResolveResult => ({ ...base, url: link.url, platform: link.platform, ...patch });
    const label = CATALOG_PLATFORM_LABELS[link.platform];
    try {
      if (link.platform === 'deezer') return await this.resolveDeezer(link, offset, limit, answer, signal);
      if (link.platform === 'apple-music') return await this.resolveApple(link, offset, limit, answer, signal);
      if (TOOL_PLATFORMS.includes(link.platform)) return await this.resolveWithTool(link, offset, limit, answer, signal);
      return await this.resolveWithOdesli(link, answer, signal);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'not-found') return answer({ kind: 'unavailable', reason: `${label} has nothing at that address.` });
      if (error instanceof DomainError) throw error;
      return answer({ kind: 'unavailable', reason: `${label} could not be read just now: ${describeError(error)}` });
    }
  }

  private async resolveDeezer(link: MusicLink, offset: number, limit: number, answer: (p: Partial<CatalogResolveResult> & Pick<CatalogResolveResult, 'kind'>) => CatalogResolveResult, signal?: AbortSignal): Promise<CatalogResolveResult> {
    if (!link.id) return answer({ kind: 'unsupported', reason: 'A Deezer short link says nothing until it is opened. Open it, then paste the address it goes to.' });
    if (link.kind === 'track') {
      const track = await this.upstream(() => this.deezer.track(link.id!, signal), 'Deezer');
      return track ? answer({ kind: 'track', track }) : answer({ kind: 'unavailable', reason: 'Deezer has no song at that address.' });
    }
    if (link.kind === 'album') {
      const detail = await this.album(`deezer:${link.id}`, offset, limit, signal);
      return answer({ kind: 'album', collection: { ref: detail.collection, artworkUrl: detail.album.artworkUrl, covers: coversOf(detail.page.tracks), releaseDate: detail.album.releaseDate, page: detail.page } });
    }
    if (link.kind === 'playlist') {
      const found = await this.upstream(() => this.deezer.playlist(link.id!, offset, Math.min(limit, CATALOG_COLLECTION_CAP - offset), signal), 'Deezer');
      if (!found) return answer({ kind: 'unavailable', reason: 'Deezer would not list that playlist: it is private or gone.' });
      const { playlist } = found;
      const tracks = found.tracks.slice(0, limit);
      const head = offset === 0 ? tracks : ((await this.upstream(() => this.deezer.playlist(link.id!, 0, 8, signal), 'Deezer'))?.tracks ?? []);
      const total = playlist.total;
      const collection: CatalogCollection = {
        ref: collectionRef(link, 'playlist', playlist.title, playlist.owner, playlist.url),
        artworkUrl: playlist.artworkUrl,
        covers: coversOf(head),
        releaseDate: null,
        page: { tracks, offset, limit, total, hasMore: offset + tracks.length < Math.min(total ?? 0, CATALOG_COLLECTION_CAP), capped: (total ?? 0) > CATALOG_COLLECTION_CAP },
      };
      return answer({ kind: 'playlist', collection });
    }
    if (link.kind === 'artist') {
      const detail = await this.artist(`deezer:${link.id}`, {}, signal);
      return answer({ kind: 'artist', artist: detail.artist });
    }
    return answer({ kind: 'unsupported', reason: 'That Deezer address is not a song, album, playlist or artist.' });
  }

  private async resolveApple(link: MusicLink, offset: number, limit: number, answer: (p: Partial<CatalogResolveResult> & Pick<CatalogResolveResult, 'kind'>) => CatalogResolveResult, signal?: AbortSignal): Promise<CatalogResolveResult> {
    if (link.kind === 'track' && link.id) {
      const track = await this.upstream(() => this.itunes.track(link.id!, signal), 'Apple Music');
      return track ? answer({ kind: 'track', track }) : answer({ kind: 'unavailable', reason: 'Apple Music has no song at that address in this storefront.' });
    }
    if (link.kind === 'album' && link.id) {
      const detail = await this.album(`apple-music:${link.id}`, offset, limit, signal);
      const full = await this.upstream(() => this.itunes.album(link.id!, signal), 'Apple Music');
      return answer({ kind: 'album', collection: { ref: detail.collection, artworkUrl: detail.album.artworkUrl, covers: coversOf(full?.tracks ?? detail.page.tracks), releaseDate: detail.album.releaseDate, page: detail.page } });
    }
    if (link.kind === 'artist' && link.id) {
      const detail = await this.artist(`apple-music:${link.id}`, {}, signal);
      return answer({ kind: 'artist', artist: detail.artist });
    }
    if (link.kind === 'playlist' && link.id) return this.resolveApplePlaylist(link, offset, limit, answer, signal);
    return answer({ kind: 'unsupported', reason: 'That Apple Music address is not a song, album or artist.' });
  }

  private async resolveWithTool(link: MusicLink, offset: number, limit: number, answer: (p: Partial<CatalogResolveResult> & Pick<CatalogResolveResult, 'kind'>) => CatalogResolveResult, signal?: AbortSignal): Promise<CatalogResolveResult> {
    const label = CATALOG_PLATFORM_LABELS[link.platform];
    const reader = this.options.linkReader;
    if (!reader) return answer({ kind: 'unsupported', reason: `${label} links are read by yt-dlp or spotDL, which are not available here.` });
    const match = link.platform === 'spotify' && link.kind === 'track';
    let read: LinkRead;
    try {
      read = await this.resolveCache.get(`${link.url}|${match ? 'match' : ''}`, () => (match ? withBudget(signal, this.options.matchBudgetMs ?? MATCH_BUDGET_MS, (budget) => reader(link.url, { signal: budget, match })) : reader(link.url, { signal, match })));
    } catch (error) {
      // spotDL's `--preload` writes `null` for the song when its YouTube Music match fails (no
      // "songs" result, or a video its yt-dlp cannot open — measured 2026-10-10), although Spotify's
      // own data was read. The song is still worth showing: read it again without the match, and
      // spotDL matches it again when it is downloaded. A missing tool is not retried.
      if (!match || signal?.aborted || (error instanceof LinkReadError && error.code === 'tool-missing')) return answer({ kind: 'unavailable', reason: this.unreadable(link, error) });
      try {
        read = await this.resolveCache.get(`${link.url}|`, () => reader(link.url, { signal, match: false }));
      } catch (again) {
        return answer({ kind: 'unavailable', reason: this.unreadable(link, again) });
      }
    }
    const platform: CatalogPlatform = link.platform;
    if (read.kind === 'track') {
      const track = trackFromLink(read.track, { platform });
      return track ? answer({ kind: 'track', track }) : answer({ kind: 'unavailable', reason: `${label} described nothing playable at that address.` });
    }
    // Every entry, in order, up to the bound (CATALOG_COLLECTION_CAP); past it the list says so.
    const rows: Array<{ track: CatalogTrack; bare: boolean; position: number }> = [];
    read.entries.slice(0, CATALOG_COLLECTION_CAP).forEach((e, i) => {
      const track = trackFromLink(e, { platform, owner: link.kind === 'album' ? read.owner : null, album: link.kind === 'album' ? read.title : null });
      if (track) rows.push({ track, bare: !e.title, position: i + 1 });
    });
    const all = rows.map((r) => r.track);
    await this.fillCovers(all, reader, signal);
    const page = pageOf(all, offset, limit, read.total ?? read.entries.length, read.capped || read.entries.length > CATALOG_COLLECTION_CAP || (read.total ?? 0) > CATALOG_COLLECTION_CAP);
    page.tracks = await this.hydratePage(link, rows.slice(offset, offset + page.tracks.length), page.tracks, reader, signal);
    const kind: 'album' | 'playlist' = link.kind === 'album' ? 'album' : 'playlist';
    const collection: CatalogCollection = {
      ref: collectionRef(link, kind, read.title, read.owner),
      artworkUrl: read.artworkUrl,
      covers: coversOf(all),
      releaseDate: read.date && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(read.date) ? read.date : null,
      page,
    };
    if (link.kind === 'artist') {
      const artist: CatalogArtist = { id: `${platform}:${link.id ?? link.url}`, name: read.owner ?? read.title, pictureUrl: read.artworkUrl, albumCount: null, fans: null, genre: null, sources: [{ platform, id: link.id, url: link.url, previewUrl: null, matchedBy: 'link' }], rank: 0 };
      return answer({ kind: 'artist', artist, collection });
    }
    return answer({ kind, collection });
  }

  /**
   * A list whose entries came without artwork (a SoundCloud set lists addresses only) gets its first
   * four looked up one by one, two at a time, so its mosaic is never blank. Each answer also fills
   * that entry's title and artist.
   */
  private async fillCovers(tracks: CatalogTrack[], reader: LinkReader, signal?: AbortSignal): Promise<void> {
    const need = 4 - coversOf(tracks).length;
    if (need <= 0) return;
    const missing = tracks.map((t, i) => ({ t, i })).filter(({ t }) => !t.artworkUrl).slice(0, Math.min(need + 2, 6));
    const one = async ({ t, i }: { t: CatalogTrack; i: number }): Promise<void> => {
      const url = t.sources[0]?.url;
      if (!url || coversOf(tracks).length >= 4) return;
      const read = await this.resolveCache.get(`${url}|`, () => reader(url, { signal })).catch(() => null);
      if (read?.kind !== 'track') return;
      const filled = trackFromLink(read.track, { platform: t.sources[0]!.platform });
      if (filled) tracks[i] = { ...filled, id: t.id, album: t.album ?? filled.album, sources: describedSources(t.sources, filled.sources) };
    };
    for (let k = 0; k < missing.length; k += 2) await Promise.all(missing.slice(k, k + 2).map(one));
  }

  /**
   * A SoundCloud set lists most of its songs as bare ids (yt-dlp's flat listing). The page asked for
   * is described in one batch — the reader runs the tool once for exactly those positions
   * (`items`), and the tool looks the ids up in batches — and each bare row takes its title, artist,
   * artwork and length. Positions keep the order; if the answer does not line up, the bare rows stay.
   */
  private async hydratePage(link: MusicLink, rows: Array<{ track: CatalogTrack; bare: boolean; position: number }>, tracks: CatalogTrack[], reader: LinkReader, signal?: AbortSignal): Promise<CatalogTrack[]> {
    const bare = rows.filter((r) => r.bare);
    if (!bare.length) return tracks;
    const positions = bare.map((r) => r.position);
    const key = `${link.url}|items:${positions.join(',')}`;
    const read = await this.resolveCache.get(key, () => reader(link.url, { signal, items: positions })).catch(() => null);
    if (read?.kind !== 'collection' || read.entries.length !== bare.length) return tracks;
    const filled = new Map<string, LinkTrack>(bare.map((r, i) => [r.track.id, read.entries[i]!]));
    return tracks.map((t) => {
      const entry = filled.get(t.id);
      if (!entry?.title) return t;
      const full = trackFromLink(entry, { platform: t.sources[0]!.platform, album: t.album });
      return full ? { ...full, id: t.id, trackNumber: t.trackNumber, album: t.album ?? full.album, sources: describedSources(t.sources, full.sources) } : t;
    });
  }

  /** An Apple Music playlist from its public page (DEC-039, owner decision 2026-10-06). */
  private async resolveApplePlaylist(link: MusicLink, offset: number, limit: number, answer: (p: Partial<CatalogResolveResult> & Pick<CatalogResolveResult, 'kind'>) => CatalogResolveResult, signal?: AbortSignal): Promise<CatalogResolveResult> {
    let found: ApplePlaylistPage | null;
    try {
      found = await this.applePageCache.get(link.url, () => fetchApplePlaylistPage(this.options.fetch, link.url, link.id!, { timeoutMs: this.options.timeouts?.itunes ?? 15_000, signal }));
    } catch (error) {
      if (error instanceof ApplePageChanged) return answer({ kind: 'unavailable', reason: error.message });
      throw error;
    }
    if (!found) return answer({ kind: 'unavailable', reason: 'Apple Music has no playlist at that address, or it is private.' });
    const all = found.tracks.slice(0, CATALOG_COLLECTION_CAP);
    const total = found.total ?? all.length;
    const page = pageOf(all, offset, limit, total, total > CATALOG_COLLECTION_CAP);
    // The page carries the songs it shows; when Apple says there are more, the list says so.
    const short = total > all.length && all.length < CATALOG_COLLECTION_CAP;
    return answer({
      kind: 'playlist',
      collection: { ref: collectionRef(link, 'playlist', found.title, found.owner), artworkUrl: found.artworkUrl, covers: coversOf(all), releaseDate: null, page: { ...page, total } },
      reason: short ? `Apple’s public page for this playlist lists its first ${all.length} of ${total} songs; the rest can’t be read without an Apple account.` : null,
    });
  }

  /**
   * Every song of an album or playlist link, in order, page after page (`CATALOG_PAGE_MAX` at a
   * time), up to `CATALOG_COLLECTION_CAP`. Stopping at the bound is reported (`capped`), never silent.
   */
  resolveAll(input: string, options: { signal?: AbortSignal; max?: number; onPage?: (result: CatalogResolveResult) => void } = {}): Promise<CollectedList> {
    return collectAllPages((offset, limit) => this.resolve(input, offset, limit, options.signal), { max: options.max ?? CATALOG_COLLECTION_CAP, pageSize: CATALOG_PAGE_MAX, ...(options.signal ? { signal: options.signal } : {}), ...(options.onPage ? { onPage: options.onPage } : {}) });
  }

  private unreadable(link: MusicLink, error: unknown): string {
    const said = describeError(error);
    if (link.platform === 'spotify' && (link.kind === 'playlist' || link.kind === 'unknown')) {
      return `Spotify would not list this playlist. It is private, or one Spotify made itself (Spotify’s API does not share those with other apps). spotDL said: ${said}`;
    }
    if (error instanceof LinkReadError && error.code === 'tool-missing') return said;
    if (error instanceof LinkReadError && error.code === 'busy') return `Too many links are being read at once. Try again in a moment. (${said})`;
    return `${CATALOG_PLATFORM_LABELS[link.platform]} could not be read: ${said}`;
  }

  /** Tidal, Qobuz and Amazon Music publish no keyless API; with a SongLink key their links still resolve. */
  private async resolveWithOdesli(link: MusicLink, answer: (p: Partial<CatalogResolveResult> & Pick<CatalogResolveResult, 'kind'>) => CatalogResolveResult, signal?: AbortSignal): Promise<CatalogResolveResult> {
    const label = CATALOG_PLATFORM_LABELS[link.platform];
    if (!this.odesli.configured) return answer({ kind: 'unsupported', reason: `${label} has no public API to read a link with, and SongLink (which could) now needs a key. An administrator can add one in the catalog settings.` });
    const found = await this.odesli.links(link.url, signal);
    if (!found || !found.title) return answer({ kind: 'unavailable', reason: `SongLink did not recognise that ${label} link.` });
    const own: CatalogSource = { platform: link.platform, id: link.id, url: link.url, previewUrl: null, matchedBy: 'link' };
    const sources = mergeSources([own], found.sources);
    if (found.kind === 'album' || link.kind === 'album') {
      // The album's songs come from the same album on Deezer when SongLink names it there.
      const dz = sources.find((s) => s.platform === 'deezer' && s.id);
      if (dz?.id) {
        const detail = await this.album(`deezer:${dz.id}`, 0, CATALOG_PAGE_MAX, signal).catch(() => null);
        if (detail) return answer({ kind: 'album', collection: { ref: collectionRef(link, 'album', found.title, found.artist), artworkUrl: found.artworkUrl ?? detail.album.artworkUrl, covers: coversOf(detail.page.tracks), releaseDate: detail.album.releaseDate, page: detail.page } });
      }
      return answer({ kind: 'album', collection: { ref: collectionRef(link, 'album', found.title, found.artist), artworkUrl: found.artworkUrl, covers: found.artworkUrl ? [found.artworkUrl] : [], releaseDate: null, page: { tracks: [], offset: 0, limit: 1, total: null, hasMore: false, capped: false } }, reason: `${label} albums list their songs only when the same album is on Deezer.` });
    }
    const track: CatalogTrack = { id: `${link.platform}:${link.id ?? link.url}`, title: found.title, artist: found.artist ?? '', artists: found.artist ? [found.artist] : [], album: null, albumArtist: null, durationMs: null, isrc: null, artworkUrl: found.artworkUrl, releaseDate: null, year: null, trackNumber: null, discNumber: null, bpm: null, explicit: null, genre: null, label: null, sources, rank: 0 };
    return answer({ kind: 'track', track });
  }

  /* ---------------------------------------------------- lyrics, enrichment */

  lyrics(input: { title: string; artist: string; album?: string | undefined; durationSec?: number | undefined }, signal?: AbortSignal): Promise<CatalogLyrics> {
    const key = JSON.stringify([input.title.toLowerCase(), input.artist.toLowerCase(), input.album?.toLowerCase() ?? null, input.durationSec ?? null]);
    return this.lyricsCache.get(key, () => this.upstream(() => this.lrclib.lyrics(input, signal), 'LRCLIB'));
  }

  /** MusicBrainz's genre, label and year for a song, and its other homes. Cached for a day. */
  enrich(input: { isrc?: string | null | undefined; title?: string | null | undefined; artist?: string | null | undefined; durationMs?: number | null | undefined }, signal?: AbortSignal): Promise<CatalogEnrichment> {
    const key = input.isrc ? `isrc:${input.isrc}` : JSON.stringify([input.title?.toLowerCase(), input.artist?.toLowerCase(), input.durationMs ? Math.round(input.durationMs / 5000) : null]);
    return this.enrichCache.get(key, () => this.upstream(() => this.musicbrainz.enrich(input, signal), 'MusicBrainz'));
  }

  /** Enrichment with the song's other homes added (Deezer by ISRC; SongLink with a key). */
  async enrichWithLinks(input: { isrc?: string | null | undefined; title?: string | null | undefined; artist?: string | null | undefined; durationMs?: number | null | undefined }, signal?: AbortSignal): Promise<CatalogEnrichment> {
    const base = await this.enrich(input, signal);
    const isrc = input.isrc ?? base.isrc;
    const extra = await this.crossLinks({ isrc, title: input.title ?? '', artist: input.artist ?? '', durationMs: input.durationMs ?? null, sources: base.sources }, signal).catch(() => [] as CatalogSource[]);
    return { ...base, isrc, sources: mergeSources(base.sources, extra) };
  }

  /** Whether two rows are one recording (exported for the player's own merging). */
  static sameRecording = sameRecording;
}

/**
 * The music catalog for the companion's Search tool (DEC-039): the embedded helper's
 * `/helper/v1/catalog/*`, asked from the main process.
 *
 * The window cannot reach the helper itself — its content security policy keeps `connect-src` to
 * the app, and the helper's token never leaves this process — so each read is an IPC channel, and a
 * search's NDJSON is read here as it arrives and passed on chunk by chunk (`event:catalog-chunk`,
 * tagged with the window's `searchId`). Downloads take the helper's own path (`/helper/v1/fetch`),
 * as every download on this PC does, and land where Settings says. Starred albums and playlists
 * and the filter are kept in the companion's own store.
 */
import { CatalogAlbumDetail, CatalogArtistDetail, CatalogEnrichment, CatalogLyrics, CatalogResolveResult, HELPER_CATALOG_ROUTES, HELPER_ROUTES, HelperJob, SavedCatalogItem, SavedCatalogTombstone, type SavedCatalogItemList, type SavedCatalogItemRef, type CatalogSearchChunk, type CatalogSource, type CatalogTrack, type DownloadAuthorizationBasis, type OutputFormat } from '@now-playing/contracts';
import { CatalogBatchQueueError, mergeSavedCatalog, pickDownloadSource, queueResolvedCatalogBatch, readCatalogStream, savedCatalogKey, savedCatalogRefFromKey } from '@now-playing/domain/catalog';
import type { z } from 'zod';
import { CatalogFilter, type CatalogSearchIpc } from '../shared/ipc.js';

export interface CatalogStore {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown, now: string): void;
}

export interface SavedCatalogTransport {
  available?(): boolean;
  list(): Promise<SavedCatalogItemList>;
  put(item: SavedCatalogItem): Promise<SavedCatalogItemList>;
  remove(ref: SavedCatalogItemRef, at: string): Promise<SavedCatalogItemList>;
}

export interface CompanionCatalogOptions {
  /** Where the embedded helper listens and its token; null while it is not running. */
  helper: () => { origin: string | null; token: string | null; reason: string | null };
  store: CatalogStore;
  /** Paired Hub's `library:sync` endpoints; absent when no authorized Hub is available. */
  sharedCatalog?: SavedCatalogTransport;
  /** Push a chunk to the window. */
  send: (payload: { searchId: string; chunk: CatalogSearchChunk }) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const SAVED_KEY = 'catalog.saved';
const SAVED_TOMBSTONES_KEY = 'catalog.savedTombstones';
const FILTER_KEY = 'catalog.filter';
const SAVED_CAP = 2000;
const DEFAULT_FILTER: CatalogFilter = { sections: ['tracks', 'artists', 'albums', 'playlists'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud'] };

type Answer<T> = { result: T | null; reason: string | null };

export class CompanionCatalog {
  private readonly running = new Map<string, AbortController>();
  private readonly fetchImpl: typeof fetch;
  private savedSync: Promise<void> | null = null;
  private savedRetry: ReturnType<typeof setTimeout> | null = null;
  private savedRetryDelayMs = 1_000;

  constructor(private readonly options: CompanionCatalogOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private where(): { origin: string; token: string } | string {
    const { origin, token, reason } = this.options.helper();
    if (!origin || !token) return reason ?? 'The helper isn’t running, so the music services can’t be asked. Check Settings ▸ Network.';
    return { origin, token };
  }

  /** What went wrong with a helper call, in its own words when it gave some. */
  private async refusal(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) return body.message;
    } catch {
      // Not JSON: the status says enough.
    }
    return response.status === 429 ? 'Too many searches at once. Wait a moment, then try again.' : 'The music services could not be read just now.';
  }

  private async get<S extends z.ZodType>(path: string, query: Record<string, string | number | undefined>, schema: S, signal?: AbortSignal): Promise<Answer<z.infer<S>>> {
    const at = this.where();
    if (typeof at === 'string') return { result: null, reason: at };
    const url = new URL(path, at.origin);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    try {
      const response = await this.fetchImpl(url, { headers: { 'x-helper-token': at.token, accept: 'application/json' }, ...(signal ? { signal } : {}) });
      if (!response.ok) return { result: null, reason: await this.refusal(response) };
      const parsed = schema.safeParse(await response.json());
      return parsed.success ? { result: parsed.data, reason: null } : { result: null, reason: 'The helper answered with something this window does not understand.' };
    } catch (error) {
      return { result: null, reason: `The helper could not be reached: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** A search, read as it arrives; each chunk goes to the window. Resolves when it ends. */
  async search(request: CatalogSearchIpc): Promise<{ reason: string | null }> {
    const at = this.where();
    if (typeof at === 'string') return { reason: at };
    this.running.get(request.searchId)?.abort();
    const controller = new AbortController();
    this.running.set(request.searchId, controller);
    const url = new URL(HELPER_CATALOG_ROUTES.search, at.origin);
    const query: Record<string, string | number | undefined> = { q: request.q, track: request.track, artist: request.artist, album: request.album, sections: request.sections.join(','), providers: request.providers.join(','), offset: request.offset || undefined, limit: request.limit };
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    try {
      const response = await this.fetchImpl(url, { headers: { 'x-helper-token': at.token, accept: 'application/x-ndjson' }, signal: controller.signal });
      if (!response.ok || !response.body) return { reason: response.ok ? 'The helper sent nothing back.' : await this.refusal(response) };
      for await (const chunk of readCatalogStream(response.body)) {
        if (controller.signal.aborted) break;
        this.options.send({ searchId: request.searchId, chunk });
      }
      return { reason: null };
    } catch (error) {
      if (controller.signal.aborted) return { reason: null };
      return { reason: `The helper could not be reached: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      if (this.running.get(request.searchId) === controller) this.running.delete(request.searchId);
    }
  }

  cancel(searchId: string): { ok: boolean } {
    const controller = this.running.get(searchId);
    controller?.abort();
    this.running.delete(searchId);
    return { ok: Boolean(controller) };
  }

  album(id: string, offset: number, limit: number) {
    return this.get(HELPER_CATALOG_ROUTES.album, { id, offset, limit }, CatalogAlbumDetail);
  }

  artist(id: string, albumsOffset: number) {
    return this.get(HELPER_CATALOG_ROUTES.artist, { id, albumsOffset, albumsLimit: 12, topLimit: 10 }, CatalogArtistDetail);
  }

  resolve(url: string, offset: number, limit: number) {
    return this.get(HELPER_CATALOG_ROUTES.resolve, { url, offset, limit }, CatalogResolveResult);
  }

  lyrics(input: { title: string; artist: string; album?: string | undefined; durationSec?: number | undefined }) {
    return this.get(HELPER_CATALOG_ROUTES.lyrics, input, CatalogLyrics);
  }

  enrich(input: { isrc?: string | undefined; title?: string | undefined; artist?: string | undefined; durationSec?: number | undefined }, links = false) {
    return this.get(HELPER_CATALOG_ROUTES.enrich, { ...input, links: links ? 1 : 0 }, CatalogEnrichment);
  }

  /**
   * A catalog song through the helper's download path: its best source (YouTube Music, YouTube,
   * SoundCloud, Bandcamp, then Spotify through spotDL), else one MusicBrainz knows of, with the
   * person's rights basis. The file lands where Settings says, as every download on this PC does.
   */
  async download(input: { track: CatalogTrack; basis: DownloadAuthorizationBasis; format?: OutputFormat | undefined }): Promise<{ job: HelperJob | null; source: CatalogSource | null; reason: string | null }> {
    const eligibleSources = input.track.sources.filter((candidate) => candidate.platform !== 'soundcloud');
    let source = pickDownloadSource(eligibleSources);
    if (!source) {
      const more = await this.enrich({ isrc: input.track.isrc ?? undefined, title: input.track.title, artist: input.track.artists[0] ?? input.track.artist, durationSec: input.track.durationMs ? Math.round(input.track.durationMs / 1000) : undefined }, true);
      source = pickDownloadSource((more.result?.sources ?? []).filter((candidate) => candidate.platform !== 'soundcloud'));
    }
    if (!source) return { job: null, source: null, reason: `“${input.track.title}” is in a store, but nowhere this PC can download from. SoundCloud downloads must be checked by the Hub.` };
    const at = this.where();
    if (typeof at === 'string') return { job: null, source, reason: at };
    try {
      const response = await this.fetchImpl(new URL(HELPER_ROUTES.fetch, at.origin), {
        method: 'POST',
        headers: { 'x-helper-token': at.token, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ url: source.url, tool: 'auto', ...(input.format ? { format: input.format } : {}), authorization: { basis: input.basis, acknowledged: true } }),
      });
      if (!response.ok) return { job: null, source, reason: await this.refusal(response) };
      const job = HelperJob.safeParse(await response.json());
      return job.success ? { job: job.data, source, reason: null } : { job: null, source, reason: 'The helper answered with something this window does not understand.' };
    } catch (error) {
      return { job: null, source, reason: `The helper could not be reached: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Resolve every source first, then queue the complete collection with one explicit rights basis. */
  async downloadBatch(input: { tracks: CatalogTrack[]; basis: DownloadAuthorizationBasis; format?: OutputFormat | undefined }): Promise<{ jobs: HelperJob[]; queued: number; reason: string | null }> {
    const available = this.where();
    if (typeof available === 'string') return { jobs: [], queued: 0, reason: available };
    const jobs: HelperJob[] = [];
    try {
      const result = await queueResolvedCatalogBatch(
        async () => ({ tracks: input.tracks, hasMore: false, capped: false }),
        async (track) => {
          let source = pickDownloadSource(track.sources.filter((candidate) => candidate.platform !== 'soundcloud'));
          if (!source) {
            const more = await this.enrich({ isrc: track.isrc ?? undefined, title: track.title, artist: track.artists[0] ?? track.artist, durationSec: track.durationMs ? Math.round(track.durationMs / 1000) : undefined }, true);
            source = pickDownloadSource((more.result?.sources ?? []).filter((candidate) => candidate.platform !== 'soundcloud'));
          }
          return source;
        },
        async (track, source) => {
          const queued = await this.queueDownloadSource(source, input.basis, input.format);
          if (!queued.job) throw new Error(queued.reason ?? `“${track.title}” could not be queued.`);
          jobs.push(queued.job);
        },
      );
      return { jobs, queued: result.queued, reason: null };
    } catch (error) {
      const queued = error instanceof CatalogBatchQueueError ? error.queued : jobs.length;
      return { jobs, queued, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async queueDownloadSource(source: CatalogSource, basis: DownloadAuthorizationBasis, format?: OutputFormat): Promise<{ job: HelperJob | null; reason: string | null }> {
    const at = this.where();
    if (typeof at === 'string') return { job: null, reason: at };
    try {
      const response = await this.fetchImpl(new URL(HELPER_ROUTES.fetch, at.origin), {
        method: 'POST',
        headers: { 'x-helper-token': at.token, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ url: source.url, tool: 'auto', ...(format ? { format } : {}), authorization: { basis, acknowledged: true } }),
      });
      if (!response.ok) return { job: null, reason: await this.refusal(response) };
      const job = HelperJob.safeParse(await response.json());
      return job.success ? { job: job.data, reason: null } : { job: null, reason: 'The helper answered with something this window does not understand.' };
    } catch (error) {
      return { job: null, reason: `The helper could not be reached: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private localSaved(): SavedCatalogItem[] {
    const raw = this.options.store.get<unknown[]>(SAVED_KEY, []);
    return (Array.isArray(raw) ? raw : []).flatMap((item) => {
      const parsed = SavedCatalogItem.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  private localTombstones(): SavedCatalogTombstone[] {
    const raw = this.options.store.get<unknown[]>(SAVED_TOMBSTONES_KEY, []);
    return (Array.isArray(raw) ? raw : []).flatMap((item) => {
      const parsed = SavedCatalogTombstone.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }

  private persistSaved(items: SavedCatalogItem[], tombstones: SavedCatalogTombstone[]): void {
    const at = this.now();
    this.options.store.set(SAVED_KEY, items.slice(0, SAVED_CAP), at);
    this.options.store.set(SAVED_TOMBSTONES_KEY, tombstones, at);
  }

  async saved(): Promise<{ items: SavedCatalogItem[] }> {
    await this.syncSavedCatalog();
    return { items: this.localSaved() };
  }

  async save(item: SavedCatalogItem): Promise<{ items: SavedCatalogItem[] }> {
    const key = savedCatalogKey(item);
    const current = this.localSaved();
    if (!current.some((saved) => savedCatalogKey(saved) === key) && current.length >= SAVED_CAP) throw new Error(`The library already holds ${SAVED_CAP} starred items. Un-star some first.`);
    const items = [item, ...current.filter((saved) => savedCatalogKey(saved) !== key)];
    const tombstones = this.localTombstones().filter((marker) => marker.key !== key);
    this.persistSaved(items, tombstones);
    await this.syncSavedCatalog();
    return { items: this.localSaved() };
  }

  async unsave(ref: SavedCatalogItemRef): Promise<{ items: SavedCatalogItem[] }> {
    const key = savedCatalogKey(ref);
    const at = this.now();
    const items = this.localSaved().filter((item) => savedCatalogKey(item) !== key);
    const tombstones = this.localTombstones().filter((marker) => marker.key !== key);
    tombstones.push({ key, at });
    this.persistSaved(items, tombstones);
    await this.syncSavedCatalog();
    return { items: this.localSaved() };
  }

  private async syncSavedCatalog(): Promise<void> {
    const transport = this.options.sharedCatalog;
    if (!transport || transport.available?.() === false) return;
    if (this.savedSync) return this.savedSync;
    this.savedSync = this.reconcileSavedCatalog(transport)
      .then((pending) => {
        if (pending) this.scheduleSavedRetry();
        else {
          this.savedRetryDelayMs = 1_000;
          if (this.savedRetry) clearTimeout(this.savedRetry);
          this.savedRetry = null;
        }
      })
      .catch(() => this.scheduleSavedRetry())
      .finally(() => { this.savedSync = null; });
    return this.savedSync;
  }

  private async reconcileSavedCatalog(transport: SavedCatalogTransport): Promise<boolean> {
    let remote = await transport.list();
    const merged = mergeSavedCatalog(this.localSaved(), remote.items, this.localTombstones(), remote.tombstones);
    this.persistSaved(merged.items, merged.tombstones);
    for (const item of merged.put) remote = await transport.put(item);
    for (const marker of merged.del) {
      const ref = savedCatalogRefFromKey(marker.key);
      if (ref) remote = await transport.remove(ref, marker.at);
    }
    const settled = mergeSavedCatalog(merged.items, remote.items, merged.tombstones, remote.tombstones);
    this.persistSaved(settled.items, settled.tombstones);
    return settled.put.length > 0 || settled.del.length > 0;
  }

  private scheduleSavedRetry(): void {
    if (this.savedRetry) return;
    const delay = this.savedRetryDelayMs;
    this.savedRetryDelayMs = Math.min(this.savedRetryDelayMs * 2, 60_000);
    this.savedRetry = setTimeout(() => {
      this.savedRetry = null;
      void this.syncSavedCatalog();
    }, delay);
    this.savedRetry.unref?.();
  }

  filter(): CatalogFilter {
    const parsed = CatalogFilter.safeParse(this.options.store.get<unknown>(FILTER_KEY, null));
    return parsed.success ? parsed.data : DEFAULT_FILTER;
  }

  setFilter(next: CatalogFilter): CatalogFilter {
    this.options.store.set(FILTER_KEY, next, (this.options.now?.() ?? new Date()).toISOString());
    return this.filter();
  }
}

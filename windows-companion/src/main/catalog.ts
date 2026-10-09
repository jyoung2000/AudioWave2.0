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
import { CatalogAlbumDetail, CatalogArtistDetail, CatalogEnrichment, CatalogLyrics, CatalogResolveResult, HELPER_CATALOG_ROUTES, HELPER_ROUTES, HelperJob, SavedCollection, type CatalogCollectionRef, type CatalogSearchChunk, type CatalogSource, type CatalogTrack, type DownloadAuthorizationBasis, type OutputFormat } from '@now-playing/contracts';
import { collectionKey, pickDownloadSource, readCatalogStream } from '@now-playing/domain/catalog';
import type { z } from 'zod';
import { CatalogFilter, type CatalogSearchIpc } from '../shared/ipc.js';

export interface CatalogStore {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown, now: string): void;
}

export interface CompanionCatalogOptions {
  /** Where the embedded helper listens and its token; null while it is not running. */
  helper: () => { origin: string | null; token: string | null; reason: string | null };
  store: CatalogStore;
  /** Push a chunk to the window. */
  send: (payload: { searchId: string; chunk: CatalogSearchChunk }) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const SAVED_KEY = 'catalog.saved';
const FILTER_KEY = 'catalog.filter';
const SAVED_CAP = 2000;
const DEFAULT_FILTER: CatalogFilter = { sections: ['tracks', 'artists', 'albums', 'playlists'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud'] };

type Answer<T> = { result: T | null; reason: string | null };

export class CompanionCatalog {
  private readonly running = new Map<string, AbortController>();
  private readonly fetchImpl: typeof fetch;

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
    let source = pickDownloadSource(input.track.sources);
    if (!source) {
      const more = await this.enrich({ isrc: input.track.isrc ?? undefined, title: input.track.title, artist: input.track.artists[0] ?? input.track.artist, durationSec: input.track.durationMs ? Math.round(input.track.durationMs / 1000) : undefined }, true);
      source = pickDownloadSource(more.result?.sources ?? []);
    }
    if (!source) return { job: null, source: null, reason: `“${input.track.title}” is in a store, but nowhere this PC can download from (YouTube Music, YouTube, SoundCloud, Bandcamp or Spotify through spotDL).` };
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

  saved(): { items: SavedCollection[] } {
    const raw = this.options.store.get<unknown[]>(SAVED_KEY, []);
    const items = (Array.isArray(raw) ? raw : []).flatMap((item) => {
      const parsed = SavedCollection.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
    return { items: items.sort((a, b) => b.savedAt.localeCompare(a.savedAt)) };
  }

  save(saved: SavedCollection): { items: SavedCollection[] } {
    const key = collectionKey(saved.ref);
    const rest = this.saved().items.filter((item) => collectionKey(item.ref) !== key);
    this.options.store.set(SAVED_KEY, [saved, ...rest].slice(0, SAVED_CAP), (this.options.now?.() ?? new Date()).toISOString());
    return this.saved();
  }

  unsave(ref: Pick<CatalogCollectionRef, 'platform' | 'kind' | 'id'>): { items: SavedCollection[] } {
    const key = collectionKey(ref);
    this.options.store.set(SAVED_KEY, this.saved().items.filter((item) => collectionKey(item.ref) !== key), (this.options.now?.() ?? new Date()).toISOString());
    return this.saved();
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

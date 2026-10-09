/**
 * The music catalog, as the admin window reaches it (DEC-039): `/api/v1/catalog/*` with the admin
 * session, the search read as NDJSON while it arrives, and the hooks the Search tab is built from.
 *
 * Everything the window decides about the answers — folding the feed, what a row says, the mosaic,
 * the star — is the domain's (`@now-playing/domain/catalog`, view.ts), shared with the companion.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogAlbumDetail, CatalogArtistDetail, CatalogEnrichment, CatalogLyrics, CatalogProviderId, CatalogResolveResult, CatalogSearchChunk, CatalogSearchSection, CatalogTrack, SavedCollection } from '@now-playing/contracts';
import { CATALOG_PROVIDERS } from '@now-playing/contracts';
import { collectionKey, EMPTY_RESULTS, foldCatalogChunk, readCatalogStream, type CatalogFields, type CatalogResults } from '@now-playing/domain/catalog';
import { api, ApiError, apiStream } from './api.js';
import { useStoredState } from './hooks.js';

/* ------------------------------------------------------------------ the client */

export interface CatalogSearchParams {
  fields: CatalogFields;
  sections: readonly CatalogSearchSection[];
  providers: readonly CatalogProviderId[];
  offset?: number;
  limit?: number;
}

function searchQuery(params: CatalogSearchParams): Record<string, string | number> {
  const { fields } = params;
  const query: Record<string, string | number> = { q: fields.q.trim(), sections: params.sections.join(','), providers: params.providers.join(',') };
  for (const key of ['track', 'artist', 'album'] as const) if (fields[key].trim()) query[key] = fields[key].trim();
  if (params.offset) query['offset'] = params.offset;
  if (params.limit) query['limit'] = params.limit;
  return query;
}

/** The catalog's routes, as the Search tab calls them. */
export const hubCatalog = {
  async search(params: CatalogSearchParams, onChunk: (chunk: CatalogSearchChunk) => void, signal: AbortSignal): Promise<void> {
    const body = await apiStream('catalogSearch', { query: searchQuery(params), signal });
    for await (const chunk of readCatalogStream(body)) {
      if (signal.aborted) return;
      onChunk(chunk);
    }
  },
  album: (id: string, offset: number, limit: number, signal?: AbortSignal) => api('catalogAlbum', { query: { id, offset, limit }, ...(signal ? { signal } : {}) }) as Promise<CatalogAlbumDetail>,
  artist: (id: string, albumsOffset: number, signal?: AbortSignal) => api('catalogArtist', { query: { id, albumsOffset, albumsLimit: 12, topLimit: 10 }, ...(signal ? { signal } : {}) }) as Promise<CatalogArtistDetail>,
  resolve: (url: string, offset: number, limit: number, signal?: AbortSignal) => api('catalogResolve', { query: { url, offset, limit }, ...(signal ? { signal } : {}) }) as Promise<CatalogResolveResult>,
  lyrics: (track: CatalogTrack, signal?: AbortSignal) =>
    api('catalogLyrics', { query: { title: track.title, artist: track.artists[0] ?? track.artist, album: track.album ?? undefined, durationSec: track.durationMs ? Math.round(track.durationMs / 1000) : undefined }, ...(signal ? { signal } : {}) }) as Promise<CatalogLyrics>,
  enrich: (track: CatalogTrack, signal?: AbortSignal) =>
    api('catalogEnrich', { query: track.isrc ? { isrc: track.isrc, links: 0 } : { title: track.title, artist: track.artists[0] ?? track.artist, durationSec: track.durationMs ? Math.round(track.durationMs / 1000) : undefined, links: 0 }, ...(signal ? { signal } : {}) }) as Promise<CatalogEnrichment>,
};

export type CatalogClient = typeof hubCatalog;

/** What went wrong, for a person. The hub's own sentences pass through. */
export function catalogError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(0, error instanceof Error ? error.message : String(error), null, null, null, null);
}

/* ------------------------------------------------------------------ the filter */

export interface CatalogFilter {
  sections: CatalogSearchSection[];
  providers: CatalogProviderId[];
}

/** Songs, Artists, Albums and Playlists (UX-CAT-005, UX-SEARCH-010), in the order the window shows them. */
export const ALL_SECTIONS: readonly CatalogSearchSection[] = ['tracks', 'artists', 'albums', 'playlists'];
export const DEFAULT_FILTER: CatalogFilter = { sections: [...ALL_SECTIONS], providers: [...CATALOG_PROVIDERS] };

function isFilter(value: unknown): value is CatalogFilter {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<CatalogFilter>;
  return Array.isArray(v.sections) && v.sections.length > 0 && v.sections.every((s) => (ALL_SECTIONS as readonly string[]).includes(s)) && Array.isArray(v.providers) && v.providers.length > 0 && v.providers.every((p) => (CATALOG_PROVIDERS as readonly string[]).includes(p));
}

/** Which sections are shown and which services are asked, kept for this admin in this browser. */
export function useCatalogFilter(): [CatalogFilter, (next: CatalogFilter) => void] {
  return useStoredState<CatalogFilter>('np.admin.search.filter', DEFAULT_FILTER, isFilter);
}

/* ------------------------------------------------------------------ the live search */

export interface LiveSearch {
  results: CatalogResults;
  /** The search being shown: what was asked, for See All and for the heading. */
  asked: CatalogSearchParams | null;
  running: boolean;
  error: ApiError | null;
  run: (params: CatalogSearchParams) => void;
  cancel: () => void;
  /** Stop, and put the results away (Escape on the overview). */
  clear: () => void;
}

/**
 * One search at a time: a new one aborts the last (the server stops asking the services still
 * pending), and every chunk is folded as it arrives (UX-SEARCH-002).
 */
export function useLiveSearch(client: Pick<CatalogClient, 'search'>): LiveSearch {
  const [results, setResults] = useState<CatalogResults>(EMPTY_RESULTS);
  const [asked, setAsked] = useState<CatalogSearchParams | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const controller = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setRunning(false);
  }, []);

  const run = useCallback(
    (params: CatalogSearchParams) => {
      controller.current?.abort();
      const mine = new AbortController();
      controller.current = mine;
      setAsked(params);
      setResults(EMPTY_RESULTS);
      setError(null);
      setRunning(true);
      client
        .search(params, (chunk) => setResults((state) => foldCatalogChunk(state, chunk)), mine.signal)
        .catch((err: unknown) => {
          if (!mine.signal.aborted) setError(catalogError(err));
        })
        .finally(() => {
          if (controller.current === mine) {
            controller.current = null;
            setRunning(false);
          }
        });
    },
    [client],
  );

  const clear = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setRunning(false);
    setAsked(null);
    setResults(EMPTY_RESULTS);
    setError(null);
  }, []);

  useEffect(() => () => controller.current?.abort(), []);
  return { results, asked, running, error, run, cancel, clear };
}

/* ------------------------------------------------------------------ a 30-second preview */

export interface Preview {
  playing: string | null;
  failed: string | null;
  toggle: (url: string) => void;
  stop: () => void;
}

/** One clip at a time, from Apple Music or Deezer; a second one stops the first. */
export function usePreview(): Preview {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const stop = useCallback(() => {
    audio.current?.pause();
    setPlaying(null);
  }, []);

  const toggle = useCallback(
    (url: string) => {
      if (playing === url) return stop();
      audio.current?.pause();
      const element = new Audio(url);
      audio.current = element;
      element.onended = () => setPlaying((now) => (now === url ? null : now));
      element.onerror = () => {
        setPlaying((now) => (now === url ? null : now));
        // Deezer's clips are signed and expire; searching again gets fresh ones.
        setFailed(url);
      };
      setFailed(null);
      setPlaying(url);
      void element.play().catch(() => undefined);
    },
    [playing, stop],
  );

  useEffect(() => () => audio.current?.pause(), []);
  return { playing, failed, toggle, stop };
}

/* ------------------------------------------------------------------ starred albums and playlists */

export interface SavedCollections {
  items: SavedCollection[];
  isSaved: (ref: SavedCollection['ref']) => boolean;
  busy: boolean;
  error: ApiError | null;
  /** Star or un-star; resolves true when the hub kept the change. */
  toggle: (saved: SavedCollection) => Promise<boolean>;
}

/** The admin's starred albums and playlists, kept by the hub (`/api/v1/catalog/saved`). */
export function useSavedCollections(): SavedCollections {
  const [items, setItems] = useState<SavedCollection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    api('catalogSavedList')
      .then((answer) => {
        if (live) setItems((answer as { items: SavedCollection[] }).items);
      })
      .catch((err: unknown) => {
        if (live) setError(catalogError(err));
      });
    return () => {
      live = false;
    };
  }, []);

  const keys = useMemo(() => new Set(items.map((item) => collectionKey(item.ref))), [items]);
  const isSaved = useCallback((ref: SavedCollection['ref']) => keys.has(collectionKey(ref)), [keys]);

  const toggle = useCallback(
    async (saved: SavedCollection): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const answer = keys.has(collectionKey(saved.ref)) ? await api('catalogSavedDelete', { query: { platform: saved.ref.platform, kind: saved.ref.kind, id: saved.ref.id } }) : await api('catalogSavedPut', { body: saved });
        setItems((answer as { items: SavedCollection[] }).items);
        return true;
      } catch (err) {
        setError(catalogError(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [keys],
  );

  return { items, isSaved, busy, error, toggle };
}

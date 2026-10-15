/**
 * The music catalog, as the companion's window reaches it (DEC-039): every call is an IPC channel to
 * the main process, which asks the embedded helper's `/helper/v1/catalog/*` (the window's content
 * security policy keeps it to this app). A search's chunks arrive as `event:catalog-chunk` for the
 * search id this window chose. The hooks are the hub's, over this transport; what the window does
 * with the answers is the domain's (`@now-playing/domain/catalog`, view.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogAlbumDetail, CatalogArtistDetail, CatalogEnrichment, CatalogLyrics, CatalogProviderId, CatalogResolveResult, CatalogSearchChunk, CatalogSearchSection, CatalogTrack, SavedCatalogItem, SavedCollection, SavedTrack } from '@now-playing/contracts';
import { CATALOG_PROVIDERS, SavedSongSnapshot, SavedTrack as SavedTrackSchema } from '@now-playing/contracts';
import { collectionKey, EMPTY_RESULTS, foldCatalogChunk, savedTrackIdentity, type CatalogFields, type CatalogResults } from '@now-playing/domain/catalog';
import { invoke, subscribe } from './bridge.js';

/* ------------------------------------------------------------------ the client */

export interface CatalogSearchParams {
  fields: CatalogFields;
  sections: readonly CatalogSearchSection[];
  providers: readonly CatalogProviderId[];
  offset?: number;
  limit?: number;
}

function result<T>(answer: { result: T | null; reason: string | null }): T {
  if (answer.result === null) throw new Error(answer.reason ?? 'The music services could not be read just now.');
  return answer.result;
}

let searchCount = 0;

/** The catalog's channels, as the Search tool calls them. */
export const companionCatalog = {
  async search(params: CatalogSearchParams, onChunk: (chunk: CatalogSearchChunk) => void, signal: AbortSignal): Promise<void> {
    searchCount += 1;
    const searchId = `s${Date.now().toString(36)}${searchCount}`;
    const stop = subscribe('event:catalog-chunk', (payload) => {
      if (payload.searchId === searchId && !signal.aborted) onChunk(payload.chunk);
    });
    const onAbort = (): void => void invoke('catalog:cancel', { searchId }).catch(() => undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const { fields } = params;
      const answer = await invoke('catalog:search', {
        searchId,
        q: fields.q.trim(),
        ...(fields.track.trim() ? { track: fields.track.trim() } : {}),
        ...(fields.artist.trim() ? { artist: fields.artist.trim() } : {}),
        ...(fields.album.trim() ? { album: fields.album.trim() } : {}),
        sections: [...params.sections],
        providers: [...params.providers],
        offset: params.offset ?? 0,
        limit: params.limit ?? 25,
      });
      if (answer.reason && !signal.aborted) throw new Error(answer.reason);
    } finally {
      stop();
      signal.removeEventListener('abort', onAbort);
    }
  },
  album: async (id: string, offset: number, limit: number, _signal?: AbortSignal): Promise<CatalogAlbumDetail> => result(await invoke('catalog:album', { id, offset, limit })),
  artist: async (id: string, albumsOffset: number, _signal?: AbortSignal): Promise<CatalogArtistDetail> => result(await invoke('catalog:artist', { id, albumsOffset })),
  resolve: async (url: string, offset: number, limit: number, _signal?: AbortSignal): Promise<CatalogResolveResult> => result(await invoke('catalog:resolve', { url, offset, limit })),
  lyrics: async (track: CatalogTrack, _signal?: AbortSignal): Promise<CatalogLyrics> =>
    result(await invoke('catalog:lyrics', { title: track.title, artist: track.artists[0] ?? track.artist, ...(track.album ? { album: track.album } : {}), ...(track.durationMs ? { durationSec: Math.max(1, Math.round(track.durationMs / 1000)) } : {}) })),
  enrich: async (track: CatalogTrack, _signal?: AbortSignal): Promise<CatalogEnrichment> =>
    result(await invoke('catalog:enrich', track.isrc ? { isrc: track.isrc } : { title: track.title, artist: track.artists[0] ?? track.artist, ...(track.durationMs ? { durationSec: Math.max(1, Math.round(track.durationMs / 1000)) } : {}) })),
};

export type CatalogClient = typeof companionCatalog;

export function catalogError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/* ------------------------------------------------------------------ the filter */

export interface CatalogFilter {
  sections: CatalogSearchSection[];
  providers: CatalogProviderId[];
}

/** Songs, Artists, Albums and Playlists (UX-CAT-005, UX-SEARCH-010), in the order the window shows them. */
export const ALL_SECTIONS: readonly CatalogSearchSection[] = ['tracks', 'artists', 'albums', 'playlists'];
export const DEFAULT_FILTER: CatalogFilter = { sections: [...ALL_SECTIONS], providers: [...CATALOG_PROVIDERS] };

/** Which sections are shown and which services are asked, kept in the companion's settings store. */
export function useCatalogFilter(): [CatalogFilter, (next: CatalogFilter) => void] {
  const [filter, setFilter] = useState<CatalogFilter>(DEFAULT_FILTER);
  useEffect(() => {
    let live = true;
    invoke('catalog:filter', undefined)
      .then((kept) => {
        if (live) setFilter(kept);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const set = useCallback((next: CatalogFilter) => {
    setFilter(next);
    void invoke('catalog:filter:set', next).catch(() => undefined);
  }, []);
  return [filter, set];
}

/* ------------------------------------------------------------------ the live search */

export interface LiveSearch {
  results: CatalogResults;
  asked: CatalogSearchParams | null;
  running: boolean;
  error: Error | null;
  run: (params: CatalogSearchParams) => void;
  cancel: () => void;
  /** Stop, and put the results away (Escape on the overview). */
  clear: () => void;
}

/** One search at a time; a new one stops the last. Chunks are folded as they arrive (UX-SEARCH-002). */
export function useLiveSearch(client: Pick<CatalogClient, 'search'>): LiveSearch {
  const [results, setResults] = useState<CatalogResults>(EMPTY_RESULTS);
  const [asked, setAsked] = useState<CatalogSearchParams | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Error | null>(null);
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
  tracks: SavedTrack[];
  isSaved: (ref: SavedCollection['ref']) => boolean;
  isTrackSaved: (track: CatalogTrack) => boolean;
  busy: boolean;
  error: Error | null;
  toggle: (saved: SavedCollection) => Promise<boolean>;
  toggleTrack: (track: CatalogTrack) => Promise<boolean>;
  unstarTrack: (identityKey: string) => Promise<boolean>;
}

/** The shared Hub-backed set; local persistence is retained only as an offline outbox. */
export function useSavedCollections(): SavedCollections {
  const [items, setItems] = useState<SavedCollection[]>([]);
  const [tracks, setTracks] = useState<SavedTrack[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const apply = useCallback((answer: { items: SavedCatalogItem[] }) => {
    setItems(answer.items.filter((item): item is SavedCollection => 'ref' in item));
    setTracks(answer.items.filter((item): item is SavedTrack => 'kind' in item && item.kind === 'track'));
  }, []);
  useEffect(() => {
    let live = true;
    invoke('catalog:saved', undefined)
      .then((answer) => { if (live) apply(answer); })
      .catch((err: unknown) => { if (live) setError(catalogError(err)); });
    return () => { live = false; };
  }, [apply]);
  const keys = useMemo(() => new Set(items.map((item) => collectionKey(item.ref))), [items]);
  const trackKeys = useMemo(() => new Set(tracks.map((item) => item.identityKey)), [tracks]);
  const isSaved = useCallback((ref: SavedCollection['ref']) => keys.has(collectionKey(ref)), [keys]);
  const isTrackSaved = useCallback((track: CatalogTrack) => {
    const identity = savedTrackIdentity(track);
    return identity !== null && trackKeys.has(identity);
  }, [trackKeys]);
  const toggle = useCallback(async (saved: SavedCollection): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const answer = keys.has(collectionKey(saved.ref))
        ? await invoke('catalog:unsave', { platform: saved.ref.platform, kind: saved.ref.kind, id: saved.ref.id })
        : await invoke('catalog:save', saved);
      apply(answer);
      return true;
    } catch (err) {
      setError(catalogError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [apply, keys]);
  const toggleTrack = useCallback(async (track: CatalogTrack): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const snapshot = SavedSongSnapshot.parse(track);
      const identityKey = savedTrackIdentity(snapshot);
      if (!identityKey) throw new Error('This song has no safe recording identity to share.');
      const saved = SavedTrackSchema.parse({ kind: 'track', identityKey, track: snapshot, savedAt: new Date().toISOString() });
      const answer = trackKeys.has(identityKey)
        ? await invoke('catalog:unsave', { kind: 'track', identityKey })
        : await invoke('catalog:save', saved);
      apply(answer);
      return true;
    } catch (err) {
      setError(catalogError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [apply, trackKeys]);
  const unstarTrack = useCallback(async (identityKey: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      apply(await invoke('catalog:unsave', { kind: 'track', identityKey }));
      return true;
    } catch (err) {
      setError(catalogError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [apply]);
  return { items, tracks, isSaved, isTrackSaved, busy, error, toggle, toggleTrack, unstarTrack };
}

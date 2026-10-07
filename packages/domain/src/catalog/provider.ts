import type { CatalogAlbum, CatalogArtist, CatalogPlaylist, CatalogProviderId, CatalogQuery, CatalogSearchSection, CatalogTrack } from '@now-playing/contracts';

export interface ProviderSearchOptions {
  offset: number;
  limit: number;
  sections: readonly CatalogSearchSection[];
  signal: AbortSignal;
}

export interface ProviderResult {
  tracks: CatalogTrack[];
  artists: CatalogArtist[];
  albums: CatalogAlbum[];
  /** Public playlists, from the services that list them (Deezer); UX-CAT-005. */
  playlists: CatalogPlaylist[];
  /** Per section: did the service return a full page, so a next page may exist? */
  full: Partial<Record<CatalogSearchSection, boolean>>;
}

/** One service a search asks. `search` may throw; the fan-out catches it and reports it. */
export interface CatalogProvider {
  readonly id: CatalogProviderId;
  /** Sections this service can answer at all. */
  readonly sections: readonly CatalogSearchSection[];
  /** How long one search may take before it is reported as a timeout. */
  readonly timeoutMs: number;
  /** Whether it can answer this kind of query (yt-dlp cannot look up an ISRC). */
  supports(query: CatalogQuery): boolean;
  search(query: CatalogQuery, options: ProviderSearchOptions): Promise<ProviderResult>;
}

export const emptyResult = (): ProviderResult => ({ tracks: [], artists: [], albums: [], playlists: [], full: {} });

/** A service may rest itself (its own published budget) without counting as a failure. */
export class ProviderResting extends Error {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message);
    this.name = 'ProviderResting';
  }
}

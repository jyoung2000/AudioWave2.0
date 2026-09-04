import type { ProviderCapabilities, ProviderDescriptor, ProviderHealth, SearchResult, TrackIdentity } from '@now-playing/contracts';
import type { AuthorizedAccount, AuthorizedDownload, CredentialRefreshResult, DownloadContext, ImportPage, PlaybackContext, PlayableRef, ProviderAdapter, ProviderRuntimeConfig, ProviderSearchPage, ProviderTestResult } from '../adapter.js';

export const REVIEWED_AT = '2026-09-03';

export function caps(overrides: Partial<ProviderCapabilities>): ProviderCapabilities {
  return { metadata: 'unsupported', search: 'unsupported', preview: 'unsupported', playback: 'unsupported', importLikes: 'unsupported', importPlaylists: 'unsupported', creatorDownload: 'unsupported', userOwnedDownload: 'unsupported', groupSync: 'unsupported', eq: 'unsupported', ...overrides };
}

export function emptyIdentity(): TrackIdentity {
  return { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} };
}

export interface ResultInput {
  provider: string;
  kind: SearchResult['kind'];
  providerId: string;
  title: string;
  artistName?: string | null;
  albumName?: string | null;
  durationMs?: number | null;
  artworkUrl?: string | null;
  canonicalUrl?: string | null;
  year?: number | null;
  genre?: string | null;
  capabilities: ProviderCapabilities;
  identity?: Partial<TrackIdentity>;
  attribution?: string | null;
  accessState?: SearchResult['accessState'];
  previewUrl?: string | null;
  trackId?: string | null;
  cachedAt?: string | null;
}

export function result(input: ResultInput): SearchResult {
  const identity: TrackIdentity = { ...emptyIdentity(), ...(input.identity ?? {}), providerIds: { ...(input.identity?.providerIds ?? {}), [input.provider]: [input.providerId] } };
  return {
    id: `${input.provider}:${input.kind}:${input.providerId}`,
    kind: input.kind,
    provider: input.provider,
    providerId: input.providerId,
    title: input.title.slice(0, 300),
    artistName: input.artistName?.slice(0, 300) ?? null,
    albumName: input.albumName?.slice(0, 300) ?? null,
    durationMs: input.durationMs ?? null,
    artworkUrl: input.artworkUrl ?? null,
    canonicalUrl: input.canonicalUrl ?? null,
    year: input.year ?? null,
    genre: input.genre?.slice(0, 60) ?? null,
    capabilities: input.capabilities,
    identity,
    attribution: input.attribution ?? null,
    cachedAt: input.cachedAt ?? null,
    stale: false,
    accessState: input.accessState ?? (input.capabilities.playback === 'available' ? 'available' : input.capabilities.playback === 'requires_auth' ? 'requires_auth' : input.capabilities.playback === 'restricted' ? 'restricted' : input.capabilities.metadata === 'available' ? 'available' : 'unsupported'),
    previewUrl: input.previewUrl ?? null,
    trackId: input.trackId ?? null,
    variants: [],
  };
}

export function healthy(provider: string, checkedAt: string, latencyMs?: number): ProviderHealth {
  return { provider, status: 'ok', circuit: 'closed', checkedAt, ...(latencyMs !== undefined ? { latencyMs } : {}) };
}

export const NOT_IMPORTABLE: ImportPage = { items: [], nextCursor: null };

/** Common no-op behaviour so adapters only implement what they actually support. */
export abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly id: string;
  protected config: ProviderRuntimeConfig = { enabled: true, clientId: null, clientSecret: null, apiKey: null, applicationId: null, redirectUri: null, contactEmail: null, extra: {} };

  abstract descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'>;
  abstract capabilities(): ProviderCapabilities;

  configure(config: ProviderRuntimeConfig): void {
    this.config = config;
  }

  requiredConfig(): readonly string[] {
    return [];
  }

  allowedHosts(): readonly string[] {
    return [];
  }

  async health(): Promise<ProviderHealth> {
    return healthy(this.id, new Date().toISOString());
  }

  async search(_query: string, _filters: { scope: string; limit: number }, _cursor: string | null): Promise<ProviderSearchPage> {
    return { results: [], nextCursor: null };
  }

  async resolve(_urlOrId: string): Promise<SearchResult | null> {
    return null;
  }

  async getMetadata(_id: string): Promise<SearchResult | null> {
    return null;
  }

  async getPreview(_id: string): Promise<PlayableRef | null> {
    return null;
  }

  async getPlayable(_id: string, _context: PlaybackContext): Promise<PlayableRef | null> {
    return null;
  }

  async getAuthorizedDownload(_id: string, _context: DownloadContext): Promise<AuthorizedDownload | null> {
    return null;
  }

  // Signatures match `ProviderAdapter` exactly so an override can narrow behaviour without
  // widening the contract; the base implementations simply ignore what they are given.
  async importLikes(_account: AuthorizedAccount, _cursor: string | null): Promise<ImportPage> {
    return NOT_IMPORTABLE;
  }

  async importPlaylists(_account: AuthorizedAccount, _cursor: string | null): Promise<ImportPage> {
    return NOT_IMPORTABLE;
  }

  async refreshCredentials(_account: AuthorizedAccount): Promise<CredentialRefreshResult> {
    return { status: 'connected' };
  }

  async test(): Promise<ProviderTestResult> {
    return { ok: true, latencyMs: null, message: 'No external connectivity required' };
  }
}

/** Parse `provider:kind:id` result ids back into their parts. */
export function parseResultId(id: string): { provider: string; kind: string; providerId: string } | null {
  const first = id.indexOf(':');
  const second = id.indexOf(':', first + 1);
  if (first < 0 || second < 0) return null;
  return { provider: id.slice(0, first), kind: id.slice(first + 1, second), providerId: id.slice(second + 1) };
}

export function isoDurationToMs(iso: string): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000);
}

export function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

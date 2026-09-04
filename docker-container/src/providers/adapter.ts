import type { DownloadAuthorizationBasis, ProviderAccount, ProviderCapabilities, ProviderDescriptor, ProviderHealth, SearchResult, SearchScope } from '@now-playing/contracts';

export interface SearchFilters {
  scope: SearchScope;
  limit: number;
}

export interface ProviderSearchPage {
  results: SearchResult[];
  nextCursor: string | null;
}

export interface PlaybackContext {
  /** Who is playing: a device id, hub user id or 'admin'. */
  actorId: string;
  /** Group playback needs seekable, shareable representations. */
  forGroup: boolean;
}

/** How a client can obtain playable bytes. `embed` means the browser must render the provider's own player. */
export type PlayableRef =
  | { kind: 'hub-stream'; url: string; mime: string | null; seekable: true; durationMs: number | null }
  | { kind: 'remote-stream'; url: string; mime: string | null; seekable: boolean; expiresAt: string | null }
  | { kind: 'embed'; embedUrl: string; canonicalUrl: string }
  | { kind: 'open-at-source'; url: string };

export interface DownloadContext {
  actorId: string;
  basis: DownloadAuthorizationBasis;
}

/** Where the download worker gets the bytes from; the adapter has already checked the provider's own permission flags. */
export type AuthorizedDownload =
  | { kind: 'file'; path: string; filename: string; mime: string | null; sizeBytes: number | null; basis: DownloadAuthorizationBasis }
  | { kind: 'http'; url: string; filename: string; mime: string | null; sizeBytes: number | null; basis: DownloadAuthorizationBasis; headers?: Record<string, string> }
  | { kind: 'external-tool'; url: string; filename: string; basis: DownloadAuthorizationBasis };

export interface ImportPage {
  items: SearchResult[];
  nextCursor: string | null;
  /** Playlist imports: per playlist name -> items. */
  playlists?: Array<{ externalId: string; name: string; items: SearchResult[] }>;
}

export interface CredentialRefreshResult {
  status: ProviderAccount['status'];
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string | null;
  error?: string;
}

/** A provider account with its decrypted access token attached for the duration of one call. */
export interface AuthorizedAccount extends ProviderAccount {
  accessToken: string | null;
  refreshToken: string | null;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
}

/** Adapters that support per-user OAuth 2.0 authorization-code + PKCE implement this in addition to ProviderAdapter. */
export interface OAuthCapableAdapter extends ProviderAdapter {
  oauth: {
    scopes: readonly string[];
    authorizationUrl(input: { redirectUri: string; state: string; codeChallenge: string }): string;
    exchangeCode(input: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokenSet>;
    refresh(refreshToken: string): Promise<OAuthTokenSet>;
    profile(accessToken: string): Promise<{ externalUserId: string; displayName: string | null }>;
  };
}

export function isOAuthCapable(adapter: ProviderAdapter): adapter is OAuthCapableAdapter {
  return typeof (adapter as Partial<OAuthCapableAdapter>).oauth === 'object';
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number | null;
  message: string;
}

/** The single adapter interface every provider implements; capability *state* is always returned, never assumed. */
export interface ProviderAdapter {
  readonly id: string;
  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'>;
  capabilities(): ProviderCapabilities;
  health(): Promise<ProviderHealth>;
  search(query: string, filters: SearchFilters, cursor: string | null): Promise<ProviderSearchPage>;
  resolve(urlOrId: string): Promise<SearchResult | null>;
  getMetadata(id: string): Promise<SearchResult | null>;
  getPreview(id: string): Promise<PlayableRef | null>;
  getPlayable(id: string, context: PlaybackContext): Promise<PlayableRef | null>;
  getAuthorizedDownload(id: string, context: DownloadContext): Promise<AuthorizedDownload | null>;
  importLikes(account: AuthorizedAccount, cursor: string | null): Promise<ImportPage>;
  importPlaylists(account: AuthorizedAccount, cursor: string | null): Promise<ImportPage>;
  refreshCredentials(account: AuthorizedAccount): Promise<CredentialRefreshResult>;
  /** Connectivity/credential test used by `POST /providers/:provider/test`. */
  test(): Promise<ProviderTestResult>;
  /** Hosts this adapter may contact (URL resolution restricts pasted links to these). */
  allowedHosts(): readonly string[];
  /** Required app-config fields (for `ProviderAppConfigView.missing`). */
  requiredConfig(): readonly string[];
  /** Adapters receive the current app configuration (decrypted) on every change. */
  configure(config: ProviderRuntimeConfig): void;
}

export interface ProviderRuntimeConfig {
  enabled: boolean;
  clientId: string | null;
  clientSecret: string | null;
  apiKey: string | null;
  applicationId: string | null;
  redirectUri: string | null;
  contactEmail: string | null;
  extra: Record<string, string>;
}

export const EMPTY_RUNTIME_CONFIG: ProviderRuntimeConfig = { enabled: true, clientId: null, clientSecret: null, apiKey: null, applicationId: null, redirectUri: null, contactEmail: null, extra: {} };

export const UNSUPPORTED_ALL: ProviderCapabilities = {
  metadata: 'unsupported',
  search: 'unsupported',
  preview: 'unsupported',
  playback: 'unsupported',
  importLikes: 'unsupported',
  importPlaylists: 'unsupported',
  creatorDownload: 'unsupported',
  userOwnedDownload: 'unsupported',
  groupSync: 'unsupported',
  eq: 'unsupported',
};

export function capabilityForBasis(basis: DownloadAuthorizationBasis): 'creatorDownload' | 'userOwnedDownload' {
  switch (basis) {
    case 'creator-download':
    case 'licensed':
      return 'creatorDownload';
    default:
      return 'userOwnedDownload';
  }
}

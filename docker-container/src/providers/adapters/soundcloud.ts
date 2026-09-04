import type { ProviderCapabilities, ProviderDescriptor, SearchResult } from '@now-playing/contracts';
import type { Clock } from '../../deps.js';
import type { SafeHttpClient } from '../http.js';
import type { AuthorizedAccount, AuthorizedDownload, DownloadContext, ImportPage, OAuthCapableAdapter, OAuthTokenSet, PlaybackContext, PlayableRef, ProviderSearchPage, ProviderTestResult } from '../adapter.js';
import { BaseAdapter, caps, REVIEWED_AT, result } from './base.js';

const API = 'https://api.soundcloud.com';
const HOSTS = ['api.soundcloud.com', 'secure.soundcloud.com', 'soundcloud.com', 'on.soundcloud.com', 'i1.sndcdn.com', 'cf-media.sndcdn.com'];

interface ScTrack {
  id: number;
  urn?: string;
  title: string;
  duration: number;
  genre?: string | null;
  artwork_url?: string | null;
  permalink_url: string;
  release_year?: number | null;
  access?: 'playable' | 'preview' | 'blocked';
  streamable?: boolean;
  downloadable?: boolean;
  has_downloads_left?: boolean;
  license?: string;
  user?: { username: string };
  isrc?: string | null;
}

/**
 * SoundCloud API: client-credentials app token for search/metadata, per-user OAuth (PKCE) for likes/playlists.
 * Streams only when the track is `playable`; downloads only when the creator enabled them and downloads are left.
 */
export class SoundCloudAdapter extends BaseAdapter implements OAuthCapableAdapter {
  readonly id = 'soundcloud';
  private appToken: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly http: SafeHttpClient,
    private readonly clock: Clock,
  ) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'SoundCloud', role: 'audio-source', docsUrl: 'https://developers.soundcloud.com/docs/api/guide.html', authType: 'oauth-pkce', authScopes: ['non-expiring'], attribution: 'on SoundCloud', rateStrategy: 'Client-level limits; 429 Retry-After honoured; app token reused until expiry', cachePolicy: '1 h', groupCompatible: true, discordCompatible: true, reviewedAt: REVIEWED_AT, limitations: ['Only tracks marked playable stream; preview-only tracks play 30 s', 'Downloads only when the creator enabled them', 'App registration currently requires a request form'] };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: 'available', search: 'available', preview: 'restricted', playback: 'restricted', importLikes: 'requires_auth', importPlaylists: 'requires_auth', creatorDownload: 'restricted', groupSync: 'best_effort', eq: 'restricted', reason: 'Per-track: playback when the creator allows streaming, download only when the creator enabled it' });
  }

  override requiredConfig(): readonly string[] {
    return ['clientId', 'clientSecret'];
  }

  override allowedHosts(): readonly string[] {
    return HOSTS;
  }

  private async appAccessToken(): Promise<string> {
    if (this.appToken && this.appToken.expiresAt > this.clock.now() + 60_000) return this.appToken.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    const basic = Buffer.from(`${this.config.clientId ?? ''}:${this.config.clientSecret ?? ''}`).toString('base64');
    const res = await this.http.request('https://secure.soundcloud.com/oauth/token', { method: 'POST', allowedHosts: HOSTS, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}`, Accept: 'application/json; charset=utf-8' }, body, timeoutMs: 12_000 });
    const data = await res.json<{ access_token?: string; expires_in?: number; error?: string }>();
    if (res.status >= 400 || !data.access_token) throw new Error(data.error ?? `SoundCloud token endpoint responded ${res.status}`);
    this.appToken = { token: data.access_token, expiresAt: this.clock.now() + (data.expires_in ?? 3600) * 1000 };
    return data.access_token;
  }

  private async get<T>(path: string, params: Record<string, string>, token?: string): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const auth = token ?? (await this.appAccessToken());
    return this.http.getJson<T>(url.toString(), { allowedHosts: HOSTS, headers: { Authorization: `OAuth ${auth}`, Accept: 'application/json; charset=utf-8' }, timeoutMs: 12_000 });
  }

  override async test(): Promise<ProviderTestResult> {
    const started = Date.now();
    await this.appAccessToken();
    return { ok: true, latencyMs: Date.now() - started, message: 'SoundCloud app credentials accepted' };
  }

  private toResult(t: ScTrack): SearchResult {
    const access = t.access ?? (t.streamable ? 'playable' : 'blocked');
    const base = this.capabilities();
    const downloadable = t.downloadable === true && t.has_downloads_left !== false;
    const capabilities: ProviderCapabilities = { ...base, playback: access === 'playable' ? 'available' : access === 'preview' ? 'restricted' : 'unsupported', preview: access === 'blocked' ? 'unsupported' : 'available', creatorDownload: downloadable ? 'available' : 'unsupported', reason: access === 'playable' ? (downloadable ? 'Creator enabled downloads for this track' : 'Streaming allowed; the creator did not enable downloads') : access === 'preview' ? 'Only a 30-second preview is available outside SoundCloud' : 'The creator blocked playback outside SoundCloud' };
    return result({ provider: this.id, kind: 'track', providerId: String(t.id), title: t.title, artistName: t.user?.username ?? null, durationMs: t.duration, artworkUrl: t.artwork_url ?? null, canonicalUrl: t.permalink_url, year: t.release_year ?? null, genre: t.genre ?? null, capabilities, identity: { isrc: t.isrc ?? null }, attribution: 'on SoundCloud', accessState: access === 'playable' ? 'available' : access === 'preview' ? 'restricted' : 'unsupported' });
  }

  override async search(query: string, filters: { scope: string; limit: number }, cursor: string | null): Promise<ProviderSearchPage> {
    if (cursor) {
      const page = await this.get<{ collection: ScTrack[]; next_href?: string }>(cursor, {});
      return { results: page.collection.map((t) => this.toResult(t)), nextCursor: page.next_href ?? null };
    }
    const page = await this.get<{ collection: ScTrack[]; next_href?: string }>('/tracks', { q: query, limit: String(Math.min(filters.limit, 50)), access: 'playable,preview,blocked', linked_partitioning: 'true' });
    return { results: page.collection.map((t) => this.toResult(t)), nextCursor: page.next_href ?? null };
  }

  override async getMetadata(id: string): Promise<SearchResult | null> {
    if (!/^\d+$/.test(id)) return null;
    const t = await this.get<ScTrack>(`/tracks/${id}`, {});
    return this.toResult(t);
  }

  override async resolve(urlOrId: string): Promise<SearchResult | null> {
    if (/^\d+$/.test(urlOrId.trim())) return this.getMetadata(urlOrId.trim());
    let u: URL;
    try {
      u = new URL(urlOrId);
    } catch {
      return null;
    }
    if (!/(^|\.)soundcloud\.com$/.test(u.hostname)) return null;
    const t = await this.get<ScTrack & { kind?: string }>('/resolve', { url: u.toString() });
    return t.kind === 'track' || t.id ? this.toResult(t) : null;
  }

  override async getPreview(id: string): Promise<PlayableRef | null> {
    return this.getPlayable(id, { actorId: 'preview', forGroup: false });
  }

  override async getPlayable(id: string, _context: PlaybackContext): Promise<PlayableRef | null> {
    if (!/^\d+$/.test(id)) return null;
    const t = await this.get<ScTrack>(`/tracks/${id}`, {});
    const access = t.access ?? (t.streamable ? 'playable' : 'blocked');
    if (access === 'blocked') return null;
    const streams = await this.get<{ http_mp3_128_url?: string; preview_mp3_128_url?: string }>(`/tracks/${id}/streams`, {});
    const url = access === 'playable' ? (streams.http_mp3_128_url ?? streams.preview_mp3_128_url) : streams.preview_mp3_128_url;
    if (!url) return { kind: 'open-at-source', url: t.permalink_url };
    return { kind: 'remote-stream', url, mime: 'audio/mpeg', seekable: access === 'playable', expiresAt: new Date(this.clock.now() + 30 * 60_000).toISOString() };
  }

  override async getAuthorizedDownload(id: string, context: DownloadContext): Promise<AuthorizedDownload | null> {
    if (!/^\d+$/.test(id)) return null;
    if (context.basis !== 'creator-download' && context.basis !== 'licensed') return null;
    const t = await this.get<ScTrack>(`/tracks/${id}`, {});
    if (!(t.downloadable === true && t.has_downloads_left !== false)) return null;
    const token = await this.appAccessToken();
    return { kind: 'http', url: `${API}/tracks/${id}/download`, filename: `${t.user?.username ?? 'SoundCloud'} - ${t.title}`, mime: null, sizeBytes: null, basis: 'creator-download', headers: { Authorization: `OAuth ${token}` } };
  }

  /* ---- OAuth (PKCE) ---- */
  readonly oauth = {
    scopes: [] as readonly string[],
    authorizationUrl: (input: { redirectUri: string; state: string; codeChallenge: string }): string => {
      const u = new URL('https://secure.soundcloud.com/authorize');
      u.searchParams.set('client_id', this.config.clientId ?? '');
      u.searchParams.set('redirect_uri', input.redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('code_challenge', input.codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('state', input.state);
      return u.toString();
    },
    exchangeCode: async (input: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokenSet> => this.userToken({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier }),
    refresh: async (refreshToken: string): Promise<OAuthTokenSet> => this.userToken({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    profile: async (accessToken: string): Promise<{ externalUserId: string; displayName: string | null }> => {
      const me = await this.get<{ id: number; username?: string }>('/me', {}, accessToken);
      return { externalUserId: String(me.id), displayName: me.username ?? null };
    },
  };

  private async userToken(params: Record<string, string>): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({ ...params, client_id: this.config.clientId ?? '', client_secret: this.config.clientSecret ?? '' });
    const res = await this.http.request('https://secure.soundcloud.com/oauth/token', { method: 'POST', allowedHosts: HOSTS, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json; charset=utf-8' }, body, timeoutMs: 12_000 });
    const data = await res.json<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string }>();
    if (res.status >= 400 || !data.access_token) throw new Error(data.error ?? `SoundCloud token endpoint responded ${res.status}`);
    return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresAt: data.expires_in ? new Date(this.clock.now() + data.expires_in * 1000).toISOString() : null, scopes: data.scope ? data.scope.split(' ') : [] };
  }

  override async importLikes(account: AuthorizedAccount, cursor: string | null): Promise<ImportPage> {
    if (!account.accessToken) throw new Error('Account has no access token');
    const page = await this.get<{ collection: ScTrack[]; next_href?: string }>(cursor ?? '/me/likes/tracks', cursor ? {} : { limit: '50', linked_partitioning: 'true', access: 'playable,preview,blocked' }, account.accessToken);
    return { items: page.collection.map((t) => this.toResult(t)), nextCursor: page.next_href ?? null };
  }

  override async importPlaylists(account: AuthorizedAccount, cursor: string | null): Promise<ImportPage> {
    if (!account.accessToken) throw new Error('Account has no access token');
    const page = await this.get<{ collection: Array<{ id: number; title: string; tracks?: ScTrack[] }>; next_href?: string }>(cursor ?? '/me/playlists', cursor ? {} : { limit: '20', linked_partitioning: 'true', show_tracks: 'true' }, account.accessToken);
    return { items: [], nextCursor: page.next_href ?? null, playlists: page.collection.map((p) => ({ externalId: String(p.id), name: p.title, items: (p.tracks ?? []).map((t) => this.toResult(t)) })) };
  }

  override async refreshCredentials(account: AuthorizedAccount) {
    if (!account.refreshToken) return { status: 'expired' as const, error: 'No refresh token; reconnect the account' };
    try {
      const t = await this.oauth.refresh(account.refreshToken);
      return { status: 'connected' as const, accessToken: t.accessToken, refreshToken: t.refreshToken ?? account.refreshToken, expiresAt: t.expiresAt };
    } catch (err) {
      return { status: 'error' as const, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

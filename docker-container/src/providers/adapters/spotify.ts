import type { ProviderCapabilities, ProviderDescriptor, SearchResult } from '@now-playing/contracts';
import type { Clock } from '../../deps.js';
import type { SafeHttpClient } from '../http.js';
import type { AuthorizedAccount, ImportPage, OAuthCapableAdapter, OAuthTokenSet, PlayableRef, ProviderSearchPage, ProviderTestResult } from '../adapter.js';
import { BaseAdapter, caps, REVIEWED_AT, result } from './base.js';

const API = 'https://api.spotify.com/v1';
const HOSTS = ['api.spotify.com', 'accounts.spotify.com', 'i.scdn.co', 'p.scdn.co'];

interface SpTrack {
  id: string;
  name: string;
  duration_ms: number;
  preview_url?: string | null;
  external_urls: { spotify: string };
  external_ids?: { isrc?: string };
  artists: Array<{ name: string; id: string }>;
  album?: { name: string; release_date?: string; images?: Array<{ url: string; width?: number }> };
  popularity?: number;
  is_playable?: boolean;
}

/**
 * Spotify Web API for metadata/search (client credentials) and per-user library import (PKCE).
 * Playback needs the browser Web Playback SDK and a Premium account and is reported as restricted; previews are not
 * available to apps created after November 2024.
 */
export class SpotifyAdapter extends BaseAdapter implements OAuthCapableAdapter {
  readonly id = 'spotify';
  private appToken: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly http: SafeHttpClient,
    private readonly clock: Clock,
  ) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'Spotify', role: 'metadata-only', docsUrl: 'https://developer.spotify.com/documentation/web-api', authType: 'oauth-pkce', authScopes: ['user-library-read', 'playlist-read-private'], attribution: 'Spotify', rateStrategy: '30-second rolling window; Retry-After honoured; batch endpoints; playlist snapshot_id checks', cachePolicy: '1 h', groupCompatible: false, discordCompatible: false, reviewedAt: REVIEWED_AT, limitations: ['No audio through the hub: Spotify playback requires the Web Playback SDK, Premium and the browser', 'Preview clips are unavailable to new API applications', 'Development-mode apps allow only allowlisted users; extended quota is required for multi-user use'] };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: 'available', search: 'available', playback: 'restricted', importLikes: 'requires_auth', importPlaylists: 'requires_auth', groupSync: 'unsupported', reason: 'Spotify streams only through its own player (Premium, browser SDK); the hub imports your library and opens tracks at Spotify' });
  }

  override requiredConfig(): readonly string[] {
    return ['clientId', 'clientSecret'];
  }

  override allowedHosts(): readonly string[] {
    return HOSTS;
  }

  private async appAccessToken(): Promise<string> {
    if (this.appToken && this.appToken.expiresAt > this.clock.now() + 60_000) return this.appToken.token;
    const basic = Buffer.from(`${this.config.clientId ?? ''}:${this.config.clientSecret ?? ''}`).toString('base64');
    const res = await this.http.request('https://accounts.spotify.com/api/token', { method: 'POST', allowedHosts: HOSTS, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` }, body: new URLSearchParams({ grant_type: 'client_credentials' }), timeoutMs: 12_000 });
    const data = await res.json<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>();
    if (res.status >= 400 || !data.access_token) throw new Error(data.error_description ?? data.error ?? `Spotify token endpoint responded ${res.status}`);
    this.appToken = { token: data.access_token, expiresAt: this.clock.now() + (data.expires_in ?? 3600) * 1000 };
    return data.access_token;
  }

  private async get<T>(path: string, params: Record<string, string>, token?: string): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const auth = token ?? (await this.appAccessToken());
    return this.http.getJson<T>(url.toString(), { allowedHosts: HOSTS, headers: { Authorization: `Bearer ${auth}` }, timeoutMs: 12_000 });
  }

  override async test(): Promise<ProviderTestResult> {
    const started = Date.now();
    await this.appAccessToken();
    return { ok: true, latencyMs: Date.now() - started, message: 'Spotify app credentials accepted' };
  }

  private toResult(t: SpTrack): SearchResult {
    const year = t.album?.release_date ? Number(t.album.release_date.slice(0, 4)) : null;
    const base = this.capabilities();
    const capabilities: ProviderCapabilities = { ...base, preview: t.preview_url ? 'available' : 'unsupported' };
    return result({ provider: this.id, kind: 'track', providerId: t.id, title: t.name, artistName: t.artists.map((a) => a.name).join(', '), albumName: t.album?.name ?? null, durationMs: t.duration_ms, artworkUrl: t.album?.images?.find((i) => (i.width ?? 0) <= 320)?.url ?? t.album?.images?.[0]?.url ?? null, canonicalUrl: t.external_urls.spotify, year: Number.isFinite(year) ? year : null, capabilities, identity: { isrc: t.external_ids?.isrc ?? null }, attribution: 'Spotify', accessState: 'restricted', previewUrl: t.preview_url ?? null });
  }

  override async search(query: string, filters: { scope: string; limit: number }, cursor: string | null): Promise<ProviderSearchPage> {
    const offset = cursor ? Number(cursor) || 0 : 0;
    const data = await this.get<{ tracks?: { items: SpTrack[]; next?: string | null } }>('/search', { q: query, type: 'track', limit: String(Math.min(filters.limit, 50)), offset: String(offset) });
    const items = data.tracks?.items ?? [];
    return { results: items.map((t) => this.toResult(t)), nextCursor: data.tracks?.next ? String(offset + items.length) : null };
  }

  override async getMetadata(id: string): Promise<SearchResult | null> {
    if (!/^[A-Za-z0-9]{22}$/.test(id)) return null;
    const t = await this.get<SpTrack>(`/tracks/${id}`, {});
    return this.toResult(t);
  }

  override async resolve(urlOrId: string): Promise<SearchResult | null> {
    const s = urlOrId.trim();
    const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(s) ?? /open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]{22})/.exec(s);
    return m ? this.getMetadata(m[1]!) : null;
  }

  override async getPreview(id: string): Promise<PlayableRef | null> {
    const r = await this.getMetadata(id);
    return r?.previewUrl ? { kind: 'remote-stream', url: r.previewUrl, mime: 'audio/mpeg', seekable: false, expiresAt: null } : null;
  }

  override async getPlayable(id: string): Promise<PlayableRef | null> {
    if (!/^[A-Za-z0-9]{22}$/.test(id)) return null;
    return { kind: 'open-at-source', url: `https://open.spotify.com/track/${id}` };
  }

  readonly oauth = {
    scopes: ['user-library-read', 'playlist-read-private'] as const,
    authorizationUrl: (input: { redirectUri: string; state: string; codeChallenge: string }): string => {
      const u = new URL('https://accounts.spotify.com/authorize');
      u.searchParams.set('client_id', this.config.clientId ?? '');
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('redirect_uri', input.redirectUri);
      u.searchParams.set('state', input.state);
      u.searchParams.set('scope', this.oauth.scopes.join(' '));
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('code_challenge', input.codeChallenge);
      return u.toString();
    },
    exchangeCode: async (input: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokenSet> => this.userToken({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier, client_id: this.config.clientId ?? '' }),
    refresh: async (refreshToken: string): Promise<OAuthTokenSet> => this.userToken({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.config.clientId ?? '' }, refreshToken),
    profile: async (accessToken: string): Promise<{ externalUserId: string; displayName: string | null }> => {
      const me = await this.get<{ id: string; display_name?: string | null }>('/me', {}, accessToken);
      return { externalUserId: me.id, displayName: me.display_name ?? null };
    },
  };

  private async userToken(params: Record<string, string>, previousRefresh?: string): Promise<OAuthTokenSet> {
    const res = await this.http.request('https://accounts.spotify.com/api/token', { method: 'POST', allowedHosts: HOSTS, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), timeoutMs: 12_000 });
    const data = await res.json<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }>();
    if (res.status >= 400 || !data.access_token) throw new Error(data.error_description ?? data.error ?? `Spotify token endpoint responded ${res.status}`);
    return { accessToken: data.access_token, refreshToken: data.refresh_token ?? previousRefresh ?? null, expiresAt: data.expires_in ? new Date(this.clock.now() + data.expires_in * 1000).toISOString() : null, scopes: data.scope ? data.scope.split(' ') : [...this.oauth.scopes] };
  }

  override async importLikes(account: AuthorizedAccount, cursor: string | null): Promise<ImportPage> {
    if (!account.accessToken) throw new Error('Account has no access token');
    const offset = cursor ? Number(cursor) || 0 : 0;
    const data = await this.get<{ items: Array<{ track: SpTrack | null }>; next: string | null }>('/me/tracks', { limit: '50', offset: String(offset) }, account.accessToken);
    const items = data.items.map((i) => i.track).filter((t): t is SpTrack => !!t).map((t) => this.toResult(t));
    return { items, nextCursor: data.next ? String(offset + data.items.length) : null };
  }

  override async importPlaylists(account: AuthorizedAccount, cursor: string | null): Promise<ImportPage> {
    if (!account.accessToken) throw new Error('Account has no access token');
    const offset = cursor ? Number(cursor) || 0 : 0;
    const lists = await this.get<{ items: Array<{ id: string; name: string; snapshot_id: string; tracks: { total: number } }>; next: string | null }>('/me/playlists', { limit: '20', offset: String(offset) }, account.accessToken);
    const playlists: NonNullable<ImportPage['playlists']> = [];
    for (const pl of lists.items) {
      const items: SearchResult[] = [];
      let next: string | null = `${API}/playlists/${pl.id}/tracks?limit=100&fields=items(track(id,name,duration_ms,preview_url,external_urls,external_ids,artists,album(name,release_date,images))),next`;
      for (let page = 0; page < 10 && next; page += 1) {
        const data: { items: Array<{ track: SpTrack | null }>; next: string | null } = await this.get(next, {}, account.accessToken);
        items.push(...data.items.map((i) => i.track).filter((t): t is SpTrack => !!t && !!t.id).map((t) => this.toResult(t)));
        next = data.next;
      }
      playlists.push({ externalId: `${pl.id}#${pl.snapshot_id}`, name: pl.name, items });
    }
    return { items: [], nextCursor: lists.next ? String(offset + lists.items.length) : null, playlists };
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

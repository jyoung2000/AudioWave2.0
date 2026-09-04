import type { ProviderCapabilities, ProviderDescriptor, SearchResult } from '@now-playing/contracts';
import type { SafeHttpClient } from '../http.js';
import type { AuthorizedAccount, ImportPage, OAuthCapableAdapter, OAuthTokenSet, PlayableRef, ProviderSearchPage, ProviderTestResult } from '../adapter.js';
import { BaseAdapter, caps, isoDurationToMs, REVIEWED_AT, result } from './base.js';

const API = 'https://www.googleapis.com/youtube/v3';
const HOSTS = ['www.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com', 'i.ytimg.com'];
export const YOUTUBE_SEARCH_COST = 100;

interface SearchItem {
  id: { videoId?: string };
  snippet: { title: string; channelTitle: string; publishedAt: string; thumbnails?: { medium?: { url: string }; default?: { url: string } } };
}
interface VideoItem {
  id: string;
  snippet: { title: string; channelTitle: string; publishedAt: string; thumbnails?: { medium?: { url: string }; default?: { url: string } } };
  contentDetails?: { duration?: string; regionRestriction?: { blocked?: string[] } };
  status?: { embeddable?: boolean; privacyStatus?: string };
}

export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = /^\/(?:shorts|embed|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
      return m ? m[1]! : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * YouTube Data API v3 for metadata/search; playback only through the official embedded player in the browser.
 * No audio download, no stream extraction. Per-user OAuth (youtube.readonly) imports liked videos and playlists.
 */
export class YouTubeAdapter extends BaseAdapter implements OAuthCapableAdapter {
  readonly id = 'youtube';

  constructor(private readonly http: SafeHttpClient) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'YouTube', role: 'audio-source', docsUrl: 'https://developers.google.com/youtube/v3', authType: 'api-key', authScopes: ['https://www.googleapis.com/auth/youtube.readonly'], attribution: 'YouTube', rateStrategy: '10,000 units/day; search costs 100 units; results cached 1 h; background discovery shed first', cachePolicy: '1 h search, 24 h metadata', groupCompatible: true, discordCompatible: false, reviewedAt: REVIEWED_AT, limitations: ['Plays only inside the embedded YouTube player; audio is not available to the EQ', 'No downloads', 'Group sync is best effort (embedded players cannot be aligned exactly)', 'Requires an API key restricted to this hub; OAuth client id/secret for library import'] };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: 'available', search: 'available', playback: 'available', importLikes: 'requires_auth', importPlaylists: 'requires_auth', groupSync: 'best_effort', eq: 'unsupported', reason: 'Plays in the embedded YouTube player; downloads and EQ are not available for YouTube content' });
  }

  override requiredConfig(): readonly string[] {
    return ['apiKey'];
  }

  override allowedHosts(): readonly string[] {
    return HOSTS;
  }

  private async get<T>(path: string, params: Record<string, string>, accessToken?: string): Promise<T> {
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (!accessToken) url.searchParams.set('key', this.config.apiKey ?? '');
    return this.http.getJson<T>(url.toString(), { allowedHosts: HOSTS, headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, timeoutMs: 12_000 });
  }

  override async test(): Promise<ProviderTestResult> {
    const started = Date.now();
    await this.get<{ items: VideoItem[] }>('videos', { part: 'id', id: 'dQw4w9WgXcQ' });
    return { ok: true, latencyMs: Date.now() - started, message: 'YouTube Data API reachable with this key' };
  }

  private toResult(v: VideoItem): SearchResult {
    const embeddable = v.status?.embeddable !== false && v.status?.privacyStatus !== 'private';
    const capabilities = embeddable ? this.capabilities() : { ...this.capabilities(), playback: 'restricted' as const, reason: 'The owner disabled embedding for this video' };
    const year = Number(v.snippet.publishedAt.slice(0, 4));
    return result({ provider: this.id, kind: 'track', providerId: v.id, title: v.snippet.title, artistName: v.snippet.channelTitle, artworkUrl: v.snippet.thumbnails?.medium?.url ?? v.snippet.thumbnails?.default?.url ?? null, canonicalUrl: `https://www.youtube.com/watch?v=${v.id}`, durationMs: v.contentDetails?.duration ? isoDurationToMs(v.contentDetails.duration) : null, year: Number.isFinite(year) ? year : null, capabilities, attribution: 'YouTube', accessState: embeddable ? 'available' : 'restricted' });
  }

  override async search(query: string, filters: { scope: string; limit: number }, cursor: string | null): Promise<ProviderSearchPage> {
    const params: Record<string, string> = { part: 'snippet', type: 'video', videoCategoryId: '10', q: query, maxResults: String(Math.min(filters.limit, 25)), safeSearch: 'none' };
    if (cursor) params['pageToken'] = cursor;
    const data = await this.get<{ items: SearchItem[]; nextPageToken?: string }>('search', params);
    const ids = data.items.map((i) => i.id.videoId).filter((v): v is string => !!v);
    if (!ids.length) return { results: [], nextCursor: null };
    const videos = await this.get<{ items: VideoItem[] }>('videos', { part: 'snippet,contentDetails,status', id: ids.join(',') });
    return { results: videos.items.map((v) => this.toResult(v)), nextCursor: data.nextPageToken ?? null };
  }

  override async getMetadata(id: string): Promise<SearchResult | null> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    const data = await this.get<{ items: VideoItem[] }>('videos', { part: 'snippet,contentDetails,status', id });
    const v = data.items[0];
    return v ? this.toResult(v) : null;
  }

  override async resolve(urlOrId: string): Promise<SearchResult | null> {
    const id = parseYouTubeId(urlOrId);
    return id ? this.getMetadata(id) : null;
  }

  override async getPlayable(id: string): Promise<PlayableRef | null> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return { kind: 'embed', embedUrl: `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&rel=0`, canonicalUrl: `https://www.youtube.com/watch?v=${id}` };
  }

  /* ---- OAuth (youtube.readonly) ---- */
  readonly oauth = {
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'] as const,
    authorizationUrl: (input: { redirectUri: string; state: string; codeChallenge: string }): string => {
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      u.searchParams.set('client_id', this.config.clientId ?? '');
      u.searchParams.set('redirect_uri', input.redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', this.oauth.scopes.join(' '));
      u.searchParams.set('state', input.state);
      u.searchParams.set('code_challenge', input.codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent');
      return u.toString();
    },
    exchangeCode: async (input: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokenSet> => this.token({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier }),
    refresh: async (refreshToken: string): Promise<OAuthTokenSet> => this.token({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken),
    profile: async (accessToken: string): Promise<{ externalUserId: string; displayName: string | null }> => {
      const data = await this.get<{ items?: Array<{ id: string; snippet?: { title?: string } }> }>('channels', { part: 'snippet', mine: 'true' }, accessToken);
      const ch = data.items?.[0];
      return { externalUserId: ch?.id ?? 'unknown', displayName: ch?.snippet?.title ?? null };
    },
  };

  private async token(params: Record<string, string>, previousRefresh?: string): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({ ...params, client_id: this.config.clientId ?? '', client_secret: this.config.clientSecret ?? '' });
    const res = await this.http.request('https://oauth2.googleapis.com/token', { method: 'POST', allowedHosts: HOSTS, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, timeoutMs: 12_000 });
    const data = await res.json<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }>();
    if (res.status >= 400 || !data.access_token) throw new Error(data.error_description ?? data.error ?? `Token endpoint responded ${res.status}`);
    return { accessToken: data.access_token, refreshToken: data.refresh_token ?? previousRefresh ?? null, expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null, scopes: data.scope ? data.scope.split(' ') : [...this.oauth.scopes] };
  }

  override async importLikes(account: AuthorizedAccount, cursor: string | null): Promise<ImportPage> {
    if (!account.accessToken) throw new Error('Account has no access token');
    const params: Record<string, string> = { part: 'snippet,contentDetails,status', myRating: 'like', maxResults: '50' };
    if (cursor) params['pageToken'] = cursor;
    const data = await this.get<{ items: VideoItem[]; nextPageToken?: string }>('videos', params, account.accessToken);
    return { items: data.items.map((v) => this.toResult(v)), nextCursor: data.nextPageToken ?? null };
  }

  override async importPlaylists(account: AuthorizedAccount, cursor: string | null): Promise<ImportPage> {
    if (!account.accessToken) throw new Error('Account has no access token');
    const params: Record<string, string> = { part: 'snippet', mine: 'true', maxResults: '25' };
    if (cursor) params['pageToken'] = cursor;
    const lists = await this.get<{ items: Array<{ id: string; snippet: { title: string } }>; nextPageToken?: string }>('playlists', params, account.accessToken);
    const playlists: NonNullable<ImportPage['playlists']> = [];
    for (const pl of lists.items) {
      const items: SearchResult[] = [];
      let token: string | null = null;
      for (let page = 0; page < 8; page += 1) {
        const p: Record<string, string> = { part: 'contentDetails', playlistId: pl.id, maxResults: '50' };
        if (token) p['pageToken'] = token;
        const data: { items: Array<{ contentDetails: { videoId: string } }>; nextPageToken?: string } = await this.get('playlistItems', p, account.accessToken);
        const ids = data.items.map((i) => i.contentDetails.videoId);
        if (ids.length) {
          const videos = await this.get<{ items: VideoItem[] }>('videos', { part: 'snippet,contentDetails,status', id: ids.join(',') }, account.accessToken);
          items.push(...videos.items.map((v) => this.toResult(v)));
        }
        token = data.nextPageToken ?? null;
        if (!token) break;
      }
      playlists.push({ externalId: pl.id, name: pl.snippet.title, items });
    }
    return { items: [], nextCursor: lists.nextPageToken ?? null, playlists };
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

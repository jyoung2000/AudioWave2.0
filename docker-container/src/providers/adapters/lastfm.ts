import type { ProviderCapabilities, ProviderDescriptor } from '@now-playing/contracts';
import type { ProviderRuntimeConfig } from '../adapter.js';
import type { SafeHttpClient } from '../http.js';
import { BaseAdapter, caps, REVIEWED_AT } from './base.js';

/**
 * Last.fm's community tags, the best free signal for mood and scene ("chill", "seen live", "90s").
 * Optional: it needs an API key the operator enters in the Providers tab; without one the adapter
 * answers with nothing and makes no request.
 */
const API = 'https://ws.audioscrobbler.com/2.0/';
const HOSTS = ['ws.audioscrobbler.com'];

export interface LastFmTag { name: string; count: number }

export class LastFmAdapter extends BaseAdapter {
  readonly id = 'lastfm';

  constructor(private readonly http: SafeHttpClient) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'Last.fm (tags)', role: 'metadata-only', docsUrl: 'https://www.last.fm/api', authType: 'api-key', authScopes: [], attribution: 'Tags from Last.fm', rateStrategy: '5 requests per second per key', cachePolicy: 'stored on the canonical row', groupCompatible: false, discordCompatible: false, limitations: ['Tags are community text and arrive weighted by votes; without an API key nothing is fetched.'], reviewedAt: REVIEWED_AT };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: this.config.apiKey ? 'available' : 'requires_auth', reason: 'Community tags; needs an API key from last.fm/api' });
  }

  override requiredConfig(): readonly string[] {
    return ['apiKey'];
  }

  override allowedHosts(): readonly string[] {
    return HOSTS;
  }

  currentConfig(): ProviderRuntimeConfig {
    return this.config;
  }

  private async call(params: Record<string, string>): Promise<LastFmTag[]> {
    const url = new URL(API);
    for (const [k, v] of Object.entries({ ...params, api_key: this.config.apiKey ?? '', format: 'json', autocorrect: '1' })) url.searchParams.set(k, v);
    const d = await this.http.getJson<{ toptags?: { tag?: LastFmTag[] } }>(url.toString(), { allowedHosts: HOSTS, timeoutMs: 8_000 }).catch(() => null);
    return (d?.toptags?.tag ?? []).filter((t) => t.name && t.count > 0);
  }

  /** Track tags when Last.fm has them, else the artist's — and nothing at all without a key. */
  async topTags(artist: string, title: string): Promise<LastFmTag[]> {
    if (!this.config.apiKey) return [];
    const track = await this.call({ method: 'track.gettoptags', artist, track: title });
    if (track.length) return track;
    return this.call({ method: 'artist.gettoptags', artist });
  }
}

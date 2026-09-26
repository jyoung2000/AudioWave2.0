import type { ProviderCapabilities, ProviderDescriptor } from '@now-playing/contracts';
import type { SafeHttpClient } from '../http.js';
import { BaseAdapter, caps, REVIEWED_AT } from './base.js';

/**
 * Deezer's public API: the one keyless source that publishes a tempo. Metadata only — this adapter
 * never touches audio. A `bpm` of 0 means Deezer has not measured the track, not that it has none.
 */
const API = 'https://api.deezer.com';
const HOSTS = ['api.deezer.com'];
const DURATION_GATE_MS = 3000;

interface DzTrack { id: number; bpm?: number; duration?: number; title?: string; artist?: { name: string }; error?: unknown }

export class DeezerAdapter extends BaseAdapter {
  readonly id = 'deezer';

  constructor(private readonly http: SafeHttpClient) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'Deezer (tempo)', role: 'metadata-only', docsUrl: 'https://developers.deezer.com/api', authType: 'none', authScopes: [], attribution: 'Tempo data from Deezer', rateStrategy: 'Public API; 50 requests per 5 s; backoff on 4xx', cachePolicy: 'stored on the canonical row', groupCompatible: false, discordCompatible: false, limitations: ['Tempo is present for a subset of the catalogue and 0 means unmeasured; no audio, no previews.'], reviewedAt: REVIEWED_AT };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: 'available', reason: 'Tempo and duration only; never audio' });
  }

  override allowedHosts(): readonly string[] {
    return HOSTS;
  }

  private get<T>(path: string): Promise<T> {
    return this.http.getJson<T>(`${API}/${path}`, { allowedHosts: HOSTS, timeoutMs: 8_000 });
  }

  async bpmByIsrc(isrc: string): Promise<{ bpm: number; durationMs: number | null } | null> {
    const t = await this.get<DzTrack>(`track/isrc:${encodeURIComponent(isrc)}`).catch(() => null);
    if (!t || t.error || !(t.bpm && t.bpm > 0)) return null;
    return { bpm: Math.round(t.bpm), durationMs: t.duration && t.duration > 0 ? t.duration * 1000 : null };
  }

  /** A search hit counts only when its length agrees with ours to three seconds; a same-named live take must not lend its tempo. */
  async bpmBySearch(artist: string, title: string, durationMs: number | null): Promise<{ bpm: number } | null> {
    const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
    const page = await this.get<{ data?: DzTrack[] }>(`search?limit=3&q=${q}`).catch(() => null);
    const hit = (page?.data ?? []).find((d) => durationMs === null || !d.duration || Math.abs(d.duration * 1000 - durationMs) <= DURATION_GATE_MS);
    if (!hit) return null;
    const t = await this.get<DzTrack>(`track/${hit.id}`).catch(() => null);
    return t && t.bpm && t.bpm > 0 ? { bpm: Math.round(t.bpm) } : null;
  }
}

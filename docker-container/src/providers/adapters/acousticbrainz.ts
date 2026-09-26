import type { ProviderCapabilities, ProviderDescriptor } from '@now-playing/contracts';
import type { SafeHttpClient } from '../http.js';
import { BaseAdapter, caps, REVIEWED_AT } from './base.js';

/**
 * AcousticBrainz: an archive of audio analysis keyed by MusicBrainz recording id, CC0. Collection
 * stopped in 2022, so it answers for the back catalogue and says nothing about anything newer.
 */
const API = 'https://acousticbrainz.org/api/v1';
const HOSTS = ['acousticbrainz.org'];

export class AcousticBrainzAdapter extends BaseAdapter {
  readonly id = 'acousticbrainz';

  constructor(private readonly http: SafeHttpClient) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'AcousticBrainz (tempo archive)', role: 'metadata-only', docsUrl: 'https://acousticbrainz.org/data', authType: 'none', authScopes: [], attribution: 'AcousticBrainz (CC0)', rateStrategy: 'Archive; one lookup per recording, never retried on 404', cachePolicy: 'stored on the canonical row', groupCompatible: false, discordCompatible: false, limitations: 'Archive frozen in 2022: nothing released since is known; needs a MusicBrainz recording id.', reviewedAt: REVIEWED_AT };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: 'available', reason: 'Archived analysis by MusicBrainz id; collection ended in 2022' });
  }

  override allowedHosts(): readonly string[] {
    return HOSTS;
  }

  async bpmByMbid(mbid: string): Promise<number | null> {
    const d = await this.http.getJson<{ rhythm?: { bpm?: number } }>(`${API}/${encodeURIComponent(mbid)}/low-level`, { allowedHosts: HOSTS, timeoutMs: 8_000 }).catch(() => null);
    const bpm = d?.rhythm?.bpm;
    return bpm && bpm > 0 ? Math.round(bpm) : null;
  }
}

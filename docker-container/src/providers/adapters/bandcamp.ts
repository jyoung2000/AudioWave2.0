import type { ProviderCapabilities, ProviderDescriptor, SearchResult } from '@now-playing/contracts';
import type { PlayableRef } from '../adapter.js';
import { BaseAdapter, caps, humanizeSlug, REVIEWED_AT, result } from './base.js';

/**
 * Bandcamp has no public API and forbids scraping, so this adapter only understands pasted links (open at source) and
 * optionally enriches them through MusicBrainz URL relationships. Purchased downloads are imported through the
 * Windows companion from the user's own Bandcamp export.
 */
export class BandcampAdapter extends BaseAdapter {
  readonly id = 'bandcamp';

  constructor(private readonly lookupUrl: (url: string) => Promise<SearchResult | null>) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'Bandcamp', role: 'metadata-only', docsUrl: 'https://bandcamp.com/developer', authType: 'none', authScopes: [], attribution: 'Bandcamp', groupCompatible: false, discordCompatible: false, reviewedAt: REVIEWED_AT, limitations: ['No public API: only deep links are supported', 'Purchases are imported from your own Bandcamp download export via the Windows companion'] };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: 'restricted', groupSync: 'unsupported', reason: 'Bandcamp offers no public API; open the link at Bandcamp to listen or buy' });
  }

  override async resolve(urlOrId: string): Promise<SearchResult | null> {
    let u: URL;
    try {
      u = new URL(urlOrId.trim());
    } catch {
      return null;
    }
    if (!/\.bandcamp\.com$/.test(u.hostname)) return null;
    const m = /^\/(track|album)\/([a-z0-9-]+)/i.exec(u.pathname);
    if (!m) return null;
    const artist = humanizeSlug(u.hostname.replace(/\.bandcamp\.com$/, ''));
    const canonical = `https://${u.hostname}${u.pathname}`;
    const enriched = await this.lookupUrl(canonical).catch(() => null);
    const base = result({ provider: this.id, kind: m[1]!.toLowerCase() === 'album' ? 'album' : 'track', providerId: canonical, title: enriched?.title ?? humanizeSlug(m[2]!), artistName: enriched?.artistName ?? artist, albumName: enriched?.albumName ?? null, durationMs: enriched?.durationMs ?? null, year: enriched?.year ?? null, canonicalUrl: canonical, capabilities: this.capabilities(), identity: enriched?.identity ?? {}, attribution: 'Bandcamp', accessState: 'unsupported' });
    return base;
  }

  override async getPlayable(id: string): Promise<PlayableRef | null> {
    return /^https:\/\/[a-z0-9-]+\.bandcamp\.com\//i.test(id) ? { kind: 'open-at-source', url: id } : null;
  }
}

/**
 * Windows companion release metadata.
 *
 * The PWA shows a "Get the Windows companion" link, and that link must not be a lie: if no release
 * has been configured the route returns 404 and the player renders nothing rather than a dead
 * button (docs/CAPABILITIES.md). An operator either pastes the metadata directly or points the hub
 * at a `latest.json` feed published by the Windows CI workflow.
 *
 * A fetched feed is validated against the canonical `ReleaseMetadata` schema before it is stored,
 * and fetched through the SSRF-guarded client with the feed's own host as the only allowlist entry
 * — a redirect to somewhere else is refused, not followed.
 */
import { ReleaseMetadata } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import type { SettingsRepository } from '../db/repositories/settings.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { SafeHttpClient } from '../providers/http.js';

const SETTINGS_KEY = 'releases.windows-companion';
/** A feed is re-fetched at most this often; the cached copy answers in between. */
const FEED_TTL_MS = 6 * 60 * 60 * 1000;

export interface ReleaseState {
  feedUrl: string | null;
  metadata: ReleaseMetadata | null;
  lastFetchedAt: string | null;
  lastError: string | null;
}

const EMPTY: ReleaseState = { feedUrl: null, metadata: null, lastFetchedAt: null, lastError: null };

export class ReleaseService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly http: SafeHttpClient,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
  ) {}

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  state(): ReleaseState {
    return this.settings.get<ReleaseState>(SETTINGS_KEY) ?? EMPTY;
  }

  private save(state: ReleaseState): ReleaseState {
    this.settings.set(SETTINGS_KEY, state, this.nowIso());
    return state;
  }

  /** Metadata for the public route. Null means "no release configured" — a 404, not an empty object. */
  latest(): ReleaseMetadata | null {
    return this.state().metadata;
  }

  async configure(input: { feedUrl?: string | null | undefined; metadata?: ReleaseMetadata | null | undefined }): Promise<ReleaseState> {
    const current = this.state();
    let next: ReleaseState = { ...current };

    if (input.metadata !== undefined) {
      if (input.metadata === null) {
        next = { ...next, metadata: null, lastError: null };
      } else {
        const parsed = ReleaseMetadata.safeParse(input.metadata);
        if (!parsed.success) throw new DomainError('validation', `That release metadata is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
        next = { ...next, metadata: parsed.data, lastFetchedAt: this.nowIso(), lastError: null };
      }
    }

    if (input.feedUrl !== undefined) {
      next = { ...next, feedUrl: input.feedUrl };
      if (input.feedUrl) {
        const fetched = await this.fetchFeed(input.feedUrl);
        next = { ...next, ...fetched };
      }
    }

    return this.save(next);
  }

  /** Refresh from the configured feed if one exists and the cached copy has aged out. */
  async refresh(force = false): Promise<ReleaseState> {
    const current = this.state();
    if (!current.feedUrl) return current;
    if (!force && current.lastFetchedAt && this.clock.now() - Date.parse(current.lastFetchedAt) < FEED_TTL_MS) return current;
    const fetched = await this.fetchFeed(current.feedUrl);
    return this.save({ ...current, ...fetched });
  }

  private async fetchFeed(feedUrl: string): Promise<Pick<ReleaseState, 'metadata' | 'lastFetchedAt' | 'lastError'>> {
    let host: string;
    try {
      const url = new URL(feedUrl);
      if (url.protocol !== 'https:') throw new Error('the feed URL must use https');
      host = url.hostname;
    } catch (err) {
      throw new DomainError('validation', `That is not a usable release feed URL: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const response = await this.http.request(feedUrl, { allowedHosts: [host], allowedSchemes: ['https:'], timeoutMs: 10_000, maxBytes: 256 * 1024, maxRedirects: 1 });
      if (response.status !== 200) throw new Error(`the feed responded ${response.status}`);
      const parsed = ReleaseMetadata.safeParse(await response.json());
      if (!parsed.success) throw new Error(`the feed is not valid release metadata (${parsed.error.issues[0]?.message ?? 'schema mismatch'})`);
      this.metrics.increment('releases.feed_fetched');
      return { metadata: parsed.data, lastFetchedAt: this.nowIso(), lastError: null };
    } catch (err) {
      this.metrics.increment('releases.feed_failed');
      const message = err instanceof Error ? err.message : String(err);
      // Keep whatever metadata is already stored: a transient fetch failure should not remove a
      // working download link.
      return { metadata: this.state().metadata, lastFetchedAt: this.state().lastFetchedAt, lastError: `Could not read the release feed: ${message}` };
    }
  }

  /** The compatibility matrix served by `GET /updates`. */
  compatibility(version: string, contractsVersion: string, protocolVersion: number): Array<{ product: string; minVersion: string; protocolVersion: number }> {
    return [
      { product: 'music-player', minVersion: version, protocolVersion },
      { product: 'windows-companion', minVersion: this.state().metadata?.version ?? version, protocolVersion },
      { product: 'contracts', minVersion: contractsVersion, protocolVersion },
    ];
  }
}

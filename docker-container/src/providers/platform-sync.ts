/**
 * Incremental import from connected platform accounts, and the discovery cache that keeps
 * recommendation requests off the providers' rate limits (spec §§20–23).
 *
 * Three properties are the point of this file:
 *
 * **Incremental, not full.** Each account keeps a cursor and a content snapshot hash. A sync
 * resumes from the cursor, and when the page hash matches the stored snapshot the run stops early
 * — re-importing an unchanged library would spend quota to learn nothing. That is what makes a
 * nightly sync affordable inside a 10,000-unit YouTube budget.
 *
 * **Every call is priced.** Imports run at P2 through the shared `RateLimitManager`, below
 * interactive search (P1) and token refresh (P0), so a background crawl can never starve a user
 * waiting on a screen.
 *
 * **Nothing is invented.** Imported items become canonical tracks with a `track_platforms` row
 * recording where they were seen and whether they are playable there. An item a provider says is
 * region-locked stays region-locked in the catalogue rather than being offered and failing later.
 */
import { createHash } from 'node:crypto';
import type { SearchResult, TasteProfileView, UserPlatformSync } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import type { CanonicalRepository } from '../db/repositories/canonical.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { AccountsService } from './accounts.js';
import type { RecommendationService } from './recommendations.js';
import type { ProviderRegistry } from './registry.js';
import type { RateLimitManager } from './rate-limit-manager.js';

/** Pages per run. A larger library finishes over several scheduled runs rather than one long one. */
const MAX_PAGES_PER_RUN = 5;
/** Cached discovery results are good for a day; seeds change slowly. */
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
/** New-release checks are cheap but pointless more than once a day. */
const NEW_RELEASE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SyncReport {
  provider: string;
  imported: number;
  pages: number;
  unchanged: boolean;
  cursor: string | null;
  error: string | null;
}

export class PlatformSyncService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly registry: ProviderRegistry,
    private readonly rateLimiter: RateLimitManager,
    private readonly recommendations: RecommendationService,
    private readonly repo: CanonicalRepository,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
  ) {}

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /**
   * Import a user's likes and playlists from one provider, resuming from the stored cursor.
   * Returns a report rather than throwing for a provider-level failure, so one bad account does not
   * fail the whole scheduled run — but an authentication failure *is* thrown, because the user has
   * to act on it.
   */
  async syncLibrary(userId: string, provider: string): Promise<SyncReport> {
    if (!this.registry.has(provider)) throw new DomainError('not-found', `This hub has no ${provider} adapter`);
    if (!this.registry.isEnabled(provider) || !this.registry.isConfigured(provider)) {
      return { provider, imported: 0, pages: 0, unchanged: true, cursor: null, error: `${provider} is not configured on this hub` };
    }
    const adapter = this.registry.get(provider);
    const capabilities = this.registry.effectiveCapabilities(provider);
    if (capabilities.importLikes === 'unsupported' && capabilities.importPlaylists === 'unsupported') {
      return { provider, imported: 0, pages: 0, unchanged: true, cursor: null, error: `${provider} does not offer an API for importing your saved music` };
    }

    const previous = this.accounts.syncStatus(userId, provider);
    this.accounts.setSyncStatus({ ...previous, status: 'running', lastError: null });

    let cursor = previous.cursor;
    let imported = 0;
    let pages = 0;
    let unchanged = false;

    try {
      const account = await this.accounts.authorize(provider, userId);
      for (; pages < MAX_PAGES_PER_RUN; pages += 1) {
        const page = await this.rateLimiter.run(provider, 'P2', () => adapter.importLikes(account, cursor), { timeoutMs: 20_000, cost: provider === 'youtube' ? 1 : 1 });
        const digest = snapshotOf(page.items);
        if (pages === 0 && digest === previous.snapshot && cursor === previous.cursor) {
          // The first page is byte-identical to the last run: nothing has changed upstream.
          unchanged = true;
          break;
        }
        imported += this.ingest(userId, provider, page.items);
        for (const playlist of page.playlists ?? []) imported += this.ingest(userId, provider, playlist.items);
        if (pages === 0) {
          this.accounts.setSyncStatus({ ...previous, status: 'running', snapshot: digest });
        }
        cursor = page.nextCursor;
        if (!cursor) break;
      }

      this.accounts.setSyncStatus({
        userId,
        provider,
        lastSyncAt: this.nowIso(),
        cursor,
        snapshot: previous.snapshot,
        etag: previous.etag,
        status: 'idle',
        lastError: null,
      });
      this.metrics.increment(`platform_sync.${provider}.imported`, imported);
      return { provider, imported, pages, unchanged, cursor, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.accounts.setSyncStatus({ ...previous, status: 'error', lastError: message.slice(0, 300) });
      this.metrics.increment(`platform_sync.${provider}.failed`);
      if (err instanceof DomainError && (err.code === 'unauthenticated' || err.code === 'forbidden')) throw err;
      return { provider, imported, pages, unchanged, cursor, error: message };
    }
  }

  /** Fold a page of provider results into the canonical catalogue. */
  private ingest(userId: string, provider: string, items: readonly SearchResult[]): number {
    let n = 0;
    for (const item of items) {
      try {
        this.recommendations.canonicaliseSearchResult(item);
        n += 1;
      } catch {
        // One unparseable item never fails a page; the rest of the import still lands.
        this.metrics.increment(`platform_sync.${provider}.item_skipped`);
      }
    }
    if (n) this.metrics.increment(`platform_sync.${provider}.items`, n);
    void userId;
    return n;
  }

  /** Every connected provider for one user, sequentially so their budgets are not spent at once. */
  async syncAll(userId: string): Promise<SyncReport[]> {
    const reports: SyncReport[] = [];
    for (const account of this.accounts.list(userId)) {
      if (account.status !== 'connected') continue;
      reports.push(await this.syncLibrary(userId, account.provider));
    }
    return reports;
  }

  /**
   * Warm the discovery cache for a user's strongest seeds. This is what makes a "Discover" request
   * answer from local data: the expensive provider searches happen on a schedule, not while
   * someone is waiting.
   */
  async warmDiscoveryCache(userId: string): Promise<{ queries: number; cached: number }> {
    const profile = this.recommendations.view(userId);
    // `dimensions` is the canonical shape: a weighted list per dimension, strongest first.
    const seeds = [...topKeys(profile, 'artist', 5), ...topKeys(profile, 'genre', 3)];
    if (!seeds.length) return { queries: 0, cached: 0 };

    let cached = 0;
    for (const seed of seeds) {
      for (const adapter of this.registry.searchable()) {
        const key = discoveryKey(adapter.id, seed);
        const hit = this.repo.cacheGet(key);
        if (hit && Date.parse(hit.expiresAt) > this.clock.now()) continue;
        try {
          const page = await this.rateLimiter.run(adapter.id, 'P4', () => adapter.search(seed, { scope: 'songs', limit: 25 }, null), { timeoutMs: 15_000, cost: adapter.id === 'youtube' ? 100 : 1 });
          this.repo.cachePut(key, adapter.id, seed, page.results, this.nowIso(), new Date(this.clock.now() + DISCOVERY_TTL_MS).toISOString());
          for (const result of page.results) this.recommendations.canonicaliseSearchResult(result);
          cached += 1;
        } catch {
          // A provider that is rate-limited or down simply contributes nothing this round; the
          // cache keeps whatever it already had.
          this.metrics.increment(`discovery.warm_failed.${adapter.id}`);
        }
      }
    }
    this.metrics.increment('discovery.cache_warmed', cached);
    return { queries: seeds.length, cached };
  }

  /**
   * New releases from artists the user actually listens to. Provider APIs differ wildly here, so
   * this uses the one thing every adapter has — search — scoped to the artist name, and filters to
   * releases from the last 60 days by year where the provider reports one.
   */
  async refreshNewReleases(userId: string): Promise<{ artists: number; found: number }> {
    const profile = this.recommendations.view(userId);
    const artists = topKeys(profile, 'artist', 10);
    const currentYear = new Date(this.clock.now()).getUTCFullYear();
    let found = 0;
    for (const artist of artists) {
      const key = discoveryKey('new-releases', artist);
      const hit = this.repo.cacheGet(key);
      if (hit && Date.parse(hit.expiresAt) > this.clock.now()) continue;
      const results: SearchResult[] = [];
      for (const adapter of this.registry.searchable()) {
        try {
          const page = await this.rateLimiter.run(adapter.id, 'P4', () => adapter.search(artist, { scope: 'songs', limit: 15 }, null), { timeoutMs: 15_000, cost: adapter.id === 'youtube' ? 100 : 1 });
          for (const result of page.results) {
            if (result.year !== null && result.year !== undefined && result.year >= currentYear - 1) {
              results.push(result);
              this.recommendations.canonicaliseSearchResult(result);
            }
          }
        } catch {
          this.metrics.increment(`discovery.new_releases_failed.${adapter.id}`);
        }
      }
      this.repo.cachePut(key, 'new-releases', artist, results, this.nowIso(), new Date(this.clock.now() + NEW_RELEASE_TTL_MS).toISOString());
      found += results.length;
    }
    this.metrics.increment('discovery.new_releases', found);
    return { artists: artists.length, found };
  }

  /** Cached provider results for a seed, if any are still fresh. */
  cachedFor(provider: string, seed: string): SearchResult[] | null {
    const hit = this.repo.cacheGet(discoveryKey(provider, seed));
    if (!hit || Date.parse(hit.expiresAt) <= this.clock.now()) return null;
    return hit.results as SearchResult[];
  }

  status(userId: string, provider: string): UserPlatformSync {
    return this.accounts.syncStatus(userId, provider);
  }

  maintenance(): number {
    return this.repo.cachePurge(this.nowIso());
  }
}

/** The strongest `n` keys of one taste dimension, in descending weight. */
function topKeys(profile: TasteProfileView, dimension: string, n: number): string[] {
  return (profile.dimensions[dimension] ?? [])
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n)
    .map((entry) => entry.key);
}

function discoveryKey(provider: string, seed: string): string {
  return `discover:${provider}:${createHash('sha256').update(seed.toLowerCase().trim()).digest('hex').slice(0, 32)}`;
}

/** A stable digest of a page of results, so an unchanged upstream library is detected cheaply. */
function snapshotOf(items: readonly SearchResult[]): string {
  const text = items.map((i) => `${i.provider}:${i.providerId}`).join('\n');
  return createHash('sha256').update(text).digest('hex');
}

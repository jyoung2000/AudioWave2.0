/**
 * Aggregate search across every enabled, configured provider.
 *
 * A provider that fails, times out or is rate-limited degrades only itself: its error is reported
 * in `partialFailures` and the other providers' results are still returned. The response always
 * says which providers were consulted and what happened to each, so the UI can show "SoundCloud
 * did not respond" instead of silently returning less.
 *
 * Results carry capability state, never assumptions, and are deduplicated across providers: the
 * same recording found on three services becomes one row with the others as `variants`.
 */
import type { ProviderId, SearchResponse, SearchResult, SearchScope, TrackRef } from '@now-playing/contracts';
import type { z } from 'zod';
import type { LatestReleasesResponse as LatestReleasesResponseSchema } from '@now-playing/contracts';

type LatestReleasesResponse = z.infer<typeof LatestReleasesResponseSchema>;
import { DomainError, mergeSearchResults, validateOutboundUrl } from '@now-playing/domain';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { ProvidersRepository } from '../db/repositories/providers.js';
import type { ProviderRegistry } from './registry.js';
import type { RateLimitManager } from './rate-limit-manager.js';
import { ProviderHttpError } from './http.js';
import { parseResultId } from './adapters/base.js';
import type { MusicBrainzAdapter } from './adapters/musicbrainz.js';

export interface SearchRequest {
  query: string;
  scope?: SearchScope;
  /** Restrict to these provider ids (the UI's provider filter). */
  providers?: readonly string[];
  limit?: number;
  cursor?: string | null;
  actorId: string;
}

interface CursorMap {
  [provider: string]: string | null;
}

const CACHE_TTL_MS = 60 * 60 * 1000;

export class SearchService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly rateLimiter: RateLimitManager,
    private readonly repo: ProvidersRepository,
    private readonly clock: Clock,
    private readonly metrics: MetricsRegistry,
  ) {}

  private cacheKey(provider: string, query: string, scope: SearchScope, cursor: string | null): string {
    return `search:${provider}:${scope}:${cursor ?? ''}:${query.trim().toLowerCase()}`;
  }

  private readCache(key: string): { results: SearchResult[]; nextCursor: string | null; createdAt: string } | null {
    const hit = this.repo.cacheGet(key);
    if (!hit) return null;
    if (Date.parse(hit.expiresAt) <= this.clock.now()) return null;
    try {
      const parsed = JSON.parse(hit.value) as { results: SearchResult[]; nextCursor: string | null };
      return { ...parsed, createdAt: hit.createdAt };
    } catch {
      return null;
    }
  }

  private writeCache(key: string, provider: string, payload: { results: SearchResult[]; nextCursor: string | null }): void {
    const now = this.clock.now();
    this.repo.cachePut(key, provider, JSON.stringify(payload), new Date(now).toISOString(), new Date(now + CACHE_TTL_MS).toISOString());
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const started = this.clock.now();
    const scope: SearchScope = request.scope ?? 'all';
    const limit = Math.min(Math.max(request.limit ?? 25, 1), 50);
    const query = request.query.trim();
    if (!query) throw new DomainError('validation', 'Search needs a query');

    const filter = request.providers?.length ? new Set(request.providers) : null;
    const adapters = this.registry.searchable().filter((a) => !filter || filter.has(a.id));
    const cursors: CursorMap = request.cursor ? ((JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as CursorMap) ?? {}) : {};

    const sources: SearchResponse['sources'] = [];
    const partialFailures: SearchResponse['partialFailures'] = [];
    const groups: SearchResult[][] = [];
    const nextCursors: CursorMap = {};

    for (const id of this.registry.ids()) {
      if (filter && !filter.has(id)) continue;
      if (!this.registry.isEnabled(id)) {
        sources.push({ provider: id, state: 'disabled', count: 0 });
        continue;
      }
      if (!this.registry.isConfigured(id)) {
        sources.push({ provider: id, state: 'requires_auth', count: 0 });
        continue;
      }
      if (!adapters.some((a) => a.id === id)) {
        sources.push({ provider: id, state: 'skipped', count: 0 });
      }
    }

    const runs = adapters.map(async (adapter) => {
      const cursor = cursors[adapter.id] ?? null;
      const key = this.cacheKey(adapter.id, query, scope, cursor);
      const cached = this.readCache(key);
      if (cached) {
        this.metrics.increment(`search.cache_hit.${adapter.id}`);
        return { provider: adapter.id, results: cached.results.map((r) => ({ ...r, cachedAt: cached.createdAt, stale: false })), nextCursor: cached.nextCursor, error: null as string | null, retryAfterSeconds: undefined as number | undefined };
      }
      try {
        const page = await this.rateLimiter.run(adapter.id, 'P1', () => adapter.search(query, { scope, limit }, cursor), { cost: adapter.id === 'youtube' ? 100 : 1, timeoutMs: 12_000 });
        this.writeCache(key, adapter.id, { results: page.results, nextCursor: page.nextCursor });
        return { provider: adapter.id, results: page.results, nextCursor: page.nextCursor, error: null as string | null, retryAfterSeconds: undefined as number | undefined };
      } catch (err) {
        const retryAfterSeconds = err instanceof ProviderHttpError ? (err.retryAfterSeconds ?? undefined) : err instanceof DomainError ? err.retryAfterSeconds : undefined;
        return { provider: adapter.id, results: [] as SearchResult[], nextCursor: null, error: err instanceof Error ? err.message : String(err), retryAfterSeconds };
      }
    });

    const settled = await Promise.all(runs);
    for (const run of settled) {
      if (run.error) {
        sources.push({ provider: run.provider, state: 'failed', count: 0 });
        partialFailures.push({ provider: run.provider, error: run.error, ...(run.retryAfterSeconds !== undefined ? { retryAfterSeconds: run.retryAfterSeconds } : {}) });
        this.metrics.increment(`search.failed.${run.provider}`);
        continue;
      }
      sources.push({ provider: run.provider, state: 'ok', count: run.results.length });
      groups.push(run.results);
      if (run.nextCursor) nextCursors[run.provider] = run.nextCursor;
    }

    const merged = mergeSearchResults(groups).slice(0, limit);
    this.metrics.increment('search.requests');
    this.metrics.observe('search.latency_ms', this.clock.now() - started);

    return {
      query,
      scope,
      results: merged,
      partialFailures,
      sources: sources.sort((a, b) => a.provider.localeCompare(b.provider)),
      nextCursor: Object.keys(nextCursors).length ? Buffer.from(JSON.stringify(nextCursors), 'utf8').toString('base64url') : null,
      tookMs: this.clock.now() - started,
    };
  }

  /** Resolve a pasted URL through whichever adapter recognises it, with SSRF checks on the way. */
  async resolveUrl(input: string): Promise<SearchResult | null> {
    const trimmed = input.trim();
    if (!trimmed) throw new DomainError('validation', 'Nothing to resolve');
    if (/^https?:\/\//i.test(trimmed)) {
      const allowedHosts = this.registry
        .enabledAdapters()
        .flatMap((a) => a.allowedHosts())
        .concat(['youtube.com', 'www.youtube.com', 'youtu.be', 'music.youtube.com', 'open.spotify.com', 'soundcloud.com', 'on.soundcloud.com', 'bandcamp.com']);
      const check = validateOutboundUrl(trimmed, { allowedHosts, allowedSchemes: ['https:'] });
      if (!check.ok) throw new DomainError('validation', `That link cannot be resolved: ${check.reason ?? 'not an allowed host'}`);
    }
    for (const adapter of this.registry.enabledAdapters()) {
      if (!this.registry.isConfigured(adapter.id)) continue;
      try {
        const result = await this.rateLimiter.run(adapter.id, 'P0', () => adapter.resolve(trimmed), { timeoutMs: 12_000 });
        if (result) return result;
      } catch {
        // A provider that cannot resolve this link is not an error for the caller; try the next one.
      }
    }
    return null;
  }

  /** Fetch one result by its `provider:kind:id` identifier. */
  async getResult(resultId: string): Promise<SearchResult | null> {
    const parsed = parseResultId(resultId);
    if (!parsed) return null;
    if (!this.registry.has(parsed.provider) || !this.registry.isEnabled(parsed.provider)) return null;
    const adapter = this.registry.get(parsed.provider);
    return this.rateLimiter.run(parsed.provider, 'P0', () => adapter.getMetadata(parsed.providerId), { timeoutMs: 12_000 });
  }

  /** Search results are provider-shaped; queues and history need `TrackRef`s. */
  toTrackRef(result: SearchResult): TrackRef {
    return {
      trackId: result.trackId ?? deterministicTrackId(result),
      title: result.title,
      artistName: result.artistName ?? 'Unknown Artist',
      albumName: result.albumName,
      durationMs: result.durationMs,
      artworkId: null,
      identity: result.identity,
      locators: [{ kind: 'provider', provider: result.provider as ProviderId, providerTrackId: result.providerId, ...(result.canonicalUrl ? { canonicalUrl: result.canonicalUrl } : {}) }],
      provider: result.provider as ProviderId,
      genre: result.genre,
      year: result.year,
    };
  }

  /**
   * Latest releases for an artist. MusicBrainz supplies the release *list* (it is the only source
   * here with a curated discography), and each enabled playback provider is then asked whether it
   * carries that release. A provider that fails contributes a `partialFailure` rather than removing
   * the release from the list — the record still exists even if one service cannot be reached.
   *
   * Reissues and deluxe editions are flagged, not filtered: which of those counts as "latest" is
   * the listener's judgement, so the UI gets the flag and decides.
   */
  async latestReleases(input: { mbid?: string | undefined; name?: string | undefined; refresh: boolean }): Promise<LatestReleasesResponse> {
    if (!input.mbid && !input.name) throw new DomainError('validation', 'Pass either an artist MusicBrainz id or a name');
    if (!this.registry.has('musicbrainz') || !this.registry.isEnabled('musicbrainz')) {
      throw new DomainError('unsupported', 'Release lookup needs the MusicBrainz provider, which is disabled on this hub');
    }
    const mb = this.registry.get('musicbrainz') as MusicBrainzAdapter;
    const cacheKey = `releases:${input.mbid ?? input.name!.toLowerCase().trim()}`;
    if (!input.refresh) {
      const cached = this.readCache(cacheKey);
      if (cached) {
        const payload = cached as unknown as { payload?: LatestReleasesResponse };
        if (payload.payload) return { ...payload.payload, fetchedAt: cached.createdAt };
      }
    }

    const artist = input.mbid ? { id: input.mbid, name: (await this.rateLimiter.run('musicbrainz', 'P1', () => mb.artistName(input.mbid!), { timeoutMs: 12_000 })) ?? input.name ?? 'Unknown artist' } : await this.rateLimiter.run('musicbrainz', 'P1', () => mb.findArtist(input.name!), { timeoutMs: 12_000 });
    if (!artist) throw new DomainError('not-found', `MusicBrainz has no artist called "${input.name ?? input.mbid}"`);

    const groups = await this.rateLimiter.run('musicbrainz', 'P1', () => mb.releaseGroups(artist.id, 60), { timeoutMs: 20_000 });
    const partialFailures: Array<{ provider: ProviderId; error: string }> = [];
    const fetchedAt = new Date(this.clock.now()).toISOString();

    const items: LatestReleasesResponse['items'] = [];
    for (const group of groups.slice(0, 25)) {
      const sources: LatestReleasesResponse['items'][number]['sources'] = [];
      for (const adapter of this.registry.searchable()) {
        if (adapter.id === 'musicbrainz') continue;
        try {
          const page = await this.rateLimiter.run(adapter.id, 'P3', () => adapter.search(`${group.artistName} ${group.title}`, { scope: 'albums', limit: 3 }, null), { timeoutMs: 12_000, cost: adapter.id === 'youtube' ? 100 : 1 });
          const hit = page.results.find((r) => normalizeTitle(r.albumName ?? r.title) === normalizeTitle(group.title));
          if (hit) sources.push({ provider: hit.provider as ProviderId, providerId: hit.providerId, url: hit.canonicalUrl ?? null, capabilities: hit.capabilities });
        } catch (err) {
          if (!partialFailures.some((f) => f.provider === adapter.id)) partialFailures.push({ provider: adapter.id as ProviderId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      items.push({ ...group, sources, metadataSource: 'musicbrainz' as const, fetchedAt, stale: false });
    }

    const response: LatestReleasesResponse = {
      artist: { name: artist.name, musicbrainzArtistId: artist.id },
      items,
      partialFailures,
      fetchedAt,
      cacheTtlSeconds: Math.round(CACHE_TTL_MS / 1000),
    };
    this.repo.cachePut(cacheKey, 'musicbrainz', JSON.stringify({ payload: response }), fetchedAt, new Date(this.clock.now() + CACHE_TTL_MS).toISOString());
    return response;
  }

  purgeCache(): number {
    return this.repo.cachePurge(new Date(this.clock.now()).toISOString(), CACHE_TTL_MS);
  }
}

/** Compare album titles without punctuation, case or edition suffixes getting in the way. */
function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/\((?:deluxe|expanded|remaster(?:ed)?|anniversary)[^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A UUID derived from provider + id, so the same provider track always maps to the same queue item
 * id across devices and restarts without a round trip to the database.
 */
export function deterministicTrackId(result: Pick<SearchResult, 'provider' | 'providerId'>): string {
  const hash = hashHex(`${result.provider}:${result.providerId}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-7${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function hashHex(input: string): string {
  // FNV-1a over four offsets, giving 32 stable hex characters without a crypto import.
  const parts: string[] = [];
  for (let k = 0; k < 4; k += 1) {
    let h = 0x811c9dc5 ^ k;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    parts.push(h.toString(16).padStart(8, '0'));
  }
  return parts.join('');
}

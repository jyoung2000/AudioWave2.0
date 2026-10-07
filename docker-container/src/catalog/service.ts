/**
 * The hub's music catalog (DEC-039): the domain's `CatalogEngine`, wired to what the hub already
 * has — its one outbound HTTP client (host allowlist, DNS check, size and time caps), its yt-dlp and
 * spotDL through the external tool adapter, its settings and sealer, and its download queue.
 *
 * Nothing new reaches the network except through `SafeHttpClient` with `CATALOG_API_HOSTS`, and
 * nothing new runs a process except through the external tool adapter's existing slots.
 */
import { CATALOG_API_HOSTS, CATALOG_COLLECTION_CAP, CATALOG_PROVIDERS, type CatalogProviderId, type CatalogSettingsInput, type CatalogSettingsView, type CatalogSource, type CatalogTrack, type DownloadJob, type DownloadTags } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import { CatalogEngine, LinkReadError, normaliseIsrc, type CatalogFetch, type LinkRead, type LinkTrack } from '@now-playing/domain/catalog';
import type { Logger } from 'pino';
import type { Clock } from '../deps.js';
import type { Sealer } from '../crypto/seal.js';
import type { SettingsRepository } from '../db/repositories/settings.js';
import type { CreateDownloadInput, DownloadService } from '../downloads/service.js';
import type { MediaProbe, ProbedEntry } from '../media/media-metadata.js';
import type { ExternalToolAdapter } from '../providers/adapters/external-tool.js';
import { ProviderHttpError, type SafeHttpClient } from '../providers/http.js';
import type { ProviderRegistry } from '../providers/registry.js';

export const CATALOG_SETTINGS_KEY = 'catalog.settings';
const ODESLI_AAD = 'catalog.odesli';

interface StoredSettings {
  embedLyrics?: boolean;
  providers?: Partial<Record<CatalogProviderId, boolean>>;
  odesliKeySealed?: string | null;
}

export interface HubCatalogDeps {
  http: SafeHttpClient;
  settings: SettingsRepository;
  sealer: Sealer;
  providers: ProviderRegistry;
  downloads: DownloadService;
  clock: Clock;
  log: Logger;
  userAgent: string;
}

/** The hub's client as the engine's fetch. A 429 or 5xx comes back as a status, as `fetch` would. */
export function hubCatalogFetch(http: SafeHttpClient): CatalogFetch {
  return async (url, init) => {
    try {
      const res = await http.request(url, { allowedHosts: CATALOG_API_HOSTS, headers: init.headers, signal: init.signal, timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 });
      return { status: res.status, headers: res.headers, json: () => res.json(), text: () => res.text() };
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status !== null) {
        const headers = new Headers(error.retryAfterSeconds !== null ? { 'retry-after': String(error.retryAfterSeconds) } : {});
        const body = error.body ?? '';
        return { status: error.status, headers, json: async () => JSON.parse(body) as unknown, text: async () => body };
      }
      throw error;
    }
  };
}

function entryToLink(entry: ProbedEntry): LinkTrack {
  const t = entry.tags;
  return {
    url: entry.url,
    title: t?.title ?? null,
    artist: t?.artist ?? null,
    featured: t?.featured ?? [],
    album: t?.album ?? null,
    durationSec: t?.durationMs ? t.durationMs / 1000 : null,
    date: t?.date ?? null,
    artworkUrl: t?.artworkUrl ?? null,
    trackNumber: t?.trackNumber ?? null,
    discNumber: t?.discNumber ?? null,
    isrc: t?.isrc ?? null,
    label: t?.label ?? null,
    genre: t?.genre ?? null,
  };
}

/** What the external tool said a link is, in the engine's words. */
export function probeToLinkRead(probe: MediaProbe, url: string): LinkRead {
  if (probe.kind === 'track') return { kind: 'track', url: probe.url, track: { ...entryToLink({ url: probe.url, tags: probe.tags, unavailable: null }), matchUrl: probe.matchUrl ?? null } };
  const entries = probe.entries.filter((e) => !e.unavailable).map(entryToLink);
  return { kind: 'collection', url: probe.url || url, title: probe.title ?? 'Playlist', owner: probe.owner, artworkUrl: probe.artworkUrl, date: null, entries, total: probe.listed, capped: probe.entries.length > CATALOG_COLLECTION_CAP || (probe.listed ?? 0) > CATALOG_COLLECTION_CAP };
}

export class HubCatalogService {
  readonly engine: CatalogEngine;

  constructor(private readonly deps: HubCatalogDeps) {
    this.engine = new CatalogEngine({
      fetch: hubCatalogFetch(deps.http),
      userAgent: deps.userAgent,
      now: () => deps.clock.now(),
      enabled: () => this.stored().providers ?? {},
      odesliKey: () => this.odesliKey(),
      toolSearch: async ({ args, signal }) => {
        const tool = this.tool();
        return tool.catalogSearch(args, signal);
      },
      linkReader: async (url, { signal, match, items }) => {
        const tool = this.tool();
        try {
          // The whole list (up to CATALOG_COLLECTION_CAP), read once; or a page of positions in full.
          return probeToLinkRead(await tool.probe(url, signal, { match: match === true, all: true, ...(items?.length ? { items } : {}) }), url);
        } catch (error) {
          if (error instanceof DomainError) throw new LinkReadError(error.message, error.code === 'setup-required' ? 'tool-missing' : error.code === 'forbidden' ? 'unavailable' : 'failed');
          throw error;
        }
      },
    });
  }

  /** The external tool, when an administrator has not switched it off. */
  private tool(): ExternalToolAdapter {
    if (!this.deps.providers.isEnabled('external-tool')) throw new DomainError('unsupported', 'The external media tool is switched off on this hub (Admin → Providers)');
    return this.deps.providers.get('external-tool') as ExternalToolAdapter;
  }

  private stored(): StoredSettings {
    return this.deps.settings.get<StoredSettings>(CATALOG_SETTINGS_KEY) ?? {};
  }

  private odesliKey(): string | null {
    const sealed = this.stored().odesliKeySealed;
    if (!sealed) return null;
    try {
      return this.deps.sealer.open(sealed, ODESLI_AAD);
    } catch {
      return null;
    }
  }

  settingsView(): CatalogSettingsView {
    const stored = this.stored();
    const providers = Object.fromEntries(CATALOG_PROVIDERS.map((id) => [id, stored.providers?.[id] !== false])) as Record<CatalogProviderId, boolean>;
    return { embedLyrics: stored.embedLyrics !== false, providers, odesliKeyConfigured: Boolean(stored.odesliKeySealed) };
  }

  putSettings(input: CatalogSettingsInput): CatalogSettingsView {
    const stored = this.stored();
    const next: StoredSettings = { ...stored };
    if (input.embedLyrics !== undefined) next.embedLyrics = input.embedLyrics;
    if (input.providers) next.providers = { ...(stored.providers ?? {}), ...input.providers };
    if (input.odesliKey !== undefined) next.odesliKeySealed = input.odesliKey.trim() ? this.deps.sealer.seal(input.odesliKey.trim(), ODESLI_AAD) : null;
    this.deps.settings.set(CATALOG_SETTINGS_KEY, next, new Date(this.deps.clock.now()).toISOString());
    return this.settingsView();
  }

  /**
   * The tags a catalog download carries: what the catalog knows of the song, then MusicBrainz's
   * genre, label and year where the song lacks them, and LRCLIB's lyrics when the setting is on.
   * Each lookup is best effort: a slow service costs a tag, never the download.
   */
  async tagsFor(track: CatalogTrack, signal?: AbortSignal): Promise<{ tags: DownloadTags; embedded: { isrc: boolean; genre: boolean; label: boolean; year: boolean; lyrics: boolean } }> {
    const isrc = normaliseIsrc(track.isrc);
    const enrichment = isrc || (track.title && track.artist) ? await this.engine.enrich({ isrc, title: track.title, artist: track.artists[0] ?? track.artist, durationMs: track.durationMs }, signal).catch(() => null) : null;
    const primary = track.artists[0] ?? track.artist;
    const featured = track.artists.slice(1).filter((a) => a && a !== primary);
    let lyrics: string | null = null;
    if (this.settingsView().embedLyrics) {
      const found = await this.engine.lyrics({ title: track.title, artist: primary, ...(track.album ? { album: track.album } : {}), ...(track.durationMs ? { durationSec: Math.round(track.durationMs / 1000) } : {}) }, signal).catch(() => null);
      lyrics = found?.synced ?? found?.plain ?? null;
    }
    const date = track.releaseDate ?? enrichment?.releaseDate ?? (enrichment?.year ? String(enrichment.year) : null);
    const tags: DownloadTags = {
      title: track.title.slice(0, 300),
      artist: primary.slice(0, 300) || null,
      featured: featured.slice(0, 20).map((f) => f.slice(0, 200)),
      album: track.album,
      albumArtist: track.albumArtist,
      date: date && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(date) ? date : null,
      genre: (track.genre ?? enrichment?.genre ?? null)?.slice(0, 100) ?? null,
      trackNumber: track.trackNumber && track.trackNumber <= 9999 ? track.trackNumber : null,
      discNumber: track.discNumber && track.discNumber <= 999 ? track.discNumber : null,
      durationMs: track.durationMs,
      artworkUrl: track.artworkUrl && /^https?:\/\//.test(track.artworkUrl) ? track.artworkUrl : null,
      license: null,
      isrc: isrc ?? normaliseIsrc(enrichment?.isrc ?? null),
      label: track.label ?? enrichment?.label ?? null,
      lyrics: lyrics?.slice(0, 20_000) ?? null,
    };
    return { tags, embedded: { isrc: Boolean(tags.isrc), genre: Boolean(tags.genre), label: Boolean(tags.label), year: Boolean(tags.date), lyrics: Boolean(tags.lyrics) } };
  }

  /** A catalog song through the download queue, from its best downloadable source. */
  async download(
    input: { track: CatalogTrack; authorization: CreateDownloadInput['authorization']; target: CreateDownloadInput['target']; ownerId: string },
    meta: { ip: string | null; correlationId: string | null },
    actorDisplayName: string,
  ): Promise<{ job: DownloadJob; source: CatalogSource; embedded: { isrc: boolean; genre: boolean; label: boolean; year: boolean; lyrics: boolean } }> {
    const source = await this.engine.findDownloadSource(input.track);
    if (!source) throw new DomainError('not-found', `“${input.track.title}” is in a store, but nowhere this hub can download from (YouTube Music, YouTube, SoundCloud, Bandcamp or Spotify through spotDL).`);
    const { tags, embedded } = await this.tagsFor(input.track);
    const job = await this.deps.downloads.create(
      {
        source: { provider: 'external-tool', providerTrackId: null, url: source.url, locator: null, title: tags.title, artistName: tags.artist, tags },
        authorization: input.authorization,
        target: input.target,
        ownerId: input.ownerId,
      },
      meta,
      actorDisplayName,
    );
    return { job, source, embedded };
  }
}

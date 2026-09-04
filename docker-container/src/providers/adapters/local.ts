import type { ProviderCapabilities, ProviderDescriptor, SearchResult, Track } from '@now-playing/contracts';
import { routePath, routes } from '@now-playing/contracts';
import type { LibraryService } from '../../library/service.js';
import { HUB_TRACK_CAPABILITIES, PUBLIC_DOMAIN_CAPABILITIES } from '../../library/service.js';
import type { SyncRepository } from '../../db/repositories/sync.js';
import type { AuthorizedDownload, DownloadContext, PlaybackContext, PlayableRef, ProviderSearchPage } from '../adapter.js';
import { BaseAdapter, caps, REVIEWED_AT, result } from './base.js';

/** Base URL is supplied late (per request) because the hub may be reached through several origins. */
export interface BaseUrlProvider {
  baseUrl(): string;
}

/** Hub-hosted files inside the data volume. Streams with range support; downloads are the user's own files. */
export class HubLibraryAdapter extends BaseAdapter {
  readonly id = 'hub';

  constructor(
    private readonly library: LibraryService,
    private readonly base: BaseUrlProvider,
  ) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'Hub library', role: 'library', authType: 'device-credential', authScopes: ['library:read'], groupCompatible: true, discordCompatible: true, reviewedAt: REVIEWED_AT, limitations: ['Files must be placed under the data volume library directory', 'Formats browsers cannot decode are listed but not playable in the PWA'] };
  }

  capabilities(): ProviderCapabilities {
    return HUB_TRACK_CAPABILITIES;
  }

  private toResult(track: Track): SearchResult | null {
    const rec = this.library.findTrack(track.id);
    return rec ? this.library.toSearchResult(rec, 'hub', HUB_TRACK_CAPABILITIES, this.base.baseUrl()) : null;
  }

  override async search(query: string, filters: { scope: string; limit: number }): Promise<ProviderSearchPage> {
    const records = this.library.search(query, { limit: filters.limit, excludeTag: 'public-domain', scope: filters.scope });
    return { results: records.map((r) => this.library.toSearchResult(r, 'hub', HUB_TRACK_CAPABILITIES, this.base.baseUrl())), nextCursor: null };
  }

  override async getMetadata(id: string): Promise<SearchResult | null> {
    const rec = this.library.findTrack(id);
    return rec && this.library.tagOf(rec) !== 'public-domain' ? this.toResult(rec.track) : null;
  }

  override async resolve(urlOrId: string): Promise<SearchResult | null> {
    const m = /\/library\/stream\/([0-9a-f-]{36})/i.exec(urlOrId) ?? /^([0-9a-f-]{36})$/i.exec(urlOrId.trim());
    return m ? this.getMetadata(m[1]!) : null;
  }

  override async getPreview(id: string): Promise<PlayableRef | null> {
    return this.getPlayable(id, { actorId: 'preview', forGroup: false });
  }

  override async getPlayable(id: string, _context: PlaybackContext): Promise<PlayableRef | null> {
    const rec = this.library.findTrack(id);
    if (!rec || rec.track.unsupportedReason) return null;
    return { kind: 'hub-stream', url: `${this.base.baseUrl()}${routePath(routes.libraryStream, { trackId: id })}`, mime: rec.mime, seekable: true, durationMs: rec.track.durationMs };
  }

  override async getAuthorizedDownload(id: string, context: DownloadContext): Promise<AuthorizedDownload | null> {
    const rec = this.library.findTrack(id);
    if (!rec) return null;
    const path = this.library.absolutePath(rec);
    if (!path) return null;
    if (context.basis !== 'user-owned' && context.basis !== 'hub-hosted') return null;
    return { kind: 'file', path, filename: rec.relativePath.split('/').pop() ?? `${rec.track.artistName} - ${rec.track.title}`, mime: rec.mime, sizeBytes: rec.sizeBytes, basis: context.basis };
  }
}

/** The bundled public-domain fixture set: a real end-to-end audio provider with every capability available. */
export class PublicDomainAdapter extends BaseAdapter {
  readonly id = 'public-domain';

  constructor(
    private readonly library: LibraryService,
    private readonly base: BaseUrlProvider,
  ) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'Public domain', role: 'audio-source', authType: 'none', authScopes: [], attribution: 'Synthetic fixture', groupCompatible: true, discordCompatible: true, reviewedAt: REVIEWED_AT, limitations: ['Serves the directory configured by NP_PUBLIC_DOMAIN_DIR (defaults to the generated test fixtures)'] };
  }

  capabilities(): ProviderCapabilities {
    return PUBLIC_DOMAIN_CAPABILITIES;
  }

  private root() {
    return this.library.rootByTag('public-domain');
  }

  override async health() {
    const root = this.root();
    const checkedAt = new Date().toISOString();
    if (!root) return { provider: this.id, status: 'unconfigured' as const, circuit: 'closed' as const, checkedAt, lastError: 'NP_PUBLIC_DOMAIN_DIR is not set' };
    return { provider: this.id, status: 'ok' as const, circuit: 'closed' as const, checkedAt };
  }

  override async search(query: string, filters: { scope: string; limit: number }): Promise<ProviderSearchPage> {
    const records = this.library.search(query, { limit: filters.limit, tag: 'public-domain', scope: filters.scope });
    return { results: records.map((r) => this.library.toSearchResult(r, 'public-domain', PUBLIC_DOMAIN_CAPABILITIES, this.base.baseUrl())), nextCursor: null };
  }

  override async getMetadata(id: string): Promise<SearchResult | null> {
    const rec = this.library.findTrack(id);
    return rec && this.library.tagOf(rec) === 'public-domain' ? this.library.toSearchResult(rec, 'public-domain', PUBLIC_DOMAIN_CAPABILITIES, this.base.baseUrl()) : null;
  }

  override async resolve(urlOrId: string): Promise<SearchResult | null> {
    const m = /^([0-9a-f-]{36})$/i.exec(urlOrId.trim());
    return m ? this.getMetadata(m[1]!) : null;
  }

  override async getPreview(id: string): Promise<PlayableRef | null> {
    return this.getPlayable(id, { actorId: 'preview', forGroup: false });
  }

  override async getPlayable(id: string, _context: PlaybackContext): Promise<PlayableRef | null> {
    const rec = this.library.findTrack(id);
    if (!rec || this.library.tagOf(rec) !== 'public-domain' || rec.track.unsupportedReason) return null;
    return { kind: 'hub-stream', url: `${this.base.baseUrl()}${routePath(routes.libraryStream, { trackId: id })}`, mime: rec.mime, seekable: true, durationMs: rec.track.durationMs };
  }

  override async getAuthorizedDownload(id: string, context: DownloadContext): Promise<AuthorizedDownload | null> {
    const rec = this.library.findTrack(id);
    if (!rec || this.library.tagOf(rec) !== 'public-domain') return null;
    const path = this.library.absolutePath(rec);
    if (!path) return null;
    return { kind: 'file', path, filename: rec.relativePath.split('/').pop() ?? `${rec.track.artistName} - ${rec.track.title}`, mime: rec.mime, sizeBytes: rec.sizeBytes, basis: context.basis === 'public-domain' ? 'public-domain' : 'public-domain' };
  }

  /** All fixture tracks (used by the demo seed and the discovery catalogue). */
  tracks() {
    const root = this.root();
    return root ? this.library.tracksForRoot(root.id) : [];
  }
}

/** Tracks exposed by paired Windows companions through the sync store. Playable only after a hub transfer. */
export class CompanionLibraryAdapter extends BaseAdapter {
  readonly id = 'companion';

  constructor(
    private readonly sync: SyncRepository,
    private readonly library: LibraryService,
    private readonly base: BaseUrlProvider,
  ) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'Windows companion libraries', role: 'library', authType: 'device-credential', authScopes: ['library:share'], groupCompatible: true, discordCompatible: false, reviewedAt: REVIEWED_AT, limitations: ['Playback and download require the owning companion to authorize a transfer to the hub first'] };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: 'available', search: 'available', preview: 'restricted', playback: 'restricted', userOwnedDownload: 'restricted', groupSync: 'unsupported', eq: 'available', reason: 'Available after the owning companion transfers the file to the hub' });
  }

  private toResult(track: Track): SearchResult {
    const hash = track.identity.contentHash;
    const hubCopy = hash ? this.library.findByHash(hash) : undefined;
    const capabilities: ProviderCapabilities = hubCopy ? caps({ metadata: 'available', search: 'available', preview: 'available', playback: 'available', userOwnedDownload: 'available', groupSync: 'exact', eq: 'available' }) : this.capabilities();
    return result({ provider: this.id, kind: 'track', providerId: track.id, title: track.title, artistName: track.artistName, albumName: track.albumName, durationMs: track.durationMs, year: track.year, genre: track.genre, capabilities, identity: track.identity, trackId: hubCopy?.id ?? track.id, artworkUrl: hubCopy?.track.artworkId ? `${this.base.baseUrl()}${this.library.artworkPathFor(hubCopy.track.artworkId)}` : null, previewUrl: hubCopy ? `${this.base.baseUrl()}${this.library.streamPath(hubCopy.id)}` : null });
  }

  private tracks(): Track[] {
    return this.sync
      .all('tracks')
      .filter((r) => !r.deletedAt)
      .map((r) => r as unknown as Track)
      .filter((t) => typeof t.title === 'string' && typeof t.artistName === 'string');
  }

  override async search(query: string, filters: { scope: string; limit: number }): Promise<ProviderSearchPage> {
    const q = query.toLowerCase();
    const hits = this.tracks().filter((t) => t.title.toLowerCase().includes(q) || t.artistName.toLowerCase().includes(q) || (t.albumName ?? '').toLowerCase().includes(q));
    return { results: hits.slice(0, filters.limit).map((t) => this.toResult(t)), nextCursor: null };
  }

  override async getMetadata(id: string): Promise<SearchResult | null> {
    const t = this.tracks().find((x) => x.id === id);
    return t ? this.toResult(t) : null;
  }

  override async getPlayable(id: string, _context: PlaybackContext): Promise<PlayableRef | null> {
    const t = this.tracks().find((x) => x.id === id);
    const hubCopy = t?.identity.contentHash ? this.library.findByHash(t.identity.contentHash) : undefined;
    if (!hubCopy) return null;
    return { kind: 'hub-stream', url: `${this.base.baseUrl()}${this.library.streamPath(hubCopy.id)}`, mime: hubCopy.mime, seekable: true, durationMs: hubCopy.track.durationMs };
  }

  override async getAuthorizedDownload(id: string, context: DownloadContext): Promise<AuthorizedDownload | null> {
    const t = this.tracks().find((x) => x.id === id);
    const hubCopy = t?.identity.contentHash ? this.library.findByHash(t.identity.contentHash) : undefined;
    if (!hubCopy || context.basis !== 'user-owned') return null;
    const path = this.library.absolutePath(hubCopy);
    return path ? { kind: 'file', path, filename: hubCopy.relativePath.split('/').pop() ?? 'track', mime: hubCopy.mime, sizeBytes: hubCopy.sizeBytes, basis: 'user-owned' } : null;
  }
}

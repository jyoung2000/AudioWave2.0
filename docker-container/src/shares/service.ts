/**
 * Shareable links for a track, album, playlist or whole library.
 *
 * Three properties matter and are enforced here rather than in the routes:
 *
 * 1. **The token is never stored.** Only its SHA-256 and a short hint are kept, so a database dump
 *    does not hand out working links. The token is returned exactly once, at creation.
 * 2. **A link is not a download.** `allowStream` lets the hub serve bytes it hosts; `allowDownload`
 *    is separate and still requires the content to be hub-hosted. Provider-referenced items are
 *    never streamed by the hub — the share page offers an "open at source" link instead, which is
 *    the honest capability (docs/DOWNLOADS_AND_LEGAL.md).
 * 3. **Every link is revocable and countable.** Expiry, an access cap and revocation are all
 *    checked on the same path, and the access count increments atomically so a cap cannot be
 *    raced past.
 *
 * The hub cannot see a browser-local library, so a library or playlist share carries the item list
 * the creator uploaded. Those items are metadata only: they resolve to "open at source" unless the
 * hub happens to hold the same content hash.
 */
import { createHash } from 'node:crypto';
import type { ShareKind, ShareLinkView, SharePayload } from '@now-playing/contracts';
import { DomainError, uuidv7 } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { RequestMeta } from '../auth/service.js';
import type { LibraryRepository } from '../db/repositories/library.js';
import type { ShareItemRow, ShareRecord, SharesRepository } from '../db/repositories/shares.js';
import type { Clock, RandomSource } from '../deps.js';
import type { LibraryService } from '../library/service.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { NetworkService } from '../network/service.js';
import { randomToken } from '../util.js';

export interface CreateShareInput {
  kind: ShareKind;
  targetId: string;
  title?: string | undefined;
  allowStream: boolean;
  allowDownload: boolean;
  expiresInSeconds: number | null;
  maxAccesses: number | null;
  items?: ReadonlyArray<{
    trackId: string;
    title: string;
    artistName: string;
    albumName: string | null;
    durationMs: number | null;
    contentHash: string | null;
    openAtSourceUrl: string | null;
  }>;
}

export interface ResolvedShare {
  share: ShareRecord;
  payload: SharePayload;
}

const MAX_ITEMS = 5000;

export class ShareService {
  constructor(
    private readonly repo: SharesRepository,
    private readonly library: LibraryService,
    private readonly libraryRepo: LibraryRepository,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly hubName: () => string,
  ) {}

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(`share:${token}`).digest('hex');
  }

  create(input: CreateShareInput, owner: { id: string; displayName: string }, meta: RequestMeta): { share: ShareLinkView; token: string } {
    const items = this.itemsFor(input);
    if (!items.length) throw new DomainError('validation', 'There is nothing to share: no matching track, album or playlist items were supplied');
    if (items.length > MAX_ITEMS) throw new DomainError('validation', `A share can hold at most ${MAX_ITEMS} items`);

    const token = randomToken(this.random, 24);
    const now = this.clock.now();
    const record: ShareRecord = {
      id: uuidv7(now),
      kind: input.kind,
      targetId: input.targetId,
      title: (input.title ?? this.defaultTitle(input.kind, items)).slice(0, 300),
      description: null,
      ownerId: owner.id,
      ownerDisplayName: owner.displayName,
      tokenHash: ShareService.hashToken(token),
      tokenHint: token.slice(-6),
      allowStream: input.allowStream,
      // Downloading requires the hub to actually hold the bytes; a metadata-only share cannot grant it.
      allowDownload: input.allowDownload && items.some((i) => i.content_hash !== null || i.hub_track_id !== null),
      expiresAt: input.expiresInSeconds === null ? null : new Date(now + input.expiresInSeconds * 1000).toISOString(),
      maxAccesses: input.maxAccesses,
      accessCount: 0,
      playCount: 0,
      createdAt: this.nowIso(),
      revokedAt: null,
    };
    this.repo.create(record, items);
    this.metrics.increment('shares.created');
    this.audit.record({
      actor: { kind: owner.id === 'admin' ? 'admin' : 'device', id: owner.id, displayName: owner.displayName },
      action: 'share.create',
      outcome: 'success',
      target: { kind: 'share', id: record.id },
      ip: meta.ip,
      correlationId: meta.correlationId,
      // The token itself is never audited — only which link was created and what it grants.
      details: { kind: input.kind, items: String(items.length), allowStream: String(record.allowStream), allowDownload: String(record.allowDownload) },
    });
    return { share: this.view(record, token), token };
  }

  private defaultTitle(kind: ShareKind, items: readonly ShareItemRow[]): string {
    const first = items[0];
    if (kind === 'track' && first) return `${first.title} — ${first.artist_name}`;
    if (kind === 'album' && first) return first.album_name ?? first.title;
    if (kind === 'library') return `A shared library (${items.length} tracks)`;
    return `A shared playlist (${items.length} tracks)`;
  }

  /**
   * Resolve what the share points at. A hub-hosted track is looked up so the link can stream; an
   * uploaded item list is taken at face value as metadata, with `hub_track_id` filled in only when
   * the hub genuinely holds matching content.
   */
  private itemsFor(input: CreateShareInput): ShareItemRow[] {
    const rows: ShareItemRow[] = [];
    const push = (position: number, item: Omit<ShareItemRow, 'share_id' | 'position'>): void => {
      rows.push({ share_id: '', position, ...item });
    };

    if (input.items?.length) {
      input.items.forEach((item, i) => {
        const hubTrack = item.contentHash ? (this.libraryRepo.findTracksByHash(item.contentHash).find((t) => !t.deletedAt) ?? null) : null;
        push(i, {
          track_id: item.trackId,
          title: item.title,
          artist_name: item.artistName,
          album_name: item.albumName,
          duration_ms: item.durationMs,
          content_hash: item.contentHash,
          open_at_source_url: item.openAtSourceUrl,
          hub_track_id: hubTrack?.id ?? null,
          artwork_id: hubTrack?.track.artworkId ?? null,
        });
      });
      return rows;
    }

    // No item list: the target must be something the hub itself holds.
    if (input.kind === 'track') {
      const rec = this.library.findTrack(input.targetId);
      if (!rec) throw new DomainError('not-found', 'The hub does not hold that track, so it needs the item list from the device that does');
      push(0, {
        track_id: rec.id,
        title: rec.track.title,
        artist_name: rec.track.artistName,
        album_name: rec.track.albumName,
        duration_ms: rec.track.durationMs,
        content_hash: rec.contentHash,
        open_at_source_url: null,
        hub_track_id: rec.id,
        artwork_id: rec.track.artworkId,
      });
      return rows;
    }

    if (input.kind === 'album') {
      const matching = this.library.allTracks().filter((t) => (t.track.albumName ?? '').toLowerCase() === input.targetId.toLowerCase() || t.track.albumId === input.targetId);
      matching.forEach((rec, i) =>
        push(i, {
          track_id: rec.id,
          title: rec.track.title,
          artist_name: rec.track.artistName,
          album_name: rec.track.albumName,
          duration_ms: rec.track.durationMs,
          content_hash: rec.contentHash,
          open_at_source_url: null,
          hub_track_id: rec.id,
          artwork_id: rec.track.artworkId,
        }),
      );
      return rows;
    }

    throw new DomainError('validation', `A ${input.kind} share must include the item list, because the hub cannot read a device's own library`);
  }

  list(ownerId: string | undefined): ShareLinkView[] {
    return this.repo.list(ownerId).map((s) => this.view(s));
  }

  /**
   * A listed link cannot show its URL: the hub only stores the token's hash, so the full link
   * exists exactly once, in the creation response. `token` is passed only on that path.
   */
  view(record: ShareRecord, token?: string): ShareLinkView {
    const base = this.network.reachableBaseUrl();
    const { tokenHash: _h, description: _d, ownerDisplayName: _o, ...rest } = record;
    const expired = record.expiresAt !== null && Date.parse(record.expiresAt) <= this.clock.now();
    const capped = record.maxAccesses !== null && record.accessCount >= record.maxAccesses;
    const warning = record.revokedAt
      ? 'This link has been revoked.'
      : expired
        ? 'This link has expired.'
        : capped
          ? 'This link has reached its access limit.'
          : base.warning;
    return {
      ...rest,
      url: token ? this.urlFor(token) : null,
      reachable: base.reachable,
      warning,
    };
  }

  /** Absolute URL for a token the caller still holds (creation time only). */
  urlFor(token: string): string | null {
    const base = this.network.reachableBaseUrl();
    return base.url ? `${base.url.replace(/\/$/, '')}/s/${token}` : null;
  }

  revoke(shareId: string, actor: { id: string; displayName: string; isAdmin: boolean }, meta: RequestMeta): void {
    const record = this.repo.find(shareId);
    if (!record) throw new DomainError('not-found', 'No such link');
    if (!actor.isAdmin && record.ownerId !== actor.id) throw new DomainError('not-found', 'No such link');
    if (!this.repo.revoke(shareId, this.nowIso())) throw new DomainError('conflict', 'That link is already revoked');
    this.metrics.increment('shares.revoked');
    this.audit.record({
      actor: { kind: actor.isAdmin ? 'admin' : 'device', id: actor.id, displayName: actor.displayName },
      action: 'share.revoke',
      outcome: 'success',
      target: { kind: 'share', id: shareId },
      ip: meta.ip,
      correlationId: meta.correlationId,
    });
  }

  /**
   * Public resolution. Counts one access atomically — the cap is enforced by the UPDATE itself, so
   * concurrent requests cannot both slip past the last remaining access.
   */
  resolve(token: string, baseUrl: string): ResolvedShare {
    const record = this.repo.findByTokenHash(ShareService.hashToken(token));
    // The same message for "no such link", "revoked" and "expired": a probe learns nothing from it.
    const gone = (): never => {
      this.metrics.increment('shares.miss');
      throw new DomainError('not-found', 'That link is not available. It may have expired, been used up, or been revoked.');
    };
    if (!record) return gone();
    if (record.revokedAt) return gone();
    if (record.expiresAt !== null && Date.parse(record.expiresAt) <= this.clock.now()) return gone();
    if (!this.repo.countAccess(record.id)) return gone();

    this.metrics.increment('shares.resolved');
    const items = this.repo.items(record.id);
    const payload: SharePayload = {
      kind: record.kind,
      title: record.title,
      description: record.description,
      ownerDisplayName: record.ownerDisplayName,
      artworkUrl: items[0]?.artwork_id ? `${baseUrl}/api/v1/library/artwork/${encodeURIComponent(items[0].artwork_id)}` : null,
      items: items.map((item) => {
        const streamable = record.allowStream && item.hub_track_id !== null;
        return {
          trackId: item.track_id,
          title: item.title,
          artistName: item.artist_name,
          albumName: item.album_name,
          durationMs: item.duration_ms,
          artworkUrl: item.artwork_id ? `${baseUrl}/api/v1/library/artwork/${encodeURIComponent(item.artwork_id)}` : null,
          streamable,
          downloadable: streamable && record.allowDownload,
          openAtSourceUrl: item.open_at_source_url,
          availabilityNote: streamable ? null : item.open_at_source_url ? 'This hub does not host this track; the link opens it at its source.' : 'This track is not hosted by this hub and has no public source link.',
        };
      }),
      totalItems: items.length,
      expiresAt: record.expiresAt,
      allowStream: record.allowStream,
      allowDownload: record.allowDownload,
      hubName: this.hubName(),
    };
    return { share: record, payload };
  }

  /**
   * Authorize an anonymous stream of one shared track. Streaming is only ever possible for content
   * the hub itself hosts — a provider reference has no bytes here to serve.
   */
  authorizeStream(token: string, trackId: string): { hubTrackId: string; share: ShareRecord } {
    const record = this.repo.findByTokenHash(ShareService.hashToken(token));
    if (!record || record.revokedAt) throw new DomainError('not-found', 'That link is not available');
    if (record.expiresAt !== null && Date.parse(record.expiresAt) <= this.clock.now()) throw new DomainError('not-found', 'That link is not available');
    if (!record.allowStream) throw new DomainError('forbidden', 'This link shares the track list only; playback was not enabled by whoever created it');
    const item = this.repo.items(record.id).find((i) => i.track_id === trackId);
    if (!item) throw new DomainError('not-found', 'That track is not part of this link');
    if (!item.hub_track_id) throw new DomainError('unsupported', 'This hub does not host that track, so it cannot play it here. Use the link to its original source.');
    this.repo.countPlay(record.id);
    this.metrics.increment('shares.streams');
    return { hubTrackId: item.hub_track_id, share: record };
  }

  itemCount(shareId: string): number {
    return this.repo.itemCount(shareId);
  }

  /** Expired and long-revoked links are removed; the audit trail of their creation remains. */
  maintenance(): number {
    const cutoff = new Date(this.clock.now() - 7 * 86_400_000).toISOString();
    const removed = this.repo.purgeExpired(cutoff);
    if (removed) this.metrics.increment('shares.purged', removed);
    return removed;
  }
}

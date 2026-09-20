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
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
  /**
   * For capped links: a short-lived grant tied to this counted access. Stream requests that carry
   * it (`?grant=`) do not count again, so one page view can play and seek freely.
   */
  streamGrant: string | null;
}

export interface ShareOwner {
  id: string;
  displayName: string;
  /** Whether the creator may itself read hub-hosted tracks (admin, or a device with `library:read`). Default true. */
  canReadHubLibrary?: boolean;
}

const MAX_ITEMS = 5000;
/** How long a stream grant from one counted access stays valid. */
const STREAM_GRANT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Where a visitor fetches the cover for an item in a shared link.
 *
 * Must stay in step with `routes.shareArtwork`. It is a public path under `/s/`, not the
 * `admin-or-device` `/api/v1/library/artwork/:id` the share payload used to point at — that one
 * answered 401 to every visitor, so every cover on every share page was a broken image.
 */
function shareArtworkUrl(baseUrl: string, token: string, artworkId: string): string {
  return `${baseUrl}/s/${encodeURIComponent(token)}/artwork/${encodeURIComponent(artworkId)}`;
}

/** Only plain web links are ever stored or rendered as "open at source". */
export function safeSourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A request that starts playback (no Range, or a range from byte 0) rather than seeking within it. */
function startsPlayback(range: string | undefined): boolean {
  if (!range) return true;
  const m = /^bytes=(\d*)-/.exec(range.trim());
  return !m || m[1] === '' || Number(m[1]) === 0;
}

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
  ) {
    this.grantKey = Buffer.from(random.bytes(32));
  }

  /** Process-local key for stream grants; grants simply lapse on restart. */
  private readonly grantKey: Buffer;

  private signGrant(shareId: string, expiresAtMs: number): string {
    const sig = createHmac('sha256', this.grantKey).update(`share-grant:v1:${shareId}:${expiresAtMs}`).digest('base64url');
    return `${expiresAtMs.toString(36)}.${sig}`;
  }

  private grantValid(shareId: string, grant: string | null | undefined): boolean {
    if (!grant) return false;
    const [expText, sig] = grant.split('.');
    if (!expText || !sig) return false;
    const expiresAtMs = Number.parseInt(expText, 36);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.clock.now()) return false;
    const expected = Buffer.from(this.signGrant(shareId, expiresAtMs));
    const given = Buffer.from(grant);
    return expected.byteLength === given.byteLength && timingSafeEqual(expected, given);
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(`share:${token}`).digest('hex');
  }

  create(input: CreateShareInput, owner: ShareOwner, meta: RequestMeta): { share: ShareLinkView; token: string } {
    for (const item of input.items ?? []) {
      if (item.openAtSourceUrl !== null && safeSourceUrl(item.openAtSourceUrl) === null) throw new DomainError('validation', 'A source link must be an http(s) URL');
    }
    const items = this.itemsFor(input, owner.canReadHubLibrary !== false);
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
  private itemsFor(input: CreateShareInput, canReadHubLibrary: boolean): ShareItemRow[] {
    const rows: ShareItemRow[] = [];
    const push = (position: number, item: Omit<ShareItemRow, 'share_id' | 'position'>): void => {
      rows.push({ share_id: '', position, ...item });
    };

    if (input.items?.length) {
      input.items.forEach((item, i) => {
        // Only a creator that may itself read the hub's library can turn a content hash into a
        // publicly streamable hub track; anyone else's items stay metadata-only.
        const hubTrack = item.contentHash && canReadHubLibrary ? (this.libraryRepo.findTracksByHash(item.contentHash).find((t) => !t.deletedAt) ?? null) : null;
        push(i, {
          track_id: item.trackId,
          title: item.title,
          artist_name: item.artistName,
          album_name: item.albumName,
          duration_ms: item.durationMs,
          content_hash: item.contentHash,
          open_at_source_url: safeSourceUrl(item.openAtSourceUrl),
          hub_track_id: hubTrack?.id ?? null,
          artwork_id: hubTrack?.track.artworkId ?? null,
        });
      });
      return rows;
    }

    // No item list: the target must be something the hub itself holds.
    if ((input.kind === 'track' || input.kind === 'album') && !canReadHubLibrary) throw new DomainError('forbidden', 'Sharing hub-hosted tracks requires the library:read scope');
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
      artworkUrl: items[0]?.artwork_id ? shareArtworkUrl(baseUrl, token, items[0].artwork_id) : null,
      items: items.map((item) => {
        const streamable = record.allowStream && item.hub_track_id !== null;
        return {
          trackId: item.track_id,
          title: item.title,
          artistName: item.artist_name,
          albumName: item.album_name,
          durationMs: item.duration_ms,
          artworkUrl: item.artwork_id ? shareArtworkUrl(baseUrl, token, item.artwork_id) : null,
          streamable,
          downloadable: streamable && record.allowDownload,
          openAtSourceUrl: safeSourceUrl(item.open_at_source_url),
          availabilityNote: streamable ? null : safeSourceUrl(item.open_at_source_url) ? 'This hub does not host this track; the link opens it at its source.' : 'This track is not hosted by this hub and has no public source link.',
        };
      }),
      totalItems: items.length,
      expiresAt: record.expiresAt,
      allowStream: record.allowStream,
      allowDownload: record.allowDownload,
      hubName: this.hubName(),
    };
    let streamGrant: string | null = null;
    if (record.maxAccesses !== null && record.allowStream) {
      const expiry = Math.min(this.clock.now() + STREAM_GRANT_TTL_MS, record.expiresAt ? Date.parse(record.expiresAt) : Number.POSITIVE_INFINITY);
      streamGrant = this.signGrant(record.id, expiry);
    }
    return { share: record, payload, streamGrant };
  }

  /**
   * Authorize an anonymous stream of one shared track. Streaming is only ever possible for content
   * the hub itself hosts — a provider reference has no bytes here to serve.
   *
   * A capped link (`maxAccesses`) is enforced here too: a request carrying a valid grant from a
   * counted page view streams freely; otherwise starting playback counts as an access (refused
   * once the cap is reached) and seeking within a stream is only allowed while the cap is not used up.
   */
  authorizeStream(token: string, trackId: string, options: { grant?: string | null; range?: string | undefined } = {}): { hubTrackId: string; share: ShareRecord } {
    const record = this.repo.findByTokenHash(ShareService.hashToken(token));
    const gone = (): never => {
      throw new DomainError('not-found', 'That link is not available');
    };
    if (!record || record.revokedAt) return gone();
    if (record.expiresAt !== null && Date.parse(record.expiresAt) <= this.clock.now()) return gone();
    if (!record.allowStream) throw new DomainError('forbidden', 'This link shares the track list only; playback was not enabled by whoever created it');
    const item = this.repo.items(record.id).find((i) => i.track_id === trackId);
    if (!item) throw new DomainError('not-found', 'That track is not part of this link');
    if (!item.hub_track_id) throw new DomainError('unsupported', 'This hub does not host that track, so it cannot play it here. Use the link to its original source.');
    if (record.maxAccesses !== null && !this.grantValid(record.id, options.grant)) {
      if (startsPlayback(options.range)) {
        if (!this.repo.countAccess(record.id)) return gone();
      } else if (record.accessCount >= record.maxAccesses) {
        return gone();
      }
    }
    this.repo.countPlay(record.id);
    this.metrics.increment('shares.streams');
    return { hubTrackId: item.hub_track_id, share: record };
  }

  /**
   * Authorise one artwork fetch for a shared link.
   *
   * Deliberately does **not** count an access. A page with eight covers on it would otherwise spend
   * eight of a capped link's allowance just by rendering, and the cap is meant to count people who
   * opened the link, not images their browser fetched. `resolve()` already counted this visit.
   *
   * A token that does not resolve is 404 and says nothing more, the same as everywhere else. A
   * token that resolves but has lapsed answers 410: whoever holds an artwork URL obtained it from a
   * page this hub rendered for them, so they already know the link existed, and telling them it has
   * expired reveals nothing a guess could have learned.
   */
  authorizeArtwork(token: string, artworkId: string): { share: ShareRecord; artworkId: string } {
    const record = this.repo.findByTokenHash(ShareService.hashToken(token));
    if (!record) throw new DomainError('not-found', 'That link is not available.');
    if (record.revokedAt) throw new DomainError('gone', 'That link has been revoked.');
    if (record.expiresAt !== null && Date.parse(record.expiresAt) <= this.clock.now()) throw new DomainError('gone', 'That link has expired.');
    if (record.maxAccesses !== null && record.accessCount >= record.maxAccesses) throw new DomainError('gone', 'That link has been used up.');
    // Scoped to the share: holding one link must not turn into a reader for the whole library.
    const item = this.repo.items(record.id).find((i) => i.artwork_id === artworkId);
    if (!item) throw new DomainError('not-found', 'That artwork is not part of this link.');
    return { share: record, artworkId };
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

import type { ShareKind, ShareLink } from '@now-playing/contracts';
import type { Db } from '../connection.js';

interface ShareRow {
  id: string;
  kind: ShareKind;
  target_id: string;
  title: string;
  description: string | null;
  owner_id: string;
  owner_display_name: string;
  token_hash: string;
  token_hint: string;
  allow_stream: number;
  allow_download: number;
  expires_at: string | null;
  max_accesses: number | null;
  access_count: number;
  play_count: number;
  created_at: string;
  revoked_at: string | null;
}

export interface ShareRecord extends ShareLink {
  description: string | null;
  ownerDisplayName: string;
}

export interface ShareItemRow {
  share_id: string;
  position: number;
  track_id: string;
  title: string;
  artist_name: string;
  album_name: string | null;
  duration_ms: number | null;
  content_hash: string | null;
  open_at_source_url: string | null;
  hub_track_id: string | null;
  artwork_id: string | null;
}

function toShare(r: ShareRow): ShareRecord {
  return {
    id: r.id,
    kind: r.kind,
    targetId: r.target_id,
    title: r.title,
    ownerId: r.owner_id,
    tokenHash: r.token_hash,
    tokenHint: r.token_hint,
    allowStream: r.allow_stream === 1,
    allowDownload: r.allow_download === 1,
    expiresAt: r.expires_at,
    maxAccesses: r.max_accesses,
    accessCount: r.access_count,
    playCount: r.play_count,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    description: r.description,
    ownerDisplayName: r.owner_display_name,
  };
}

export class SharesRepository {
  constructor(private readonly db: Db) {}

  create(share: ShareRecord, items: ShareItemRow[]): void {
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO share_links (id, kind, target_id, title, description, owner_id, owner_display_name, token_hash, token_hint, allow_stream, allow_download, expires_at, max_accesses, access_count, play_count, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL)')
        .run(share.id, share.kind, share.targetId, share.title, share.description, share.ownerId, share.ownerDisplayName, share.tokenHash, share.tokenHint, share.allowStream ? 1 : 0, share.allowDownload ? 1 : 0, share.expiresAt, share.maxAccesses, share.createdAt);
      const stmt = this.db.prepare('INSERT INTO share_items (share_id, position, track_id, title, artist_name, album_name, duration_ms, content_hash, open_at_source_url, hub_track_id, artwork_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const it of items) stmt.run(share.id, it.position, it.track_id, it.title, it.artist_name, it.album_name, it.duration_ms, it.content_hash, it.open_at_source_url, it.hub_track_id, it.artwork_id);
    })();
  }

  find(id: string): ShareRecord | undefined {
    const r = this.db.prepare<[string], ShareRow>('SELECT * FROM share_links WHERE id = ?').get(id);
    return r ? toShare(r) : undefined;
  }

  findByTokenHash(tokenHash: string): ShareRecord | undefined {
    const r = this.db.prepare<[string], ShareRow>('SELECT * FROM share_links WHERE token_hash = ?').get(tokenHash);
    return r ? toShare(r) : undefined;
  }

  list(ownerId?: string): ShareRecord[] {
    if (ownerId) return this.db.prepare<[string], ShareRow>('SELECT * FROM share_links WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId).map(toShare);
    return this.db.prepare<[], ShareRow>('SELECT * FROM share_links ORDER BY created_at DESC').all().map(toShare);
  }

  items(shareId: string): ShareItemRow[] {
    return this.db.prepare<[string], ShareItemRow>('SELECT * FROM share_items WHERE share_id = ? ORDER BY position').all(shareId);
  }

  itemCount(shareId: string): number {
    return this.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM share_items WHERE share_id = ?').get(shareId)?.n ?? 0;
  }

  /** Counts an access atomically; returns false when the access cap has been reached. */
  countAccess(id: string): boolean {
    return this.db.prepare('UPDATE share_links SET access_count = access_count + 1 WHERE id = ? AND (max_accesses IS NULL OR access_count < max_accesses)').run(id).changes > 0;
  }

  countPlay(id: string): void {
    this.db.prepare('UPDATE share_links SET play_count = play_count + 1 WHERE id = ?').run(id);
  }

  revoke(id: string, now: string): boolean {
    return this.db.prepare('UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id).changes > 0;
  }

  purgeExpired(before: string): number {
    return this.db.prepare('DELETE FROM share_links WHERE (expires_at IS NOT NULL AND expires_at < ?) OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(before, before).changes;
  }
}

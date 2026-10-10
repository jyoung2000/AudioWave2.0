import { SavedCollection, type CatalogCollectionRef } from '@now-playing/contracts';
import type { Db } from '../connection.js';

/** At most this many starred lists per owner: a library, not a dump. */
export const SAVED_COLLECTIONS_CAP = 2000;

interface Row {
  body: string;
}

/**
 * Starred albums and playlists (UX-SEARCH-005), in the shared `SavedCollection` shape. A row that no
 * longer parses (a hand edit, an older shape) is left out of the list rather than failing it.
 */
export class SavedCollectionsRepository {
  constructor(private readonly db: Db) {}

  list(ownerId: string): SavedCollection[] {
    const rows = this.db.prepare<[string], Row>('SELECT body FROM saved_collections WHERE owner_id = ? ORDER BY saved_at DESC, collection_id').all(ownerId);
    return rows.flatMap((row) => {
      try {
        const parsed = SavedCollection.safeParse(JSON.parse(row.body));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  /** Every owner's lists whose id starts with `prefix` (`admin:`), one per ref, newest first: what devices see as shared. */
  listShared(prefix: string): SavedCollection[] {
    const rows = this.db.prepare<[number, string], Row>('SELECT body FROM saved_collections WHERE substr(owner_id, 1, ?) = ? ORDER BY saved_at DESC, collection_id LIMIT 2000').all(prefix.length, prefix);
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      try {
        const parsed = SavedCollection.safeParse(JSON.parse(row.body));
        if (!parsed.success) return [];
        const key = `${parsed.data.ref.platform}:${parsed.data.ref.kind}:${parsed.data.ref.id}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [parsed.data];
      } catch {
        return [];
      }
    });
  }

  count(ownerId: string): number {
    return this.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM saved_collections WHERE owner_id = ?').get(ownerId)?.n ?? 0;
  }

  has(ownerId: string, ref: Pick<CatalogCollectionRef, 'platform' | 'kind' | 'id'>): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM saved_collections WHERE owner_id = ? AND platform = ? AND kind = ? AND collection_id = ?').get(ownerId, ref.platform, ref.kind, ref.id));
  }

  put(ownerId: string, saved: SavedCollection): void {
    this.db
      .prepare('INSERT INTO saved_collections (owner_id, platform, kind, collection_id, body, saved_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, platform, kind, collection_id) DO UPDATE SET body = excluded.body, saved_at = excluded.saved_at')
      .run(ownerId, saved.ref.platform, saved.ref.kind, saved.ref.id, JSON.stringify(saved), saved.savedAt);
  }

  remove(ownerId: string, ref: Pick<CatalogCollectionRef, 'platform' | 'kind' | 'id'>): boolean {
    return this.db.prepare('DELETE FROM saved_collections WHERE owner_id = ? AND platform = ? AND kind = ? AND collection_id = ?').run(ownerId, ref.platform, ref.kind, ref.id).changes > 0;
  }
}

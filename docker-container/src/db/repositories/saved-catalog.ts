import { SavedCatalogItem, SavedCatalogTombstone, type SavedCatalogDeleteRequest, type SavedCatalogItem as SavedItem, type SavedCatalogItemList } from '@now-playing/contracts';
import type { Db } from '../connection.js';

/** Bound active stars per Hub. Tombstones remain so offline clients cannot resurrect deletions. */
export const SAVED_CATALOG_ITEMS_CAP = 2000;

interface ItemRow { body: string | null; }
interface TombstoneRow { item_key: string; deleted_at: string; }

export function savedCatalogItemKey(item: SavedItem | SavedCatalogDeleteRequest): string {
  if ('identityKey' in item) return `track:${item.identityKey}`;
  if ('ref' in item) return `collection:${item.ref.platform}:${item.ref.kind}:${item.ref.id}`;
  return `collection:${item.platform}:${item.kind}:${item.id}`;
}

function itemKind(item: SavedItem): 'track' | 'album' | 'playlist' {
  return 'kind' in item ? 'track' : item.ref.kind;
}

/** The one Hub-backed, metadata-only set shared by admins and every paired client. */
export class SavedCatalogRepository {
  constructor(private readonly db: Db) {}

  list(): SavedCatalogItemList {
    const itemRows = this.db.prepare<[], ItemRow>(
      'SELECT body FROM saved_catalog_items WHERE deleted_at IS NULL AND body IS NOT NULL ORDER BY saved_at DESC, item_key',
    ).all();
    const items = itemRows.flatMap(({ body }) => {
      if (!body) return [];
      try {
        const parsed = SavedCatalogItem.safeParse(JSON.parse(body));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
    const tombstones = this.db.prepare<[], TombstoneRow>(
      'SELECT item_key, deleted_at FROM saved_catalog_items WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, item_key',
    ).all().flatMap((row) => {
      const parsed = SavedCatalogTombstone.safeParse({ key: row.item_key, at: row.deleted_at });
      return parsed.success ? [parsed.data] : [];
    });
    return { items, tombstones, shared: [] };
  }

  count(): number {
    return this.db.prepare<[], { n: number }>(
      'SELECT COUNT(*) AS n FROM saved_catalog_items WHERE deleted_at IS NULL',
    ).get()?.n ?? 0;
  }

  has(item: SavedItem | SavedCatalogDeleteRequest): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM saved_catalog_items WHERE item_key = ? AND deleted_at IS NULL').get(savedCatalogItemKey(item)));
  }

  /** A stale offline star cannot overwrite a newer snapshot or a newer tombstone. */
  put(item: SavedItem): void {
    this.db.prepare(
      `INSERT INTO saved_catalog_items (item_key, kind, body, saved_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(item_key) DO UPDATE SET kind = excluded.kind, body = excluded.body,
         saved_at = excluded.saved_at, updated_at = excluded.updated_at, deleted_at = NULL
       WHERE excluded.updated_at > saved_catalog_items.updated_at`,
    ).run(savedCatalogItemKey(item), itemKind(item), JSON.stringify(item), item.savedAt, item.savedAt);
  }

  /** Record a durable timestamped delete marker, even if the key never reached this Hub while online. */
  remove(ref: SavedCatalogDeleteRequest, at: string): void {
    const key = savedCatalogItemKey(ref);
    this.db.prepare(
      `INSERT INTO saved_catalog_items (item_key, kind, body, saved_at, updated_at, deleted_at)
       VALUES (?, ?, NULL, ?, ?, ?)
       ON CONFLICT(item_key) DO UPDATE SET body = NULL, saved_at = excluded.saved_at,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
       WHERE excluded.updated_at >= saved_catalog_items.updated_at`,
    ).run(key, ref.kind, at, at, at);
  }
}

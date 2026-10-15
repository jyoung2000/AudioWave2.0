-- One editable, Hub-backed star set. Legacy collection rows are copied once, deduplicated by catalog ref.
CREATE TABLE saved_catalog_items (
  item_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('track', 'album', 'playlist')),
  body TEXT,
  saved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_saved_catalog_items_updated ON saved_catalog_items(updated_at DESC, item_key);

INSERT OR REPLACE INTO saved_catalog_items (item_key, kind, body, saved_at, updated_at, deleted_at)
SELECT 'collection:' || platform || ':' || kind || ':' || collection_id,
       kind, body, saved_at, saved_at, NULL
FROM saved_collections
ORDER BY saved_at ASC, owner_id ASC, collection_id ASC;

-- Albums and playlists starred from the catalog search (UX-SEARCH-005): the shared SavedCollection
-- shape, kept per owner ('admin:<admin user id>' for the admin window) so the player can sync its
-- own later. The ref's platform, kind and id are the key; the rest of the shape is the body.
CREATE TABLE saved_collections (
  owner_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('album', 'playlist')),
  collection_id TEXT NOT NULL,
  body TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, platform, kind, collection_id)
);
CREATE INDEX idx_saved_collections_owner ON saved_collections(owner_id, saved_at);

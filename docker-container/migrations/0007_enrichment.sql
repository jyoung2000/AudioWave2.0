-- What a track becomes once the hub has looked it up: featured artists from the artist credit, a
-- weighted genre profile on one vocabulary, a tempo with its source, the cover, and how sure the
-- match was. enriched_at NULL means nothing has looked yet.
ALTER TABLE canonical_tracks ADD COLUMN featured_artists TEXT NOT NULL DEFAULT '[]';
ALTER TABLE canonical_tracks ADD COLUMN genre_profile TEXT NOT NULL DEFAULT '{}';
ALTER TABLE canonical_tracks ADD COLUMN bpm REAL;
ALTER TABLE canonical_tracks ADD COLUMN bpm_source TEXT;
ALTER TABLE canonical_tracks ADD COLUMN artwork_url TEXT;
ALTER TABLE canonical_tracks ADD COLUMN match_confidence REAL;
ALTER TABLE canonical_tracks ADD COLUMN enriched_at TEXT;
CREATE INDEX IF NOT EXISTS idx_canonical_tracks_enriched ON canonical_tracks(enriched_at);

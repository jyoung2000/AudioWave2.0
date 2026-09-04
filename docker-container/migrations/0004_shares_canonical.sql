-- Shareable links, canonical music catalogue, discovery cache/jobs, listening events, profiles, platform connections.
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  owner_id TEXT NOT NULL,
  owner_display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  allow_stream INTEGER NOT NULL DEFAULT 1,
  allow_download INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  max_accesses INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_share_links_owner ON share_links(owner_id, created_at DESC);

CREATE TABLE share_items (
  share_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  album_name TEXT,
  duration_ms INTEGER,
  content_hash TEXT,
  open_at_source_url TEXT,
  hub_track_id TEXT,
  artwork_id TEXT,
  PRIMARY KEY (share_id, position)
);

CREATE TABLE canonical_artists (
  id TEXT PRIMARY KEY,
  musicbrainz_artist_id TEXT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  genres TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  popularity REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_canonical_artists_norm ON canonical_artists(normalized_name);
CREATE INDEX idx_canonical_artists_mbid ON canonical_artists(musicbrainz_artist_id);

CREATE TABLE canonical_tracks (
  id TEXT PRIMARY KEY,
  musicbrainz_recording_id TEXT,
  isrc TEXT,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  artist_id TEXT REFERENCES canonical_artists(id),
  artist_name TEXT NOT NULL,
  normalized_artist TEXT NOT NULL,
  album_id TEXT,
  album_name TEXT,
  release_year INTEGER,
  duration_ms INTEGER,
  genres TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  popularity REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_canonical_tracks_match ON canonical_tracks(normalized_artist, normalized_title);
CREATE INDEX idx_canonical_tracks_mbid ON canonical_tracks(musicbrainz_recording_id);
CREATE INDEX idx_canonical_tracks_isrc ON canonical_tracks(isrc);

CREATE TABLE track_platforms (
  track_id TEXT NOT NULL REFERENCES canonical_tracks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_track_id TEXT NOT NULL,
  url TEXT,
  availability TEXT NOT NULL DEFAULT 'unknown',
  last_verified_at TEXT,
  PRIMARY KEY (track_id, provider, provider_track_id)
);
CREATE INDEX idx_track_platforms_provider ON track_platforms(provider, provider_track_id);

CREATE TABLE artist_relations (
  artist_id TEXT NOT NULL REFERENCES canonical_artists(id) ON DELETE CASCADE,
  related_artist_id TEXT NOT NULL REFERENCES canonical_artists(id) ON DELETE CASCADE,
  weight REAL NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (artist_id, related_artist_id, source)
);

CREATE TABLE discovery_cache (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  query TEXT NOT NULL,
  results TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_discovery_cache_expiry ON discovery_cache(expires_at);

CREATE TABLE discovery_jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'P3',
  payload TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX idx_discovery_jobs_due ON discovery_jobs(state, next_run_at, priority);

CREATE TABLE listening_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);
CREATE INDEX idx_listening_events_user ON listening_events(user_id, occurred_at);

CREATE TABLE taste_profiles (
  user_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE aggregate_profiles (
  owner_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);

CREATE TABLE platform_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_user_id TEXT,
  access_token_sealed TEXT,
  refresh_token_sealed TEXT,
  expires_at TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, provider)
);

CREATE TABLE recommendation_feedback (
  recommendation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  feedback TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recommendation_id, user_id)
);

CREATE TABLE recommendation_seeds (
  user_id TEXT PRIMARY KEY,
  artists TEXT NOT NULL DEFAULT '[]',
  genres TEXT NOT NULL DEFAULT '[]',
  liked_track_ids TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

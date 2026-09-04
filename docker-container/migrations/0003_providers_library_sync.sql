-- Providers (encrypted app configs, accounts, checkpoints, cache), downloads, transfers, hub library, blobs, sync store.
CREATE TABLE provider_app_configs (
  provider TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  client_id TEXT,
  client_secret_sealed TEXT,
  api_key_sealed TEXT,
  application_id TEXT,
  redirect_uri TEXT,
  contact_email TEXT,
  extra TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_device_id TEXT,
  external_user_id TEXT,
  display_name TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  import_cursor TEXT,
  token_last4 TEXT,
  access_token_sealed TEXT,
  refresh_token_sealed TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(provider, owner_user_id)
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_device_id TEXT,
  code_verifier_sealed TEXT,
  return_to TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE user_platform_sync (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  last_sync_at TEXT,
  cursor TEXT,
  snapshot TEXT,
  etag TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE metadata_cache (
  cache_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_metadata_cache_expiry ON metadata_cache(expires_at);

CREATE TABLE download_jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source TEXT NOT NULL,
  authorization TEXT NOT NULL,
  target TEXT NOT NULL,
  progress TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at TEXT,
  checksum_sha256 TEXT,
  result_locator TEXT,
  result_size_bytes INTEGER,
  error TEXT,
  output_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_download_jobs_state ON download_jobs(state, created_at);
CREATE INDEX idx_download_jobs_owner ON download_jobs(owner_id, created_at DESC);

CREATE TABLE transfer_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'file',
  state TEXT NOT NULL,
  from_device_id TEXT NOT NULL,
  to_device_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  chunk_size_bytes INTEGER NOT NULL DEFAULT 1048576,
  resume_offset INTEGER NOT NULL DEFAULT 0,
  checksum_verified INTEGER NOT NULL DEFAULT 0,
  receiver_confirmed INTEGER NOT NULL DEFAULT 0,
  policy TEXT NOT NULL DEFAULT 'both',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  track_id TEXT
);
CREATE INDEX idx_transfer_jobs_devices ON transfer_jobs(from_device_id, to_device_id);
CREATE INDEX idx_transfer_jobs_hash ON transfer_jobs(content_hash);

CREATE TABLE library_roots (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'hub-directory',
  display_name TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'connected',
  last_scan_at TEXT,
  last_scan_error TEXT,
  track_count INTEGER NOT NULL DEFAULT 0,
  watch INTEGER NOT NULL DEFAULT 1,
  scan_checkpoint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE hub_tracks (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  track TEXT NOT NULL,
  content_hash TEXT,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  mime TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(root_id, relative_path)
);
CREATE INDEX idx_hub_tracks_hash ON hub_tracks(content_hash);

CREATE TABLE artwork (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  mime TEXT,
  track_id TEXT,
  owner_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_blobs_track ON blobs(track_id);

CREATE TABLE synced_records (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  body TEXT,
  last_change_id TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX idx_synced_records_updated ON synced_records(collection, updated_at);
CREATE INDEX idx_synced_records_tombstones ON synced_records(deleted_at);

CREATE TABLE applied_changes (
  change_id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE sync_cursors (
  device_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  cursor TEXT,
  PRIMARY KEY (device_id, collection)
);

CREATE TABLE sync_state (
  device_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  enabled_collections TEXT NOT NULL DEFAULT '[]',
  last_success_at TEXT,
  last_error TEXT,
  conflicts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

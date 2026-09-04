-- Core: settings, admin auth, sessions, audit, hub users, devices, credentials, pairing, metrics samples.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  bootstrap INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE admin_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip_display TEXT,
  user_agent TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_admin_sessions_user ON admin_sessions(user_id, revoked_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_display_name TEXT,
  action TEXT NOT NULL,
  target_kind TEXT,
  target_id TEXT,
  outcome TEXT NOT NULL,
  ip_display TEXT,
  correlation_id TEXT,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_events_time ON audit_events(occurred_at DESC);
CREATE INDEX idx_audit_events_action ON audit_events(action, occurred_at DESC);

CREATE TABLE hub_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  avatar TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT,
  public_key_fingerprint TEXT NOT NULL,
  public_key TEXT,
  app_version TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  last_seen_at TEXT,
  revoked_at TEXT,
  hub_user_id TEXT REFERENCES hub_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_devices_user ON devices(hub_user_id);

CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  hub_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  label TEXT
);
CREATE INDEX idx_device_credentials_device ON device_credentials(device_id);

CREATE TABLE pairing_sessions (
  id TEXT PRIMARY KEY,
  hub_id TEXT NOT NULL,
  device_kind TEXT NOT NULL,
  requested_scopes TEXT NOT NULL DEFAULT '[]',
  code_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  state TEXT NOT NULL DEFAULT 'pending',
  claimed_device_name TEXT,
  claimed_public_key TEXT,
  claimed_app_version TEXT,
  claimed_protocol_version INTEGER,
  claimed_platform TEXT,
  claim_secret_hash TEXT,
  verification_fingerprint TEXT,
  confirmed_at TEXT,
  consumed_at TEXT,
  resulting_device_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pairing_sessions_state ON pairing_sessions(state, expires_at);

CREATE TABLE metrics_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sampled_at TEXT NOT NULL,
  counters TEXT NOT NULL,
  histograms TEXT NOT NULL
);
CREATE INDEX idx_metrics_samples_time ON metrics_samples(sampled_at);

-- Groups: memberships, invites, authoritative queue + playback, revisions, replay log, idempotency results, history, drift.
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  hub_id TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  settings TEXT NOT NULL DEFAULT '{}',
  invite_code_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE group_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT
);
CREATE INDEX idx_group_invites_group ON group_invites(group_id, expires_at);

CREATE TABLE group_memberships (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  member_kind TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  display_name TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  revoked_at TEXT,
  share_aggregate INTEGER NOT NULL DEFAULT 0,
  last_request_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(group_id, member_id)
);
CREATE INDEX idx_group_memberships_member ON group_memberships(member_id);

CREATE TABLE group_queues (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  queue TEXT NOT NULL,
  playback TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE group_revisions (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  command TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 1,
  reject_reason TEXT,
  PRIMARY KEY (group_id, revision)
);

CREATE TABLE group_events (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (group_id, seq)
);

CREATE TABLE group_command_results (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, idempotency_key)
);
CREATE INDEX idx_group_command_results_time ON group_command_results(created_at);

CREATE TABLE group_history (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  track TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_track_id TEXT,
  requester_id TEXT NOT NULL,
  requester_display_name TEXT NOT NULL,
  outcome TEXT NOT NULL,
  skip_reason TEXT,
  queue_revision INTEGER NOT NULL,
  queue_item_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_group_history_group ON group_history(group_id, started_at DESC);

CREATE TABLE group_drift (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  drift_ms REAL NOT NULL,
  position_ms INTEGER NOT NULL,
  dsp_latency_ms REAL NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (group_id, member_id)
);

CREATE TABLE group_availability (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  available INTEGER NOT NULL,
  reason TEXT,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (group_id, item_id, member_id)
);

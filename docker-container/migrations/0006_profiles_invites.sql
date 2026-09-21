-- Profiles: a username, a picture and shared playlists on the HubUser behind a device credential.
--
-- `hub_users.display_name` starts life as the device name given at pairing, and two people can
-- both be "Chrome on Windows". A unique index on it would therefore fail on a hub that already has
-- devices. The claimed username lives in `profile_name_key` instead: the NFC-normalised, trimmed,
-- lower-cased name, NULL until the person picks one. The unique index is on that column, so two
-- simultaneous saves of the same name cannot both win whatever the code above it does.
ALTER TABLE hub_users ADD COLUMN profile_name_key TEXT;
CREATE UNIQUE INDEX idx_hub_users_profile_name ON hub_users(profile_name_key) WHERE profile_name_key IS NOT NULL;

CREATE TABLE profile_playlists (
  user_id TEXT NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL,
  name TEXT NOT NULL,
  csv TEXT NOT NULL,
  tracks INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, playlist_id)
);

-- Pictures are kept in the database rather than beside it so that the online backup — one
-- consistent snapshot — carries them without a second thing to copy. They are small: every upload
-- is re-encoded to a 256 x 256 WebP before it is stored.
CREATE TABLE profile_avatars (
  blob_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES hub_users(id) ON DELETE CASCADE,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- Invites people can see, answer and withdraw. A closed invite is kept for 30 days so the group's
-- list can say what became of it.
ALTER TABLE group_invites ADD COLUMN to_profile_id TEXT REFERENCES hub_users(id);
ALTER TABLE group_invites ADD COLUMN withdrawn_at TEXT;
ALTER TABLE group_invites ADD COLUMN declined_at TEXT;
ALTER TABLE group_invites ADD COLUMN created_by_name TEXT;
CREATE INDEX idx_group_invites_to_profile ON group_invites(to_profile_id) WHERE to_profile_id IS NOT NULL;

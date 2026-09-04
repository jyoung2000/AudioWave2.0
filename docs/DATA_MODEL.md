# Data model

All entities are defined once in `packages/contracts/src/entities` (Zod) and generated to JSON Schema under `packages/contracts/generated/json-schema/`. Every synced entity extends `SyncedEntityBase`: `id` (UUIDv7, stable across sync), `schemaVersion`, `createdAt`/`updatedAt` (UTC ISO-8601), `deletedAt` (tombstone).

| Entity | Purpose | Identity / notes |
|---|---|---|
| `UserProfile` | Local profile (name, avatar) | local; shared with hubs only when enabled |
| `HubUser` | Hub-side person record; multi-user recommendations key on it | one per paired person |
| `Device` / `DeviceCredential` / `DeviceCredentialSecret` | Paired device, hashed scoped credential, one-time client secret | public-key fingerprint; scopes |
| `LibraryRoot` | A directory the device owns (opaque `handleId`; status connected/needs-permission/missing/scanning) | never a path when shared |
| `Artist`, `Album`, `Track` | Normalized library rows | `Track.identity` (`TrackIdentity`: contentHash, quickHash, ISRC, MusicBrainz ids, provider ids) — a title is never a key |
| `TrackRef` | Snapshot embedded in playlists/queues/events so they stay meaningful if the row disappears | carries locators + identity |
| `MediaLocator` | `browser-handle` / `opfs` / `windows-file` / `hub-blob` / `provider` | resolved only by the owning device |
| `ProviderAccount`, `ProviderAppConfigInput/View`, `UserPlatformSync`, `ProviderCapability` | App credentials (write-only), per-user connections (no tokens in schema), incremental sync checkpoints, reviewed capabilities | secrets encrypted with the installation key |
| `Playlist`, `PlaylistItem` | Ordered mixed-locator playlists; `Playlist.eqPresetId` = playlist default; `PlaylistItem.eqOverridePresetId` = per-track-per-playlist override | positions rewritten on reorder; LWW per item |
| `Queue`, `QueueItem`, `QueueCommand`, `PlaybackState` | Solo (local) and Group (hub) queues share one reducer | revision + idempotency keys |
| `EqPreset`, `EqBand`, `EqBinding`, `RetuneConfig`, `AudioSettings`, `ResolvedEq` | 10-band/parametric presets; bindings by scope global/playlist/track/playlist-track | precedence documented in AUDIO_PIPELINE.md |
| `ListeningEvent` | Append-only behaviour events with track snapshot, position, reason, context, mood/activity | never counted as a play on `play` alone |
| `AggregateTasteProfile` | Weights per artist/genre/album/era + hour histogram, sample size, `minSampleMet` | no titles, no timestamps |
| `Recommendation` | Ranked item with tier, reasons, availability per platform, feedback | from `packages/recommendations` |
| `Group`, `GroupMembership`, `GroupQueueRevision`, `GroupHistoryEntry`, `GroupPlaybackState` | Groups, roles, revision log, history, hub timeline | `GroupHistoryEntry.id` = idempotent `event_id` |
| `DownloadJob`, `TransferJob`, `DiscoveryJob` | Durable jobs with states queued/running/paused/retrying/completed/failed/cancelled | authorization basis recorded on downloads |
| `PairingSession`, `PairingLinkPayload` | Single-use pairing (code hash only) and QR/deep-link payload | see PAIRING_AND_SYNC.md |
| `DiscordConfiguration`, `DiscordTemplates`, `DiscordStatus` | Bot configuration (token last-4 only), constrained templates, live status | |
| `AuditEvent` | Security/audit trail with truncated IP display | |
| `CanonicalTrack`, `CanonicalArtist`, `TrackPlatform`, `ArtistRelation`, `DiscoveryCacheEntry` | Platform-independent recommendation catalogue and shared discovery cache | |
| `ShareLink`, `ShareLinkView`, `SharePayload` | Revocable public links (token hash, hint, expiry, caps, flags) and their public payload | |

## Files and formats
| Format | Schema | Version |
|---|---|---|
| Playlist JSON (`now-playing-playlist`) | `PlaylistJson` — playlist, items with `TrackRef`, EQ override ids, embedded presets | `SCHEMA_VERSIONS.playlistJson = 1` |
| EQ preset JSON (`now-playing-eq-preset`) | `EqPresetJson` | 1 |
| Group history CSV | `HISTORY_CSV_COLUMNS`, `HistoryCsvRow` (schema_version, event_id, group_id, started_at_utc, ended_at_utc, track_id, provider, provider_track_id, title, artist, album, duration_ms, requester_id, requester_display_name, outcome, skip_reason, queue_revision) | 1 |
| Release metadata `latest.json` | `ReleaseMetadata` (version, releasedAt, channel, signed, artifacts with sha256) | 1 |
| Sync manifest/delta | `SyncManifest`, `SyncChange`, `SyncDeltaRequest/Response`, `SyncStatus` | 1 |
| M3U/M3U8 | parsed/serialized by `packages/domain/src/playlist-formats.ts` (relative paths only) | — |

## Storage
- Player: IndexedDB databases `now-playing-*` with object stores per entity, `schemaVersion` on rows, versioned upgrade functions; artwork and OPFS blobs by content hash.
- Hub: SQLite WAL, one table per entity plus `schema_migrations`, `group_events` (replay log), `group_command_results` (idempotency), `applied_changes` (sync idempotency), `metrics_samples`, `admin_sessions`, `share_links`/`share_items`, canonical/discovery tables. Migrations are numbered SQL files under `docker-container/migrations/`.
- Companion: SQLite (same migration style) under the user's app-data directory; file ids are opaque UUIDs mapped to paths only inside the main process.

## Retention and compaction
- Tombstones: kept 30 days after every known peer's cursor passes them.
- Listening events: user-configurable window (default 365 days), then compacted into aggregates.
- Logs: size-rotated, 5 files; diagnostics bundles are generated on demand and not stored.
- Metrics samples: 30 days of minute samples, then hourly roll-ups.

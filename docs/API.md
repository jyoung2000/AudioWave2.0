# API

The hub API is generated from `packages/contracts/src/api/routes.ts`. The committed OpenAPI 3.1 document is `packages/contracts/generated/openapi.json` (served live at `GET /api/v1/openapi.json`). JSON Schemas for every entity are under `packages/contracts/generated/json-schema/`.

## Conventions
- Base path `/api/v1`; health probes at `/healthz` and `/readyz`; realtime WebSocket at `/api/v1/realtime`; public share pages at `/s/:token`.
- Errors are RFC 9457 `application/problem+json` (`ProblemDetails`: `type`, `title`, `status`, `detail`, `code`, `correlationId`, `retryAfterSeconds`).
- Authentication: admin session cookie (`now-playing-session`, HttpOnly, SameSite=Strict, Secure in remote mode) + `X-CSRF-Token` on non-GET; device credential `Authorization: Bearer <credentialId>.<secret>` with per-route scopes. Routes marked `x-setup-required` return `403 setup-required` until the bootstrap password is replaced.
- Rate-limit classes (`x-rate-limit`): `auth` 10/min/IP, `pairing` 5/min/IP, `search` 60/min, `write` 120/min, `default` 600/min; `429` carries `Retry-After`.
- Pagination: `cursor` + `limit`; responses return `nextCursor`.
- Timestamps are UTC ISO-8601; ids are UUIDv7.

## Route groups (operationId → path)
| Group | Operations |
|---|---|
| Health | `healthz` GET /healthz · `readyz` GET /readyz · `getVersion` GET /version |
| Hub & auth | `getHubIdentity` GET /hub · `getSession` GET /auth/session · `login` POST /auth/login · `changePassword` POST /auth/change-password · `logout` POST /auth/logout · `listSessions` · `revokeSession` · `listAudit` |
| Pairing | `createPairingSession` POST /pairing/sessions · `listPairingSessions` · `revokePairingSession` · `claimPairing` POST /pairing/claim · `confirmPairing` · `pairingStatus` · `completePairing` |
| Devices | `listDevices` · `revokeDevice` · `updateDevice` · `getMyDevice` |
| Search & providers | `search` GET /search · `listProviders` · `getProviderConfig`/`putProviderConfig` · `testProvider` · `resolveUrl` · `providerUsage` · `latestReleases` GET /artists/releases |
| Accounts (per-user OAuth) | `listAccounts` · `startAccountConnect` · `accountCallback` · `disconnectAccount` · `syncAccount` · `accountSyncStatus` |
| Groups | `listGroups` · `createGroup` · `getGroup` · `updateGroup` · `archiveGroup` · `createInvite` (optionally `toProfileId`) · `listInvites` GET /groups/:groupId/invites · `withdrawInvite` DELETE /groups/:groupId/invites/:inviteId · `previewInvite` GET /groups/invites/preview?code= · `listMyInvites` GET /me/invites · `acceptMyInvite` · `declineMyInvite` · `joinGroup` · `leaveGroup` · `revokeMember` · `setMemberRole` · `getGroupQueue` · `groupQueueCommand` · `listGroupHistory` · `exportGroupHistoryCsv` · `exportGroupHistoryJson` · `importGroupHistory` · `groupSyncInfo` · `groupAggregate` · `groupNowPlaying` |
| Profiles | `getMyProfile` GET /profiles/me · `updateMyProfile` PATCH /profiles/me (409 when the name is taken) · `profileNameAvailable` GET /profiles/available?name= · `putMyAvatar`/`deleteMyAvatar` /profiles/me/avatar · `putMyProfilePlaylist`/`deleteMyProfilePlaylist` /profiles/me/playlists/:playlistId · `searchProfiles` GET /profiles?q=&limit= · `getProfile` · `getProfileAvatar` · `getProfilePlaylistCsv` GET /profiles/:id/playlists/:playlistId.csv · admin: `adminListProfiles` · `adminRenameProfile` · `adminRemoveProfileAvatar` |
| Recommendations | `putAggregateProfile`/`deleteAggregateProfile`/`getAggregateProfile` · `ingestListeningEvents` · `getRecommendations` · `recommendationFeedback` · `setRecommendationSeeds` · `getTasteProfile` · `getRecommendationConfig`/`putRecommendationConfig` |
| Downloads | `listDownloads` · `createDownload` · `downloadAction` · `downloadFormats` · `downloadStorage` |
| Library | `listLibraryTracks` · `listLibraryRoots` · `addLibraryRoot` · `removeLibraryRoot` · `scanLibrary` · `scanLibraryRoot` POST /library/roots/:rootId/scan · `streamTrack` · `getArtwork` |
| Sync & files | `exchangeManifest` · `exchangeDelta` · `syncStatus` · `headFile` · `putFileChunk` · `getFile` · `listTransfers` · `createTransfer` · `transferAction` |
| Metrics | `metricsOverview` · `metricsConnections` · `metricsRaw` |
| Discord | `getDiscordConfig`/`putDiscordConfig` · `setDiscordToken`/`clearDiscordToken` · `discordAction` · `discordStatus` · `discordInviteUrl` · `getDiscordTemplates`/`putDiscordTemplates` · `previewDiscordTemplate` · `resetDiscordTemplates` · `testDiscordCommand` |
| Network, logs, diagnostics, backup, updates | `getNetwork`/`putNetwork` · `listLogs` · `diagnosticsBundle` · `createBackup` · `backupSpace` GET /backup/space · `listBackups` · `restoreBackup` · `downloadBackup` GET /backup/:backupId/download · `getBackupSettings`/`putBackupSettings` /backup/settings · `exportAll` · `importAll` · `getUpdates` · `getWindowsCompanionRelease`/`putWindowsCompanionRelease` |
| Live TV | `getLiveTv` GET /live-tv · `putLiveTv` PUT /live-tv · `deleteLiveTv` DELETE /live-tv · `getLiveTvSummary` GET /live-tv/summary |
| Shares | `createShare` · `listShareSources` GET /shares/sources · `listShares` · `revokeShare` · `resolveShare` · `streamShared` · `sharePage` |
| Playlists (DEC-041) | `listFolderPlaylists` GET /playlists · `createFolderPlaylist` POST /playlists · `getFolderPlaylist` GET /playlists/:playlistId · `updateFolderPlaylist` PATCH /playlists/:playlistId · `deleteFolderPlaylist` DELETE /playlists/:playlistId · `addFolderPlaylistEntries` POST /playlists/:playlistId/entries · `removeFolderPlaylistEntries` POST /playlists/:playlistId/entries/remove · `moveFolderPlaylistEntry` POST /playlists/:playlistId/entries/move · `exportFolderPlaylist` GET /playlists/:playlistId/export · `getPlaylistFolder`/`putPlaylistFolder` /playlists/folder |
| Starred collections | `listSavedCollections` GET /catalog/saved · `saveCollection` PUT /catalog/saved · `unsaveCollection` DELETE /catalog/saved |

### Profiles
Device-only, scopes `profile:read` / `profile:write`; nothing is anonymous and the first-run gate applies. A profile belongs to the HubUser behind the credential.

- **Usernames** are unique per hub, compared case-insensitively after Unicode NFC normalisation and trimming, and enforced by a unique index — of two simultaneous saves exactly one gets `200` and the other `409`. 3–40 characters: letters, numbers, spaces, `.`, `_`, `-`; first and last must be a letter or number. `admin` is reserved. A profile that has not picked a name yet shows its device name, which is not reserved for it.
- **Pictures**: send raw `image/png`, `image/jpeg` or `image/webp`, at most 512 × 512 and 1 MB. The hub goes by the bytes, not the header, re-encodes to a 256 × 256 WebP with the metadata dropped, and stores that. A hub whose FFmpeg has no WebP encoder answers `503` and stores nothing. Served with `Cache-Control: private, max-age=300`.
- **Shared playlists**: raw `text/csv`, header `title,artist,album,seconds`, RFC 4180 quoting, at most 2 MB and 5,000 rows. Stored normalised and served re-serialised — never the uploaded bytes — and cells lose a leading `=`, `+`, `-` or `@`.
- `GET /profiles?q=` matches names containing `q`, case-insensitively, `limit` ≤ 20, and never includes the caller.

### Invites
`POST /groups/:groupId/invites` takes an optional `toProfileId` and returns `inviteId` and `toProfileId` beside the code. A directed invite still has a code, but only the addressed profile can use it: `join` from anyone else answers `403`. The addressee sees it under `GET /me/invites` and answers with `accept` (same effect as join) or `decline`.

`GET /groups/:groupId/invites` lists the last 30 days, newest first, each with a `state` of `open`, `used`, `expired`, `withdrawn` or `declined`; it never returns a code. `DELETE …/invites/:inviteId` withdraws one, and its code stops working at once. `GET /groups/invites/preview?code=` returns `{ groupName, memberCount, fromName, role, expiresAt }` — the count, never the member list — answers `404` for an unknown, used, expired or withdrawn code, and is rate-limited like `join` so it cannot be used to guess codes. The audit log records `invite.create`, `invite.withdraw`, `invite.accept` and `invite.decline`.

The link the player understands is a fragment, so none of it reaches any server, and the player strips it from the address bar as soon as it has read it:
`<player address>#invite/<CODE>?hub=<hub base URL>&g=<group name>&from=<sender>&r=<role>&x=<expiresAt>`

### Backup space
`GET /backup/space` (admin, or a device with `backup:read`) returns `{ path, freeBytes, totalBytes, lastArchiveBytes, keep }` for the backup directory — `<data>/backups`, or `NP_BACKUP_DIR` when set. A device never sees a host path outside the data volume: `path` is `host folder` instead. A missing directory is `null`s, not an error. The companion's counterpart is `GET /helper/v1/backup/estimate?parts=music,tv,movies` (`x-helper-token`), which returns the measured size of each configured folder and the backup drive's free space; a part that could not be measured within 20 s is left out, never reported as 0. Sizes are bytes; clients show decimal units (1 GB = 10⁹ bytes).

### Backup settings and downloads
`GET /backup/settings` and `PUT /backup/settings` (admin) hold `{ location, include: { credentials, activity, caches }, schedule: { frequency: off|daily|weekly, time: "HH:MM", weekday: 0–6 }, keep }`; the answer adds `path`, `dataDir`, `locationFixed`, `nextRunAt` and `lastRunAt`. A `PUT` may send any part. `location` is a folder inside the data volume, sent relative to it (`backups`) or as the container sees it (`/data/backups`); anything outside the volume, a `..` segment, the `keys/` folder or a folder the hub cannot write to is `400`, and nothing is stored. When `NP_BACKUP_DIR` is set it wins and `locationFixed` is true. The defaults are what the hub always did: every day at 03:00, everything included, the last 10 kept. Times are on the hub's clock (`TZ`, UTC by default). The scheduler checks every minute; a hub that was off at a slot takes the backup when it starts. `keep` (0 = all) prunes the oldest scheduled backups; backups made with Back Up Now are never pruned, pre-restore safety copies keep 10. Leaving a part out removes it from the archive only: `credentials` clears provider keys and secrets, provider and platform tokens, OAuth states and the Discord token; `activity` empties the audit log and metrics samples; `caches` empties the metadata and discovery caches. A safety backup always holds everything.

`GET /backup/:backupId/download` (admin session only) streams one archive as `application/vnd.sqlite3` with `Content-Disposition: attachment` and `Cache-Control: no-store`, and records `backup.download` in the audit log. Only an id the hub itself writes (`backup-<stamp>[-auto|-safety]`) that `GET /backup` lists is served; anything else is `404`.

### Shared links from the admin window
`GET /shares/sources` (admin) lists what the hub itself can share: `playlists` (synced to the hub, with at least one track: `{ id, name, trackCount }`) and `albums` from the hub library (`{ id, title, artistName, trackCount }`). An admin `POST /shares` with `kind: "playlist"` and no `items` builds the item list from the synced playlist; a device still sends its own `items`, as before. What a link grants is unchanged: items stream only where the hub holds the file, and the token is returned once.

### Playlists in the hub's folder (DEC-041)
The hub keeps playlists as files in `<data>/playlists` (Music ▸ Playlists ▸ Playlist folder changes it to a folder under `playlists/` or `library/`): one `<name>.m3u8` (`#EXTM3U`, `#PLAYLIST:<name>`, `#EXTINF:<secs>,<artist> - <title>`, then a path relative to the folder for a song in the hub's library, else the song's best source URL) and one `<name>.airwave.json` sidecar (`PlaylistSidecar`). Shapes: `packages/contracts/src/api/playlist-folder.ts`.

- `GET /playlists?catalogId=&isrc=` → `{ folder: PlaylistFolderInfo, items: FolderPlaylistSummary[] }`; with a song, each summary's `hasTrack` says whether it holds it. Hand-made `.m3u`/`.m3u8` files are listed with `origin: "hand-made"`, `readOnly: true`.
- `POST /playlists` `{ name, description?, tracks?: CatalogTrack[] }` → 201 `FolderPlaylistSummary`.
- `GET /playlists/:playlistId?offset=&limit=` (≤ 200) → `FolderPlaylistPage`: each `FolderPlaylistEntry` has `locationKind` (`library` with the library's `trackId` to stream, `url`, or `missing`), its catalog id, ISRC, platforms and sources.
- `PATCH /playlists/:playlistId` `{ name?, description? }` (the files are renamed), `DELETE /playlists/:playlistId` (the two files, never the songs).
- `POST /playlists/:playlistId/entries` `{ tracks: CatalogTrack[] (≤ 500), position?, allowDuplicates? }` → `{ playlist, added, skipped }`; `POST …/entries/remove` `{ entryIds }`; `POST …/entries/move` `{ entryId, to }`.
- `GET /playlists/:playlistId/export` → the `.m3u8` (`audio/x-mpegurl`, attachment).
- `GET`/`PUT /playlists/folder` (admin only) `{ relativePath, move }` → `{ folder, moved, failed }`.

Who may: an admin session, everything. A device needs **`playlists:use`**: it reads every list, creates lists, and adds songs to any; it renames, moves and deletes only in lists it created (`createdBy` is its device id), and removes only entries it added (`addedBy`) or entries in a list it created. Caps: 10,000 songs a playlist, 1,000 playlists a folder.

**For a player filing into hub playlists:** `GET /api/v1/playlists?catalogId=<CatalogTrack.id>&isrc=<isrc>` for the submenu (ticks), `POST /api/v1/playlists/:playlistId/entries` with `{ tracks: [catalogTrack] }` to file, `POST /api/v1/playlists` with `{ name, tracks: [catalogTrack] }` for New Playlist…, and `GET /api/v1/playlists/:playlistId` to read one; a `library` entry streams through `POST /library/stream-urls` with its `trackId`.

### Starred collections for devices
`GET /catalog/saved` → `{ items: SavedCollection[], shared: SavedCollection[] }`: an admin gets its own starred lists (`shared` empty); a device with **`library:sync`** gets its own as `items` and the admin's as `shared` (read-only). `PUT /catalog/saved` (a `SavedCollection`) stars into the caller's own; `DELETE /catalog/saved?platform=&kind=&id=` un-stars the caller's own; both answer the same shape. A player syncing stars reads `GET`, then `PUT`/`DELETE` its changes.

### Live TV kept on the hub
A paired companion keeps a copy of its Live TV on the hub, so players that cannot reach the companion's loopback helper get the same channels. Contract: `HubLiveTv = { channels: HubLiveTvChannel[], guide: HelperTvGuideEntry[], updatedAt: string | null, sourceDevice: { deviceId, name } | null }`, where `HubLiveTvChannel` is `HelperTvChannel` with `url` and `logo` held to http(s) links with no user name or password.

- `PUT /live-tv`, device credential of a **companion** with `library:share` (the scope a companion already needs to put its library on the hub), body `{ channels, guide }`, at most 50,000 of each and 32 MB; replaces the copy and answers `HubLiveTvSummary = { channelCount, guideCount, updatedAt, sourceDevice }`. A player, another hub or an admin session is refused.
- `GET /live-tv`, admin or a device with `library:read`: the copy (empty lists and nulls before any companion sent one).
- `DELETE /live-tv`, admin, or the companion that sent the copy (another companion gets `403`).
- `GET /live-tv/summary`, admin: the summary only.

The hub never fetches any of these addresses. The companion sends its copy after each sync and a few seconds after its Live TV changes, only while it shares its library with the hub, leaves out channels whose address is not a plain web link, and removes the copy when sharing is turned off.

## Realtime protocol
Envelope: `{ eventId, type, occurredAt, schemaVersion, actorId, payload, seq? }`. Server events: `hello`, `group.snapshot`, `group.queue.updated`, `group.playback`, `group.command.rejected`, `group.history.appended`, `presence`, `pong`, `error`, `upgrade-required`, `job.progress`, `discord.status`, `resync.required`, `device.revoked`. Client events: `ping`, `ack`, `resync`, `group.subscribe`, `group.unsubscribe`, `group.command`, `group.drift`, `group.availability`. Protocol version negotiated with `?protocol=`; heartbeats every 15 s; replay window 500 events.

Regenerate after editing contracts: `pnpm generate` (CI fails when the committed output is stale).

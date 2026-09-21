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
| Library | `listLibraryTracks` · `listLibraryRoots` · `addLibraryRoot` · `removeLibraryRoot` · `scanLibrary` · `streamTrack` · `getArtwork` |
| Sync & files | `exchangeManifest` · `exchangeDelta` · `syncStatus` · `headFile` · `putFileChunk` · `getFile` · `listTransfers` · `createTransfer` · `transferAction` |
| Metrics | `metricsOverview` · `metricsConnections` · `metricsRaw` |
| Discord | `getDiscordConfig`/`putDiscordConfig` · `setDiscordToken`/`clearDiscordToken` · `discordAction` · `discordStatus` · `discordInviteUrl` · `getDiscordTemplates`/`putDiscordTemplates` · `previewDiscordTemplate` · `resetDiscordTemplates` · `testDiscordCommand` |
| Network, logs, diagnostics, backup, updates | `getNetwork`/`putNetwork` · `listLogs` · `diagnosticsBundle` · `createBackup` · `backupSpace` GET /backup/space · `listBackups` · `restoreBackup` · `exportAll` · `importAll` · `getUpdates` · `getWindowsCompanionRelease`/`putWindowsCompanionRelease` |
| Shares | `createShare` · `listShares` · `revokeShare` · `resolveShare` · `streamShared` · `sharePage` |

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

## Realtime protocol
Envelope: `{ eventId, type, occurredAt, schemaVersion, actorId, payload, seq? }`. Server events: `hello`, `group.snapshot`, `group.queue.updated`, `group.playback`, `group.command.rejected`, `group.history.appended`, `presence`, `pong`, `error`, `upgrade-required`, `job.progress`, `discord.status`, `resync.required`, `device.revoked`. Client events: `ping`, `ack`, `resync`, `group.subscribe`, `group.unsubscribe`, `group.command`, `group.drift`, `group.availability`. Protocol version negotiated with `?protocol=`; heartbeats every 15 s; replay window 500 events.

Regenerate after editing contracts: `pnpm generate` (CI fails when the committed output is stale).

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
| Groups | `listGroups` · `createGroup` · `getGroup` · `updateGroup` · `archiveGroup` · `createInvite` · `joinGroup` · `leaveGroup` · `revokeMember` · `setMemberRole` · `getGroupQueue` · `groupQueueCommand` · `listGroupHistory` · `exportGroupHistoryCsv` · `exportGroupHistoryJson` · `importGroupHistory` · `groupSyncInfo` · `groupAggregate` · `groupNowPlaying` |
| Recommendations | `putAggregateProfile`/`deleteAggregateProfile`/`getAggregateProfile` · `ingestListeningEvents` · `getRecommendations` · `recommendationFeedback` · `setRecommendationSeeds` · `getTasteProfile` · `getRecommendationConfig`/`putRecommendationConfig` |
| Downloads | `listDownloads` · `createDownload` · `downloadAction` · `downloadFormats` · `downloadStorage` |
| Library | `listLibraryTracks` · `listLibraryRoots` · `addLibraryRoot` · `removeLibraryRoot` · `scanLibrary` · `streamTrack` · `getArtwork` |
| Sync & files | `exchangeManifest` · `exchangeDelta` · `syncStatus` · `headFile` · `putFileChunk` · `getFile` · `listTransfers` · `createTransfer` · `transferAction` |
| Metrics | `metricsOverview` · `metricsConnections` · `metricsRaw` |
| Discord | `getDiscordConfig`/`putDiscordConfig` · `setDiscordToken`/`clearDiscordToken` · `discordAction` · `discordStatus` · `discordInviteUrl` · `getDiscordTemplates`/`putDiscordTemplates` · `previewDiscordTemplate` · `resetDiscordTemplates` · `testDiscordCommand` |
| Network, logs, diagnostics, backup, updates | `getNetwork`/`putNetwork` · `listLogs` · `diagnosticsBundle` · `createBackup` · `listBackups` · `restoreBackup` · `exportAll` · `importAll` · `getUpdates` · `getWindowsCompanionRelease`/`putWindowsCompanionRelease` |
| Shares | `createShare` · `listShares` · `revokeShare` · `resolveShare` · `streamShared` · `sharePage` |

## Realtime protocol
Envelope: `{ eventId, type, occurredAt, schemaVersion, actorId, payload, seq? }`. Server events: `hello`, `group.snapshot`, `group.queue.updated`, `group.playback`, `group.command.rejected`, `group.history.appended`, `presence`, `pong`, `error`, `upgrade-required`, `job.progress`, `discord.status`, `resync.required`, `device.revoked`. Client events: `ping`, `ack`, `resync`, `group.subscribe`, `group.unsubscribe`, `group.command`, `group.drift`, `group.availability`. Protocol version negotiated with `?protocol=`; heartbeats every 15 s; replay window 500 events.

Regenerate after editing contracts: `pnpm generate` (CI fails when the committed output is stale).

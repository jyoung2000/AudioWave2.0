# Unified Companion–Player pairing and media access

**Status:** Scope approved; implementation remains partial.
**Scope approved by the user:** one user-facing code, same-PC/LAN/remote PWA and Android clients, Companion-backed radio, MusicSearch, Live TV/EPG, TV/movie playback with on-demand transcoding, and Player access to configured downloads, backups, and allowlisted tool provisioning.

**Implemented slice:** paired AWSP now exposes `tools.status` and an allowlisted download lifecycle (`start`, `status`, `fileChunk`, `forget`), with per-peer job grants, bounded chunks and Player-side import; pairing status automatically shows yt-dlp, spotDL and FFmpeg and polls while automatic setup is installing. Verification is fixture-backed (real browser/sidecar/relay, controlled local helper), not a live installed Companion test. MusicSearch runtime distribution is excluded pending upstream license clarification. Enrollment expiry/revocation lifecycle beyond existing AWSP, backup/restore, TV/movie inventory/playback/transcoding and interactive remote tool install are still incomplete.

## Problem

The Companion and Music Player currently expose separate pairing workflows:

- The local helper uses a persistent token for catalog/search and helper routes.
- AWSP uses a ticket plus a short-lived code to enroll a streaming client.
- The Player's radio metadata and Live TV/EPG paths use helper routes, while the Companion's TV/movie folders are stored/backed up but not indexed or streamed.

A single user-facing enrollment must make the Player's media capabilities and explicitly approved Companion jobs available locally and remotely, without exposing arbitrary administration, commands, or filesystem paths.

## User-facing behavior

1. Companion Remote presents the AWSP pairing address/QR and one short-lived, single-use code, with expiry and a connected-device list; it no longer asks the user to expose a second helper token.
2. Player offers one **Connect to Companion** flow. The user scans/pastes the address and enters the code once; the existing AWSP ticket/code are the only user-facing pairing credentials.
3. Successful enrollment shows per-capability status for MusicSearch, radio, Live TV/EPG, music streaming, TV/movie media, downloads, backups, and tool provisioning. The Player persists its device identity across reloads. Forget/unpair revokes the device at Companion and clears Player storage.
4. The AWSP device identity is the Player's credential. The helper token stays inside Companion and is used only by its allowlisted server-side bridge; it is never sent to the Player or reused as the AWSP credential.
5. Player can start/monitor configured downloads and backups, request install/update of Companion's pinned allowlisted tools, and receive outputs without seeing host paths. Restore/overwrite and other destructive operations require local Companion confirmation.
6. Hub pairing remains a separate service. Group mode remains unavailable unless a Hub is connected.

## Transport and security design

- All Player↔Companion media and job operations travel over the paired AWSP connection, direct when available or through its end-to-end encrypted relay. The Player never needs a second helper address/token.
- The AWSP sidecar calls the existing helper over loopback with the helper token held inside Companion. Do not expose the helper listener to LAN/Internet as part of unified pairing.
- Extend AWSP with a narrowly scoped control/media/job channel for the paired Player. A paired streaming identity does not authorize arbitrary helper routes.
- Create a per-device AWSP identity and capability set after code redemption. Keep the helper token in the DPAPI-backed Companion store; the server bridge uses it only for exact allowlisted helper routes, never sends it to Player. Store pairing state in Companion and Player, and list, scope, rotate, and revoke it as one device pairing.
- Pairing code is CSPRNG-generated, short-lived, single-use, rate-limited, attempt-limited, stored hashed, and never logged. Replaying an expired/consumed code fails. Companion revocation closes active AWSP connections and invalidates helper/RPC credentials.
- Downloads may use only Companion's existing validated resolver and configured output destination. The Player cannot pass shell commands, arbitrary executables, or filesystem paths. Backup jobs may use only configured folders/destination; restore/overwrite requires local Companion confirmation. Tool install/update is limited to pinned, hash-verified tools in the existing provisioner; no arbitrary installers. Job state and approved outputs flow over the scoped channel without returning host paths.
- Expose only explicit Player capabilities and jobs; do not expose arbitrary settings, shell, filesystem, or app-administration APIs.
- MusicSearch stays search-only: metadata results only; no audio bytes, preview URLs, download/file-management routes, or local paths.
- No UPnP, automatic router-port opening, or third-party tunnel provisioning. Remote connectivity must use AWSP relay or a user-configured secure endpoint/VPN.

## Capability behavior

| Capability | Current state | Unified-pairing target |
|---|---|---|
| MusicSearch/catalog | Companion-owned search-only sidecar reached through the helper | Available to an enrolled Player locally and remotely through the scoped Companion channel; preserve metadata-only behavior |
| Radio | Player has its own station directory/playback; Companion helper can read current-station metadata | Keep station playback in the Player; provide Companion-backed radio metadata/enrichment and safe station lookup through the paired channel |
| Live TV/EPG | Companion validates M3U/XMLTV links and exposes channels/guide through helper routes; same-PC Player already consumes them | Expose the same channels and guide to enrolled LAN/remote clients; preserve URL validation and no-path leakage |
| Music streaming | AWSP streams Companion music to paired clients | Enroll through the same code; retain AWSP's per-device identity, streaming permissions, and revocation |
| TV/movie folders | Companion stores and backs up folders; they are not currently indexed or streamed; AWSP is music-only | Add media inventory and Player browsing/playback over the scoped channel. Direct-play compatible formats; use bounded, on-demand FFmpeg transcoding when needed, with cancellation, concurrency/CPU limits, and no permanent transcode copies. Never return host paths. |
| Companion jobs/tools | Helper supports validated downloads, backup work, and pinned tool provisioning, but these are not one unified remote Player capability | Allow scoped Player job requests/status/output transfer using Companion-configured destinations and the existing allowlisted tools; backup restore/overwrite requires local confirmation. |
| Hub/group playback | Separate Hub identity and pairing; group playback is Hub-gated | Keep separate; do not auto-enable Group mode as a side effect of Companion pairing |

## Acceptance criteria

- One code/address pair completes enrollment for same-PC, LAN, and remote PWA/Android clients; no second ticket/code or helper-token copy/paste is required.
- The same enrolled device can access all enabled Companion media capabilities; remote requests never depend on reaching a loopback address.
- Pairing tests cover success, wrong-code rate limits, expiry, replay, concurrent redemption, device revocation, and active-connection closure.
- Integration tests verify MusicSearch search-only semantics, radio metadata, Live TV/EPG data, music streaming, and TV/movie browse/seek/playback through the appropriate local and remote transports.
- Download jobs use only approved resolvers and Companion-configured destinations; backup jobs use only configured folders; backup restore/overwrite requires local confirmation; tool operations accept only pinned, hash-verified artifacts.
- Player reload preserves the masked pairing state; Forget revokes the Companion device and clears local credentials.
- Logs, diagnostics, UI errors, and URLs contain no enrollment code, helper token, AWSP credential, or absolute media path.
- Group mode remains unavailable without a paired/reachable Hub.
- Companion package and Player build/install are exercised; a mocked test alone does not count as live pairing verification.

## Implementation sequence

1. Define capability contracts, per-device pairing state, and the single enrollment exchange; add threat-model and replay/rate-limit tests.
2. Add Companion code/address lifecycle and device-revocation UI; add Player one-step pairing and protected credential persistence.
3. Add the AWSP control/media/job channel for scoped remote Companion capabilities; keep the helper listener off the public internet.
4. Wire MusicSearch, radio enrichment, and Live TV/EPG through the capability manifest and verify local + remote requests.
5. Add TV/movie inventory, safe streaming/seek, bounded on-demand transcoding, and Player browsing/playback.
6. Add scoped download, backup, and pinned-tool job APIs with configured destinations, progress/output transfer, and local confirmation for restore/overwrite.
7. Run full unit/integration/E2E suites, package/install Companion, and verify actual local, LAN, and remote Player connections and each capability.

## Release constraints

- The vendored MusicSearch upstream has unresolved licensing metadata in the repository; do not publish or redistribute a release until licensing is clarified.
- Docker sidecar startup has had intermittent failures. The MusicSearch capability is not complete until the sidecar integration is repeatably healthy and verified in the packaged Companion.

# Audit bug fixes (all bugs + critical/high security)

Requested 2026-09-16: "fix all bugs as any critical or high security changes", following the full
audit of the player/PWA, Android shell, Windows companion, local helper, hub and Docker image.
Discord voice playback was already fixed earlier the same day (docs/DISCORD_BOT.md).

Out of scope: redesigns (store.ts split, sync change-log, Android playback service), hygiene-only
deletions of root duplicate files.

## Workstreams (disjoint files, run in parallel)

- [x] A. music-player: track-end loop, media-session handler wipe, lock-screen metadata key,
      loadCurrent race, queue remove, shuffle button state, startup blocking, group-client stale
      sockets, SW navigateFallback denylist, AbortError, misc lows.
- [x] B. android + android.yml: NP_BASE_PATH, Jobs.sweep deleting live jobs, file chooser + blob
      downloads, job list races, cancel of queued jobs, foreground-service failures, renderer crash,
      back navigation.
- [x] C. windows-companion: cascade delete, sync paging, deleted playlist items, quit order, CSP,
      navigation guard, prefs partial schema, upload errors/cancel, safeStorage secret, misc.
- [x] D. local-helper: work-dir deletion, Host-header check, Windows process-tree kill, path leak,
      stream error crash, health spawn cost, spotdl config, job cleanup, test portability.
- [x] E. hub security: group membership checks, transfer ownership, Host allowlist, sync isolation,
      WebSocket auth, SSRF hardening, proxy trust, invite reuse, share limits, pairing lockout, CSRF compare.
- [x] F. hub correctness: downloads (timeout, pump, concurrency, cancel race), backup restore,
      Range handling, library scan safety, broadcast-after-commit, admin GUI bugs, misc lows.
- [x] G. build/CI: licenses.mjs + vitest.config.ts Windows paths, Windows CI exit codes, docker.yml
      latest tag, nowplaying backup stops both services, compose healthcheck port, contracts openapi version.

## Progress

- 2026-09-16: baseline snapshot taken; workstreams dispatched.
- 2026-09-16 (F, hub correctness): downloads (atomic claim, N-concurrent runner, per-job abort,
  cancel/pause cannot be overwritten, retry/resume refused while running, recover() starts the
  queue, `downloads.pump` scheduler tick, progress throttled to 4/s, FFmpeg 30 min timeout, header
  vs idle timeouts compatible with new http.ts); backup (audit before close, staged copy + verify,
  rename rollback, `-auto` suffix for scheduled backups, prune auto + safety, keep manual);
  library (416 via RangeNotSatisfiableError, `bytes=-` rejected, multi-range -> full, empty file,
  unreadable root aborts / unreadable sub-dir kept, soft-delete roots + id reuse by path/hash);
  search cursor -> 400; group broadcasts buffered until commit (localSeqs rolled back);
  admin GUI (restore error shown, no reload after restore, stored view validated, useResource
  keyed). New tests: tests/integration/{downloads-queue,library-scan-and-range,
  group-broadcast-after-commit,backup-and-search-cursor}.test.ts. Open for other owners:
  media.ts/shares.ts should set `Content-Range: bytes */size` on 416 and use `stream.partial` for
  200 vs 206; media.ts libraryScan returns an unrelated job id; sync/transfers.ts ~191 no-op
  ternary; downloads resultLocator.hubId still a placeholder (needs hub id passed from app.ts);
  groups-and-queue "refuses a group a device is not a member of" now gets 403 from the new
  membership check but still expects 200.
- 2026-09-16 (D, local-helper): per-run work subdir (mkdtemp) + SIGHUP/SIGBREAK; Host-header
  check (421) + localhost self-origin; spotDL gets a private HOME/USERPROFILE (spotDL has no
  --no-config and auto-loads ~/.spotdl/config.json) and URL behind `--`; empty --only-hosts
  rejected; Windows tree kill (taskkill /T /F), wait for close, rm retries, record always dropped;
  paths redacted from job message/error; read-stream errors handled; tool lookup cached 30s and
  deduped; finished jobs expire after 1h / oldest evicted at cap; bad % escapes → 400; installs
  serialized, unique temp file, refused while jobs run; tests portable (.mjs tools run via node,
  dataDir uses path.win32/posix). tsc, vitest (57 tests), eslint, prettier all pass.
- 2026-09-16 (E, hub security): group reads require membership (admins bypass); transfers grant
  read only to the receiver once the sender proved possession (per-uploader staging, blob
  owner_id, dedupe no longer short-circuits for non-readers, duplicate lookup scoped to sender);
  Host allowlist (421; valid bearer exempt; `NP_ALLOWED_HOSTS`) + Origin/Sec-Fetch-Site on login
  and admin writes; sync scoped by owner (`migrations/0005_sync_owner.sql`, recursive key
  sanitising); WS: handleProtocols never echoes np-auth, group:member scope, session/credential/
  membership re-validation on message + heartbeat, per-connection rate limit; SSRF: IPv6 parsing
  (mapped/compat/NAT64/6to4/Teredo), empty allowlist = deny (`allowAnyHost` opt-in), pinned
  node:http(s) fetch for native fetch, credentials/bodies not forwarded cross-origin, timeout
  covers headers only; trustProxy uses network.isTrustedProxy; invites single-use at repo level;
  share streams honour maxAccesses (grant from counted page view), hub-track shares need
  library:read, http(s)-only source URLs; pairing wrong codes locked out per IP; timing-safe CSRF,
  malformed cookies ignored; share stream 416 Content-Range + partial status. Updated
  groups-and-queue non-member test to expect 403. New tests: tests/security/{group-membership,
  transfer-ownership,host-and-origin,sync-isolation,outbound-http,share-limits}.test.ts.
  Residual: group/service.ts join ignores markInviteUsed's boolean (cross-process race only).
- 2026-09-16 (A, music-player): track end handled once from the engine's `ended` event; media
  action support recorded, never probed by clearing handlers; lock-screen metadata keyed on entry;
  load generations; remove-current reloads; next/prev availability from the store; startup not
  blocked on the hub (10 s request timeout); group-client stale sockets ignored + resync; SW
  denylist for /api and /s; AbortError ignored; misc lows. New tests incl. tests/dom/store.test.ts.
- 2026-09-16 (B, android): NOT COMPILED (no JDK 17/SDK here). NP_BASE_PATH=/assets/app/ in CI and
  docs; SW requests routed through the asset loader; sweep once per process; file chooser + blob
  downloads (BlobDownloads.kt); thread-safe job files; forgotten queued jobs never run; FGS
  failure/onTimeout/POST_NOTIFICATIONS; render-process recovery; back = history or background;
  bridge calls only from the app's own top-level page; mixed content never allowed.
- 2026-09-16 (C, windows-companion): tracks tombstoned (user_version migration drops cascade);
  paged push/pull with cursors; validated remote changes in one transaction; prefs cached, DB
  closed on will-quit; meta CSP; exact-index navigation guard; safeStorage secret; fingerprint
  check gates sync/upload; strict prefs patch schema; real upload cancel; chunked reads; restore
  validation; low items. 90 tests pass.
- 2026-09-16 (G, build/CI): pwsh steps under bash, release-only write permission; licenses.mjs and
  vitest.config.ts use fileURLToPath (LICENSES.md regenerated, 170 packages); OpenAPI draft-2020-12;
  nowplaying backup stops/restarts both services, chowns ./data; compose healthcheck uses NP_PORT,
  discord service env mirrors hub; docker.yml latest only on default branch/tags, smoke test,
  gha cache; ci.yml read-only permissions, format:check, .ci-data chown. eslint.config.js edit was
  blocked by a config-protection hook (needs user approval).
- 2026-09-16 (lead, cross-cutting): invite claim checked inside a transaction in join(); media.ts
  416 Content-Range + partial status; libraryScan job now performs the scan (scheduler
  `sync-library` for provider hub); downloads get the real hub id; signed media URLs
  (`POST /library/stream-urls`, `?sig=` on media routes, bound to path + device credential, 6 h,
  revoked with the device) and the player requests them (`HubClient.streamUrl`). Contracts
  regenerated (120 operations / 98 paths). Full run: workspace typecheck, eslint, prettier clean;
  750/761 tests pass — the 11 failures are install-script.test.ts, which needs a POSIX shell.
- 2026-09-16 (review): independent diff review found two issues, both fixed: Host allowlist now
  also accepts .local/.lan/.home.arpa/.internal names (NP_ALLOWED_HOSTS documented in compose.yaml
  and .env.example); WebSocket rate-limit violations reset every heartbeat. Hub typecheck, tests,
  eslint and prettier re-run clean.

## Verification (for Antigravity)

Not verified here: Android build (no JDK 17/SDK), Docker image build (no Docker), a live Discord
voice session (needs the bot token), real yt-dlp/spotDL runs.

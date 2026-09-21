# AudioWave2.0 — Combined one-shot build prompt

**Target: Claude Code · Opus 5 (reasoning effort: high) or Fable 5 (reasoning effort: medium)**

This merges every AudioWave/Airwave Claude Code prompt written to date: the repo audit fix-pass,
the three missing hub/helper route specs (profiles, group invites, backup space), the Airwave
frontend adoption plan, and the AWSP remote-streaming protocol. Paste everything below the line
into Claude Code at the repo root:

`C:\Users\jalon\projects\AudioWave2.0\AudioWave2.0-claude-now-playing-music-suite-tfzu57`

---

You are finishing the AudioWave2.0 suite (repo `jyoung2000/AudioWave2.0`, branch
`claude/now-playing-music-suite-tfzu57`) in one pass, as six phases. Each phase lands green —
`pnpm verify` plus that phase's own checks — before the next begins, with a reviewable commit per
phase (or per sub-phase where marked). If a later phase would be blocked by an earlier failure,
stop at the last green commit and report what blocked you; never paper over a red gate.

Work through AGENTS.md as always: read `design/manifest.json` first; contracts before servers;
change component, stylesheet, rule, test and coverage ledger together; run `pnpm styleguide:check`,
the named tests, `pnpm styleguide:build` and `pnpm styleguide:pdf` after UI work.

**Sources of truth**

| What | Where | Role |
|---|---|---|
| Three finished frontends | Repo root — `airwave-now-playing.html`, `airwave-companion.html`, `airwave-hub.html` (moved to `design/frontends/` in Phase 0) | Design + interaction target for the three apps (Phase 3) |
| Repo logic | `music-player/src/lib/*`, `windows-companion/src/{main,preload,renderer}`, `docker-container/src/*` | Functional truth — every number shown must come from here |
| Route specs | Phases 1–3 below (baked in verbatim) | Contract truth for the routes the player already calls |
| airwave-np design records | `C:\Users\jalon\projects\airwave-np\design\` (NP-*/NPD-* IDs) | Merge into this repo's `design/ux-rules.json` / `decisions.md` as screens are ported |

---

## Phase 0 — Preflight and repo truth

1. If the working folder has no `.git`: `git init`, add the `jyoung2000/AudioWave2.0` remote, fetch
   `claude/now-playing-music-suite-tfzu57`, then `git reset --mixed origin/claude/now-playing-music-suite-tfzu57`
   so local changes survive as unstaged work. Review the diff; commit the local work first, in
   logical chunks, before anything else. (An earlier audit found 12,600+ unpushed lines here —
   they must not be lost.)
2. The three frontend files sit loose at the repo root. `git mv` (or move + add) them to
   `design/frontends/airwave-now-playing.html`, `design/frontends/airwave-companion.html` and
   `design/frontends/airwave-hub.html`, and commit. Every later reference to a frontend file
   means that folder. Treat them as read-only reference material: Phase 3 ports from them, it
   never edits them.
3. Run `pnpm verify` for a baseline and record what is red. CI was red at last audit; Phase 2
   addresses the known causes, but re-verify each from the current tree rather than trusting the
   audit — the state may have moved.

## Phase 1 — Shared hub/helper routes (contracts first, then servers)

The Now Playing player already calls every route below and falls back with honest messages
("the container doesn't keep profiles yet") until they exist. Build contracts for all three
specs first, then the servers, migrations, tests, admin-GUI views and docs. The player needs no
change. Commit per sub-phase.

### 1A. Profiles on the hub (`docker-container`)

Add **user profiles** so a paired player can keep a username, a picture and shared playlists on
the hub, and find other people's (Settings ▸ Profile, and people results in search).

**Contract** (`packages/contracts/src/api/routes.ts`, all under `/api/v1`, `auth: 'device'`):

| Route | Body / query | Response | Scope |
|---|---|---|---|
| `GET /profiles/me` | — | `ProfileView` | `profile:read` |
| `PATCH /profiles/me` | `{ displayName }` | `ProfileView`; **409** if the name is taken | `profile:write` |
| `GET /profiles/available?name=` | name | `{ available: boolean }` | `profile:read` |
| `PUT /profiles/me/avatar` | raw `image/png`, `image/jpeg` or `image/webp`, ≤ 512 × 512, ≤ 1 MB | `Ok` | `profile:write` |
| `DELETE /profiles/me/avatar` | — | `Ok` | `profile:write` |
| `GET /profiles/:id/avatar` | — | the image, `Cache-Control: private, max-age=300` | `profile:read` |
| `PUT /profiles/me/playlists/:playlistId?name=` | raw `text/csv`, ≤ 2 MB, ≤ 5,000 rows | `Ok` | `profile:write` |
| `DELETE /profiles/me/playlists/:playlistId` | — | `Ok` | `profile:write` |
| `GET /profiles?q=&limit=` | name contains q, case-insensitive, limit ≤ 20 | `{ items: ProfileSummary[] }` (never includes the caller) | `profile:read` |
| `GET /profiles/:id` | — | `ProfileView` | `profile:read` |
| `GET /profiles/:id/playlists/:playlistId.csv` | — | `text/csv; charset=utf-8` | `profile:read` |

```ts
ProfileSummary = { id: Uuid, displayName: DisplayName, avatarUrl: string | null, playlistCount: number }
ProfileView    = { id: Uuid, displayName: DisplayName, avatarUrl: string | null,
                   playlists: { id: string, name: string, tracks: number, updatedAt: IsoDateTime }[] }
```

- `avatarUrl` is the hub-relative path `/api/v1/profiles/:id/avatar`, or null.
- Add `'profile:read'` and `'profile:write'` to `Scope` in `common.ts`, and to the player's default
  pairing scopes in the admin GUI's Devices view.
- A profile belongs to the **HubUser** behind the device credential (`HubUser.displayName` and
  `HubUser.avatar` already exist — reuse them rather than adding a parallel table).

**Rules the server enforces**

- **Usernames are unique** per hub, compared case-insensitively after Unicode NFC normalisation and
  trimming. Enforce with a unique index on the normalised name, not only a check in code, so two
  simultaneous saves can't both win. 3–40 characters: letters, numbers, spaces, `.`, `_`, `-`;
  must start and end with a letter or number. `admin` and names differing from an existing one only
  by case are taken.
- Avatars: verify the bytes are really PNG/JPEG/WebP (magic numbers), re-encode server-side to
  256 × 256 WebP, strip metadata, store in the data volume as a blob (`Avatar.kind = 'image'`).
- Playlists: parse the CSV (header `title,artist,album,seconds`; RFC 4180 quoting), store it
  normalised, serve it back re-serialised — never echo the uploaded bytes. Strip leading `=`, `+`,
  `-`, `@` from cells when serving CSV (spreadsheet formula injection).
- Search and profile reads only for paired devices with `profile:read`; no anonymous access. The
  first-run gate applies: nothing works until the admin password is changed.
- Rate-limit writes like other device writes; log with the configured IP logging mode.

**Server, storage, tests**

- Migration: `profile_playlists (user_id, playlist_id, name, csv, tracks, updated_at)`, PK
  `(user_id, playlist_id)`; unique index on `lower(normalised display_name)`.
- `docker-container/src/profiles/service.ts` + routes in `src/api/routes/profiles.ts`.
- Include avatars and profile playlists in `./nowplaying backup` / Backup ▸ Export.
- Integration tests: name uniqueness (including a race of two PATCHes), 409 body, avatar type
  sniffing and re-encoding, CSV round-trip with quoted commas, formula-cell stripping, scope
  checks, search excludes the caller, first-run gate.
- Admin GUI: a **Profiles** view under Hub (name, picture, playlist count, last change) with
  Rename and Remove picture for moderation.
- Docs: routes in `docs/API.md`; a line in `docs/PRIVACY.md` saying profiles are visible to every
  device paired with the same hub.

### 1B. Group invites people can see, answer and withdraw (`docker-container`)

The hub can already create groups, make a single-use expiring invite code, join with a code, and
leave. Four things are missing: seeing what an invite is for before joining; invites addressed to
a person (appearing in their Profile tab without link-copying); recording a decline; listing and
withdrawing codes.

**Contract** (`packages/contracts/src/api/routes.ts`, all under `/api/v1`):

| Route | Auth · scope | Body / query | Response |
|---|---|---|---|
| `POST /groups/:groupId/invites` (extend) | as today | add optional `toProfileId: Uuid` | add `inviteId: Uuid`, `toProfileId: Uuid \| null` |
| `GET /groups/:groupId/invites` | admin-or-device · `group:admin` | — | `{ items: InviteView[] }`, newest first, last 30 days |
| `DELETE /groups/:groupId/invites/:inviteId` | admin-or-device · `group:admin` | — | `Ok`; the code stops working immediately |
| `GET /groups/invites/preview?code=` | device · `group:member` · rate limit `pairing` | code | `{ groupName, memberCount, fromName, role, expiresAt }`; 404 if unknown, used or expired |
| `GET /me/invites` | device · `group:member` | — | `{ items: { inviteId, groupId, groupName, fromName, role, expiresAt }[] }`, only unanswered ones addressed to the caller's profile |
| `POST /me/invites/:inviteId/accept` | device · `group:member` | — | `GroupView` (same effect as join) |
| `POST /me/invites/:inviteId/decline` | device · `group:member` | — | `Ok` |

```ts
InviteView = { inviteId: Uuid, role: GroupRole, createdBy: string, createdAt: IsoDateTime,
               expiresAt: IsoDateTime, toProfileId: Uuid | null, toName: string | null,
               state: 'open' | 'used' | 'expired' | 'withdrawn' | 'declined',
               usedBy: string | null, answeredAt: IsoDateTime | null }
```

**Server**

- Migration adds `to_profile_id`, `withdrawn_at`, `declined_at`, `created_by_name` to the invites
  table. `purgeInvites` keeps rows 30 days after they close so the list can show them.
- A directed invite still has a code, but only the addressed profile can use it: `join` with a
  directed code from another device returns 403.
- The preview never reveals the member list, only the count; rate-limited like `join` so it can't
  guess codes.
- Audit log records `invite.create`, `invite.withdraw`, `invite.accept`, `invite.decline`.

**Tests**

- Directed invite: addressee sees it in `/me/invites` and can accept; someone else gets 403.
- Decline removes it from `/me/invites` and shows `declined` in the group's list.
- Withdraw makes the code fail with 403 and shows `withdrawn`.
- Preview returns 404 for used, expired and withdrawn codes.
- Every route answers 403 without its scope.

**Link format the player understands** (a fragment — none of it reaches any server; the player
strips it from the address bar as soon as it has read it):

`<player address>#invite/<CODE>?hub=<hub base URL>&g=<group name>&from=<sender>&r=<role>&x=<expiresAt>`

### 1C. Backup size and free space (`local-helper` + `docker-container`)

Settings ▸ Sources ▸ Backup shows how big the next backup will be and how much room each backup
location has. The player computes playlists/settings/algorithms itself; it asks these routes for
folder and disk numbers.

**Companion helper** — add to `HELPER_ROUTES` in `packages/contracts/src/api/local-helper.ts`:

`GET /helper/v1/backup/estimate?parts=music,tv,movies` — needs `x-helper-token` like every route
except health.

```ts
HelperBackupEstimate = {
  parts: Partial<Record<'music' | 'tv' | 'movies', { bytes: number; files: number; measuredAt: IsoDateTime }>>,
  destination: { path: string; freeBytes: number | null; totalBytes: number | null } | null,
}
```

- Each part is the recursive size of the folder the companion is set to use for it. Skip symlinks;
  count each hard link once. Cache 10 minutes per folder. Stop after 20 s and return the parts
  measured so far; leave out any part that timed out — never report it as 0.
- `destination` is the companion's backup folder, measured with `fs.statfs` (on Windows, its
  drive). No folder set → `null`. `parts` accepts only `music`, `tv`, `movies`; anything else 400.
- Tests: two parts in a temp folder incl. one hard link; missing folder left out; timeout returns
  what it has; 401 without the token.

**Hub** — `GET /api/v1/backup/space`, `auth: 'admin-or-device'`, new scope `backup:read` (given to
players by default):

```ts
BackupSpace = { path: string; freeBytes: number | null; totalBytes: number | null;
                lastArchiveBytes: number | null; keep: number | null }
```

- `path` is the configured backup directory (default `/data/backups`), measured with the
  `diskUsage()` helper `api/routes/media.ts` already has — move it to a shared module, don't copy.
- `lastArchiveBytes` = newest archive's size. Device callers never see a host path outside
  `/data`: return `path: 'host folder'` in that case.
- Tests: admin gets numbers; device without `backup:read` gets 403; missing directory returns
  nulls, not 500.

**Player behaviour** (already built): expected size = companion parts + player's own figures;
per-destination bar (used · this backup · free after it); Back Up Now disabled when it doesn't
fit, reason shown. Decimal units (1 GB = 10⁹ bytes).

## Phase 2 — Fix-pass: audited defects

A full audit (2026-09-20, 883 tests passing at the time) confirmed six high-severity defects.
**Re-verify each against the current tree before fixing** — write or run a failing test first,
then fix, then keep the test:

1. **Broken audio worklet in the served single-file build** — the worklet the served build loads
   fails; playback in the served artifact is degraded relative to the dev build.
2. **Pitch shifter clicks on upward shifts** — audible discontinuities when shifting pitch up;
   verify with a rendered-output measurement, not by ear.
3. **Broken share-page artwork** — artwork on the share page does not load/render.
4. **Zombie process after backup restore** — the restore path leaves a process running that is
   never reaped; verify with a process-table check in the restore test.
5. **Unpushed local work** — handled in Phase 0; confirm nothing of the 12,600+ local lines was
   lost before this phase closes.
6. **Red CI gate** — after 1–5, the full gate must be green; fix any remaining CI-only failures
   (environment pins, Playwright/Chromium shims) rather than skipping them.

## Phase 3 — Adopt the Airwave frontends as the product's real UIs

The three finished frontends in `design/frontends/` (placed there in Phase 0) become the UIs of
this repo's three apps.

**Ground rules**

1. **The new frontends are the design source of truth.** Where a repo view and a new frontend
   disagree on layout, controls, or copy, the new frontend wins. Where the new frontend has no
   answer (an admin-only detail it never showed), keep the repo's behaviour and restyle it.
2. **The repo's logic is the functional source of truth.** The frontends simulate data (sample
   libraries, fake devices, `say('Mockup — nothing happens.')`). None of that simulation survives:
   every number shown must come from the real store, IPC bridge, or API. Delete the mockup banners
   and the "(Mockup — nothing happens.)" suffix wherever a control now does the thing.
3. **Honesty holds.** The frontends never claim what hasn't happened ("Requested", never "backed
   up"; "Ready" only after the destination answered). Keep that voice when wiring real calls.
4. **Design records merge, they don't fork.** airwave-np's rules and decisions are prefixed
   NP-*/NPD-* precisely so they can join this repo's `design/ux-rules.json` and
   `design/decisions.md` without collisions. Import the NP rules a screen relies on when you port
   that screen, with their evidence pointed at this repo's tests.
5. **Tokens:** each HTML file's `:root` custom properties are its token set (light + two dark
   lists). Fold them into `packages/aqua-ui/src/styles/tokens.json` under the existing
   conventions rather than leaving three private palettes. A collision with an existing aqua-ui
   token keeps the aqua-ui name.

### 3A. The music player (`music-player`) ← `airwave-now-playing.html`

The file was built to become this player and already speaks this repo's protocols: pairing
(`/pairing/claim|status|complete`), device bearer `credentialId.secret`, groups (`/groups`,
invites, join, leave), the companion helper (`/helper/v1/health`, port scan 17342–17345,
`x-helper-token` from the `np-helper-token` meta), and `/healthz`/`/readyz`/`/api/v1/hub`.

- Adopt the file as the player's shell. Two acceptable shapes — pick one and say why in the PR:
  (a) serve it as-is (dependency-free except the three.js import map) and move the remaining
  React logic behind the `window.*` seams it already defines (`window.kv`, `window.COMPANION`,
  `window.hubPeople`, `window.setOutputVolume`, `window.connState`, the `library:play` /
  `transport:next` / `toolbar:change` events), or (b) port its markup + CSS into the Vite app and
  drive it from `src/lib`. (a) is less risk: the file has 21 Playwright suites in airwave-np.
- Replace its simulated library/playback with `src/lib/library.ts`, `playback.ts`,
  `crossfade.ts`, `db.ts` (its `window.kv` shim maps onto the existing db module), and its search
  with the real `platforms.ts`/`fetch-helper.ts` flows.
- Its Settings already cover Statistics, Recommendations (algorithm editor), Sources ▸
  Connections/Backup, Player, Equalizer (with default volume), and Profile (groups + invites).
  Wire each pane to the real client (`hub-client.ts`, `group-client.ts`) instead of its direct
  `fetch` where a client exists; keep its connection log.
- The routes it calls that didn't exist are Phase 1's work — by this phase they are real. Wire
  the panes to them; do not stub fake success anywhere Phase 1 is incomplete.
- Port the airwave-np test suites (`C:\Users\jalon\projects\airwave-np\tests\*.mjs`, runner
  `tests\run.mjs` — still in the airwave-np folder, not this repo) into this repo's
  Playwright setup so the shell keeps its coverage; keep `music-player`'s own tests for the
  logic layer.

### 3B. The Windows companion (`windows-companion`) ← `airwave-companion.html`

The mockup contributes markup, CSS and interaction patterns; its data layer is sample arrays.
The Electron renderer keeps its bridge.

- Rebuild `src/renderer` (App, views: Library → Library tab, Hub/Transfers → Remote,
  Folders/Backup/About → Settings, plus the mockup's Live TV tab) on the mockup's structure:
  Snow Leopard window chrome, matte push buttons, Aqua checkboxes/pop-ups, gel scrollbar, status
  line at the foot. Extract the mockup's CSS into the renderer stylesheet (tokens per ground rule
  5); the markup becomes the views' JSX.
- Every figure goes through `src/preload`'s bridge to `src/main`: downloader status
  (yt-dlp/spotdl/ffmpeg presence and versions — main can reuse `local-helper`'s tool resolution),
  folders and the watcher, transfers with real progress, hub pairing state from `main/hub.ts`.
- Backup: the mockup shows path picker, what-to-include (incl. Recommendation algorithms),
  schedule, keep-count, expected size, and drive free space with a used/this-backup/free bar.
  Implement it for real in `src/main`: measure folders (recursive size, hard links once, cached),
  `statfs` on the backup drive, write the archive, list restorable backups. Expose the same
  measurement through the helper route from Phase 1C so the player's numbers agree with the
  companion's.
- Keep the mockup's gating honesty: a missing downloader shows amber and says what to install;
  nothing reports "Ready" it hasn't verified.

### 3C. The hub admin GUI (`docker-container/src/web`) ← `airwave-hub.html`

The current `src/web` views already have real data flows via `lib/api.ts` — keep those, replace
the presentation.

- Rebuild App + views on the mockup's window: Overview tiles, Devices (pairing codes +
  fingerprint confirm), Music (library, providers with capability rows, downloads/jobs, Live TV
  playlists), Groups, Sharing (+ Discord bot), System (network, what-works-where, Backup, log).
  Map the existing views (Overview, Devices, Library, Providers, Downloads, Groups, Shares,
  Discord, Network, Backup, Diagnostics, Recommendations) into those six tabs; Recommendations
  content joins Music or System — don't drop it.
- The mockup's password gate is real here: it's the existing first-run admin-password flow,
  restyled. Everything `data-gated` stays disabled until the server says setup is done.
- Groups tab: the mockup adds New Group and a per-group Invites section (TTL, role, Make Invite
  Link with the `#invite/CODE?hub=…&g=…&from=…` link format, code table with Withdraw). Wire
  create/invite to the real routes; list/withdraw/preview are Phase 1B's routes.
- Backup: real `/backup` routes plus Phase 1C's `/backup/space`; the free-space bar distinguishes
  the data volume from a mounted `/backups` host folder, as the mockup does.
- Keep the log pane reading the real log stream, and the status line reading real bind/port
  state.

## Phase 4 — AWSP: AudioWave Streaming Protocol

Direct, NAT-traversing, high-fidelity audio streaming from the **Windows companion** (library
holder / server) to the **music player clients** on **Android (native)**, **iOS (native)**, and
**PWA (browser)** — seamless with the screen off and while roaming Wi-Fi ↔ mobile data. No
traffic goes through the Docker container. Read the existing repo structure and integrate — do
not scaffold a parallel app. Complete, runnable code, not sketches.

### 4.0 Transport foundation

Use **iroh** (https://github.com/n0-computer/iroh, the library behind `n0-computer/dumbpipe`):

- Devices dial by **EndpointId** (ed25519 public key), not IP. Iroh performs QUIC hole punching
  for a direct connection and falls back to the n0 relay only when punching fails; connections
  are end-to-end encrypted QUIC.
- **Windows companion**: embed iroh via the Rust crate (preferred, small sidecar/service crate)
  or `@number0/iroh` if staying in Electron/Node. Persist the `SecretKey` to disk on first run so
  the EndpointId — and the pairing ticket — is stable forever.
- **Android**: iroh Kotlin bindings from `n0-computer/iroh-ffi`.
- **iOS**: iroh Swift bindings from `n0-computer/iroh-ffi` (SwiftPM / xcframework).
- **PWA**: browsers cannot hole punch. Use iroh's browser/WASM build, which connects via the
  relay over WebSocket — still end-to-end encrypted, same protocol, same EndpointId. Verify the
  current state of iroh browser support before implementing; if not viable, implement §4.6's
  fallback.
- Study `dumbpipe/src/main.rs` for canonical patterns: `Endpoint::builder(presets::N0)
  .secret_key(k).alpns(...)`, `EndpointTicket::new(endpoint.addr())`, `connect(addr, ALPN)` →
  `open_bi()`, bidirectional copy loops. Reuse the ticket concept for pairing.

ALPN: `awsp/1`.

### 4.1 Protocol spec (write `docs/AWSP.md` first, then implement to it)

One QUIC connection per client, carrying:

**Control stream** (one long-lived bidi stream, opened by client immediately after connect):
- Length-prefixed JSON messages `{id, type, seq, payload}`.
- Client→server intents: `hello {device_name, client_kind, protocol_version, resume_token?}`,
  `play {track_id, offset_ms}`, `pause`, `seek {ms}`, `next`, `prev`, `set_queue {track_ids}`,
  `browse {path|query, page}`, `get_artwork {track_id, size}`, `prefetch {track_id}`,
  `report {buffer_ms, throughput_kbps, dropouts}`.
- Server→client: `state {playing, track_id, position_ms, queue, volume}` (pushed on every change
  + every 5 s), `library_delta`, `error`, `pong`.
- The **server is authoritative** for queue/state; clients render state and send intents.
  Heartbeat ping/pong every 5 s; client reconnects with exponential backoff (250 ms → 30 s),
  requests a full `state` snapshot and resumes the audio stream at its last contiguous byte
  offset via `resume_token`.

**Audio stream(s)** (client opens a new bidi stream per fetch):
- Request `{track_id, byte_start, byte_end|null, tier}` — HTTP-Range semantics, so seek = new
  range request, instant.
- Response: 16-byte header `{track_id_hash, total_len, codec, tier}` then raw file bytes. The
  server never transcodes on the `lossless` tier — it streams the original FLAC/ALAC/MP3 bytes.
- **Tiers**: `lossless` (source bytes, default), `high` (Opus 256k), `saver` (Opus 128k).
  Client-side ABR (native clients only — the PWA never switches tiers): measure delivered vs
  consumed bytes over a 10 s window; if sustained throughput < 1.2× source bitrate, request
  subsequent ranges at `high` and notify the UI; return to `lossless` after 60 s of headroom.
  Server implements Opus tiers with `ffmpeg`/`libopus`, caching transcoded segments on disk keyed
  by `(track_id, tier)`.
- **Buffering (all clients)**: target 20 s buffered, low-water 5 s (pause fetch loop above
  target, resume below); prefetch first 30 s of the next queued track when the current one has
  < 45 s remaining. Control and audio are separate QUIC streams so a control message never waits
  behind audio.

**Pairing**: server displays ticket string + QR (ticket = EndpointId + relay URL, like dumbpipe's
`EndpointTicket`). Client scans/pastes once, stores it plus its own device keypair; server keeps
an allowlist of paired client EndpointIds and rejects unknown ids (`connection.remote_id()`
against the allowlist before accepting streams).

### 4.2 Windows companion (server)

- Long-running service inside the existing companion app: iroh endpoint + library indexer (walk
  configured music folders, extract tags/duration/artwork, SQLite index) + the AWSP handlers.
- Each accepted connection spawns tasks; each audio-range request is served from file with
  backpressure (respect QUIC stream flow control; never read the whole file into memory).
- Settings UI additions: music folders, pairing screen (ticket + QR + paired-devices list with
  revoke), per-device tier cap, optional port pin.
- Autostart with Windows (tray icon); survive sleep/wake by rebinding the endpoint on
  network-change events.

### 4.3 Android client (native, Kotlin)

- **Media3 `MediaSessionService`** foreground service (`mediaPlayback` type) owns the iroh
  endpoint, the AWSP client, the buffer, and an **ExoPlayer with a custom `DataSource`** reading
  from the AWSP buffer (FLAC decode, gapless, audio focus come free from Media3).
- Screen-off: partial wakelock only while playing; on pause, 10-min grace timer, then let the
  connection idle and release the wakelock — reconnect on notification/media-button action
  (target < 1.5 s to audio). Detect Doze (`isDeviceIdleMode`) and surface a one-time prompt to
  exempt from battery optimization.
- Roaming: rely on QUIC connection migration for Wi-Fi ↔ 5G; the 20 s buffer absorbs the
  migration gap. Register a `NetworkCallback`, probe on network change; if migration fails,
  silent reconnect + range-resume with zero user-visible interruption.
- Media notification with artwork, lockscreen/Bluetooth controls via MediaSession, Android
  Auto-safe metadata.

### 4.4 iOS client (native, Swift)

- `AVAudioEngine`/`AVAudioPlayerNode` (or AVPlayer with a custom
  `AVAssetResourceLoaderDelegate` reading from the AWSP buffer). Enable the **`audio` background
  mode** so playback + its fetches continue with the screen off — the supported path; no
  location/other hacks.
- On pause/screen-off iOS suspends the app after a short window: persist playback state +
  `resume_token`, let the connection die, reconnect on foreground/remote-command (Control
  Center, AirPods) via `MPRemoteCommandCenter`.
- `MPNowPlayingInfoCenter` for lockscreen metadata/artwork; handle interruptions (calls, Siri)
  and route changes (headphones unplugged → pause).
- Same buffering/ABR/migration rules as Android.

### 4.5 PWA client — lossless, no quality tiers

- Same AWSP protocol over the iroh WASM/browser transport (relay-carried, e2e-encrypted).
- The PWA is lossless-only: raw FLAC with Range support, plus on-demand FLAC-fMP4 HLS segmented
  via ffmpeg (`-c:a flac -f hls -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4`).
  Safari plays the FLAC HLS natively; Chromium uses progressive/MSE. **Never use hls.js on
  Safari** — it cannot play lossless FLAC HLS. A service-worker bridge carries the AWSP
  transport under the media element.
- Screen-off reality (document honestly in the README): with an actively playing `<audio>`/MSE
  element, mobile browsers keep audio + network alive with the screen off; on iOS Safari the PWA
  is still subject to suspension when paused, and it cannot hole punch — the PWA is the
  "works anywhere, relay-carried" tier; native apps are the direct tier.
- Media Session API for lockscreen controls + artwork; do **not** request a Wake Lock for audio.

### 4.6 Fallback + verification

- If iroh's browser build is unusable at implementation time: a tiny WebSocket bridge **inside
  the Windows companion** (not the Docker container) speaking AWSP over WSS on a local port,
  reachable via the user's Tailscale tailnet from the PWA. Behind a settings toggle, off by
  default.
- Deliverables before this phase closes: `docs/AWSP.md`; server + all three clients building; an
  integration test that streams a 24/96 FLAC through two NAT-simulated iroh endpoints
  (`n0-computer` netsim tooling) and asserts zero gaps across a 3 s induced path outage; an
  automated **bit-identity test** proving the lossless path delivers byte-identical audio; a
  `TESTING.md` with the manual matrix (Wi-Fi→5G mid-song, screen off 30 min while playing, pause
  15 min → resume, relay-only forced mode via env var, PWA on iOS Safari + Chrome Android).
- Log connection type (direct vs relay-carried) at INFO on both sides and surface it as a small
  indicator in each client's now-playing UI.

Constraints: no third-party accounts, no Docker-container involvement, no plaintext anywhere;
all secrets (server SecretKey, client keypairs, allowlist) stored with OS-appropriate protection
(DPAPI / Android Keystore / iOS Keychain / IndexedDB+WebCrypto for PWA). Commit in reviewable
increments: spec → server → Android → iOS → PWA → tests.

## Phase 5 — Final verification

- `pnpm verify`, `pnpm styleguide:check`, `pnpm styleguide:build`, `pnpm styleguide:pdf` all
  green; full CI gate green.
- Player: the ported airwave-np suites pass against the real apps (hub + helper running in the
  test harness, as the existing e2e setup does).
- One end-to-end pass, scripted: pair player↔hub, pair companion↔hub, create a group in the hub
  GUI, make an invite link, open it in the player, join; send a directed invite, see it in the
  addressee's Profile tab, decline it, see `declined` in the group list; set a profile name
  (uniqueness enforced); run a backup from the companion with the size/space numbers agreeing
  with the player's Backup pane; stream one FLAC over AWSP with a forced relay-only leg.
- Grep for leftovers: no "Mockup", "nothing happens", `H.groups`-style sample arrays, or
  `BK_DISK` fixtures in shipped code.

## Sequencing and stop points

Phase order is dependency order: 0 (truth) → 1 (routes all UIs need) → 2 (working logic to wire
onto) → 3 (UIs) → 4 (streaming) → 5 (gate). Each phase's commit is a safe stopping point; if the
run must be split, stop after Phase 3 — Phases 0–3 are one coherent product, Phase 4 is the
next one.

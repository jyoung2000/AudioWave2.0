# Claude Code prompt — make the Airwave frontends the product's real UIs (AudioWave2.0)

Paste this into Claude Code at the root of the AudioWave2.0 repo
(`C:\Users\jalon\projects\AudioWave2.0\AudioWave2.0-claude-now-playing-music-suite-tfzu57`).

---

Three finished frontends live in `C:\Users\jalon\projects\airwave-np\deliver\`. They are the design
and interaction targets for this repo's three apps, and this task wires each one to the real
functionality this repo already has:

| New frontend | Becomes the UI of | Real functionality today |
|---|---|---|
| `airwave-now-playing.html` | `music-player` (the Airwave music player) | `music-player/src/lib/*` — playback, crossfade, library, db, hub-client, group-client, fetch-helper, discover, media-session |
| `airwave-companion.html` | `windows-companion` (the Windows app) | Electron `src/main/*` (hub, library, watcher, store) through `src/preload` → `src/renderer` |
| `airwave-hub.html` | `docker-container` admin GUI (`src/web`) | `src/web/lib/api.ts` against the real `/api/v1` admin routes |

Work through AGENTS.md as always: read `design/manifest.json` first; contracts before servers;
change component, stylesheet, rule, test and coverage ledger together; run `pnpm styleguide:check`,
the named tests, `pnpm styleguide:build` and `pnpm styleguide:pdf` after UI work; `pnpm verify`
before finishing. This is large — do it as the phases below, each one landing green before the next.

## Ground rules

1. **The new frontends are the design source of truth.** Where a repo view and a new frontend
   disagree on layout, controls, or copy, the new frontend wins. Where the new frontend has no
   answer (an admin-only detail it never showed), keep the repo's behaviour and restyle it.
2. **The repo's logic is the functional source of truth.** The new frontends simulate data
   (sample libraries, fake devices, `say('Mockup — nothing happens.')`). None of that simulation
   survives: every number shown must come from the real store, IPC bridge, or API. Delete the
   mockup banners and the "(Mockup — nothing happens.)" suffix wherever a control now does the thing.
3. **Honesty holds.** The new frontends never claim what hasn't happened ("Requested", never
   "backed up"; "Ready" only after the destination answered). Keep that voice when wiring real calls.
4. **Design records merge, they don't fork.** airwave-np's rules and decisions are prefixed NP-*/
   NPD-* precisely so they can join this repo's `design/ux-rules.json` and `design/decisions.md`
   (its own DEC/UX IDs) without collisions — that was NPD-013's point. Import the NP rules a screen
   relies on when you port that screen, with their evidence pointed at this repo's tests.
5. **Tokens:** each HTML file's `:root` custom properties are its token set (light + two dark
   lists). Fold them into `packages/aqua-ui/src/styles/tokens.json` under the existing conventions
   rather than leaving three private palettes. A collision with an existing aqua-ui token keeps the
   aqua-ui name.

## Phase 1 — the music player (`music-player`)

`airwave-now-playing.html` was built to become this player (its repo says so), and it already
speaks this repo's protocols: pairing (`/pairing/claim|status|complete`), device bearer
`credentialId.secret`, groups (`/groups`, invites, join, leave), the companion helper
(`/helper/v1/health`, port scan 17342–17345, `x-helper-token` from the `np-helper-token` meta), and
`/healthz`/`/readyz`/`/api/v1/hub`.

- Adopt the file as the player's shell. Two acceptable shapes — pick one and say why in the PR:
  (a) serve it as-is (it is dependency-free except the three.js import map) and move the remaining
  React logic behind the `window.*` seams it already defines (`window.kv`, `window.COMPANION`,
  `window.hubPeople`, `window.setOutputVolume`, `window.connState`, the `library:play` /
  `transport:next` / `toolbar:change` events), or (b) port its markup + CSS into the Vite app and
  drive it from `src/lib`. (a) is less risk: the file has 21 Playwright suites in airwave-np.
- Replace its simulated library/playback with `src/lib/library.ts`, `playback.ts`, `crossfade.ts`,
  `db.ts` (its `window.kv` shim maps onto the existing db module), and its search with the real
  `platforms.ts`/`fetch-helper.ts` flows.
- Its Settings already cover Statistics, Recommendations (algorithm editor), Sources ▸ Connections/
  Backup, Player, Equalizer (with default volume), and Profile (groups + invites). Wire each pane to
  the real client (`hub-client.ts`, `group-client.ts`) instead of its direct `fetch` where a client
  exists; keep its connection log.
- Three route sets it calls don't exist yet. Implement them from the specs already in
  `C:\Users\jalon\projects\airwave-np\docs\`: `hub-profiles.md` (profiles, unique usernames,
  avatars, shared-playlist CSV), `hub-group-invites.md` (invite preview, directed invites, decline,
  list/withdraw), `backup-space.md` (`/helper/v1/backup/estimate`, `/api/v1/backup/space`). Until
  each lands, the player's built-in fallbacks already say the container "doesn't keep profiles yet"
  etc. — don't stub fake success.
- Port the airwave-np test suites (`tests/*.mjs`, runner `tests/run.mjs`) into this repo's Playwright
  setup so the shell keeps its coverage; keep `music-player`'s own tests for the logic layer.

## Phase 2 — the Windows companion (`windows-companion`)

`airwave-companion.html` is a mockup: markup, CSS and interaction patterns to adopt; its data layer
is sample arrays. The Electron renderer keeps its bridge.

- Rebuild `src/renderer` (App, views: Library → Library tab, Hub/Transfers → Remote, Folders/Backup/
  About → Settings, plus the mockup's Live TV tab) on the mockup's structure: Snow Leopard window
  chrome, matte push buttons, Aqua checkboxes/pop-ups, gel scrollbar, status line at the foot.
  Extract the mockup's CSS into the renderer stylesheet (tokens per ground rule 5); the markup
  becomes the views' JSX.
- Every figure goes through `src/preload`'s bridge to `src/main`: downloader status (yt-dlp/spotdl/
  ffmpeg presence and versions — main can reuse `local-helper`'s tool resolution), folders and the
  watcher, transfers with real progress, hub pairing state from `main/hub.ts`.
- Backup: the mockup shows path picker, what-to-include (incl. Recommendation algorithms), schedule,
  keep-count, expected size, and drive free space with a used/this-backup/free bar. Implement it for
  real in `src/main`: measure folders (recursive size, hard links once, cached), `statfs` on the
  backup drive, write the archive, list restorable backups. Expose the same measurement through the
  helper route from `backup-space.md` so the player's numbers agree with the companion's.
- Keep the mockup's gating honesty: a downloader that's missing shows amber and says what to install;
  nothing reports "Ready" it hasn't verified.

## Phase 3 — the hub admin GUI (`docker-container/src/web`)

`airwave-hub.html` is the target for the admin GUI. The current `src/web` views already have real
data flows via `lib/api.ts` — keep those, replace the presentation.

- Rebuild App + views on the mockup's window: Overview tiles, Devices (pairing codes + fingerprint
  confirm), Music (library, providers with capability rows, downloads/jobs, Live TV playlists),
  Groups, Sharing (+ Discord bot), System (network, what-works-where, Backup, log). Map the existing
  views (Overview, Devices, Library, Providers, Downloads, Groups, Shares, Discord, Network, Backup,
  Diagnostics, Recommendations) into those six tabs; Recommendations content joins Music or System —
  don't drop it.
- The mockup's password gate is real here: it's the existing first-run admin-password flow, restyled.
  Everything `data-gated` stays disabled until the server says setup is done.
- Groups tab: the mockup adds New Group and a per-group Invites section (TTL, role, Make Invite
  Link with the `#invite/CODE?hub=…&g=…&from=…` link format, code table with Withdraw). Wire create/
  invite to the real routes; list/withdraw/preview come from `hub-group-invites.md` — build those
  routes in the same phase so the table isn't decorative.
- Backup: real `/backup` routes plus the new `/backup/space`; the free-space bar distinguishes the
  data volume from a mounted `/backups` host folder, as the mockup does.
- Keep the log pane reading the real log stream, and the status line reading real bind/port state.

## Verification

- `pnpm verify`, `pnpm styleguide:check`, `pnpm styleguide:build`, `pnpm styleguide:pdf` all green.
- Player: ported suites pass against the real apps (hub + helper running in the test harness, as
  the existing e2e setup does).
- One end-to-end pass, scripted: pair player↔hub, pair companion↔hub, create a group in the hub GUI,
  make an invite link, open it in the player, join; set a profile name (uniqueness enforced); run a
  backup from the companion with the size/space numbers agreeing with the player's Backup pane.
- Grep for leftovers: no "Mockup", "nothing happens", `H.groups`-style sample arrays, or
  `BK_DISK` fixtures in shipped code.

## Sequencing note

Phases are independent enough to land as separate PRs (player; companion; hub GUI), but the shared
route work (`hub-profiles.md`, `hub-group-invites.md`, `backup-space.md`) underpins all three — do
contracts + server for those first if you want the three UI phases to wire against real routes from
day one.

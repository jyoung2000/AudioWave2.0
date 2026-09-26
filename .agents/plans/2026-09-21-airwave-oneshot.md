# The combined one-shot build — record of the first pass (2026-09-21)

Prompt: `docs/audiowave-oneshot-master-prompt.md`. Branch: `claude/airwave-oneshot-build`, cut from
`claude/now-playing-music-suite-tfzu57` at `b454b53`.

**Where it stopped: after Phase 2, green, with the functional half of Phase 3C done.** Phases 3A, 3B,
the presentation half of 3C, 4 and 5 are not started. Nothing below claims otherwise.

## What was measured

`pnpm verify` at the last commit: every gate PASS, `docker-build` SKIPPED (no Docker daemon on this
machine, reported as skipped and not as passed). 422 unit · 100 DOM · 161 contract · 215 integration ·
117 security tests; Playwright 64 player + 22 hub + 16 aqua-ui e2e, 9 + 9 a11y, 5 local-file.

Baseline before any change: one red gate, `format`, and only because Prettier was checking the
per-machine `.claude/settings.local.json`. `.claude` is now in `.prettierignore`.

## Phase 0 — done

- `.git` was already present and the earlier local work was already committed: 12 commits ahead of
  `origin/claude/now-playing-music-suite-tfzu57`. **They are not pushed.** Pushing publishes; it was
  not asked for, so it was not done. `git push -u origin claude/airwave-oneshot-build` carries them.
- The three frontends moved to `design/frontends/` and were committed untouched.

## Phase 1 — done (contracts → servers → tests → GUI → docs)

1A profiles, 1B invites, 1C backup space. 29 hub integration tests and 6 helper tests, plus two hub
e2e tests through the real GUI. Decisions worth knowing:

- **The unique index is on a new column, not on `display_name`.** `hub_users.display_name` starts as
  the device name from pairing, and two people can both be "Chrome on Windows"; a unique index there
  would fail the migration on any hub that already has devices. `profile_name_key` holds the
  NFC-normalised, lower-cased name, NULL until someone picks one. A device name is not reserved.
- **Names are composed to NFC in the contract, before validation.** "e" + combining diaeresis is not
  a letter to `\p{L}`; the first test run caught the decomposed form being refused as malformed
  instead of answered with 409.
- **Pictures are re-encoded with FFmpeg** (already in the image), since the hub has no image
  library. A hub without a WebP encoder answers 503 and stores nothing. They live in a SQLite BLOB
  table so the one online backup carries them; the JSON export carries them as base64.
- **Backup directory is configurable** (`NP_BACKUP_DIR`), because "a host path outside `/data`" could
  not otherwise exist. `diskUsage()` moved to `src/disk-usage.ts`.
- **The helper does not know the companion's folders**; they are options (`--music-dir`, `--tv-dir`,
  `--movies-dir`, `--backup-dir`, or `startHelper({ backup })`). `local-helper/src/measure.ts` is
  written to be imported by the companion's main process in 3B so the two agree by construction.
- The CSV rule follows the prompt — *strip* a leading `= + - @` — which differs from the history
  export's existing rule (prefix a quote). Both are safe; they are not the same.

## Phase 2 — re-verified, one gap closed

| # | Defect | State in this tree | Evidence |
|---|---|---|---|
| 1 | Worklet in the served build | fixed in the 09-20 pass | `music-player/tests/e2e/worklet.spec.ts`, `local-file.spec.ts` |
| 2 | Pitch shifter clicks upward | fixed in the 09-20 pass | `packages/audio-core/tests/unit/pitch-shifter.test.ts` (discontinuity measured) |
| 3 | Share-page artwork | fixed in the 09-20 pass | `docker-container/tests/security/share-limits.test.ts` |
| 4 | Process left after restore | fixed, but only an injected `exit()` was tested | **new:** `tests/integration/restore-process-exit.test.ts` runs the real entry point, restores, and asks the OS — exit 0, pid gone, port free |
| 5 | Unpushed local work | committed, not pushed (see Phase 0) | `git log origin/…..HEAD` |
| 6 | Red gate | green | table above |

Phase 1 itself cost two gates, both fixed: the single-file `now-playing.html` had to be rebuilt, and
the player's first load crossed its 656KB budget by 1KB because the route table ships in it. The
budget is 658KB now with the reason written beside it.

## Phase 3 — only the functional half of 3C

Done, in the current GUI's style: **Profiles** view (rename, remove picture), **New Group**,
per-group **Invites** (works-for, joins-as, Make Invite Link in the `#invite/CODE?hub=…` format, list
with state, Withdraw), **Backup location** bar from `/backup/space`, the three new scopes in the
default pairing set. One honest departure from the mockup: the hub keeps only a code's hash, so the
invite table cannot show codes — it shows who the invite is for and its state, and the code appears
once, when made. The hub does not serve the player, so the link needs the address players open it
at; the field is remembered per browser, and without it there is a code and no link.

Not done:

- **3A player.** `airwave-now-playing.html` is 19,146 lines with a generated demo library, a demo
  statistics year and simulated playback (`buildDemo`, "the library's playback is simulated"). Its
  seams exist (`window.kv`, `window.COMPANION`, `window.hubPeople`, `window.setOutputVolume`,
  `window.connState`, `library:play` / `transport:next` / `toolbar:change`). Recommended shape: (a),
  serve the file and move `src/lib` behind the seams, because its 21 suites come with it. First step
  is an inventory of every read of the demo dataset, not code.
- **3B companion** and the **presentation half of 3C** (six-tab window, tokens folded into
  `tokens.json`, NP-* rules merged). Both mockups still say "Mockup" (9 and 7 mentions).
- **Phase 4 (AWSP)** and **Phase 5**. Two things to settle before writing Phase 4 code: the state of
  iroh's browser build (the prompt asks for this check), and where the Swift client gets built —
  it cannot be built or tested on this Windows machine, and n0's netsim tooling is Linux-side.

## Working notes for the next pass

- The hub's Playwright suite serves `docker-container/dist`. Run `pnpm build:hub` before
  `test:e2e` after touching `src/web`, or the tests exercise the previous GUI.
- `pnpm styleguide:pdf` rewrites the PDF with different bytes on every run; `git checkout` it unless
  the guide's fingerprint actually changed.

---

# Part 2 (2026-09-21, second session) — prompt: `docs/audiowave-oneshot-part2-prompt.md`

Order A → B → C → D → E; each step commits green. This section is appended as each step lands.

## Step A — hub GUI presentation (done, `6aa9a2b`)

The six-tab window of `design/frontends/airwave-hub.html`: Overview · Devices (+ Profiles) · Music
(Library, Providers, Downloads, Recommendations) · Groups · Sharing (Shared links, Discord) · System
(Network, Backup, Diagnostics). The thirteen sections keep their data flows and ledger entries and
stack inside the tabs; `#section-id` in the address still opens the right tab. Overview gained the
mockup's six tiles from `metricsOverview`; the status line reads bind address and port from
`networkGet`. The tab strip started as `admin-tabs` in the hub and became `ToolTabs` in aqua-ui
during Step B, since the companion wears the same strip.

Departures, recorded as DEC-017: the first-run gate is a screen, not a banner over a disabled
interface (the server refuses every gated route until the password changes, so a live-looking
interface behind it would be a picture of one); the invite table shows who/state, not codes; the
mockup's `warning` #d99a1e yields to `--aqua-warning`; `header*`, `warningBg`, `warningEdge` joined
`tokens.json`.

Measured at the commit: hub e2e 16, hub a11y 9, hub DOM 10; full `pnpm verify` green except the
two `*-up-to-date` gates, which reported the regenerated `now-playing.html` and styleguide as
uncommitted diffs — committing them is the fix, and was.

## Step B — Windows companion (done)

Four tabs on the mockup's window: Library (folders by kind — Saved Music / TV / Movies — and the
music list), Live TV, Remote (hub connection, transfers), Settings (downloaders, general, network,
backup, storage, about). `ToolTabs` moved into aqua-ui with its styles in `aqua-window.css`; the
hub now uses the same component. The companion had never loaded `aqua-window.css` at all — its
chrome was unstyled — fixed with the same alias and import the hub has.

- **Backup is real** (`src/main/backup.ts`): settings (folder, include, schedule, keep-count),
  estimate through `createEstimator` from `local-helper/src/measure.ts` on the companion's own
  folders, an archive as a dated folder (`data.json` + copied folders, hard links linked once),
  listing, restore from an archive or a file, keep-count pruning, a schedule that ticks while the
  app is open. Sizes are decimal. Back Up Now is disabled with the reason when it cannot run.
- **The helper is embedded** (`src/main/helper.ts`): `startHelper` from `@now-playing/local-helper`
  with `backup: { folders, backupDir }` from the same settings, token kept under `safeStorage`,
  port a preference (default 17342). `tests/integration/backup.test.ts` asserts the companion's
  estimate and `GET /helper/v1/backup/estimate` return the same bytes and files for the same
  temp folders — the prompt's "agree by construction" test.
- The estimator now sums several folders per part (`measure.ts`), leaving a part out if any of
  its folders could not be finished; one new helper test.
- Folders have a kind (`music`|`tv`|`movies`, migration v2); TV and movie folders are kept and
  backed up, not indexed.
- Live TV: no data exists in the repo, so the tab says so (DEC-018). No sample channels anywhere.
- Not done from the mockup: the Remote tab's "Pair a device" code and "how devices may connect"
  are AWSP pairing — Step D. Downloads preferences (audio format, video quality, speed limit) have
  no main-process behaviour behind them yet and were not drawn as if they did.

Measured: companion integration 20 (main process) + 10 (backup) + existing; DOM 7; helper 7 on the
estimate route. `pnpm build:windows` green; the built app was launched through Playwright's
Electron driver and each tab screenshotted with the embedded helper running on 17342.

## Step C — the player: inventory (work list), before any code

Line numbers are into `design/frontends/airwave-now-playing.html` (19,146 lines). Structure: style
17–4883 · Script A AquaArt 4884–5033 · Script B Statistics engine (`AW`) 5034–6766 · body 6768–7973 ·
Script C the app 7974–17151 · Script D three.js module 17154–18824 (imports `three` via an import
map to jsdelivr, lines 8–15) · Script E toolbar pills 18826–18858 · Script F `window.VP_DEMO`
base64 clips, **one 173,875-char line at 18863** · Script G video player 18866–19143.

**Demo data and where it is read.** `AW.buildDemo` 5101–5212 (seeded year of events) → `sets.demo`
6143, source default `'demo'` 6121/6138, `<option value="demo">` 7397, the "generated demo year"
copy 6638. Real history already has a bridge: `window.AW.playerHistory()` 13625 maps `state.plays`
and `state.sessions` (written by `logPlay` 9557, `logSession` 9618; persisted in kv `library:state`).
`window.LIBRARY` 8033–8058 sixteen rows `[title,{artist,album},seconds,bpm,platform]`, alias `LIB`
9057; `library:add` (9473) appends real rows. `DEMO_HISTORY` 12437–12443. `window.ALBUMS` 7978–8032
(the jewel case's two albums). Invented `CHANNELS/SHOWS/MOVIES` 11334–11369. `RADIO_SEED` 10448–10497
is real stations (an offline shelf), not sample data of the person's — kept.

**Simulated playback.** Transport IIFE 16650–17150: `setInterval(…,1000)` 17130–17144 advances
`pos[mode] += 1`; `library:play` handler 17113–17128; `setPlaying`/scrub 16713–17062; prev 17066,
next 17073 (dispatches cancelable `transport:next`, handled 9650); the admissions at 8978 and 12809.
Real audio exists only for radio (`#radioAudio` 7268, 10995–11126), search preview (8590) and video.
Volume seam: `window.setOutputVolume` 9015, `volume:change` 8994; EQ 16053–16460 wires radio/video only.

**Network.** `connGet` 15016 (helper, reads `np-helper-token` meta 15028), `hubRaw` 15374 / `hubCall`
15400 (bearer `credentialId.secret`, creds in kv `player:hub`): pairing 15423–15439, profiles
15482–15686, groups/invites 15765–15981, people search 16038, backup estimate 15296 + `/backup/space`
15301. Third-party: iTunes search 8292, **api.anthropic.com 8323–8336 (removed: no third-party
accounts)**, Deezer JSONP 8522, radio-browser 10674, radio metadata feeds 16749–16794.

**Seams.** `window.kv` 8094–8123 (`get` async, `set` sync; backend `window.storage` → localStorage →
memory; keys `player:volume`, `player:prefs`, `library:state`, `player:hub`, `player:invites`,
`nowplaying:pose`). `window.COMPANION` 15069/16486. `window.hubPeople` 16034. `window.connState`
16052. Events `library:play` 9645→17113, `transport:next` 17078→9650, `toolbar:change` 18836→9508/
15477/18308, `library:add`, `player:heard`, `volume:change`. Raw `localStorage` outside kv: the
Statistics prefs `airwave:statistics` 6120–6131.

**Decision on shape (a): holds.** The edits that make playback real touch one IIFE and one boot
block; the data seams already exist. The file is served as the shell; a Vite-bundled bridge loads
first and implements `window.storage` (→ `db.ts`), the library feed (→ `library.ts` via
`library:add`), `window.NP_PLAYER` (→ `PlaybackEngine`), `window.THREE` (three bundled, no CDN),
and hands pairing to `HubClient`.

## Step C — the player (in progress; this entry is completed at the commit)

Built: `music-player/index.html` is generated from the frontend by `music-player/scripts/make-shell.py`
(every edit asserted against the exact text it replaces; the frontend file is untouched), and
`music-player/src/shell/bridge.ts` stands behind its seams. Shape (a), as decided (DEC-019).

What the bridge provides: `window.storage` → `db.ts` (the artifact contract: `set(key, json)`,
`get → {key, value}`); `window.LIBRARY` from `library.ts`; `window.NP_LIBRARY` (add folder / add
files / rescan / forget); `window.NP_PLAYER` → `PlaybackEngine` (the transport's bar follows the
element; the one-second clock survives only for the shared broadcast); `window.NP_TOOLS` → the
helper through `tool-backend.ts` / `tools-core.ts`; `window.NP_THREE()` lazy three.js; the shell's
hub credential handed to `HubClient`; the service worker registered.

Found and fixed on the way:
- The kv shim reads `r.value` from `window.storage.get`; the first bridge returned the bare value, so
  nothing the shell stored could be read back (prefs, library state, the hub credential). Fixed to the
  artifact contract; `player.spec.ts` asserts a play survives a reload.
- The React app registered the service worker; the shell did not — the installable, offline player
  would have silently stopped being either. The bridge registers it now; asserted in `player.spec.ts`.
- Top-level `await` cannot exist in the single-file IIFE build; `NP_READY` is a promise and Script D
  waits on it. three.js moved out of the first load (dynamic imports inside that wait).
- A rescan dropped the rows added from search/links; `refreshRows` keeps non-local rows.
- The shell only found a helper by port scan; served by a helper (token meta present) it now asks its
  own origin first and at boot — the zero-configuration detection the React player had.
- The transport's Download key was a toggle that saved nothing. It now opens a sheet asking why the
  person may have the file (the helper's authorization basis), fetches through the helper and indexes
  the result as a real track, which then plays.
- Back Up Now in the player logged "requested" to nobody. It now measures and says nothing was sent:
  the companion starts backups (its figures are the same figures, by construction — Step B).

Budgets: first load *down* from 658 KB to 240 KB (the bridge alone; the interface is inline in the
HTML); total up from 2180 to 2320 KB for the ~900 KB shell. Reasons written in the test file.

Later in Step C (second model; the first test-porting subagent stopped mid-run out of credits):
- All 21 airwave-np suites are ported to `music-player/tests/e2e/np/*.spec.ts` on the shared
  `np/_shell.ts` (real WAVs indexed through `NP_LIBRARY.addFiles`; no fabricated data). Suites that
  asserted the demo year (prefs, stats, discover) and the sixteen rows now seed and play real files.
- The React-era e2e specs were rewritten against the shell where their property still holds
  (player, a11y, helper, responsive, local-file); `features.spec.ts` and `platforms.spec.ts` were
  removed — their screens (shuffle deal, FLAC/WAV download sheet, platform table) are not in the
  shell, and their logic stays unit-tested in `music-player/tests/unit` and `packages/*`.
- More real bugs, each now covered: kv writes lost on an immediate reload (journal, below); adding
  files showed "0 tracks"; Statistics threw when reopened with nothing recorded (`AW.refresh` still
  fell back to 'demo'); the empty genre list claimed `role=list` (axe); ten controls and labels broke
  this repo's touch rules (UX-TOUCH-001/002) — fixed with a coarse-pointer layer, desktop unchanged;
  the jewel case's glow ran past the page edge on a tablet (clipped with `overflow-x: clip`).
- The bridge journals every kv write to localStorage synchronously and commits it to IndexedDB, and
  replays anything left at start-up — except the hub credential, which `hub-client.ts` keeps out of
  localStorage on purpose.
- The shell says "Now Playing", the product's name, not "Airwave" (the lowercase
  `airwave-algorithm` file type stays: it is a format files carry).
- Design records: 47 NP-* rules merged into `design/ux-rules.json` under `np-*` groups, evidence
  pointed at the ported tests (4 carry reviewer evidence only: their test did not survive as a
  separate assertion); NPD-001…031 appended to `design/decisions.md` with notes where this repo has
  since changed the fact (NPD-023/024/025/028/031). `music-player/scripts/merge-np-design.py`.
- Coverage: 19 shell surfaces (`player-shell-*`) discovered from `ShellSurface` in the bridge. The
  React player's 17 entries stay, marked "React specimen, not served", authority `proposed`: the
  styleguide still renders those views as specimens and 28 rule owners point at them.

Not done in Step C, named plainly:
- The React player UI (`music-player/src/{App,main}.tsx`, `views/`, `components/`) is still in the
  tree as styleguide specimens; retiring it and re-pointing those rules at the shell is left.
- The React build's "Running from a file" panel (what a browser withholds from a local page) has no
  counterpart in the shell; its two tests were removed with it.
- A layout shift in Sources ▸ Live TV: at ~744px, committing the playlist field re-renders the table
  above and moves "Load channels now" under the finger. The test commits the field first; the shift
  itself is not fixed.
- `np/prefs.spec.ts` "the equalizer survives a reload" and `np/menuverify.spec.ts` stalled on a click
  under heavy parallel load in some runs and passed alone; judged load-sensitive, not a defect.

## Step C — committed `405dad6` (player e2e 141/141; verify otherwise green, docker SKIPPED)

## Step D — AWSP (in progress)

- D.1 spec `8035c81`: docs/AWSP.md with §0 the state of iroh as researched 2026-09-22 (iroh 1.2.0,
  iroh-tickets 1.0.0, browser build official but unpublished, relay-only via clear_ip_transports,
  computer.iroh:iroh-android 1.1.0 on Maven Central). Browser build viable → PWA over iroh wasm.
- D.2 server `d935c9f`: windows-companion/awsp-server (Rust, 16 cargo tests incl. 24/96 FLAC bit
  identity and a relay-only 3 s outage with 0 underruns), Electron supervisor src/main/awsp.ts
  (key + allowlist under DPAPI, restarts, rebind on network change/resume), Settings ▸ Remote ▸
  Stream to your devices. `pnpm verify` gained test:awsp.
- Toolchain installed on this machine for D.3: rustup target wasm32-unknown-unknown,
  wasm-bindgen-cli 0.2.122.

## Step E — final verification (in progress, 2026-09-25)

State on entry: Steps A–D are all committed (`6aa9a2b`, `4ef410f`, `405dad6`, `8035c81`, `d935c9f`,
`ed28a06`, `fa57802`, `7d8a052`). The plan had recorded only D.1 and D.2, so D.3 (the PWA over iroh),
D.4 (the manual matrix and the CI-only netsim job) and the native Android client were committed but
unrecorded; they are recorded here by reference to those commits.

The note this pass was handed — "performance budgets fail: THREE.js in the entry chunk, ~540 KB over"
— **no longer reproduces**. `three` is its own 1,007 kB chunk and `pnpm test:perf` is 10 passed /
1 skipped. It was fixed in `405dad6` when the shell replaced the React entry; the first load is
236 kB. Nothing was changed for it.

**E.4 leftover grep — pass.** No simulated behaviour survives in shipped code: no
`say('Mockup — nothing happens.')`, no `BK_DISK`, no `buildDemo`, no `H.groups` sample arrays, in any
of `docker-container/src`, `music-player/src`, `music-player/index.html`, `now-playing.html`,
`windows-companion/src`, `local-helper/src`, `packages`, `android/app/src`. What the grep does still
match is prose crediting the design source ("as the mockup drew it", "in the mockup's amber voice")
and the styleguide's own documented `mockup only` coverage state (DEC-009) — neither is leftover
simulation. The original mockups under `design/frontends/` keep their banners, as design references.

**E.3 the scripted cross-app pass — the real gap, being built now.** Every existing suite tests one
application. The player's np suites stub the hub with route interception against the contract, which
is right for testing the player but means nothing has checked that the player's assumptions and the
hub's real behaviour agree. `tests/journey/` is the only place that seam is exercised: one
Playwright run booting the real hub (`dist/server.js`, fresh data directory) and the real player
(`vite preview` over `music-player/dist`) on ports the per-application suites do not use.

Reused rather than rebuilt, and why:
- The AWSP leg already exists as `music-player/tests/e2e/awsp.spec.ts` — real sidecar, real
  `iroh-relay 1.2.0`, `AWSP_RELAY_ONLY=1`, pairing through the UI, a 24/96 FLAC proved byte-identical
  by SHA-256, exact 206 ranges, a 416 past the end, and a resume from the last contiguous byte after
  the relay is killed mid-stream. That is the spec's relay-only FLAC leg in full.
- The companion has no Electron e2e; its main process is covered in-process by
  `windows-companion/tests/integration`. Driving it under `_electron` is part of this step.

### E.3 harness — written, not yet run

`tests/journey/` (config + `cross-app.spec.ts` + tsconfig), `pnpm test:journey`. One Playwright run,
`mode: 'serial'`, five numbered steps, two real servers on ports the per-application suites do not
use (hub 4548, player 4174) so it can run beside them.

What the shell's real pairing flow turned out to be, read from `music-player/index.html` rather than
assumed — it is a genuine two-application dance and the reason this test is worth having:
`#cfgHub` (address) → `#hubTest` must succeed before `#hubPairBtn` will do anything ("Test the
container first") → `POST /pairing/claim` with the 8+ character code → the player shows
`#hubPairMsg .pf__fp`, a fingerprint → **the hub must confirm that fingerprint in its Devices tab**
→ the player polls `/pairing/status` every 2 s until `confirmed` → `/pairing/complete` hands over the
credential → `#hubUnpair` appears. No stub can check that sequence; only two running applications can.

Steps: 01 first run and the bootstrap password dying at the API · 02 pair through both GUIs with the
fingerprint confirmed on the hub side · 03 group in the hub GUI, invite link pointed at the running
player, opened and accepted there, membership confirmed at the hub's API · 04 directed invite in the
Profile tab inbox, declined, `declined` read back at the hub's API · 05 profile name taken, second
claim refused by the hub.

Guards where the shape was inferred rather than read (`test.skip` with a reason, never a silent pass):
the hub's Devices-tab confirm control, and `hubFetch` for the direct profile write in step 05. First
run will say which of those is wrong; they are marked so a missing seam reports itself instead of
looking green.

No leg is claimed to pass. `pnpm verify` was running while this was written and had not finished.

### E.1 gates — one real failure, and one piece of noise

`pnpm verify` with `NP_SKIP_DOCKER=1`, 1316 s: **24 PASS, `test:e2e` FAIL (1038 s), docker SKIPPED.**
Passing includes `test:awsp` (46 s, the Rust sidecar suite), `test:a11y` (58 s), `test:local`,
`styleguide:check`, `styleguide-up-to-date` and `styleguide:pdf`. The earlier claim in this session
that verify exited 0 was wrong and is corrected here: the 0 came from the shell pipeline the run was
piped through, not from `verify.mjs`, which does exit 1 on a FAIL.

**The failure is one test**, `music-player/tests/e2e/np/func.spec.ts` → "avatar gradient not black;
the transport at rest is a slider with every key reachable". `docker-container` and `packages/aqua-ui`
e2e both passed clean (`.last-run.json` for each).

Investigation so far, none of it conclusive:
- It **passes alone** (3.9 s).
- Running the whole of `tests/e2e/np` in order — 110 tests, 14.2 m — **passes**, so the trigger is not
  within the np suites. Alphabetically the specs before them are `a11y` and `awsp`; `awsp.spec.ts`
  starts a real `iroh-relay`, the sidecar and ffmpeg, and installs a service worker on the player
  origin, which makes "the machine is loaded and something persists" the obvious suspicion.
- The plan previously filed two similar cases as "load-sensitive under heavy parallel load". That
  explanation does not fit: this config is `workers: 1, fullyParallel: false` with no retries, so
  there is no parallelism, and nothing is being masked.
- Two hypotheses were formed and **discarded on evidence rather than kept as guesses**: cross-test
  localStorage leakage through the bridge's kv journal (Playwright gives each test its own context,
  so storage is already isolated), and the avatar gradient's `var()` falling back to black
  (`--avatar-fill-top` is defined inline at `music-player/index.html:62`, so it resolves at parse
  time). `boot()`'s fixed `waitForTimeout(400)` after `NP_READY` remains suspicious on principle — a
  sleep standing in for a condition — but which of the test's five assertions actually failed is not
  yet known, and no fix should be made until it is.

A full player-e2e run is in flight purely to capture the error text. **Nothing has been changed for
this failure, and it is not being reclassified as flake.**

**Noise, not a failure:** `docs/design/styleguide.pdf` regenerates to different bytes from identical
sources (4,789,581 → 4,790,539) while the HTML fingerprint is unchanged at `153b057d9109861c` and
`styleguide-up-to-date` passes. Chrome's PDF writer embeds a creation date and a document id, which
is why there is an up-to-date gate for the HTML and none for the PDF. Left as is; normalising it
would mean stripping `/CreationDate` and `/ID` on export.

### E.1 — the e2e failure was a one-off; the suite is green

Four reproduction attempts, all passing, so the single `np/func.spec.ts` failure in the first verify
run is an intermittent that did not recur:

| attempt | scope | result |
|---|---|---|
| the one test alone | 1 test | passed, 3.9 s |
| `tests/e2e/np` in order | 110 tests | passed, 14.2 m |
| the full player suite, standalone | 142 tests | passed |
| **`CI=1 node scripts/verify.mjs test:e2e`** — the exact conditions that failed | 142 + 16 + 5 = **163** | **passed, 1080 s** |

The last of those matters most: `CI=1` is what verify sets, and it changes the config's behaviour
(`reuseExistingServer` off, so Playwright starts its own preview server, and a different reporter).
Matching it was the last untried variable rather than another guess, and it passed too.

So the gate table is now **all PASS, docker SKIPPED**. Nothing was changed to achieve that: no retry
was added, no assertion relaxed, no test quarantined. The failure is recorded here rather than
explained away, because one unreproduced failure in 163 tests is a real observation and the honest
thing is to say it happened and that its cause was not found.

Two hypotheses were tested and rejected on evidence (cross-test `localStorage` leakage — Playwright
already isolates storage per test; the avatar `var()` falling back to black — `--avatar-fill-top` is
inline at `music-player/index.html:62`). `boot()`'s fixed `waitForTimeout(400)` after `NP_READY`
remains the most suspicious thing nearby, and is deliberately **not** changed: replacing a sleep with
a condition needs a condition, and inventing a readiness signal in the product to satisfy a test is
the wrong direction. If it recurs, that is where to look first.

**A diagnosability gap found while chasing it, worth fixing before the next occurrence:** under
`CI=1` the player config writes `playwright-report/`, which is the only artifact that would have
named which of the test's five assertions failed — and the next run overwrites it. The original
failure's report was gone before it could be read. The assertions themselves all carry messages, so
the information exists; it just does not survive.

### E.3 first run — step 01 green, and a design error corrected

First run: **01 passed** (the hub's first run driven against the real server, bootstrap password dead
at the API), 02 failed, 03–05 did not run.

02's failure was mine, and structural rather than a selector slip: I had written five `test()` blocks,
and **Playwright gives every test its own browser context**. So 02 opened a page that was signed out
of the hub 01 had just set up — `getByRole('tab', {name: 'Devices'})` waited 4 minutes for a tab that
only exists once signed in — and no paired credential could have survived into 03 either. "One
scripted end-to-end pass" is one pass: it is now a single test with `test.step()` phases sharing one
context, one hub session and one paired player, and the steps still report individually.

Two selectors I had inferred were also wrong, and are now taken from the hub's own suite and source
rather than guessed:
- the code is created with **Create pairing code** and read from `getByLabel('Pairing code')` as
  *text* (`XXXXX-XXXXX`, ten Crockford base32 characters), not an input value;
- confirming is not a bare button. `docker-container/src/web/views/Devices.tsx` asks the operator to
  **type the six-character verification code the device is showing** into a `Verification code` field
  before Confirm is enabled — "if it does not match what the device shows, do not confirm". That is
  the real anti-machine-in-the-middle step, and a stub could never have exercised it. The journey now
  reads the code off the player's `#hubPairMsg .pf__fp` and types it into the hub.

### E.3 second run — the hub half of pairing works; a navigation error corrected

Second run got further: 01 passed, and in 02 the hub minted a pairing code and the player read it —
`Create pairing code` → `getByLabel('Pairing code')` → `XXXXX-XXXXX` — so the cross-application half
of the handshake is exercised for the first time. It then failed filling `#cfgHub`.

Cause, from Playwright's own error context rather than a guess: `#cfgHub` was in the DOM but **not
visible**, so `fill` retried and timed out. `openConnections` had been revealing Settings by setting
`#prefs.hidden = false`, which puts the element in the tree without putting it on the screen.
Settings in the shell is a page with its own address (`#settings/src` is Sources), so it is now
navigated to, and the helper waits for `#cfgHub` to be *visible* rather than merely present.

Worth keeping: Playwright refusing to type into something a person could not see is what surfaced
this. A test that had reached in through `evaluate` would have "passed" while exercising a pane the
user never opened.

### E.3 third run — the journey found a real bug: pairing through the hub's GUI could not work

Third run drove the whole handshake: hub set up, pairing code created in the Devices tab, the player
told where the hub is, `#hubTest` green, the code claimed, the player's verification code read off
`#hubPairMsg .pf__fp`, typed into the hub's Verification code field, Confirm pressed. Then
`#hubUnpair` stayed `hidden` for 120 s — 238 polls — and pairing never completed.

**It never could.** The numbers do not line up:

- `packages/domain/src/pairing.ts`: `verificationFingerprint` is `formatFingerprint(hex.slice(0, 12))`
  — twelve hex characters in three groups, `AB12-CD34-EF56`, fourteen characters with separators.
  That is what the player displays.
- `docker-container/src/pairing/service.ts:182-187`: `confirm()` strips non-alphanumerics, upper-cases
  and requires `timingSafeEqual` against **the whole** stored value — all twelve characters.
- `docker-container/src/web/views/Devices.tsx`: the operator's input carried **`maxLength={8}`**.
  Eight characters cannot equal twelve, so every confirm failed — and on mismatch the service
  **revokes the session**, so the operator had to start again and could never succeed.
- The hint said "a **six-character** verification code", agreeing with neither the twelve the hub
  compares nor the eight the field allowed.

Pairing a device with the hub through the hub's own interface was impossible.

**Why nothing caught it.** `docker-container/tests/e2e/hub.spec.ts` asserts the code's shape and that
a fingerprint is shown, and stops there — it never confirms. The player's `np/profile.spec.ts`
"pair, edit the profile on the container" runs against a **stubbed** hub that answers the contract,
so its pairing always succeeded. Neither side was wrong on its own; no test had ever completed a real
confirm across both. That is precisely the gap this suite was written for, and it found this on its
first complete run through the handshake.

**Fix** (`Devices.tsx`): the field holds the value the device actually shows (`maxLength={20}`), the
Confirm button enables on twelve alphanumerics rather than four, and the hint states the real shape
instead of a length nothing uses. The domain format and the comparison are left alone — they agree
with each other; it was the interface that could not express them.

### E.3 runs four to eight — the whole pass is green, and every remaining error was the harness's

With the `Devices.tsx` fix in place, run four cleared steps 01–03 for the first time: the pairing
handshake completed (`#hubUnpair` visible, `player:hub` holding `credentialId` and `secret`), the group
was made in the hub's GUI, the invite link the hub composed was opened by the player's own hash router
and accepted, and the hub listed the player as a member. Steps 04 and 05 then failed four times in a
row, each time for a reason that was mine and each time teaching something about the contract:

| Run | Failed at | Why — and what it says about the real system |
| --- | --- | --- |
| 4 | 04, Decline never found (15.1 m) | Two errors at once. The invite body said `toDeviceId`; the contract addresses a directed invite to a **profile** (`toProfileId`), and Zod stripped the unknown key, so the hub minted an *undirected* invite that `GET /me/invites` never delivered. The text match still passed — on step 03's "Joined" row. And the inbox `#invIn` lives in Settings ▸ Profile (`#pp-profile`, `hidden` at the root route): `toContainText` reads hidden text, `getByRole('button')` rightly refuses hidden buttons. |
| 5 | 05, second player's session (7.4 s) | `POST /pairing/sessions` is `responseStatus: 201`; the helper expected 200. |
| 6 | 05, second player's claim (12.2 s) | Message did not carry the body — fixed the helper to print status and body before anything else. |
| 7 | 05, second player's claim → **403** | `{"detail":"Missing or invalid CSRF token"}`. The Playwright `request` fixture carried the **operator's session cookie** from step 01 into an `auth: 'none'` device route, and the hub refuses an unsafe request that has a cookie but no token. Correct behaviour; a real player never sends that cookie. Device calls now travel in their own cookie-less `APIRequestContext`. |
| 8 | — | **1 passed (10.8 s).** |

Two other things the rewrite of steps 04–05 had to get right:

- The shell exposes no `hubFetch`; the original step 05 could only ever `test.skip`. It now sets the
  name the way a person does — `#pfName`, `#pfSave` — and reads it back at `GET /profiles/me` with the
  credential the hub issued in step 02 (`Authorization: Bearer <credentialId>.<secret>`, the scheme
  `hubRaw` uses at `index.html:15207`). That is the first time that credential is used by anything
  other than the shell's own code.
- `/profiles/available` excludes the caller's own profile
  (`docker-container/src/api/routes/profiles.ts:37`), so one identity can never see its own name as
  taken. Step 05 pairs a **second** player over the API — session, claim, confirm, complete, the four
  calls the GUI walked in step 02 — and it is that player that reads `available: false` and gets
  **409** on `PATCH /profiles/me`. Uniqueness is proven against another identity, which is what it is for.

What the journey now proves end-to-end, in one browser context and one hub process, in about ten
seconds: hub first-run and bootstrap-password revocation; pairing through the hub's GUI with the
device's verification code typed back; a GUI-made group and a GUI-made invite link consumed by the
player's router; a directed invite arriving at `/me/invites`, declined in the player's inbox, and read
as `declined` from the hub; a profile name taken in the player and refused to a second device.

### E.3 — the other legs

- **Companion ↔ hub, and the backup numbers.** `windows-companion/tests/integration/companion-and-hub.test.ts`
  pairs the companion with a real in-process hub ("pairs, then reports the hub it is connected to",
  refuses an unissued code, forgets a credential from the database, refuses a hub whose fingerprint
  changed), and `backup.test.ts:85` "reports the same bytes as the helper route started with the same
  folders" — the helper route is what the player's Backup pane displays, so this is the
  companion-estimate ↔ player-pane equivalence. Run this pass: **30/30**. There is still no launched-Electron
  e2e; the companion's window is exercised at the DOM level (`companion-shell.dom.test.tsx`) and its
  main process in-process (`main-process.test.ts`). That is stated, not papered over.
- **Docker.** Docker Desktop is not running on this machine (`npipe:////./pipe/dockerDesktopLinuxEngine`
  missing), so the container leg was reviewed statically and is **not** claimed as run:
  `Dockerfile:78-80` sets `NP_PORT=4546 NP_BIND_MODE=localhost NP_CONTAINER=1`;
  `network/service.ts:51-54` binds `0.0.0.0` when `inContainer` (a published port cannot reach the
  container's loopback) and `127.0.0.1` otherwise; `compose.yaml:25` publishes `127.0.0.1:4546:4546`
  only; the healthcheck follows `NP_PORT`. On the request path, `security.ts:isAllowedHost` accepts IP
  literals and `localhost`, and `isLoopbackOrigin` covers `localhost`, `127.0.0.1` and `[::1]`, so a
  player served from a loopback origin talks to the containerised hub with no env var. Same code the
  journey just drove as a plain node process; only the bind address and port differ. To run it live:
  start Docker Desktop, `docker compose up -d` in `docker-container/`, and point the journey's
  `HUB_URL` at `http://127.0.0.1:4546`.
- **AWSP, relay-only, to the PWA.** `music-player/tests/e2e/awsp.spec.ts` — real `awsp-server`
  sidecar, real `iroh-relay`, `AWSP_RELAY_ONLY=1`: "pairs, plays relay-carried, is bit-identical, seeks
  by range, and resumes across a relay restart". Run this pass with the player's own config
  (`--config tests/e2e/playwright.config.ts`; a bare `npx playwright test` has no `baseURL` and fails
  at `goto('/')` — that was a wrong invocation, not the leg): **1 passed (25.7 s)**.

### Step E — status at commit

| Leg | Evidence | Result |
| --- | --- | --- |
| E.1 gates | `node scripts/verify.mjs` (after the e2e one-off) | all PASS, docker SKIPPED |
| E.3 hub ↔ player journey | `pnpm test:journey`, runs 8 and 9 | 1 passed, 10.8 s / 10.6 s |
| E.3 companion ↔ hub, backup numbers | `windows-companion` integration, 2 files | 30/30 |
| E.3 AWSP relay-only to the PWA | `music-player` `awsp.spec.ts` | 1 passed, 25.7 s |
| E.3 Docker leg | static review only — daemon not running | reviewed, **not run** |
| E.4 leftovers grep | `Mockup — nothing happens`, `BK_DISK`, `buildDemo`, `H.groups` | none in shipped code |

One product defect found and fixed on the way: pairing through the hub's GUI could not complete
(`Devices.tsx`, `maxLength={8}` against a twelve-character fingerprint). `docs/design/styleguide.pdf`
is dirty because Chrome's PDF output is byte-nondeterministic; the HTML fingerprint `153b057d9109861c`
is unchanged, so it is left out of the commit as noise. Not pushed.

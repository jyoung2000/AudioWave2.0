# AudioWave2.0 — one-shot build, part 2

**Target: Claude Code · Fable 5 (reasoning effort: medium).** Paste everything below the line at the
repo root: `C:\Users\jalon\projects\AudioWave2.0\AudioWave2.0-claude-now-playing-music-suite-tfzu57`

Before starting, so the run is not taxed on every new file, start the session with the edit gate
scoped off for this repo (either works):

```
set ECC_GATEGUARD=off
```

or add the repo path to `GATEGUARD_EXEMPT_GLOBS`.

---

You are finishing the AudioWave2.0 suite. Part 1 is done and green on branch
`claude/airwave-oneshot-build`. **Read these two files first, fully, and nothing else until you have:**

1. `.agents/plans/2026-09-21-airwave-oneshot.md` — what part 1 did, decided and measured, and what
   is left. Do not redo or re-litigate anything it records as done.
2. `docs/audiowave-oneshot-master-prompt.md` — the original six-phase spec. Its Phase 3, 4 and 5
   text is still the contract for this run, **except where this prompt overrides it.**

Then `AGENTS.md` and `design/manifest.json`, as always.

Stay on `claude/airwave-oneshot-build` (or branch from it). Do not push unless told to.

## What this run covers

| Step | Work | Override of the master prompt |
|---|---|---|
| A | 3C presentation: hub admin GUI ← `design/frontends/airwave-hub.html` | functional half is already done — restyle and regroup only |
| B | 3B: Windows companion ← `design/frontends/airwave-companion.html` | none |
| C | 3A: music player ← `design/frontends/airwave-now-playing.html` | shape (a) is decided — see below |
| D | Phase 4 AWSP: spec → companion server → **PWA client** → tests → Android | **iOS is on hold: write no Swift.** PWA moves ahead of Android and is the client that must work |
| E | Phase 5 final verification | the scripted pass uses the PWA for the AWSP leg |

Order is A → B → C → D → E. Each step lands green — `pnpm verify` plus the step's own checks — with
its own commit(s) before the next begins. If a step cannot go green, stop at the last green commit,
append what blocked you to the plan file, and report. Never paper over a red gate, never widen a
design exception to pass a check, never stub fake success.

## Rules that part 1 learned the hard way

- **The hub's Playwright suite serves `docker-container/dist`.** Run `pnpm build:hub` before
  `pnpm --filter @now-playing/hub test:e2e` after touching `src/web`, or you test the old GUI.
  Check whether the player and companion suites have the same trap before trusting a pass.
- `pnpm styleguide:pdf` rewrites the PDF with new bytes every run. `git checkout
  docs/design/styleguide.pdf` unless the guide's source fingerprint really changed.
- `pnpm generate` output and the single-file `now-playing.html` are committed artefacts with
  up-to-date gates: regenerate and commit them whenever contracts or the player change.
- `tests/perf/bundle-budget.test.ts` budgets are deliberately tight. If a budget must rise, raise it
  by what was measured and write the reason beside it, in the file's existing voice. Prefer keeping
  new code out of the first load (lazy chunks) over raising the number.
- Bash here is Git Bash behind a wrapper that mis-parses heredocs containing unpaired apostrophes
  and flags SQL keywords. For multi-file patches, write a script to the scratchpad and run it; use
  Edit for files you have already read or written.
- Windows machine: no Docker daemon (that gate reports SKIPPED — leave it so), no bundled Chromium
  for PDF (the repo scripts already use installed Chrome).

## Token economy — this is a constraint, not a suggestion

- `airwave-now-playing.html` is 19,146 lines / 1.1 MB, part of it base64 video. **Never Read it
  whole.** Work from `grep -n` inventories and read only the line ranges you are about to change.
  Delegate broad inventories ("every read of the demo dataset", "every `fetch(` and what it calls")
  to an Explore subagent and keep only its conclusions.
- Run long gates (`pnpm verify`, e2e) in the background while you read; never poll them.
- Run the fast subset while iterating: `node scripts/verify.mjs lint typecheck test:unit test:dom
  test:contracts test:integration test:security styleguide:check`. Run the full gate once per step.
- Do not re-read files whose content is already in context. Do not narrate options you will not take.
- Compact at each step boundary (after the step's commit), not mid-step.

## Step A — hub GUI presentation (`docker-container/src/web`)

Already real and tested: Profiles view, New Group, per-group Invites (make link, list, withdraw),
Backup-location space bar, all data flows through `lib/api.ts`. Keep all of it.

- Rebuild `App.tsx` on the mockup's window: six tabs — Overview, Devices, Music, Groups, Sharing,
  System — replacing the source list. Map the thirteen existing views into them as the master
  prompt says (Profiles goes with Groups or Devices; Recommendations joins Music or System — do not
  drop either). Password gate = the existing first-run flow restyled; `data-gated` controls stay
  disabled until the server says setup is done. Log pane reads the real log route; status line reads
  real bind/port state.
- Extract the mockup's CSS into the admin stylesheet; fold its `:root` tokens into
  `packages/aqua-ui/src/styles/tokens.json` under existing conventions (an existing aqua-ui name wins
  a collision). Record any deliberate exception in `design/decisions.md`.
- Two recorded departures from the mockup stand: the invite table shows who/state, not codes (the hub
  keeps only hashes), and the invite link needs the "Players open Now Playing at" field.
- Update `tests/e2e/hub.spec.ts`, `a11y.spec.ts` (navigation is by tab now) and
  `design/coverage.json`. Finish with zero "Mockup" / "nothing happens" strings in `src/web`.

## Step B — Windows companion (`windows-companion`)

As the master prompt's 3B, with these specifics:

- Backup measurement: import `local-helper/src/measure.ts` (`measureFolder`, `driveSpace`,
  `createEstimator`) into `src/main` rather than writing a second walker, and start the embedded
  helper with `startHelper({ backup: { folders, backupDir } })` from the companion's configured
  folders, so `GET /helper/v1/backup/estimate` and the companion's own Backup view agree by
  construction. Add a test that asserts they return the same bytes for the same temp folder.
- Real archive writing, listing restorable backups, keep-count and schedule live in `src/main`
  behind the preload bridge, with integration tests in `tests/integration`.
- Live TV tab: wire to whatever real playlist/source data exists; where the repo has none, the tab
  says what is missing in the mockup's amber voice. It never shows sample channels.
- Verify the packaged app still builds (`pnpm build:windows`) and, if a display is available, launch
  it and screenshot each tab as proof.

## Step C — the player (`music-player`)

**Shape (a) is decided: serve the file as the shell and move the React/`src/lib` logic behind the
`window.*` seams.** Reason: least risk, and its 21 Playwright suites come with it. Say so in the
commit; do not revisit.

1. **Inventory first, no code.** Via subagent: every consumer of the demo library (`buildDemo`, the
   "demo library" block near line 5076, `AW.Dataset`), every place playback is simulated (search
   "simulated"), every direct `fetch(`/`hubCall(`/`connGet(`, and the exact surface of each seam
   (`window.kv`, `window.COMPANION`, `window.hubPeople`, `window.setOutputVolume`,
   `window.connState`, events `library:play` / `transport:next` / `toolbar:change`). Write the
   inventory into the plan file; it is the work list.
2. Copy the frontend into the player as its shell source (the file in `design/frontends/` stays
   read-only). Build a thin bridge module, bundled by Vite and loaded by the shell, that implements
   the seams on top of `src/lib`: `window.kv` → `db.ts`; library and playback → `library.ts`,
   `playback.ts`, `crossfade.ts` and the audio-core worklet; search → `platforms.ts` /
   `fetch-helper.ts`; hub and groups → `hub-client.ts` / `group-client.ts`. Keep its connection log.
3. Replace the demo dataset at its source so every consumer gets real data: real library, real play
   history for Statistics. An empty library shows the real empty state, not a generated year.
4. Settings panes wire to the Phase 1 routes that now exist: Profile (name with live availability,
   picture, shared playlists, people search, invites: preview / accept / decline / `#invite/` links
   stripped from the address bar), Sources ▸ Backup (`/backup/space` + helper `/backup/estimate`,
   decimal units, Back Up Now disabled with the reason when it will not fit).
5. Keep the single-file local build, the service worker/PWA build, the Android WebView shell and
   `local-helper` serving all working — they all ship this player. Keep the bundle budgets honest.
6. Port the airwave-np suites from `C:\Users\jalon\projects\airwave-np\tests\*.mjs` (runner
   `tests\run.mjs`) into this repo's Playwright setup. A suite that asserted demo data is rewritten
   to seed real data through the app's own import path, not deleted. Keep `music-player`'s existing
   logic-layer tests. Merge the NP-*/NPD-* rules the ported screens rely on from
   `C:\Users\jalon\projects\airwave-np\design\` into `design/ux-rules.json` / `decisions.md`, with
   evidence pointing at this repo's tests.

If the inventory shows shape (a) cannot carry real playback without rewriting most of the file, stop
and report that with the evidence rather than switching shape silently.

## Step D — AWSP (master prompt Phase 4, minus iOS, PWA first)

Commit order: **spec → companion server → PWA → tests → Android.**

1. **Research before design (small, bounded):** check the current state of iroh — the Rust crate API
   (`Endpoint`, tickets, ALPN, relay-only mode), `@number0/iroh` for Node, and the browser/WASM
   build over relay WebSocket. Use Context7 / the iroh repo, not memory. Record what you found, with
   versions, at the top of `docs/AWSP.md`.
2. `docs/AWSP.md`: the full protocol as the master prompt specifies (control stream, range-based
   audio streams, tiers, buffering numbers, pairing ticket + allowlist, resume tokens). State plainly
   that iOS native is deferred and that the PWA is lossless-only and relay-carried.
3. **Server in the companion:** prefer a small Rust sidecar crate (Rust 1.98 is installed) owning the
   iroh endpoint, persisted SecretKey (DPAPI-protected), allowlist, library index access and range
   serving with backpressure; the Electron main process supervises it and owns the settings UI
   (folders, ticket + QR, paired devices with revoke, per-device tier cap, optional port pin, tray
   autostart, rebind on network change). Opus tiers via ffmpeg with an on-disk segment cache.
4. **PWA client — the one that must work.** If iroh's browser build is viable: AWSP over it, behind
   a service-worker bridge feeding the media element; raw FLAC with Range for Chromium (progressive /
   MSE), FLAC-in-fMP4 HLS for Safari, never hls.js on Safari; Media Session API; no Wake Lock;
   client keys in IndexedDB + WebCrypto. **If it is not viable, implement §4.6's fallback for real**:
   a WebSocket bridge inside the companion speaking AWSP over WSS on a local port, behind a settings
   toggle that is off by default, reachable over the user's tailnet. Either way the now-playing UI
   shows the connection type (direct / relay-carried / bridge) and both sides log it at INFO.
   "Works" means demonstrated, not asserted: a Playwright test that pairs a browser client with a
   real running server process, streams a generated FLAC fixture end to end, seeks, survives a
   dropped connection by resuming at the last contiguous byte, and **a bit-identity assertion that
   the bytes the PWA received equal the source file's bytes.**
5. **Tests.** n0's netsim tooling is Linux-side and there is no Docker daemon here. Do the most
   honest thing available: an integration test with two real iroh endpoints on this machine, a
   forced relay-only mode via env var, and a 3 s induced outage (pause/drop at a local proxy or by
   closing the path) asserting zero audible gaps against the 20 s buffer, with a 24-bit/96 kHz FLAC
   fixture generated by ffmpeg. Put the true NAT-simulated netsim test in the repo as a CI-only
   (Linux) job, marked as not run locally — and say so in the report; do not claim it passed.
   `TESTING.md` gets the manual matrix, with the iOS-native rows marked deferred and the iOS Safari
   PWA rows kept.
6. **Android (last, native Kotlin under `android/`):** Media3 `MediaSessionService` +
   custom `DataSource` on the AWSP buffer, iroh-ffi Kotlin bindings, Keystore-held keys, wakelock /
   Doze / `NetworkCallback` behaviour as specified. Must build (`./gradlew assembleDebug`) and pass
   `./gradlew test`. Use the emulator/device via adb only if one is attached; otherwise report device
   testing as not done. If the iroh Kotlin bindings cannot be consumed from this project, stop the
   Android leg there, record why, and do not fake the transport — the run still succeeds if the
   server and PWA are green.

Constraints unchanged: no third-party accounts, no Docker-container involvement in streaming, no
plaintext on the wire, secrets under OS-appropriate protection.

## Step E — final verification (master prompt Phase 5, adjusted)

- `pnpm verify`, `pnpm styleguide:check`, `pnpm styleguide:build`, `pnpm styleguide:pdf` green.
- Ported airwave-np suites pass against the real apps with hub + helper running in the harness.
- One scripted end-to-end pass: pair player↔hub and companion↔hub; create a group in the hub GUI;
  make an invite link; open it in the player; join; send a directed invite, see it in the
  addressee's Profile tab, decline, see `declined` in the group's list; set a profile name with
  uniqueness enforced; run a companion backup whose size/space numbers equal the player's Backup
  pane; stream one FLAC over AWSP **to the PWA** with the forced relay-only leg.
- Leftover grep over shipped code: no "Mockup", "nothing happens", `H.groups`-style sample arrays,
  `BK_DISK` fixtures, `buildDemo`, or "playback is simulated".
- Append to `.agents/plans/2026-09-21-airwave-oneshot.md`: what was done, what was measured (test
  counts from the run, not remembered), every departure from the prompts and why, and anything not
  done — named plainly, including iOS (deferred by decision) and any test that exists but was not
  run here.

## Stop points

Each step's commit is a safe stop. If the run must be split, the natural cuts are after C (the three
apps are one coherent product) and after D.4 (server + working PWA). Report at the end with: the
gate table, the commit list, what is demonstrably working, and what is not — in that order.

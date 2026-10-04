# Hermes — prove what is not yet proven, and report back to Claude Code

**Repository:** https://github.com/jyoung2000/AudioWave2.0 — branch `claude/airwave-oneshot-build`
(https://github.com/jyoung2000/AudioWave2.0/tree/claude/airwave-oneshot-build), at `4a1ab09` or later.
**Machine:** the owner's Windows 11 PC. The suite is **Airwave**: the player (PWA, also inside the
Android app), **Airwave Hub** (Docker or Node) and **Airwave Companion** (Electron, Windows).

You are Hermes. Since your last pass (`.agents/plans/2026-09-28-hermes-final.md`, companion-flow brief
`.agents/prompts/2026-09-29-hermes-companion-flow.md`) the hub admin window and the companion window
were rebuilt to their Airwave designs, every control those designs drew was wired, and the downloaders
became ready without setup. Unit, DOM, integration, contract and security tests pass. What follows has
**not** been shown working on real hardware. Your job is to prove each item works — or, where it does
not or cannot be proven here, to tell Claude Code exactly where the feature stands, what blocks it and
what to do next. Your report is read by Claude Code, so write it for an engineer who will act on it.

## 0. Rules

- **Fresh clone** into `C:\Users\jalon\AudioWave2.0-prove` (never over an older clone; the older ones
  keep their reports). `pnpm install`, then `pnpm build`. Node 22, pnpm, Rust, JDK 17 and the Android SDK
  are installed.
- **Sandbox the companion:** run the packaged app with `PORTABLE_EXECUTABLE_DIR=C:\np-prove` so it never
  touches the owner's real companion profile (`%APPDATA%\now-playing-companion`). Use your own hub data
  folder (`NP_DATA_DIR=C:\np-prove\hub`), never another clone's `docker-container/data`.
- **Ports:** hub 4546 (or 4550 for a second hub), player preview 4173, companion helper 17342 (if it is
  taken, set another in the companion's **Settings ▸ Network ▸ Helper port**). **Never touch port 8642** —
  it is your own gateway.
- **Processes:** record every PID you start and stop only those. Never kill by name. One run at a time
  per port and per log file. Wait for things to finish; no polling loops.
- **Test media:** copy from `C:\Music\NowPlayingTest` into `C:\np-prove\music`; never edit the original.
  Download only public-domain or openly licensed audio (archive.org public-domain items).
- **Secrets** (hub password, pairing codes, helper token) stay in your scratch folder, read at run time,
  never committed and never pasted in the report.
- **Keystrokes only into the window you mean:** before any UI Automation keystroke or click, find the
  target window by exact title **and** the PID you recorded, confirm it is foreground, abort otherwise.
- **System settings are the owner's:** you never change Windows network, firewall or metered settings
  yourself. Where a step needs one (§2.9, §2.10), ask the owner in chat to do that one step, wait for
  "done", record that a person did it, and continue.
- **Never push.** Commit the report and any harness scripts you add (machine paths from `NP_SCRATCH` /
  `NP_CLONE` environment variables, as in your earlier passes) in reviewable pieces.
- If an approach fails twice for a reason in your harness, stop that approach and write it up rather
  than looping.

## 1. Baseline

1. `pnpm verify` once, output to a log. Record each gate's PASS / FAIL / SKIPPED. Do not try to fix
   anything; this is the baseline the rest of the report refers to.
2. If `test:e2e` fails, note which tests. The known pattern: on a loaded machine the player suite has
   failed a different handful of tests each run (60-second timeouts, once `ERR_NO_BUFFER_SPACE`), and
   every failing file passed when rerun alone. That is §2.1.

## 2. The unproven items

For each item: do the steps, then grade it (§3). Every step names what to capture as evidence.

### 2.1 The player's browser suite, in one full run
- On a quiet machine (close what you can; nothing else running Playwright), run
  `pnpm --filter @now-playing/music-player test:e2e` once in full. Evidence: the summary line and, for any
  failure, the test name, the error and its trace path.
- If it fails, rerun **only** the failing files. A test that fails in the full run and passes alone is a
  load/isolation problem — say which, with timings (how long the full run took). A test that fails both
  ways is a defect.

### 2.2 The Docker image and the container journey
- Start Docker Desktop (it is installed; ask the owner if it needs a reboot or sign-in). Then
  `pnpm test:journey:container` and `node scripts/verify.mjs docker-build`.
- Evidence: build log tail, image size, the journey summary. In the container, confirm the hub found
  yt-dlp in the image (`/usr/local/bin/yt-dlp`) and that **Music ▸ Providers** shows "External media tool"
  as working with no setup.

### 2.3 A download job through the hub itself
- Signed in to the hub admin, queue one archive.org public-domain track as a download (rights basis
  "public domain") through the hub's own UI/API (**Music ▸ Downloads**), once on the Node hub and once in
  the container from §2.2.
- Then play the downloaded file in the player paired with that hub. Evidence: the job's states, the file
  on disk (size), a screenshot of it playing.

### 2.4 The companion setting FFmpeg up by itself
- Start the packaged companion (sandboxed) with FFmpeg **not** on its PATH (launch it with a `PATH` that
  excludes any ffmpeg directory; do not uninstall anything). It should fetch and verify FFmpeg on its own.
- Evidence: **Settings ▸ Downloaders** showing FFmpeg "Setting up… N%" then ready, the
  `setup-state.json` `verified` record (asset + SHA-256), and the time it took.

### 2.5 The three apps working together
- Run §1–§3 of `.agents/prompts/2026-09-29-hermes-companion-flow.md` against this build: folder picker
  through UI Automation (fallback: the owner does the one click), the hub following the folder (add,
  rename, delete), tempo, backup numbers matching, a second hub refusing the old credential, a synced song
  playing in the player through the hub, **Send to Hub**, streaming to a device, group listening with two
  browser profiles, radio into a group queue.
- Also, new since that brief:
  - **Live TV through the hub:** in the companion's Live TV tab add a public M3U playlist and an XMLTV
    guide (find openly published test ones; never a paid or private IPTV list). With sharing on, the hub's
    **Music** tab must show "Live TV from the companion" with the channel count. Then a player paired with
    the hub but **without** the companion reachable (another browser profile with no `COMPANION` address,
    or another device) must list those channels in Live TV, with Now / Next / Until from the guide.
  - **Sharing default:** pairing with a hub that grants library sharing starts syncing without ticking
    anything; turning it off stops syncing and removes the companion's Live TV copy from the hub.

### 2.6 Android
- Build the player for the app and the app itself, exactly as `android/README.md` says
  (`NP_BASE_PATH=/assets/app/ pnpm build:player`, copy `music-player/dist` into
  `android/app/src/main/assets/app`, `./gradlew assembleDebug`). Install on an emulator or a device
  (`adb install -r …`), launch, add a song, play it, open Radio and play a station, open Live TV.
- Evidence: build log tail, APK size, screenshots, `adb logcat` lines for any crash or WebView error.

### 2.7 Talk-station headline
- In the player, tune **WBEZ 91.5** and **WGN 720** by double-clicking each row itself (select by its
  `data-sid`), solo and in group listening mode. Read the big title at the top of the player.
- Your pass 4 once saw "No group session" and "Classical" there instead of the station's programme
  format, possibly from clicking a neighbouring row. Confirm or clear it with screenshots of each case.

### 2.8 Group Play, Pause and Skip from the hub admin
- In **Groups**, open a group with two members (two player profiles), queue two songs, then use the
  admin's Play, Pause and Skip. Both players must follow within the group's drift tolerance.
- Evidence: screenshots of the admin and both players at each step.

### 2.9 The helper on the network (off by default)
- In the companion, **Settings ▸ Network**, turn on "Let devices on this network use the helper without
  pairing". Windows will show a Firewall prompt: **ask the owner to answer it** ("Private networks" only),
  and record that they did.
- From another device on the same network (a phone, or a second PC), fetch
  `http://<this PC's address>:<port>/helper/v1/health`, `/helper/v1/tv/channels` and
  `/helper/v1/radio/now-playing?url=<a public stream>` — each must answer. Then try a token route such as
  `/helper/v1/fetch` from that device, **with** the token — it must be refused from the network.
- Turn the setting off and confirm the network routes stop answering. Evidence: each request and its
  status, the setting's hint text.

### 2.10 Streaming on a metered connection
- Build the streaming sidecar: `cargo build --release` in `windows-companion/awsp-server`, then
  `pnpm build:windows` so the packaged app carries `awsp-server.exe`.
- Turn on **Remote ▸ Let paired devices stream from this PC**, pair a player, start a FLAC.
- Ask the owner to make this PC's connection metered (either tether to a phone hotspot, or in Windows
  Settings set the current network to "Metered connection") and tell you when it is done. With
  "On metered connections" **off**, the stream must stop and the status must say why; with it **on**, it
  must continue. Ask the owner to undo the metered setting afterwards.
- Also check "last seen" on the paired device after it disconnects. Evidence: status text, timings,
  player behaviour, screenshots.

### 2.11 A real download with the companion's Downloads settings
- In **Settings ▸ Downloads**, set a save-to folder under `C:\np-prove\downloads`, a format, two at once,
  a speed limit (e.g. 500 KB/s) and "When one finishes: notify". From the player, fetch two public-domain
  archive.org tracks through the companion.
- Evidence: both files in the folder in the chosen format, the observed rate respecting the limit, the
  Windows notification (screenshot), clicking it showing the file.

### 2.12 Quick check of the other new controls (real app, not tests)
One pass each, screenshot and one line of result:
- hub: create a shared link for an album and open it in a private window; set a weekly backup schedule;
  download one backup archive; scan one folder; Network Save / Revert; Discord status wording.
- companion: per-tool **Check All** and **Update**; "Check for new versions" (no release exists yet, so
  it should say so); Export Logs (open the zip and confirm no token, Bearer value or folder path is in it);
  Clear Cache; the song list with all of `C:\np-prove\music` reachable by keyboard.

## 3. Grades

Grade every item §2.1–§2.12 (and each bullet of §2.12) with one of:

- `PROVEN` — it worked end to end on this hardware; evidence attached.
- `BROKEN` — it does not work; give the exact failure.
- `PARTIAL` — some steps worked; say which did not.
- `BLOCKED` — it could not be tried; name the blocker precisely (what is missing, who can remove it).
- `NOT TESTABLE HERE` — this machine cannot do it at all; say what would.

Plus a 1–5 for how it felt to use, where a person was involved.

## 4. Report for Claude Code

Write `.agents/plans/2026-10-04-hermes-prove-it.md` in the clone:

1. **Verdict table** — one row per item: grade, one-line result, evidence path(s).
2. **Status for every item that is not `PROVEN`** — for each:
   - *Where the feature is:* the files that own it (check the paths exist), what already works, what
     the tests cover.
   - *What failed or blocked it:* the exact error, log lines, screenshots.
   - *Next step:* who does it (owner / Claude Code / you on a re-run) and what exactly.
   - For a defect, a ready `claude -p` prompt that names the files, reproduces the failure as a test
     first, and states the expected behaviour. Check every path in the prompt exists.
3. **Still not proven on real hardware** — a short list of anything that remains untested after this
   pass, and why.
4. **Processes** you started and stopped (PIDs), and anything you left running (should be nothing).

Commit in reviewable pieces (report, harness scripts, evidence). Never push.

Verdicts without evidence will be discarded.

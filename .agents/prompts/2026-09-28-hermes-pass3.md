# Hermes — pass 3: the untested ground of the Now Playing suite, as a real user

**Repository:** https://github.com/jyoung2000/AudioWave2.0 — branch `claude/airwave-oneshot-build`
(https://github.com/jyoung2000/AudioWave2.0/tree/claude/airwave-oneshot-build).
**Machine:** the owner's Windows 11 PC. Three apps: the **hub** (Docker container), the **player**
(web app / PWA) and the **Windows companion** (Electron app with an embedded local helper).

You are Hermes. Your second pass (`.agents/plans/2026-09-27-hermes-retest.md`, now on the branch)
proved the setup, the step-2 defects, the helper's origin rules and the first real tool install. It did
**not** reach the features this whole round was built for. This pass is only that ground. Use the apps
the way a person would, then check the truth at the API or in the other app, and grade everything.

## 0. Before anything: how to work this time

Pass 2 lost a lot of its time and two of its actions went wrong. Do not repeat these:

- **No status loops.** Do not restate the state of earlier work between steps. Keep one running file,
  `.agents/plans/2026-09-28-hermes-pass3.md`, append to it after each section, and move on. If you
  catch yourself writing the same paragraph twice, stop and do the next test instead.
- **Wait for long jobs, don't poll them.** Start them, do something else, read the result once.
- **Never kill processes by name.** No `taskkill /IM node.exe`, no sweeping kills. Stop only a PID you
  started yourself and have recorded. Other programs on this PC (your own gateway on 8642 among them)
  must never be touched.
- **Sandbox the companion properly.** Overriding `APPDATA` does not move an Electron app's data on
  Windows; pass 2 wrote into the owner's real profile that way. The companion keeps everything under
  `%PORTABLE_EXECUTABLE_DIR%\NowPlayingCompanion-data` when that variable is set — so for any run that
  must not touch the owner's real companion, launch it with `PORTABLE_EXECUTABLE_DIR=C:\np-pass3` and
  confirm the files land there before you rely on it.
- **Never delete or edit the owner's data**, tracked files, or the real `docker-container/data`
  (restore anything a script removes, and say so).
- **Evidence you can trust.** Quote a result only after reading it yourself. A wrapper's exit code is
  not the result; the gate's own output is.

## 1. Setup (short — pass 2 proved it)

Fresh clone into a new folder, `git checkout claude/airwave-oneshot-build`, `pnpm install`,
`pnpm verify` once and record its table (pnpm 10.33.0; corepack is broken here — `npm i -g
pnpm@10.33.0`). Docker Desktop running. Then, one terminal each:

1. Hub: `cd docker-container; docker compose up -d --build --wait` → http://127.0.0.1:4546 (set the
   admin password on first run).
2. Player: `pnpm build:player; cd music-player; npx vite preview --port 4174 --host 127.0.0.1`.
   Also use it as served by the hub at http://127.0.0.1:4546.
3. Companion: `pnpm dev:windows` — sandboxed as in §0 unless the step says otherwise.

Music: `C:\Music\NowPlayingTest` (known tempos, tagged and untagged; `.agents/evidence/make-corpus.sh`
rebuilds it) plus a few real albums.

## 2. What changed since pass 2 — confirm quickly

1. **Searches no longer go to port 8642.** The player used to send every typed search and pasted link
   to `http://127.0.0.1:8642`, which nothing in the suite serves — on this PC that is your own gateway.
   With the player open and the browser's network panel recording, search for a song and paste a
   SoundCloud link: no request may go to `:8642`. Search results must still arrive (from the hub when
   paired, from iTunes when not).
2. **The flaky preview test.** `music-player/tests/e2e/np/preview.spec.ts` now reports, when a search
   shows no rows, what the dropdown showed, whether the player was still paired, and which lookups were
   made. Run the suite five times (`pnpm --filter @now-playing/music-player exec playwright test
   --config tests/e2e/playwright.config.ts np/preview.spec.ts`). If it fails, paste that message — it
   is the evidence the last failure lacked. If it never fails, say so.
3. **FFmpeg's verification is on record.** In the companion's tools folder, `setup-state.json` now keeps,
   per tool, the release asset and the SHA-256 it was verified against. For FFmpeg that is the zip
   (the executables are unpacked from it after it is checked, then it is deleted). Compare those values
   with the GitHub release pages. For yt-dlp and spotDL, the executable's own SHA-256 must equal the
   recorded one. (Your pass-2 finding that ffmpeg.exe "can never match" was right about the file and
   wrong about the check — grade the record, not the impossible comparison.)
4. **Setup order** is yt-dlp → FFmpeg → spotDL (`local-helper/src/provision.ts`, `SETUP_ORDER`). In
   pass 2 FFmpeg was on PATH and so skipped, which is why it looked last. In a sandboxed run with
   FFmpeg off PATH, confirm the real order from Settings ▸ Downloaders.

## 3. The ground nobody has covered — the point of this pass

### 3.1 Radio: the song on the air (NP-RADIO-001)

Radio tab. Use stations that publish **no feed of their own** — WFMT 98.7, WDCB 90.9, KEXP, Radio
Paradise, 011.fm, and a few from the directory search — in three setups:

- **(a) player alone** (no companion, not paired): the station line shows the programme format, never an
  invented song title.
- **(b) companion connected** (Sources ▸ Connections ▸ Windows companion app, address empty, Connect):
  the headline and the station's row show the real song within ~20 s and follow it when it changes.
- **(c) paired with the hub, companion closed:** the same, read by the hub.

For each station, compare the player's title with what the station's own website says is playing.
Try a talk station, a station between songs, and an HLS/AAC stream: each must fall back to the
programme format, not to garbage or a stale title. Watch the network: only the **tuned** station's
title is ever asked for — never one request per row of the list. Directly:
`GET /api/v1/radio/now-playing?url=<a stream URL>` with a device credential returns the title; an
`http://192.168.x.x` or `http://127.0.0.1` URL returns `reason: "Private or local addresses are blocked"`.

### 3.2 Radio: keep the song you just heard (NP-RADIO-002)

Right-click a station whose song is showing (phone-width window or touch: long-press — releasing
must not retune the station). The menu shows **On air: Artist — Title** and three commands:

- **Add Song to Up Next** — the song appears in Now Playing's list and becomes a library entry
  (labelled Radio when search finds no match). Reload: it is still there, and still in any playlist.
- **Add Song to Playlist ▸** — your playlists and New Playlist…; the song lands once, not twice.
- **Add Song to Group Queue** — unpaired or in no group: disabled, and hovering says why. Paired in one
  group: it names the group. Several groups: a submenu. Choose one: the hub finds a playable copy **by
  that same artist** and appends it; the toast says the position, or why nothing was queued. Test a
  song the hub can play (something in its library or the companion-synced folder) and one it cannot,
  and a title shared by two artists — a same-titled song by someone else must never be queued. Confirm
  on the hub's admin view and on a second player in the same group.
- **Keyboard:** Shift+F10 on a station opens the menu; ArrowRight/ArrowLeft work on **both** submenus.

### 3.3 Companion ↔ hub, as a person

Pair from the companion's own window — Remote ▸ Hub connection (never done by any pass). Watch a folder; add, rename and delete
files and see the hub follow. Run a backup and compare its size and space numbers with the player's
Backup pane — they must match to the byte. Unpair; pair with a *different* hub (a second data folder) —
it must refuse to reuse the old credential. Tempo: untagged files in the corpus get **≈** tempos after a
scan, tagged ones keep their tags, measured values match the corpus's known tempos.

### 3.4 All three at once

A track the companion synced plays in the player through the hub; a group queue plays it; a transfer
companion → hub → player completes and plays. Enable streaming (companion Remote ▸ Stream to your devices, off by
default) and stream a FLAC to the player — relay-only, then direct; pause, seek, resume; stop the
sidecar mid-stream and see what the player says. Two browser profiles in one group: play, skip, one
leaves mid-song.

### 3.5 Links from YouTube / SoundCloud / Spotify

Only if the owner gives you keys (enter them in the hub's Providers tab, never in files): resolve →
audition → queue → import likes and playlists. Downloads: YouTube and Spotify must be refused with a
reason; SoundCloud only for tracks the creator made downloadable. Without keys: grade every refusal and
every "sign in through the hub" path. A yt-dlp and a spotDL fetch through the companion must work.

### 3.6 Android (if an emulator or device exists), and the quality sweep

Install `android/`, pair, stream one track. Then every screen of all three apps: dark mode, phone width,
keyboard only, screen-reader names, copy that blames the wrong thing, a control that does nothing, a
state that lies, a wait over 3 s with no feedback, a crash you can trigger twice.

## 4. Grade like a user

One row per feature: | Feature | App(s) | Grade 1–5 | Verdict | One-line user critique | Evidence |

Grade: 5 recommend · 4 minor polish · 3 works but I noticed · 2 I'd stop using it · 1 broken or
dishonest. Verdict: `WORKS` · `BROKEN` (fixable in place) · `REWORK` (design wrong) · `REDO` (does not
do what it claims) · `NOT TESTABLE HERE` (say why). Evidence: exact steps, expected, actual, a
screenshot or log path, `file:line` when you found it, and the test that should have caught it.

## 5. Rules

- Fix-forward only; never revert, delete or stub a source file to pass a check.
- Never push. Commit on the branch in reviewable pieces, each message ending with the attribution line
  of whichever agent wrote the change.
- UI/UX changes follow `AGENTS.md` (read `design/manifest.json`, cite the rule ID, update the rule, its
  test and `design/coverage.json` together, run `pnpm styleguide:check`, `styleguide:build`,
  `styleguide:pdf`); player shell edits go through `music-player/scripts/make-shell.py`.
- Root cause before any fix; reproduce twice; two failed attempts → stop and write it up.
- No secrets, and no inventories of the owner's machine (PATH dumps, installed-software lists) in
  anything committed.

## 6. Delegating fixes to Claude Code

One defect per invocation, print mode, scoped tools, bounded turns; check every path you name exists
before you send it:

```
claude -p "<one precise task: file paths, the reproduction, expected vs actual, the test to run>" \
  --allowedTools "Read,Edit,Grep,Glob,Bash(pnpm *),Bash(node *),Bash(git *)" \
  --max-turns 10 --effort medium --output-format json
```

`--effort high --max-turns 20` only for a cause that spans two apps. Record `total_cost_usd`.

## 7. Deliverable

`.agents/plans/2026-09-28-hermes-pass3.md`, committed:

1. **§2 confirmations** — each WORKS or not, with evidence.
2. **§3 verdicts** — every item, graded, with evidence; NP-RADIO-001 and NP-RADIO-002 first.
3. **Connection matrix** — player↔hub, companion↔hub, player↔companion (from 4174 and from the hub's
   origin), Android↔companion.
4. **Defects** — ranked by user impact; each `fixed in <sha>` or `for Claude Code:` + the exact prompt.
5. **Rework / redo list**, **Decisions for the owner**, **Not done** (named, with why).
6. **Closing proof** — the `pnpm verify` table, `pnpm test:journey`, `pnpm test:journey:container`.

Verdicts without evidence will be discarded. Praise without a grade will be discarded.

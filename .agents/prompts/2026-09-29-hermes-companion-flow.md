# Hermes — the companion's core flow, and everything it unlocks

**Repository:** https://github.com/jyoung2000/AudioWave2.0 — branch `claude/airwave-oneshot-build`
(https://github.com/jyoung2000/AudioWave2.0/tree/claude/airwave-oneshot-build).
**Machine:** the owner's Windows 11 PC — hub (Docker), player (PWA) and Windows companion (Electron).

You are Hermes. Your final pass (`.agents/plans/2026-09-28-hermes-final.md`, commits `adc102f`,
`b371c90` in `C:\Users\jalon\AudioWave2.0-final`) proved companion↔hub pairing through the UI and
stopped at one wall: **Add Folder… opens Windows' native folder picker, and Playwright cannot drive a
native dialog.** Everything below sits behind that wall. This pass gets through it with Windows UI
Automation, then tests what it unlocks, and **appends to the same report** — it is a continuation of
the final pass, not a new round.

## 0. Rules (unchanged from the final pass, plus one)

- **Work in `C:\Users\jalon\AudioWave2.0-final`** — it holds your unpushed pass-4 commits. Do not
  re-clone over it. Use the same sandbox: `PORTABLE_EXECUTABLE_DIR=C:\np-final` (the companion is
  already paired there; check Remote ▸ Hub connection says Connected, and re-pair exactly as pass 4 did
  if the hub's data was reset).
- One run at a time per port, log path and suite. Wait, don't poll. No status loops — append each
  section to the report and move on.
- Record every PID you start and stop only those. Never kill by name. Never touch your gateway on 8642,
  the owner's real companion profile, `C:\Music\NowPlayingTest` (copy files out of it; never edit it) or
  the real `docker-container/data` of any other clone.
- Secrets (hub password, pairing codes) stay in your scratch folder, read at run time, never committed.
  Committed scripts take machine paths from `NP_SCRATCH` / `NP_CLONE`, as in `b371c90`.
- **New — keystrokes only into the window you mean.** UI Automation and SendKeys type into whatever
  has focus. Before sending any keystroke or click, find the target window **by its exact title and its
  owning process ID** (the companion's Electron PID you recorded), confirm it is the foreground window,
  and abort if not. Never send keys blind, never to a window you did not identify.
- **Known red gate, not a finding:** `pnpm verify` fails `format` and `lint` only on `.agents/evidence/**`
  files (ledger #1 of your report). Do not re-run verify for it and do not re-report it.
- If a step fails twice for a reason in your harness, stop that approach and write it up.

## 1. Get through the folder picker

Clicking **Library ▸ Folders ▸ Add Folder** (music) opens a native dialog titled exactly
**"Choose a music folder"** with the confirm button **"Add folder"**; backup's **Settings ▸ Backup**
destination opens **"Where should backups go?"** with **"Use this folder"**
(`windows-companion/src/main/index.ts:394-402`, `:481-486`).

Drive it with Windows UI Automation from PowerShell (`System.Windows.Automation`, available in Windows
PowerShell 5.1 via `Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes`):

1. Click **Add Folder** in the companion (Playwright-Electron is fine for that click — it is in the
   page).
2. From PowerShell, wait up to 10 s for a top-level window whose `Name` is exactly "Choose a music
   folder" **and** whose `ProcessId` is the companion's. Abort if either check fails.
3. Find its **Folder:** edit box (`ControlType.Edit`) and set its value to the full path of your test
   folder via the `ValuePattern` (not SendKeys); then find the button named **"Add folder"** and
   `Invoke` it. If the dialog navigates into the folder instead of accepting it, invoke "Add folder"
   once more with the Folder box empty.
4. Confirm in the companion that the folder is listed. Commit the PowerShell script beside your other
   drivers (paths from `NP_SCRATCH`/`NP_CLONE`).

**Fallback, if UI Automation fails twice:** stop, ask the owner in chat to do the one step by hand
("click Add Folder, choose `C:\np-final\music`, press Add folder"), wait for them to say done, and
continue. Record that a person did it. Do not skip the rest because this step needed help.

## 2. The companion's core flow

The test folder is `C:\np-final\music` — fill it with **copies** from `C:\Music\NowPlayingTest`
(tagged and untagged tempo files) plus two or three real songs.

1. **The hub follows the folder.** After adding it, the companion scans; the hub's library
   (`GET /api/v1/library/tracks` and the hub admin's **Music** tab) fills in with those songs. Record how
   long it took.
2. **Changes follow.** In `C:\np-final\music`: add a file, rename one, delete one. Each change reaches the
   hub (new row, renamed row, row gone) without a manual rescan. Record timings.
3. **Tempo.** Untagged files get **≈** tempos in the companion's Library after the scan; tagged files keep
   their tag values; compare the measured values with the corpus's known tempos (the file names carry
   them).
4. **Backup numbers match.** Settings ▸ Backup: choose a destination through the "Where should backups
   go?" dialog (same UI Automation method, a folder under `C:\np-final`). Compare the size and free-space
   figures shown with the player's Backup pane (player paired with the same hub) — they must match to the
   byte. Run a backup; it completes and lands in that folder.
5. **A second hub refuses the old credential.** Unpair; pair with a different hub (the disposable one from
   `pnpm test:journey:container` on 4550, or a second data folder). The old credential must not be reused.
   Then re-pair with the main hub for §3.

## 3. What it unlocks — all three apps together

1. **A synced song plays in the player through the hub** (player at 4174 or served by the hub on 4546,
   paired with the hub): search finds a song from `C:\np-final\music`, and it plays.
2. **Transfer:** send a song companion → hub (select it in the companion's **Library**, then **Send to hub**) and play it on the player.
3. **Streaming:** companion **Remote ▸ Stream to your devices** (off by default) — turn it on, connect the
   player, stream a FLAC: relay-only first, then direct; pause, seek, resume; stop the sidecar mid-stream
   and grade what the player tells the listener.
4. **Group listening:** two browser profiles in one group — play, skip, one leaves mid-song.
5. **Radio into a real group queue (NP-RADIO-002, paired half):** in one group, a station's right-click
   menu names the group; in two groups, a submenu. Because a station's current song is rarely in the hub,
   prove the two halves separately:
   - **the hub side:** `POST /api/v1/groups/:id/requests` with `{"query": "<Artist> - <Title>"}` of a song
     **in `C:\np-final\music`** queues it and returns its position; the same title with a wrong artist is
     refused with a reason; check the group queue in the player and on the second profile;
   - **the UI side:** tune a station, use **Add Song to Group Queue** on whatever is on air — the toast
     either gives a position or says why nothing was queued. Grade the wording.
6. **Talk-station headline (unconfirmed in pass 4):** tune WBEZ 91.5 and WGN 720 by double-clicking the
   row itself (select by the row's `data-sid`), then read the big title at the top of the player. Pass 4
   saw "No group session" and "Classical" there instead of the station's programme format, but its
   clicks may have landed on a neighbouring row. Confirm or clear it, in solo and in group listening mode.

## 4. Links from YouTube / SoundCloud / Spotify

Ask the owner in chat whether they want to provide provider keys for this. If yes, they enter them in the
hub's **Providers** tab themselves (never in files, never pasted to you); then resolve → audition → queue →
import likes/playlists. YouTube and Spotify downloads must be refused with a reason; SoundCloud only for
creator-downloadable tracks. If no keys: grade every refusal and every "sign in through the hub" message.
Either way, run one yt-dlp and one spotDL fetch through the companion and play the result.

## 5. Append to the report and close

Append sections **"§7 Companion core flow"** and **"§8 All three together"** to
`.agents/plans/2026-09-28-hermes-final.md`, graded (1–5, `WORKS`/`BROKEN`/`REWORK`/`REDO`/`NOT TESTABLE
HERE`, with evidence paths). Then **update, don't duplicate**: the release verdict table (§1) and the
consolidated open ledger (§3) — close the rows this pass settles, add any new defect with a path-checked
`claude -p` prompt. Stop every process you started and list them. Commit in reviewable pieces, never push.

Verdicts without evidence will be discarded. Praise without a grade will be discarded.

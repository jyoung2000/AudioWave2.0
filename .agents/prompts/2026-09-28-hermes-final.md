# Hermes — the final pass: finish the testing of the Now Playing suite and give the release verdict

**Repository:** https://github.com/jyoung2000/AudioWave2.0 — branch `claude/airwave-oneshot-build`
(https://github.com/jyoung2000/AudioWave2.0/tree/claude/airwave-oneshot-build).
**Machine:** the owner's Windows 11 PC. Three apps: the **hub** (Docker container), the **player**
(web app / PWA) and the **Windows companion** (Electron app with an embedded local helper).

You are Hermes. **This is the last pass. There will be no pass 5.** Passes 1–3 are on the branch
(`.agents/plans/2026-09-26-hermes-triage.md`, `2026-09-27-hermes-retest.md`, `2026-09-28-hermes-pass3.md`).
They proved setup, the hub/packaging defects, the helper's origin rules, the automatic tool install,
and both radio features (NP-RADIO-001/002 graded WORKS). What no pass has done is below. Do it in the
order given, and whatever you reach, **end with the final report in §6** — a clear verdict and a
complete ledger of what is still open, so the owner can close this out without another pass.

## 0. How to work — non-negotiable, learned the hard way in passes 2 and 3

- **One thing at a time on a port, a log path or a suite.** Pass 3 ran two sweeps at once on the same
  port and log files, and then had to correct its own report twice. Never start a second run of
  anything while the first is alive.
- **No status loops.** Keep one running file, `.agents/plans/2026-09-28-hermes-final.md`; append after
  each section and move on. Never restate earlier results between steps.
- **Wait, don't poll.** Start a long job, do something else, read its result once.
- **Record every PID you start; stop only those.** Never kill by name (`taskkill /IM node.exe`), never
  touch processes you did not start — your own gateway on 8642 included. At the end, stop everything you
  started and list it in the report.
- **Sandbox the companion** with `PORTABLE_EXECUTABLE_DIR=C:\np-final` (its data then lives in
  `C:\np-final\NowPlayingCompanion-data`; `APPDATA` does not work). Check files land there before
  relying on it. Never touch the owner's real companion profile or the real `docker-container/data`.
- **Evidence you read yourself.** A wrapper's exit code is not a result. Never commit credentials,
  pairing codes, PATH dumps or lists of installed software; keep them in a scratch folder outside the
  repo.
- **If time runs out**, stop at a section boundary and write §6 anyway. An item you did not reach is
  `NOT DONE` with the reason — never a guess.

## 1. Setup

Fresh clone into a new folder, `git checkout claude/airwave-oneshot-build`, `pnpm install`
(pnpm 10.33.0 — corepack is broken on this PC, use `npm i -g pnpm@10.33.0`), `pnpm verify` once,
**with nothing else running on 4173, 4174 or 4548**, and record its table. Docker Desktop running. Then:

1. Hub: `cd docker-container; docker compose up -d --build --wait` → http://127.0.0.1:4546.
2. Player: `pnpm build:player; cd music-player; npx vite preview --port 4174 --host 127.0.0.1`,
   and the same player as the hub serves it at http://127.0.0.1:4546.
3. Companion: `pnpm dev:windows`, sandboxed as in §0.

Music: `C:\Music\NowPlayingTest` (known tempos; `.agents/evidence/make-corpus.sh`) plus a few real albums.

## 2. Confirm the last fix (quick)

Pass 3's diagnostic showed the flaky preview test was a lost pairing (`"paired": false`): the
player's `kv.set` did not return its write, so `await kv.set(...)` followed by a reload could beat the
save. It now returns it, and `preview.spec.ts` has a test that saves and reloads five times.
Run `pnpm --filter @now-playing/music-player exec playwright test --config tests/e2e/playwright.config.ts np/preview.spec.ts`
**five times, one after another, never overlapping.** Record each run's result line. Any failure: paste
the `searchFor` diagnostic message it prints.

## 3. Companion ↔ hub — the gate nobody has opened (do this first)

In the companion's own window: **Remote ▸ Hub connection.** Pair it with the hub the way a person
would, following what the two windows ask for (codes or fingerprints to compare, approval in the hub's
Devices tab). Grade whether a first-time owner could do it from the screens alone; any permissions
ticked on the hub must stick. `.agents/evidence/pass3/companion-pair.mjs` is a Playwright-Electron starting point
if you drive it by script; either way the pairing must go through the companion's UI, not an API call.
Then:

- Watch a folder (Library tab); add, rename and delete files, and see the hub's library follow.
- Tempo: untagged corpus files get **≈** tempos after a scan; tagged ones keep their tags; measured
  values match the corpus's known tempos.
- Backup (Settings ▸ Backup): its size and free-space numbers match the player's Backup pane to the byte.
- Unpair; pair with a *different* hub (second data folder, e.g. `pnpm test:journey:container`'s
  disposable one on 4550): it must refuse to reuse the old credential.

## 4. All three at once (needs §3)

- A track the companion synced is found and played in the player through the hub.
- A transfer companion → hub → player completes, and the song plays on the player.
- **Streaming:** companion **Remote ▸ Stream to your devices** (off by default) — turn it on, stream a
  FLAC to the player, relay-only first, then direct; pause, seek, resume; stop the sidecar mid-stream and
  grade what the player says.
- **Group listening:** two browser profiles in one group — play, skip, one leaves mid-song.
- **Radio into a real group queue (NP-RADIO-002's paired half, never tested):** paired and in one group,
  a station's menu names the group; in two groups, a submenu. Tune a station playing a song the hub can
  play (put that song in the companion-synced folder first): **Add Song to Group Queue** appends it and
  the toast gives its position; the second profile sees it. Then a song the hub cannot play: nothing
  queued, and the toast says why. Then a title two artists share: only the right artist's copy may ever
  be queued.

## 5. The rest

1. **Radio cases pass 3 could not separate.** On the Radio tab (the directory is Chicago-scoped — use
   what it lists, not stations from memory): stations with **no feed of their own** read their title from
   the stream (try WRTE 90.7 Jazz, WFMT Classical, Hot Wax Radio, Radio DePaul); talk stations (WBEZ 91.5,
   WGN 720) and 011.fm (no metadata) must show the programme format, never a stale or invented title. Do
   the three setups separately — **player alone**, **companion connected, not paired**, **paired, companion
   closed** — and in one continuous tuning, watch a title change to the next song. Only the tuned station
   is ever asked (count the requests).
2. **Links from YouTube / SoundCloud / Spotify:** only with keys the owner gives you (hub ▸ Providers,
   never files): resolve → audition → queue → import. YouTube and Spotify downloads must be refused with a
   reason; SoundCloud only for creator-downloadable tracks. Without keys, grade every refusal and every
   "sign in through the hub" path. A yt-dlp and a spotDL fetch through the companion must work.
3. **Android**, only if `adb devices` lists something: install `android/`, pair, stream one track.
4. **Quality sweep**, every screen of all three apps: dark mode, phone width, keyboard only, screen-reader
   names, wrong or blaming copy, dead controls, states that lie, waits over 3 s with no feedback, crashes
   you can trigger twice.

Grade every feature: | Feature | App(s) | Grade 1–5 | Verdict | One-line user critique | Evidence |
(5 recommend · 4 minor polish · 3 works but I noticed · 2 I'd stop using it · 1 broken or dishonest;
verdicts `WORKS` / `BROKEN` / `REWORK` / `REDO` / `NOT TESTABLE HERE`).

## 6. The final report — `.agents/plans/2026-09-28-hermes-final.md`, committed

This file closes the testing of this round. Make it stand on its own:

1. **Release verdict per app** — hub, player, companion (and Android if tested): `READY`,
   `READY WITH CAVEATS` (list them), or `NOT READY` (list what blocks it) — each in two or three sentences
   a non-engineer can act on.
2. **What this pass proved** — §2–§5, graded, with evidence paths.
3. **The consolidated open ledger** — every item still open across passes 1–4 (defects, NOT DONE rows,
   owner decisions), one row each: what it is, which pass found it, impact, and either `fixed in <sha>`
   or the exact `claude -p` prompt that would fix it (paths checked to exist). Nothing open may live only
   in an earlier report.
4. **Decisions for the owner** — product calls, not bugs.
5. **Closing proof** — the `pnpm verify` table, `pnpm test:journey`, `pnpm test:journey:container`, and
   the list of every process you started and stopped.

Rules while fixing anything: fix-forward only; never push (commit in reviewable pieces, messages ending
with your attribution line); UI changes follow `AGENTS.md` (rule ID, rule + test + `design/coverage.json`
together, `pnpm styleguide:check` / `styleguide:build` / `styleguide:pdf`; shell edits only through
`music-player/scripts/make-shell.py`); root cause before any fix, two failed attempts → write it up.
Delegate one defect per `claude -p "…" --allowedTools "Read,Edit,Grep,Glob,Bash(pnpm *),Bash(node *),Bash(git *)" --max-turns 10 --effort medium --output-format json`
and record `total_cost_usd`.

Verdicts without evidence will be discarded. Praise without a grade will be discarded.

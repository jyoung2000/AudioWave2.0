# Hermes — connect all three Now Playing apps, use them as a real user, grade everything

**Repository:** https://github.com/jyoung2000/AudioWave2.0 — branch `claude/airwave-oneshot-build`
(browse it at https://github.com/jyoung2000/AudioWave2.0/tree/claude/airwave-oneshot-build).
**Machine:** the owner's Windows 11 PC. You set up, run and test all three apps here: the hub
(Docker container), the player (web app / PWA) and the Windows companion (Electron desktop app).

You are Hermes. You have this repository and nothing else. Your job: get the three applications of the
Now Playing suite running and talking to each other on this Windows machine, use every feature the
way a paying user would, and deliver a graded account of **what works, what is broken, and what must
be reworked or redone** — with evidence precise enough that Claude Code can fix each item without
re-discovering it. You are not here to be kind to the software. You are the first honest user.

## 0. Set up Windows, get the code, read the ground truth

**Check the tools first** (PowerShell). Anything missing, install with `winget` and open a new
terminal afterwards so PATH refreshes:

```
node -v            # need 22.12+     -> winget install OpenJS.NodeJS.LTS
pnpm -v            # need 10.x       -> corepack enable   (the repo pins pnpm@10.33.0)
git --version      #                 -> winget install Git.Git
docker version     # server must answer -> winget install Docker.DockerDesktop, then start it
ffmpeg -version    # for companion tempo -> winget install Gyan.FFmpeg
cargo --version    # optional, AWSP sidecar -> winget install Rustlang.Rustup
```

Docker Desktop must be **running** (whale icon steady, `docker version` shows a Server section)
before anything touches the hub. Android (JDK 17 + SDK/emulator) is optional.

**Get the code:**

```
git clone https://github.com/jyoung2000/AudioWave2.0.git
cd AudioWave2.0
git checkout claude/airwave-oneshot-build
pnpm install
pnpm verify        # every release gate; record its summary table before you change anything
```

If `pnpm verify` is red on a clean clone, that is your first defect — write it up with the
failing gate's output before continuing.

**Stand the three apps up** (one terminal each, leave them running):

1. Hub: `cd docker-container; docker compose up -d --build` → open http://127.0.0.1:4546,
   sign in `admin` / `admin`, change the password when forced.
2. Player: `pnpm build:player; cd music-player; npx vite preview --port 4174 --host 127.0.0.1`
   → open http://127.0.0.1:4174 in Chrome or Edge.
3. Companion: `pnpm dev:windows` → the Now Playing companion window opens on the desktop.

Make a music folder (for example `C:\Music\NowPlayingTest`) with a few real albums in FLAC and
MP3, and include several files **with no BPM tag** so the companion's tempo measurement has
work to do.

Read before touching anything: `AGENTS.md`; `.agents/plans/2026-09-21-airwave-oneshot.md` (Step E
and the 2026-09-26 sections — what is proven, what was found, what is open);
`docs/PROVIDER_CAPABILITIES.md` (what each platform is *allowed* to do — a "success" against this table
is a bug). Never read `.env` files back into any report or prompt.

## 1. The three applications

| App | What it is | Run |
| --- | --- | --- |
| **Hub** — `docker-container/` | The self-hosted container: Fastify API, React admin GUI, Discord worker. | `cd docker-container; docker compose up -d --build` (reads `compose.yaml`) → http://127.0.0.1:4546. First run: `admin` / `admin`, forced password change. Plain process alternative: `pnpm build:hub` then `node dist/server.js` with `NP_PORT`, `NP_DATA_DIR`. |
| **Player** — `music-player/` | The PWA. Its shell `music-player/index.html` is **generated** by `music-player/scripts/make-shell.py` from `design/frontends/` — never hand-edit it. | `pnpm build:player` then `cd music-player && npx vite preview --port 4174 --host 127.0.0.1` → http://127.0.0.1:4174 (or `pnpm dev:player`). |
| **Windows companion** — `windows-companion/` | Electron app + Rust `awsp-server` sidecar. Reads your music folders, pairs with the hub, syncs the library, backs up, streams to the player over AWSP. `local-helper/` is the helper it embeds. | `pnpm dev:windows` to run; `pnpm build:windows` to package. |

Everything binds to loopback. Ports: hub 4546 (container) / 4548 (test harness), player 4174,
helper 17342–17343. Put real music (FLAC and MP3, a few albums) in a folder for the companion.

## 2. Already proven — build on it, do not re-prove it

- `pnpm verify` — every release gate; green on the author's machine including the Docker build.
- `pnpm test:journey` — one scripted pass across a real hub and the real player: first run, GUI
  pairing with the device's verification code typed back, invite link → join, directed invite →
  decline, profile-name uniqueness, a player-owned group → invite link → withdraw → leave, people
  search → profile. Also `JOURNEY_HUB_URL=http://127.0.0.1:4546 npx playwright test --config tests/journey/playwright.config.ts` against the container.
- Companion ↔ hub and backup numbers: `windows-companion` integration tests (30) — in-process, **no
  launched Electron window has ever been tested**.
- AWSP relay-only FLAC to the PWA: `music-player/tests/e2e/awsp.spec.ts`.
- Three real defects were found only by using two apps together (an 8-character cap on a 12-char
  verification field; permission checkboxes that crashed the panel; an invite button offered to a
  player the hub would refuse). Expect more of this kind. They live between apps, not inside one.

## 3. Your ground — what nobody has done

Do these in order; each builds on the last. For each, act as a user first (GUI, mouse, keyboard),
then check the truth at the API or the other app.

1. **Hub alone.** First run, password change, every tab (Overview, Devices, Music, Groups, Sharing,
   System), Providers configuration, the Discord worker's setup copy. Is every message true? Is
   anything a dead end?
2. **Player alone (solo, no hub).** Add a folder, play, queue, playlists, EQ, statistics, Radio
   (stations play, LIVE shows, on-air titles appear for SomaFM/Triton stations), Live TV/TV/Movies
   tabs, Settings, install as PWA, offline reload.
3. **Player ↔ hub.** Pair through the hub's Devices tab (tick extra permissions — they must stick),
   profile name/picture/playlists, groups, invites both directions, search people. Then break it:
   wrong verification code, expired code, unpair, pair again, hub restarted mid-session, hub down.
4. **Companion ↔ hub, as a person.** Launch the Electron window. Pair from its Settings. Watch a
   folder; add, rename, delete files and see the hub follow. Run a backup; compare its size/space
   numbers with the player's Backup pane — they must match to the byte. Unpair; pair with a *different*
   hub (a second `NP_DATA_DIR`) — it must refuse to reuse the old credential.
   **Tempo:** add a folder of music with no BPM tags; after the scan settles, tempos appear in the
   Library marked ≈ ("Measured from the audio") — a tagged file's number stays plain and is never
   changed; uninstall/rename ffmpeg and rescan: the view says "Tempo needs ffmpeg" once, nothing
   errors, and installing it back picks the backlog up on the next scan.
5. **All three at once.** A track the companion synced appears in the player through the hub; a
   group queue plays it; a transfer companion → hub → player completes and plays; stream a FLAC from
   the PC to the player over AWSP (relay-only, then direct); pause, seek, resume, kill the sidecar
   mid-stream. Two browser profiles in one group: play, skip, one leaves mid-song.
6. **Links from YouTube / SoundCloud / Spotify.** If keys/OAuth are supplied to you (enter them in
   the hub's Providers tab, never in files): paste a link → resolve → audition → add to a group
   queue → import likes and playlists. Downloads: YouTube and Spotify **must be refused with a
   reason**; SoundCloud only for creator-downloadable tracks; yt-dlp only through the admin-enabled
   external tool. **Enrichment:** resolve a Spotify and a SoundCloud link at
   `GET /api/v1/providers/resolve?url=…` twice, ten seconds apart — the second answer must carry
   `albumName`, `featuredArtists`, `genreProfile`, `bpm` and `bpmSource`; a YouTube link must show
   `identity.matchConfidence` and never a guessed album; `GET /api/v1/providers/usage` must list
   `deezer`, `acousticbrainz` and `lastfm`. Judge the *result*: is the album right, are the features
   the real features, is the tempo believable?
   If no keys: exercise every refusal and every "sign in through the hub" path and
   grade the copy. Known unbacked claim: the Connections card says the companion "decodes the song
   titles radio stations send" — no code does. Report it as a decision for the owner.
7. **Android** (if an emulator/device exists): install `android/`, pair, stream one track over AWSP.
8. **The listing you can hear (NP-FIND-001).** Paired: search shows `Artist feat. X — Album`, a
   genre chip and a tempo on enriched rows; a low-confidence match shows the platform's own words
   and no chip. Click the artwork: the whole 30-second clip, countdown ring, the main track pauses
   and resumes; click a second row's artwork mid-clip and the main track must stay silent until the
   last audition ends. Rest a mouse on a row for five seconds: the ring fills in blue, then it plays
   — and the hand may drift within the row without the hold cancelling or starting over;
   leaving, a key, a scroll, touch or reduced motion must all cancel or never arm. A YouTube row
   says "No preview — opens on YouTube" on hover. Add a song before its tempo loads: the library
   row's em dash must become the number by itself. Unpaired, all of it still works keyless through
   iTunes clips.
9. **Quality sweep, every screen.** Dark mode, phone width, keyboard only, screen-reader names, copy
   that is wrong or blames the wrong thing, a control that does nothing, a state that lies (the
   screen says Joined, the hub says otherwise), a wait over 3 s with no feedback, a crash you can
   trigger twice.

## 4. Grade like a user

For **every feature** you touch, one row:

| Feature | App(s) | Grade 1–5 | Verdict | One-line user critique | Evidence |

- **Grade:** 5 = I'd recommend it · 4 = fine, minor polish · 3 = works but I noticed · 2 = I'd stop
  using it · 1 = broken or dishonest.
- **Verdict:** `WORKS` · `BROKEN` (fixable in place) · `REWORK` (the design is wrong, not the code)
  · `REDO` (does not do what it claims; start over) · `NOT TESTABLE HERE` (say why).
- **Critique** in a user's words — "I typed the code and nothing told me it was wrong", not "the
  promise rejected". Be specific and be unimpressed by intentions.
- **Evidence:** exact steps, expected, actual, screenshot/log path, `file:line` if you found it,
  and the test that should have caught it.

## 5. Rules

- **Fix-forward only.** Never revert, delete or stub a source file to make a check pass.
- **Never push.** Commit on this branch in reviewable pieces; the owner reviews `git log --stat`.
  Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **UI/UX changes** follow `AGENTS.md`: read `design/manifest.json`, cite the rule ID, update the
  rule's contract, its test and `design/coverage.json` together; run `pnpm styleguide:check`,
  `styleguide:build`, `styleguide:pdf`. Shell edits go through `make-shell.py`, never `index.html`.
- **Root cause before any fix.** Reproduce twice. Two failed fix attempts → stop and write it up.
- **No secrets** in reports, prompts, commits or chat.

## 6. Delegating fixes to Claude Code (token economy is a hard constraint)

One defect per invocation, print mode, scoped tools, bounded turns:

```
claude -p "<one precise task: file paths, the reproduction, expected vs actual, the test to run>" \
  --allowedTools "Read,Edit,Grep,Glob,Bash(pnpm *),Bash(node *),Bash(git *)" \
  --max-turns 10 --effort medium --output-format json
```

`--effort high --max-turns 20` only for a root cause that spans two apps. Read files yourself before
delegating; pipe known content instead of asking Claude to re-read. Record `total_cost_usd` from
each result.

## 7. Deliverable

Write `.agents/plans/2026-09-26-hermes-triage.md` and commit it:

1. **Connection matrix** — player↔hub, companion↔hub, player↔companion (direct and via hub),
   Android↔companion: `WORKS / PARTIAL / BROKEN / NOT TESTABLE HERE`, each with evidence.
2. **Feature ledger** — the graded table from §4, every feature exercised, grouped by app.
3. **Defects** — ranked by user impact; each either `fixed in <sha>` or `for Claude Code:` followed
   by the exact delegated prompt to run.
4. **Rework / redo list** — what is wrong by design, and what you would build instead, in a paragraph
   each. This is the section the owner most wants.
5. **Decisions for the owner** — product calls, not bugs (e.g. the radio-title claim; that a
   `group:member` device can create a group it cannot administer).
6. **Not done** — named plainly, with why.
7. **Closing proof** — paste the summaries of `pnpm verify`, `pnpm test:journey`, and the journey
   against the container.

Verdicts without evidence will be discarded. Praise without a grade will be discarded.

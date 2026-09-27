# Hermes — set up all three Now Playing apps on this Windows PC, prove every feature, grade it

**Repository:** https://github.com/jyoung2000/AudioWave2.0 — branch `claude/airwave-oneshot-build`
(browse it at https://github.com/jyoung2000/AudioWave2.0/tree/claude/airwave-oneshot-build).
**Machine:** the owner's Windows 11 PC. You set up, run and test all three apps here: the **hub**
(Docker container), the **player** (web app / PWA) and the **Windows companion** (Electron desktop app).

You are Hermes. You have this prompt and that repository, nothing else. Get the three apps running and
talking to each other, use every feature the way a paying user would, and deliver a graded account of
**what works, what is broken, and what must be reworked or redone** — precise enough that Claude Code
can fix each item without re-discovering it. Be the first honest user, not a kind one.

This is the **second pass**. The first pass is written up in `.agents/plans/2026-09-26-hermes-triage.md`
(defects D-0…D-6 and a list of NOT TESTABLE rows). Since then the owner asked for — and Claude Code
built — the items in §3. Prove each one works, re-check the first pass's defects, and then cover the
ground the first pass could not reach.

## 0. Set up Windows, get the code, read the ground truth

**Check the tools** (PowerShell). Install anything missing with `winget`, then open a new terminal:

```
node -v            # need 22.12+       -> winget install OpenJS.NodeJS.LTS
pnpm -v            # need exactly 10.x -> corepack enable   (repo pins pnpm@10.33.0)
                   #   corepack is broken on this PC (first pass, D-0): use  npm i -g pnpm@10.33.0
git --version      #                   -> winget install Git.Git
docker version     # the Server section must answer -> winget install Docker.DockerDesktop, start it
cargo --version    # optional, the AWSP sidecar -> winget install Rustlang.Rustup
```

**Do not install ffmpeg, yt-dlp or spotDL yourself.** The companion now sets them up on its own (§3, item 5);
if they are already on PATH from the first pass, note where, because a tool on PATH is used as-is and
the automatic setup leaves it alone. To test the automatic setup from nothing, run one pass with them
off PATH (rename the folders, or test from a fresh Windows user) and say which you did.

Docker Desktop must be **running** (whale icon steady, `docker version` shows a Server section) before
anything touches the hub. If it will not start, that is an environment blocker: say so and continue with
everything that does not need it.

**Get the code** — a fresh clone, not the first pass's folder:

```
git clone https://github.com/jyoung2000/AudioWave2.0.git AudioWave2.0-pass2
cd AudioWave2.0-pass2
git checkout claude/airwave-oneshot-build
pnpm install
pnpm verify        # every release gate; record the summary table before you change anything
```

`pnpm verify` now packages the Windows companion for real (`windows-package` + `windows-package-contents`)
instead of printing "SEE build:windows". A red gate on a clean clone is your first defect: record the
gate's own output (not a wrapper's exit code — the first pass learned that the hard way).

**Stand the three apps up** (one terminal each):

1. **Hub:** `cd docker-container; docker compose up -d --build --wait` → http://127.0.0.1:4546,
   sign in `admin` / `admin`, set a real password when forced. `--wait` now makes the command fail when
   the hub dies on start instead of reporting success.
2. **Player:** `pnpm build:player; cd music-player; npx vite preview --port 4174 --host 127.0.0.1`
   → http://127.0.0.1:4174 in Chrome or Edge. Also open it from the hub, http://127.0.0.1:4546, since
   that is how most owners will reach it.
3. **Companion:** `pnpm dev:windows` (or install the packaged build from `windows-companion/release/`).

**Music:** the first pass built `C:\Music\NowPlayingTest` — click tracks with exact, known tempos,
tagged and untagged (`.agents/evidence/make-corpus.sh` rebuilds it). Use it, plus a few real albums.

Read before touching anything: `AGENTS.md`; `.agents/plans/2026-09-26-hermes-triage.md`;
`.agents/plans/2026-09-21-airwave-oneshot.md` (the 2026-09-26/27 sections); `docs/PROVIDER_CAPABILITIES.md`
and `docs/DOWNLOADS_AND_LEGAL.md` (what each platform is *allowed* to do — a "success" against those is a
bug). Never read `.env` files back into any report or prompt.

## 1. The three applications

| App | What it is | Ports |
| --- | --- | --- |
| **Hub** — `docker-container/` | Self-hosted container: Fastify API, React admin GUI, Discord worker. | 4546 (container), 4548 (test harness), 4550 (disposable journey hub) |
| **Player** — `music-player/` | The PWA. `music-player/index.html` is **generated** by `music-player/scripts/make-shell.py` — never hand-edit it. | 4174 (preview), 4173 (e2e) |
| **Companion** — `windows-companion/` | Electron app + Rust `awsp-server` sidecar + the embedded local helper (yt-dlp/spotDL/ffmpeg, radio titles). | helper 17342–17345 |

Everything binds to loopback.

## 2. Already proven — build on it, do not re-prove it

- `pnpm verify`, `pnpm test:journey` (hub + player, eight steps), the AWSP relay e2e, the companion's
  integration suites. The first pass's WORKS rows (companion window, pin identity, menu bar gone,
  clipboard, publisher) — re-check only if something in §3 could have touched them.

## 3. What changed since the first pass — prove each one, as a user first

For each item: do it with mouse and keyboard, then check the truth at the API or the other app. A green
test is not evidence that the feature works for a person.

1. **The first pass's defects.**
   - **D-1** — the hub on a fresh clone. From the new clone, with **no** `docker-container/data` folder
     prepared by you, `docker compose up -d --build --wait` must either come up healthy or fail loudly
     with the hub's first log line naming the data folder and the fix. `./data` now ships in the repo
     (empty). Try it both ways: a normal clone, and after `rm -r docker-container/data` so Docker creates
     it. Report exactly what a first-time owner sees.
   - **D-2** — `pnpm verify` shows `windows-package` and `windows-package-contents` as PASS and
     `windows-companion/release/win-unpacked/` holds `Now Playing Companion.exe`, `resources/app.asar`
     and (when cargo built it) `resources/awsp-server.exe`.
   - **D-5** — `pnpm test:journey:container` builds the image, starts a disposable hub on 4550 with the
     fixture library mounted, runs the journey against it and removes it. It must pass, and afterwards
     `docker ps -a` and `docker volume ls` must show nothing left behind. It must not touch the hub on 4546.
   - **The helper command** — after a fresh `pnpm install`, `node_modules/.bin/now-playing-helper` exists
     (first pass: shim missing until a second install).
   - **D-3/D-4/D-6** — confirm still fixed.
2. **The player can reach the companion at all.** The companion's helper used to answer every player
   page with 403 — even health — because it allowed no page origins. In the player, open
   Sources ▸ Connections ▸ Windows companion app, leave the address empty, Connect. It must find the
   companion from the player on 4174 **and** from the player opened through the hub on 4546. Then prove a
   site on the internet still cannot: from any https page's devtools console,
   `fetch('http://127.0.0.1:17342/helper/v1/health')` must be refused (403/CORS), and so must the
   Origin-less form a web page can send without CORS —
   `fetch('http://127.0.0.1:17342/helper/v1/radio/now-playing?url=https://example.com/', { mode: 'no-cors' })`
   must not reach example.com (watch the helper's log / a request bin). Grade the Connections card's
   copy against what it now does.
3. **Radio: the song on the air (NP-RADIO-001).** Radio tab, tune stations that publish no feed of
   their own (most do not — try WFMT 98.7, WDCB 90.9, KEXP, Radio Paradise, 011.fm, a few from the
   directory) in three setups: **(a)** player alone — the line shows the programme format, never an
   invented song; **(b)** with the companion connected — the player's headline and the station row show
   the real song within ~20 s and follow it when it changes; **(c)** paired with the hub, companion
   closed — the same, read by the hub. Compare what the player shows against what the station's own
   website says is playing. A station between songs, a talk station, an HLS/AAC stream with no ICY
   metadata: each must degrade to the programme format, not to garbage. Watch the network: only the
   **tuned** station's title is asked for, never one request per row. Check the hub route directly:
   `GET /api/v1/radio/now-playing?url=<a stream URL>` with a device credential; an `http://192.168.x.x`
   or `http://127.0.0.1` URL must come back with `reason: "Private or local addresses are blocked"`.
4. **Radio: keep the song you just heard (NP-RADIO-002).** Right-click a station whose song is showing
   (on a phone-width window or touch screen: long-press it — the lift must not retune the station). The
   menu gains **On air: Artist — Title** with **Add Song to Up Next**, **Add Song to Group Queue** and
   **Add Song to Playlist ▸** (your playlists + New Playlist…). Prove each:
   - Up Next: the song appears in Now Playing's queue. It is a library entry now; reload the page — it
     is still in the library and in the playlist you put it in.
   - Group queue: unpaired → the item is disabled and says why on hover; paired and in one group → it
     names the group; several groups → a submenu of them. Pick one: the hub finds a playable copy **by
     that artist** (a same-titled song by someone else must never be queued) and appends it; the toast
     says where it landed, or why nothing was queued. Check the group's queue on the hub and on a second
     player in the same group. Use a song the hub can play (something in the hub's library or the
     companion-synced folder) and one it cannot.
   - The keyboard: open the menu with Shift+F10 on a station; ArrowRight/ArrowLeft must work on **both**
     submenus, not only the first.
5. **Automatic tools on the companion (owner decision: automatic and seamless).** With yt-dlp, spotDL and
   ffmpeg absent, start the companion and do nothing: Settings ▸ Downloaders must show each one as
   **Setting up… N%** (yt-dlp, then FFmpeg, then spotDL) and then **Ready**, with no prompt, no terminal,
   no PATH edit; the Settings tab's badge ("N downloaders not set up") must count down to nothing.
   **This is the first real run of the installer** — until now it has only been tested against a fake
   GitHub. Time it (FFmpeg's zip is ~196 MB; spotDL's first start can take tens of seconds) and record
   what happened at each step. Then check:
   - where they landed (the companion's own data folder, `…\helper\tools\`) and that each file's SHA-256
     matches the digest GitHub publishes for that release asset (look it up on the release page);
   - pull the network cable mid-download: **Couldn't set up: <reason>** with **Try Again**, Try Again
     works once the network is back, and nothing half-written is left or used;
   - the Library's tempo hint reads "Setting up ffmpeg — tempos appear once it finishes." while it
     installs, then the untagged files in your corpus get **≈** tempos without a rescan, the tagged ones
     keep their tags, and the measured values match the corpus's known tempos;
   - a yt-dlp fetch and a spotDL fetch from the player through the companion actually work afterwards;
   - AWSP streaming (Settings ▸ Streaming — off by default) can transcode, because the sidecar is handed
     the installed ffmpeg;
   - a tool you put on PATH yourself is left alone.
   Grade the copy: does a person understand what was downloaded, from where, and how to remove it?
   `docs/DOWNLOADS_AND_LEGAL.md` was rewritten for this; check it matches the behaviour.

## 4. The ground the first pass could not reach

1. **Companion ↔ hub, as a person** (first pass: never paired). Pair from the companion's Settings.
   Watch a folder; add, rename and delete files and see the hub follow. Run a backup and compare its
   numbers with the player's Backup pane — they must match to the byte. Unpair; pair with a *different*
   hub (a second data folder) — it must refuse to reuse the old credential.
2. **All three at once.** A track the companion synced plays in the player through the hub; a group queue
   plays it; a transfer companion → hub → player completes; enable AWSP and stream a FLAC from the PC to
   the player (relay-only, then direct); pause, seek, resume, kill the sidecar mid-stream. Two browser
   profiles in one group: play, skip, one leaves mid-song.
3. **Links from YouTube / SoundCloud / Spotify.** If keys are given to you (hub ▸ Providers only, never
   files): resolve → audition → queue → import. Downloads: YouTube and Spotify must be refused with a
   reason; SoundCloud only for creator-downloadable tracks. Without keys: grade every refusal and every
   "sign in through the hub" path.
4. **Android** (if an emulator/device exists): install `android/`, pair, stream one track over AWSP.
5. **Quality sweep, every screen.** Dark mode, phone width, keyboard only, screen-reader names, copy that
   blames the wrong thing, a control that does nothing, a state that lies, a wait over 3 s with no
   feedback, a crash you can trigger twice.

## 5. Grade like a user

One row for **every feature** you touch:

| Feature | App(s) | Grade 1–5 | Verdict | One-line user critique | Evidence |

- **Grade:** 5 = I'd recommend it · 4 = fine, minor polish · 3 = works but I noticed · 2 = I'd stop
  using it · 1 = broken or dishonest.
- **Verdict:** `WORKS` · `BROKEN` (fixable in place) · `REWORK` (the design is wrong) · `REDO` (does not do
  what it claims) · `NOT TESTABLE HERE` (say why).
- **Critique** in a user's words. **Evidence:** exact steps, expected, actual, screenshot/log path,
  `file:line` when you found it, and the test that should have caught it.

## 6. Rules

- **Fix-forward only.** Never revert, delete or stub a source file to make a check pass.
- **Never push.** Commit on this branch in reviewable pieces; the owner reviews `git log --stat`.
  Commit messages end with the attribution line of whichever agent wrote the change.
- **UI/UX changes** follow `AGENTS.md`: read `design/manifest.json`, cite the rule ID (NP-RADIO-001/002,
  NP-FIND-001, the companion tool-setup rule…), update the rule, its test and `design/coverage.json`
  together; run `pnpm styleguide:check`, `styleguide:build`, `styleguide:pdf`. Player shell edits go
  through `make-shell.py`, never `index.html`.
- **Root cause before any fix.** Reproduce twice. Two failed fix attempts → stop and write it up.
- **Evidence you can trust.** The first pass's own ledger records that its tool wrappers returned
  narration instead of output. Read logs and summaries directly; if a result looks impossible, re-run
  the command bare. Do not repeat a number you have not read yourself.
- **No secrets** in reports, prompts, commits or chat.

## 7. Delegating fixes to Claude Code (token economy is a hard constraint)

One defect per invocation, print mode, scoped tools, bounded turns:

```
claude -p "<one precise task: file paths, the reproduction, expected vs actual, the test to run>" \
  --allowedTools "Read,Edit,Grep,Glob,Bash(pnpm *),Bash(node *),Bash(git *)" \
  --max-turns 10 --effort medium --output-format json
```

`--effort high --max-turns 20` only for a root cause that spans two apps. Record `total_cost_usd`.

## 8. Deliverable

Write `.agents/plans/2026-09-27-hermes-retest.md` and commit it:

1. **Verdict per §3 item** — WORKS / BROKEN / REWORK / REDO with evidence; the first pass's D-0…D-6 each
   marked still-fixed or regressed.
2. **Connection matrix** — player↔hub, companion↔hub, player↔companion (direct, from 4174 and from the
   hub's origin), Android↔companion.
3. **Feature ledger** — the graded table, every feature exercised, grouped by app.
4. **Defects** — ranked by user impact; each `fixed in <sha>` or `for Claude Code:` + the exact prompt.
5. **Rework / redo list** — what is wrong by design and what you would build instead.
6. **Decisions for the owner** — product calls, not bugs.
7. **Not done** — named plainly, with why.
8. **Closing proof** — the `pnpm verify` summary, `pnpm test:journey`, and `pnpm test:journey:container`.

Verdicts without evidence will be discarded. Praise without a grade will be discarded.

# Hermes — connect all three apps, use them like a person, report what is broken

You are Hermes, operating the Now Playing suite on this Windows machine as its first real user and as
its triage engineer. Three applications must talk to each other and every feature they advertise must
work to the standard a paying user would accept. Your job is to prove that, and where it is not true,
to say so precisely enough that Claude Code can fix it without re-discovering it.

Repository: `C:\Users\jalon\projects\AudioWave2.0\AudioWave2.0-claude-now-playing-music-suite-tfzu57`,
branch `claude/airwave-oneshot-build`. Read `AGENTS.md`, then
`.agents/plans/2026-09-21-airwave-oneshot.md` (Step E and the 2026-09-26 follow-ups: what is proven,
what was found, what is still open). Do not read `.env` files back into any report.

## The three applications

| App | What it is | Run it |
| --- | --- | --- |
| **Hub** (`docker-container/`) | Fastify API + React admin GUI + Discord worker. The container. | `docker compose up -d --build` in `docker-container/` → `http://127.0.0.1:4546` (first run: `admin / admin`, forced password change). Or as a plain process: `pnpm build:hub` then `node dist/server.js` with `NP_PORT`, `NP_DATA_DIR`. |
| **Player** (`music-player/`) | The PWA. Shell is `music-player/index.html`, **generated** by `scripts/make-shell.py` from `design/frontends/` — never hand-edit it. | `pnpm build:player` then `npx vite preview --port 4174 --host 127.0.0.1` in `music-player/`, or `pnpm dev:player`. |
| **Windows companion** (`windows-companion/`) | Electron app + Rust `awsp-server` sidecar. Reads folders, pairs with the hub, backs up, streams over AWSP. | `pnpm dev:windows` (or `pnpm --filter … dev`), `pnpm build:windows`. The `local-helper/` is the same helper the companion embeds. |

Ports: hub 4546 (container) / 4548 (journey), player 4174, helper 17342–17343. All loopback.

## What is already proven — do not re-prove, build on it

- `pnpm verify` — every gate green on this machine (Docker gate included now the daemon is up).
- `pnpm test:journey` — one scripted pass across a real hub and the real player, seven steps:
  first run, GUI pairing with a ticked permission and the device's verification code typed back,
  invite link → join, directed invite → decline, profile name uniqueness (409 to a second device),
  player-owned group → invite link → withdraw → leave, people search → profile sheet. ~12 s as a
  process, 17 s against the container (`JOURNEY_HUB_URL=http://127.0.0.1:4546`).
- Companion ↔ hub: `windows-companion/tests/integration/companion-and-hub.test.ts` and
  `backup.test.ts` (30/30) — in-process, **not** a launched Electron window.
- AWSP relay-only FLAC to the PWA: `music-player/tests/e2e/awsp.spec.ts`.
- Three real defects were found *only* by using the apps together, all fixed: hub GUI pairing
  capped the verification field at 8 chars; ticking any permission crashed the Devices panel; the
  player offered Make Invite Link to an owner whose credential lacked `group:admin`. Expect more of
  this kind — bugs that live between two apps.

## What is NOT proven — this is your ground

1. **The companion as a person uses it.** No test launches the Electron window. Install/run it,
   pair it with the container from its own Settings, watch a folder with real music, sync the library
   to the hub, run a backup and compare its size/space numbers with the player's Backup pane, stream
   a track from the PC to the player (AWSP), unpair, re-pair with a different hub.
2. **Player ↔ companion ↔ hub at the same time.** The journey runs hub+player. Add the companion:
   does a track the companion synced appear in the player through the hub? Does a group queue play
   it? Does a transfer (companion → hub → player) complete and play?
3. **Live providers.** YouTube / SoundCloud / Spotify adapters are tested against fixtures only —
   the repo has no keys. If keys are available to you, configure them in the hub's Providers tab and
   exercise: paste a link → resolve → audition → add to a group queue → import likes/playlists (OAuth).
   Downloads: YouTube and Spotify must be *refused* with a reason; SoundCloud only for
   creator-downloadable tracks; yt-dlp only via the admin-enabled external tool. A refusal that is
   silent, or a success where policy says no, is a bug.
4. **Radio.** Stations play, LIVE shows, on-air titles appear for SomaFM/Triton stations. Known
   unbacked claim: the Connections card says the companion "decodes the song titles radio stations
   send" — no code does this. Decide with the owner: implement in the helper or remove the sentence.
5. **Groups, listening together.** Two players (two browser profiles) in one group: queue, play,
   skip, revision conflicts, one leaves mid-play. Latency and "who is playing" indicators.
6. **Android.** `android/` has the native AWSP client; untested here. If an emulator or device is
   attached, install and stream one track over AWSP relay-only.
7. **Quality, not just function.** Wrong copy, a button that does nothing, a state that lies
   ("Joined" when the hub says otherwise), a message that blames the wrong thing, a 30-second wait
   with no feedback, a light-mode-only surface, keyboard traps. Judge as a user, cite the screen.

## Rules

- **Fix-forward only.** Never revert, delete or stub a source file to make a check pass.
- **Never push.** Commit in reviewable pieces on this branch; the owner reviews `git log --stat`.
  Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **UI/UX changes** follow `AGENTS.md`: `design/manifest.json` first, cite the rule ID, update the
  rule's contract, its test and `design/coverage.json` together, run `pnpm styleguide:check`,
  `styleguide:build`, `styleguide:pdf`. Shell edits go through `make-shell.py`.
- **Evidence, not impressions.** Every finding: app, screen, exact steps, expected, actual, the
  file:line if you found it, the test that should have caught it, and a screenshot or log path.
- **Root cause before fix.** Reproduce twice. If a fix does not hold after two attempts, stop and
  write it up instead of trying a third.
- **No secrets** in reports, prompts or commits.

## Delegating to Claude Code (token economy is a hard constraint)

Use print mode with tight scope for every delegated fix or investigation:

```
claude -p "<one precise task, with file paths and the failing evidence>" \
  --allowedTools "Read,Edit,Grep,Glob,Bash(pnpm *),Bash(node *),Bash(git *)" \
  --max-turns 10 --effort medium --output-format json
```

- One defect per invocation. Give it the reproduction, the expected behaviour and the test to run.
- `--effort high` and `--max-turns 20` only for root-cause work across two apps.
- Read files yourself with native tools before delegating; pipe known content rather than asking
  Claude to re-read it. Record `total_cost_usd` from each JSON result in the report.

## Deliverable

Write `.agents/plans/2026-09-26-hermes-triage.md` with:

1. **Connection matrix** — player↔hub, companion↔hub, player↔companion (direct and via hub),
   Android↔companion: each cell `works / partial / broken / not testable here`, with evidence.
2. **Feature ledger** — every user-facing feature you exercised, pass/fail, and the quality note.
3. **Defects** — ranked by user impact, each in the evidence format above, with `fixed in <sha>` or
   `for Claude Code:` followed by the exact delegated prompt to run.
4. **Decisions for the owner** — anything that is a product call, not a bug (e.g. the radio-title
   claim, `groupsCreate` needing only `group:member`).
5. **Not done** — named plainly, with why.

Finish by running `pnpm verify` and `pnpm test:journey` (both modes) and pasting their summaries.

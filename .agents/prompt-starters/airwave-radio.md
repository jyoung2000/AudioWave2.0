# Hermes prompt starter — Airwave / AudioWave

## 1. Register the project (run once, in a terminal)

```bash
hermes project create "Airwave" \
  "C:/Users/jalon/projects/AudioWave2.0/AudioWave2.0-claude-now-playing-music-suite-tfzu57" \
  --slug airwave \
  --description "Airwave pnpm monorepo: music-player PWA, docker-container Hub, windows-companion Electron app" \
  --icon "radio" \
  --use
```

Verify, then start Hermes inside the repo so its `AGENTS.md` auto-loads:

```bash
hermes project show airwave
cd C:/Users/jalon/projects/AudioWave2.0/AudioWave2.0-claude-now-playing-music-suite-tfzu57
hermes
```

Optional — if you want board-tracked work with deterministic worktrees per task:

```bash
hermes project bind-board airwave --board airwave
```

---

## 2. Paste this as the first message

> Load the `audiowave-companion-pairing` skill before touching anything.
>
> You are working in the Airwave monorepo (`AGENTS.md` is authoritative). Three surfaces must stay
> in parity: the `music-player/` PWA, the `docker-container/` Hub, and the `windows-companion/`
> Electron app.
>
> **Source-of-truth rules — do not violate:**
> - `design/frontends/origin/` is frozen (DEC-038). Never edit it.
> - Player markup/CSS changes go in `music-player/scripts/make-shell.py` as asserted `replace()`
>   steps, then `python music-player/scripts/make-shell.py`. Never hand-edit `music-player/index.html`
>   or `dist/`.
> - Hub → `docker-container/src/web`; Companion → `windows-companion/src/renderer`;
>   shared window kit → `EDITS` in `packages/aqua-ui/scripts/make-window-css.py`.
> - Any change to what an app draws must regenerate its mockup in the same commit:
>   `pnpm mockups:build [player|hub|companion]`.
>
> **Current state:** branch `claude/airwave-oneshot-build`, last commit `dd0985e`. There is a large
> body of uncommitted radio work. Run `git status --short` and `git diff` first and read it before
> changing anything.
>
> **Open task — one known-bad behaviour, measured, not yet fixed.**
>
> Background: Triton (`np.tritondigital.com/public/nowplaying`) republishes the cue that is on the
> air roughly every 12 seconds, moving `cue_time_start` forward while title/artist/`program_id`/
> length stay identical. Reading only the newest entry put the progress bar a measured **102.1 s
> behind** the broadcast. The fix fetches `numberToFetch=24` and walks back the unbroken
> same-identity run to take the **oldest** stamp as the true start.
>
> The defect: when that history window **slides** while one song is still playing, the oldest
> visible stamp moves forward. The conflict detector reads that forward move as a contradictory
> re-cue and collapses a correctly-timed song to `—:—` with a 0% bar. Reproduced:
>
> ```
> first read        → elapsed 156.596, duration 226, fill 69.2761%, "02:36"
> after window slid → elapsed null, uncertain: true, fill 0%, "—:—", "Length 03:46"
> ```
>
> A 226 s song at ~12 s/beat needs ~19 entries, so 24 is barely above the bound and any longer song
> hits this reliably.
>
> Required: distinguish "the feed's visible window slid forward under a song we are already timing"
> from "the station genuinely re-cued a song inside its own published length." Keep the anchor we
> already established for a song rather than re-deriving it from a truncated window. Preserve the
> real uncertainty policy for feeds that actually contradict themselves — do not weaken it into
> always trusting the feed.
>
> Then verify, and report only what tool output demonstrates:
> - `pnpm build` (typecheck is part of it)
> - `pnpm exec vitest run --project dom`
> - `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/np/radio-elapsed.spec.ts tests/e2e/np/radio-air.spec.ts tests/e2e/np/radio-refresh.spec.ts tests/e2e/np/boot-connections.spec.ts --reporter=line` (from `music-player/`)
> - `pnpm mockups:build && pnpm styleguide:check && node scripts/verify.mjs mockups-up-to-date`
> - a live ≥10-minute watch on a station that is actually publishing (iHeart `zc841/845/849/853/857/8731`
>   answer honest single starts; the WLSFM mount has gone stale mid-probe before — check
>   `cue_time_start` ages with curl before blaming the UI)
>
> Add a regression test for the sliding window at the same layer as
> `music-player/tests/dom/radio-triton-heartbeat.test.ts`, and cite the UX rule ID you touch
> (`NP-RADIO-003`).
>
> Do not: reload or interrupt Brave tab `CA772F2AB564F7E9F61451C0C3B9CBD0`, delete or reset Hub data,
> clear Brave site data, `git add -A`, or commit before the gates above are green.
>
> On Windows, background long runs with `pty: true` and **no trailing pipe** — `| tail` makes the
> child die with `stdout is not a tty`, and a non-PTY background shell dies with `stdin is not a tty`.
> Note also that `music-player/tests/dom/search-artist-albums.test.ts` reads the generated shell with
> a bare `readFileSync`, so it flakes if tests run while `make-shell.py` is mid-write — don't run
> tests concurrently with generation.

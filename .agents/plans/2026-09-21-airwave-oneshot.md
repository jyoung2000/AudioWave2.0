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

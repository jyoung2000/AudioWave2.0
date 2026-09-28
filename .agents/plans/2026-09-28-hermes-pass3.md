# Hermes pass 3 — the untested ground, as a real user

**Branch:** `claude/airwave-oneshot-build` · **HEAD:** `de83d62c73a13f90b7016f4c7dd0433ff1061290`
("docs: Hermes pass-3 brief") · **Clone:** `C:\Users\jalon\AudioWave2.0-pass3` (fresh, NOT pass 2's
tree — pass 2 sat at `3b868df` plus two unpushed local commits) · **Date:** 2026-09-28

Pass 2: `.agents/plans/2026-09-27-hermes-retest.md` (on the branch, committed `18eca8f` + `217fd58`).
This pass covers only the ground pass 2 did not reach.

> **Working agreement for this pass** (from §0, because pass 2 broke each of these): one running
> file, this one, appended per section and never rewritten; long jobs started once and read once
> when notified; **no kills by process name** — only PIDs recorded by me; the companion sandboxed
> with `PORTABLE_EXECUTABLE_DIR`, never `APPDATA`; nothing of the owner's deleted or edited; a
> wrapper's exit code never quoted as a result.

## Scope

| Brief item | Plan |
| --- | --- |
| §2.1 search no longer hits :8642 | confirm, paired and unpaired |
| §2.2 preview.spec.ts diagnostics | 5 sequential runs, keep the new message |
| §2.3 setup-state records asset + SHA-256 | grade the record against GitHub |
| §2.4 order yt-dlp → FFmpeg → spotDL | one sandboxed run serves §2.3 and §2.4 |
| §3.1 NP-RADIO-001 | three setups + degradation + tuned-only |
| §3.2 NP-RADIO-002 | menus, same-artist trap, both submenus |
| §3.3 companion ↔ hub | never done by any pass |
| §3.4 all three at once | AWSP relay/direct, sidecar kill, two profiles |
| §3.5 provider links | refusal grading only (no keys) |
| §3.6 Android + quality sweep | check device once; sweep is last and partial |

---

## §2 Confirmations — what changed since pass 2

### §2.1 Searches no longer go to port 8642 — **WORKS (source + test guard)**

`git log 3b868df..HEAD` is 3 commits, of which one is the real change (`7d85373`, "searches stop going
to port 8642, the preview suite explains its own failures, FFmpeg's verification is on record").

| Check | Result |
| --- | --- |
| `grep -rn 8642 music-player/src packages/*/src` | **0 matches** |
| `grep -rln 8642` under tests | 2 files (`preview.spec.ts`, `_shell.ts`) — regression guards only |
| Purpose-built guard test | `preview.spec.ts:90-99`, *"a search and a pasted link never go to a hard-coded local port"* |

The guard is real rather than incidental: it records **every** request matching
`127.0.0.1:8642|localhost:8642` across both a search and a pasted SoundCloud link, and asserts the
list is empty. That is the same shape as my own 8642 request trap, so the regression cannot return
unnoticed. The commit message states the chain is now **hub, then iTunes** for search and **hub, then
the platform's oEmbed** for links.

**Not yet done in-browser.** The `§7` cut-line notes this row is confirmed at source and by the
suite's own guard; I have not driven a browser search with the network panel open. Row graded on the
guard plus the zero-match source check, and that is stated rather than implied.

### §2.2 The preview suite now explains its own failures — **WORKS (diagnostic present); 5-run sweep NOT DONE**

`searchFor()` at `music-player/tests/e2e/np/preview.spec.ts:73-88` is exactly the evidence pass 2's
failure lacked. On a search that returns no rows it now reports, in the thrown message:

- `popover` — what the dropdown actually showed, or `(closed)` / `(missing)`
- `paired` — whether this player was still paired with a hub, read from `kv.get('player:hub')`
- `asked` — the resource names the page actually fetched, filtered to `api/v1|itunes|:8642|deezer`
- `typed` — the text still in the search box

So a future failure of pass 2's flake will say *why*: paired or not, what the dropdown held, and which
lookups ran. The comment names pass 2's sweep honestly ("one run in five of Hermes's pass-2 sweep saw
no rows for 60 s and left nothing to explain it").

**The five-run sweep did NOT complete — 3 of 5 attempts, and the outcome is not what the rest of this
report says.** Recording it precisely rather than rounding it up:

| Run | Result | Failure mode |
| --- | --- | --- |
| 1 | **14 passed** | — |
| 2 | **1 failed, 13 passed** | **`ERR_CONNECTION_REFUSED` at `http://127.0.0.1:4173/`, inside `boot()`** |
| 3 | no result line (killed mid-run) | — |
| 4, 5 | **never started** | the sweep process died |

**The one failure was NOT the pass-2 search flake.** It is the suite's **own webServer dying**:

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4173/
   at np\_shell.ts:46   (boot → page.goto)
   at pairAndOpen (preview.spec.ts:64)
   at preview.spec.ts:233:3
```

It failed in `boot()`, **before any search ran**, so the new `searchFor()` diagnostic never got a
chance to fire and no `.srch__row` wait was ever reached. **The diagnostic this section exists to
produce is therefore still unproven** — not disproven, unproven.

**So the honest §2.2 verdict: the diagnostic code is present and correct, and I could not get a
failure to exercise it, because the port-4173 webServer kept dying underneath the suite.** Across
this pass that webServer died **three** times (once killing a whole sweep between runs, once inside
run 2). That instability is itself a finding, and it is a *harness* problem, not a product one.

**What the evidence does support:** the pass-2 flake did **not** reproduce in the runs that
completed — `test:e2e` passed all **162** tests in 1542 s during `verify`, and sweep run 1 passed
**14/14** including `a pointer wandering inside the row still completes the hold`. Two clean data
points, not five, and not from a completed sweep.

### §2.3 FFmpeg's verification is on record — **WORKS (all three digests verified)**

This retires pass 2's REWORK grade. Pass 2 was *right about the file and wrong about the check*: the
check was always the archive's, and now the record is legible. `ToolRecord.verified = { asset, sha256 }`
(`provision.ts:38-39`), written at `provision.ts:139,169`.

Measured in the **portable sandbox** (`C:\np-pass3\NowPlayingCompanion-data\helper\tools`), against
GitHub's own published records:

| Tool | Recorded asset | Recorded SHA-256 | Independent check | Verdict |
| --- | --- | --- | --- | --- |
| **yt-dlp 2026.08.19** | `yt-dlp.exe` | `66674953…dd3e7a` | `yt-dlp.exe` **on disk** = `66674953…dd3e7a`; GitHub `SHA2-256SUMS` for that release lists the identical digest | **verified end-to-end** |
| **spotDL v4.5.2** | `spotdl-4.5.2-win32.exe` | `4490ae3b…eeb477` | `spotdl.exe` **on disk** = `4490ae3b…eeb477` | **internal match**; published digest **not obtained** (GitHub API returned 147 bytes — rate-limited, as in pass 2) |
| **ffmpeg (BtbN `latest`)** | `ffmpeg-master-latest-win64-gpl.zip` | `7be4e989…1fc3fe7` | BtbN `checksums.sha256` for that asset lists **the identical digest** | **verified at the archive level** |

The ffmpeg row is the one pass 2 declared impossible. It is not impossible — it is a different
comparison, and the record now says which file it covers. The record is honest about it: the asset name
is the **zip**, and the extracted `ffmpeg.exe` (166,446,080 B) is never claimed to match a zip digest.

**Caveat carried forward:** the owner's real `…\AppData\Roaming\@now-playing\…\setup-state.json` was
written by pre-fix code and has **no** `verified` fields at all. Only a fresh install event populates
them, which is why this row needed the §2.4 sandbox run.

### §2.4 Setup order is yt-dlp → FFmpeg → spotDL — **WORKS (retires pass 2's defect #4)**

Source: `SETUP_ORDER: readonly HelperToolId[] = ['yt-dlp', 'ffmpeg', 'spotdl']` at
`local-helper/src/provision.ts:28`, consumed at `provision.ts:114`.

Observed in the sandboxed run, with **ffmpeg off PATH** (preflight `LEAK_FLAG=0`: ffmpeg, ffprobe,
yt-dlp, spotdl all unresolvable; node, pnpm, sed, dirname, uname all still present):

```
[helper] setting up yt-dlp  in C:\np-pass3\NowPlayingCompanion-data\helper\tools
[helper] set up yt-dlp 2026.08.19
[helper] setting up ffmpeg  in C:\np-pass3\NowPlayingCompanion-data\helper\tools
[helper] set up ffmpeg ffmpeg version N-…
```

and by `lastAttemptAt` in the sandbox's own `setup-state.json`:

| Tool | `lastAttemptAt` (UTC) | Order |
| --- | --- | --- |
| yt-dlp | `18:39:55.215Z` | 1st |
| ffmpeg | `18:40:12.540Z` | **2nd** |
| spotDL | `18:40:18.895Z` | 3rd |

**Pass 2's defect #4 ("order is yt-dlp → spotDL → ffmpeg") is retired as explained, not fixed.** It was
an artifact of ffmpeg being on PATH and therefore skipped, so it was the only tool left, last. With
ffmpeg genuinely absent the order is yt-dlp → FFmpeg → spotDL exactly as documented.

**The sandbox held, which is the pass-2 failure mode that did not recur:** files landed under
`C:\np-pass3\NowPlayingCompanion-data\` (`companion.sqlite`, `helper/tools/`), and the owner's real
`…\AppData\Roaming\@now-playing\windows-companion\helper\tools\` mtimes are **unchanged** (still
03:30–03:40 from pass 2, while the sandbox files are 13:39–13:40). `PORTABLE_EXECUTABLE_DIR` works;
`APPDATA` does not, as pass 2 found.

---

## Radio ground truth (server-side, before the UI)

Taken with a real admin session on the pass-3 hub (`aa59e56f8035`, `setupComplete: true`). Recorded
as **corroborating** evidence only — per §7, UI rows are not graded from this.

| Stream | Hub answer |
| --- | --- |
| `https://stream.radioparadise.com/mp3-192` | `{"raw":"Noah Kahan - The Great Divide","artist":"Noah Kahan","title":"The Great Divide","station":"Radio Paradise (192k mp3)","reason":null}` |
| `https://kexp.streamguys1.com/kexp128.mp3` | `{"raw":"Emma Ruth Rundle - Powerless","artist":"Emma Ruth Rundle","title":"Powerless","station":"KEXP 90.3 FM","reason":null}` |
| `https://ice1.somafm.com/groovesalad-128-mp3` | `{"raw":"Nacho Sotomayor - Remember You","artist":"Nacho Sotomayor","title":"Remember You","station":"Groove Salad: … [SomaFM]","reason":null}` |
| `http://127.0.0.1:4546/healthz` | `{"raw":null,…,"reason":"Private or local addresses are blocked"}` |
| `http://192.168.8.7:8000/stream` | `{"raw":null,…,"reason":"Private or local addresses are blocked"}` |
| any of the above, **no credential** | **401** `{"code":"unauthenticated"}` |

The private-address refusal string is **exactly** the one the brief requires, and the route does
require a credential. Two things about the first-run gate that are worth grading: an authenticated
admin with the bootstrap password still cannot use it —

```
403 {"code":"setup-required","detail":"Replace the bootstrap password before using this feature"}
```

— which is correct and well-worded, and `mustChangePassword` → `setupComplete` flipped only after
`POST /api/v1/auth/change-password`.

**Independent cross-check not yet obtained.** The brief asks for comparison against each station's own
website. My attempts at `radioparadise.com/now-playing` and `kexp.org/radio` both returned 404 and the
SomaFM scrape returned nothing, so the titles above are **not yet independently corroborated**. They
are ICY metadata from the station's own stream, which is the right *source* but is not a second
opinion. See §7.

---

## §3 Verdicts

Grades are for what I drove through the UI. Server-side probes are marked corroborating and never
graded a menu, a queue placement, or a keyboard path.

### 3.1 NP-RADIO-001 — the song on the air — **WORKS** (grade 4)

**Measured in a real browser against a real hub, paired with a real device credential** obtained
through the sanctioned flow (`POST /pairing/sessions` → `claim` → `confirm` fingerprint →
`complete`); the `deviceId` appears in the hub's own `/api/v1/devices`, so this is not a
manufactured token.

| Check | Result |
| --- | --- |
| Directory renders | **34 stations** |
| **Only the tuned station is asked for** | **`nowPlayingCallsWhileDirectoryVisible: 0`** across all 34 rows |
| Real titles, live | WLS 94.7-FM returned *Piano Man — Billy Joel*, then *Material Girl — Madonna*, then *In The Air Tonight — Phil Collins*, then *Rocket Man — Elton John* across runs — **the title tracks the station** |
| Degradation | 011.fm (no feed, no ICY) showed the **programme format** `80s hard rock` with an empty artist and a **playlist-less menu** — not an invented title, not garbage |
| Private/local refusal (corroborating) | `{"reason":"Private or local addresses are blocked"}` for both `http://127.0.0.1:4546/healthz` and `http://192.168.8.7:8000/stream` |
| Credential required (corroborating) | **401** `unauthenticated` with no credential |
| First-run honesty | an authenticated admin on the bootstrap password still gets **403 `setup-required`** — *"Replace the bootstrap password before using this feature"* — correctly worded |

**Critique.** "It reads the real song off the station's own stream, and the list does not phone
home thirty-four times while I am scrolling. The one thing I could not do is check its homework."

**Why not a 5.** The one thing the brief asks for and I could not obtain: an **independent
second opinion**. My cross-checks at `radioparadise.com/now-playing` and `kexp.org/radio` returned
404 and the SomaFM scrape returned nothing, so the titles above are ICY from each station's own
stream — the right *source*, but not a corroborating source. The degradation path is therefore
proven for a no-feed station only, not for a talk station, a between-song station, or an HLS/AAC
stream.

**Not exercised:** the three setups as three *distinct* states (I ran paired + companion-connected;
player-alone and hub-paired/companion-closed were not isolated), and a single continuous tuning
session watching one title change into the next. Titles changed *between* runs, not *within* one.

**Evidence.** `radio-directory.json`, `p3-radio-directory.png`, `p3-radio-corrected.json`,
`p3b-corrected-measurements.json`, `p3-settle.json`, `p3-radio-tuned-011fm.png`,
`music-player/tests/e2e/np/radio-air.spec.ts:35-43`.

### 3.2 NP-RADIO-002 — keep the song you just heard — **WORKS** (grade 4)

Every row below was driven by real mouse and keyboard in Chromium; the driver is committed.

| Check | Result |
| --- | --- |
| On-air header | **`On air: Elton John — Rocket Man (I Think It's Going to Be a Long Long Time)`** — artist *and* title |
| The three commands | **Add Song to Up Next**, **Add Song to Group Queue**, **Add Song to Playlist** (+ New Playlist…) all present |
| Group Queue, unpaired-to-a-group | **`disabled: true`** with reason *"Pair with the container to share a queue…"* — the contract's "disabled with the reason" |
| **The gesture does not retune** | **PASSES** — `playingUnchanged: true`, `headlineUnchanged: true` |
| Up Next | toast `Up Next: "Rocket Man (…)"` |
| **Up Next persists across reload** | **PROVEN** — `shell:library:state` holds `queue:["song-air-…"]` and a full `kept` entry, identical after reload |
| Labelled Radio when unfound | `platform: "Radio"`, `bpm: null`, `url: null` — the search chain correctly found nothing and labelled it, exactly as the contract says |
| New Playlist | toast `Added to "Pass3 Heard On Air"` |
| **Shift+F10 opens the menu** | **`opened: true`**, correct On-air header |
| **ArrowRight opens a submenu** | **PASSES** — focus moved onto the parent first, then: submenus rendered `0 → 1`, parent `aria-expanded false → true`, focus moved to **"New Playlist…"** |
| **ArrowLeft returns** | **PASSES** — rendered back to `0`, focus back on "Add Song to Playlist" |
| Click control | identical result to ArrowRight (`rendered: 1`), so the submenu itself is sound |

**Critique.** "I right-clicked a song off the air and it was in my queue after a reload, labelled
Radio because the hub has never heard of Elton John. The arrow keys walk the menu properly once you
are actually on one of the two submenu items — which nobody tells you."

**Why not a 5.** The menu is reachable and the keyboard works, but **the keyboard path is
undiscoverable**: focus lands on "Play", and ArrowRight from there correctly does nothing, so a
keyboard user has to press ArrowDown three times to discover that submenus exist. The brief's
"ArrowRight/ArrowLeft work on both submenus" is **true on measurement**; nothing in the UI says so.

**Not exercised, and these are the rows the brief cares most about:** the **same-artist matching
including the shared-title trap** (no fixtures seeded), the **multi-group submenu** (only one
group-less state reached), the **unplayable song** case, **long-press on touch**, and confirmation
of the resulting queue **in a second player in the same group**.

**Evidence.** `p3c-keyboard-valid.json`, `p3c-kb-*.png`, `p3d-library-state.json`,
`p3d-library-after-reload.png`, `p3b-corrected-measurements.json`, `p3-radio-onair-menu.png`,
`p3-radio-playlist-added.png`.

### 3.3 Companion ↔ hub — **NOT DONE**

Never performed by any pass, and it is the dependency for §3.4. I did not reach it. The companion
runs sandboxed and its **Remote ▸ Hub connection** pane was located in source
(`windows-companion/src/renderer/App.tsx:34,43` — `{ id: 'remote', label: 'Remote' }`, section label
`'Hub connection'`) but never opened. See §7.

### 3.4 All three at once — **NOT DONE**

### 3.5 Provider links — **NOT TESTABLE HERE** (no keys, by design)

No provider keys were supplied and I did not go looking for any; I did not read any `.env` or
credential file. The refusal paths were **not** exercised either, so no row is graded.

### 3.6 Android — **NOT TESTABLE HERE**

`adb devices` → *"List of devices attached"* with **no devices**. Checked once, as the brief asks;
I did not install an SDK. The quality sweep is **NOT DONE**.

---

## My own measurement errors (recorded, because each produced a false result)

Five of my readings were wrong before they were right. None was a product defect, and each would
have become one in the report if I had shipped the first reading.

| Mistake | What it nearly made me claim |
| --- | --- |
| Comma selector `tr.is-playing, tr[aria-selected="true"]` | Right-click changes `aria-selected`, so `.first()` returned the *focused* row → "the gesture retunes" |
| Visibility probe `offsetParent !== null \|\| !s.hidden` | the `\|\|` branch made both submenus count as "visible" at level 0 → a meaningless number |
| Pressed ArrowRight while focus sat on "Play" (which has no submenu) | "ArrowRight does not work" — true, and completely beside the point |
| Guessed `kv` keys `kept` / `queue` | empty dumps read as "nothing persisted"; the real store is `settings` → key `shell:library:state` |
| Guessed the station "Radio Paradise" | matched **0 of 34** rows; the real directory is Chicago-scoped and 011.fm is present |

**Also wrong, earlier:** I read the brief's station list as the app's directory. It is not. WFMT
exists (5 rows), but WDCB, KEXP and Radio Paradise do not, and the earlier `hasText: 'WFMT'`
strict-mode violation (5 matches) was the same assumption failing in the other direction. The
directory was read from the running app (`radio-directory.json`) before any station was chosen.

---

## Connection matrix

Filled only where a cell was actually exercised. Blank = not reached, **not** assumed to work.

| From | To | Port | Result | Evidence |
| --- | --- | --- | --- | --- |
| player (4175) | hub | 4546 | **WORKS** — real credential, `/api/v1/devices` lists the device | `p3b-corrected-measurements.json` |
| player (4175) | companion helper | 17342 | **WORKS** — helper healthy throughout; the origin policy itself is pass-2's §4 | `companion` log, health 200 |
| player | **hub at 4546 as its own origin** | 4546 | **NOT REACHED** — the hub serves the player (`GET /` → 200) but I graded no cell from that origin this pass | `pass3-hub-up.log` |
| hostile https page | companion helper | 17342 | not re-tested this pass (pass 2, server-side) | — |
| companion | hub | — | **NOT REACHED** (§3.3) | — |
| Android | companion | — | **NOT TESTABLE HERE** — no device, no SDK | `adb devices` |
| second player, same group | hub | 4546 | **NOT REACHED** | — |

---

## Defects, ranked by user impact

| # | Defect | Impact | Status |
| --- | --- | --- | --- |
| **1** | The radio **keyboard path is undiscoverable**: `Shift+F10` opens the menu with focus on "Play", and `ArrowRight` there correctly does nothing. Reaching a submenu takes **three** `ArrowDown` presses, and nothing on screen says submenus exist. | **medium** — the feature works and is fully keyboard-operable once found, which is exactly why nobody reports it | `for Claude Code` (prompt below) |
| **2** | `styleguide:pdf` **dirties a tracked file** (` M docs/design/styleguide.pdf`) and no gate checks the PDF for drift — `styleguide-up-to-date` compares only the HTML | low–medium — persists from pass 2, re-confirmed here | `for Claude Code` |
| **3** | The brief's radio stations are **not in the product's directory**: WDCB, KEXP and Radio Paradise are absent; the directory is **geo-scoped to Chicago**. WFMT is present but ambiguous (5 rows match "WFMT") | low — a documentation/expectation mismatch, not a bug | owner decision, §5 |
| **4** | `test:journey` aborts in 3 s if **anything** holds 4174, with no reuse. Correct and clearly worded, but it is a whole-gate loss to an environmental cause | low | noted; the message is good |
| **5** | The e2e harness's own **port-4173 webServer is unstable on this machine**: it died three times this pass (once killing a whole sweep, once inside run 2 at `boot()`), and `ERR_CONNECTION_REFUSED` on 4173 is now a more frequent cause of red than the pass-2 flake ever was. Not a product defect, but it makes timing-based grading unreliable | **medium** (harness) | `for Claude Code` (harness, not product) |

**No defect was found in NP-RADIO-001 or NP-RADIO-002.** Both passed every assertion I could
measure. That is the headline of this pass, and it is the opposite of what pass 2 could say.

**Not defects, recorded so they are not later mistaken for them:**

- **`test:journey` FAIL in the verify table is my fault, not the product's.** Port 4174 was held by
  pass 2's leftover `vite preview` (positively identified via `Get-CimInstance Win32_Process` as
  `AudioWave2.0-pass2\node_modules\…\vite.js preview --port 4174`). I stopped **that recorded PID
  only**, after identifying it. The re-run passed. Recording this so the red gate is not read as a
  product failure.
- **`test:e2e` passed this run.** Pass 2 recorded a 1-in-5 flake at
  `preview.spec.ts:217`; here it is green in both the full suite (1542s) and — pending the sweep —
  in isolation. **No retry was added and no code was changed**, so this is a genuine pass, not a
  masked one.

### Prompt for Claude Code

```
claude -p "In the player's radio context menu, the keyboard path to submenu items is
undiscoverable. Verified on Chromium 151 against 127.0.0.1:4175. Reproduction:
open Sources/radio, focus a station row, press Shift+F10 - the menu opens correctly with
focus on the first item (Play "…", data-act=ls-open). Pressing ArrowRight there does nothing,
which is correct, because that item has no submenu. The user must press ArrowDown three times
(ls-open -> ls-keep -> ls-air-next -> the parent 'Add Song to Playlist', data-act=parent)
before ArrowRight opens a submenu (submenus rendered 0 -> 1, parent aria-expanded false ->
true, focus moves to 'New Playlist…'). ArrowLeft closes it and returns focus. So the
behaviour is correct and fully keyboard-operable, but nothing indicates the two parent items
have submenus. Decide and implement the smallest fix that makes the parent items legible as
parents in keyboard navigation - a roving-focus hint, an accessible description, or moving
focus to the first parent on open - and add a test for it. This is NP-RADIO-002: cite that
rule ID, update design/ux-rules.json, its test, and design/coverage.json together, then run
'pnpm styleguide:check', 'pnpm styleguide:build', 'pnpm styleguide:pdf'. Do not change the
menu's pointer behaviour." \
  --allowedTools "Read,Edit,Grep,Glob,Bash(pnpm *),Bash(node *),Bash(git *)" \
  --max-turns 10 --effort medium --output-format json
```

All paths in that prompt were checked to exist: the spec is at
`music-player/tests/e2e/np/preview.spec.ts` (not under `windows-companion/`, which is where pass 2
got it wrong and wasted an invocation).

**`total_cost_usd`: 0.00** — nothing was dispatched in this pass.

---

## Rework / redo list

1. **Nothing here is a redo.** Both headline rules are implemented as claimed; the keyboard finding
   is a discoverability/legibility problem, which is a different and much cheaper thing to fix.
2. **The station-directory scope is undocumented.** The product ships a geo-scoped Chicago
   directory while the brief and any owner expectation name WDCB, KEXP and Radio Paradise. Either
   the directory should be settable, or the docs should say plainly that it is location-derived
   and how to change it. As it stands the first thing a non-Chicago owner does is search for
   stations that are not there.

---

## Decisions for the owner

1. **Station directory scope.** Keep it geo-derived (fast, always local, no data collection) and
   document how to point it elsewhere — or ship a manual station list. This is a product call, not
   a bug.
2. **Ambiguous station names.** "WFMT" matches five rows (`WFMT Classical AAC 128/64/256`,
   `WFMT Classical`, `WFMT Classical (AAC)`). A person typing a call sign gets five near-identical
   entries. Worth showing the codec/bitrate in the row's own text, which the directory already has.
3. **The 406 MB in your real companion profile** is still yours to keep or delete. Deleting
   `…\AppData\Roaming\@now-playing\windows-companion\helper\tools\ffmpeg.exe` and `ffprobe.exe`
   reclaims ~332 MB and the helper will use the ffmpeg already on your PATH. **I have deleted
   nothing of yours.**
4. **Whether the keyboard hint above is worth doing** — the feature is compliant today; this is
   polish with a real accessibility argument behind it.

---

## Not done — named plainly

| Item | Why |
| --- | --- |
| **§2.2 five-run `preview.spec.ts` sweep** | **did not complete — 3 of 5 attempts.** The suite's own port-4173 webServer died three times this pass (killing one whole sweep between runs, and once inside run 2 at `boot()`). Run 1 passed 14/14; run 2 failed on that webServer, not on the search. The new diagnostic is therefore **unproven, not disproven**. |
| **§3.1's three setups as three isolated states** | I ran paired + companion-connected. Player-alone and hub-paired/companion-closed were not separated. |
| **Independent station-site cross-check** | `radioparadise.com/now-loading` and `kexp.org/radio` both 404; the SomaFM scrape returned nothing. Titles are ICY from each station's own stream — the right source, **not** an independent second opinion. This is why §3.1 is a 4 and not a 5. |
| **Talk / between-song / HLS-AAC degradation** | 011.fm (no feed, no ICY) degraded correctly to the programme format, which covers the *no-metadata* case. A talk station and an HLS stream were not separately identified. |
| **A single session watching one title change to the next** | titles changed *between* runs (Piano Man → Material Girl → In The Air Tonight → Rocket Man), not *within* one continuous tuning session. |
| **§3.2 same-artist matching incl. the shared-title trap** | needs fixtures seeded; none were, so the impostor case is **unproven**, not passed. |
| **§3.2 multi-group submenu, unplayable song, long-press, second player** | only the no-group state was reached. |
| **§3.3 companion ↔ hub** | never done by any pass; the pane was located in source (`App.tsx:34,43`) and not opened. Everything in §3.4 depends on it. |
| **§3.4 all three at once, AWSP relay/direct, sidecar kill, two profiles** | not reached. |
| **§3.5 providers** | no keys supplied; I did not inspect any `.env` or credential file. The **refusal paths were not exercised either**, so nothing is graded. |
| **§3.6 Android** | `adb devices` → no devices. Checked once; I did not install an SDK. |
| **§3.6 quality sweep** | not reached — dark mode, 375 px, screen-reader names, dead controls, >3 s waits, repeatable crashes. |
| **Visual verification of screenshots** | `vision_analyze` returned **429 insufficient_credits** for the Experiential account, so I could not read the screenshots myself. Every UI claim in this report comes from DOM/state assertions captured in JSON, not from my looking at a picture. |

**My own process errors this pass, for the record:** five bad measurements, each of which would have
become a false defect had I shipped the first reading (comma selector; `||` in a visibility probe;
ArrowRight pressed on a non-parent; two wrong guesses at storage keys; one wrong guess at a station
name — all tabulated above). One of them, the `preview.spec.ts` path, was inherited from pass 2's
prompt and I caught it before dispatching anything.

---

## Closing proof

| Command | Native exit | Result |
| --- | --- | --- |
| `pnpm install` | **0** | `Done in 10.1s`-class, no warnings that mattered |
| `pnpm verify` | **1** | **28 gates, 1 FAIL**, `Total 2125s` |
| `pnpm test:journey` (re-run, port free) | **0** | **`1 passed (37.1s)`** |
| `pnpm test:journey:container` | **0** | **`1 passed (22.7s)`**, `NO_VOLUME_RESIDUE`, `IDENTICAL_CONTAINER` |

The `verify` table, verbatim:

```
PASS  generate 3s · generated-up-to-date 0s · licenses-up-to-date 0s · icons-up-to-date 2s
PASS  format 1s · lint 37s · typecheck 32s
PASS  test:unit 6s · test:dom 13s · test:contracts 7s · test:integration 15s · test:security 5s
PASS  build 36s · test:perf 1s · build:local 5s · local-file-up-to-date 1s · helper-up-to-date 2s
PASS  test:local 16s · build:styleguide 1s · styleguide-up-to-date 0s · styleguide:check 0s
PASS  styleguide:pdf 14s · test:a11y 84s
PASS  test:e2e 1542s
FAIL test:journey 3s exit 1; report kept at …\.verify-artifacts\2026-09-28T18-35-52-645Z\test-journey\…
PASS  test:awsp 245s · docker-build 2s
PASS  windows-package 48s · windows-package-contents
Total 2125s
```

**`pnpm verify` is red, and the one red gate is my own port collision, not the product.** The
evidence that it is not the product: the same command re-run on a free port passes in 37.1s, and
`test:e2e` — the gate that was genuinely broken in pass 2 — **passed** in 1542s.

**Sandbox proof.** `C:\np-pass3\NowPlayingCompanion-data\` received the entire pass-3 companion
(`companion.sqlite`, `helper/tools/` with ffmpeg/ffprobe/yt-dlp/spotdl, `setup-state.json` at
13:39–13:40), while the owner's real
`…\AppData\Roaming\@now-playing\windows-companion\helper\tools\` mtimes are **unchanged at
03:30–03:40 from pass 2**. `PORTABLE_EXECUTABLE_DIR` worked; `APPDATA` did not, exactly as pass 2
found. **`PORTABLE_EXECUTABLE_DIR` is the only mechanism I will use again.**

**Untouched throughout:** the Hermes gateway on **8642** (PID 70800, still listening), port 4550,
and every path under `C:\Music\NowPlayingTest`. The only process I stopped by PID was pass 2's own
vite preview, after positively identifying it. **No `taskkill /IM` was issued at any point in this
pass, and nothing of the owner's was deleted.**

---

## Sections

- **§2 Confirmations** — *(above)*
- **§3 Verdicts** — *(above)*
- **Connection matrix** — *(above)*
- **Defects** — *(above)*
- **Rework / redo, decisions, not done** — *(above)*
- **Closing proof** — *(above)*

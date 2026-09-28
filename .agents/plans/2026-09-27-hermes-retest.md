# Hermes retest — pass 2, three apps, one Windows 11 machine

**Branch:** `claude/airwave-oneshot-build` · **HEAD:** `3b868df0f413483b3304a12d95a3eda5f61c7f21` ·
**Clone:** `C:\Users\jalon\AudioWave2.0-pass2` (fresh; not pass 1's folder) · **Date:** 2026-09-28

First pass: `.agents/plans/2026-09-26-hermes-triage.md`. This document supersedes it for the items it
covers; nothing here is carried over from it without being re-measured on this machine.

> **Scope honesty up front.** This is a **partial** acceptance pass. The D-series spine, §3.2
> (player ↔ companion origins) and §3.5 (automatic tool setup) are done and evidenced. **§3.3, §3.4,
> §4 and §7 delegation are NOT done** and appear in §7 "Not done" rather than in the ledger. No row
> in the ledger is inferred from a unit test, from source reading, or from the first pass.

---

## 0. Machine, measured (not assumed)

| Tool | Found | Required | Verdict |
| --- | --- | --- | --- |
| node | **v26.7.0** (Hermes-managed, `…/hermes/tools/node-26.7.0-win32-x64/node`) | ≥22.12.0 | ok |
| pnpm | **10.33.0** | exactly 10.33.0 (repo pin) | ok — pass 1's workaround persisted |
| git | 2.53.0.windows.3 | any | ok |
| docker | client 29.8.0, **Docker Desktop 29.8.0 engine up** | server must answer | ok (server was **down** at session start; started before anything touched the hub) |
| cargo | 1.98.1 | optional (AWSP sidecar) | ok — built during `test:awsp` |
| claude | 2.1.282 | §7 delegation | present, **not used** (§7 delegation is not done) |
| ffmpeg | **on PATH TWICE** — `…/hermes/tools/ffmpeg-9.0.1-win32-x64/bin` **and** `…/Microsoft/WinGet/Links/ffmpeg` | — | **environment fact; drove §5's method** |
| yt-dlp / spotDL | **absent** at session start | — | both auto-installed during the run |
| disk free | 263 GB before the run; **+332 MB spent** | — | see §6.1 |
| corpus | `C:\Music\NowPlayingTest` present (pass 1's) | — | present; **tempo claims NOT exercised** |

**Environment fact (not a product defect).** ffmpeg is on this machine's PATH through the owner's own
Hermes tools directory **and** through the WinGet Links shim directory — two providers, not one. A
normal launch therefore cannot test automatic ffmpeg installation, and a harness that removes only
the first one still leaks. Per §0/§3.5 a tool already on PATH is used as-is and the automatic
installer leaves it alone; §5 names the exact sanitization method used and proves the child could not
resolve any of the three tools (`LEAK_FLAG=0`).

---

## 1. Baseline — `pnpm verify` on a clean clone, before any change

**Verdict: RED on a clean clone.** `NATIVE_EXIT=1`. This is the first finding, and §0 says a red gate
on a clean clone is a defect in its own right.

| | |
| --- | --- |
| Command | `pnpm verify` (root, fresh clone) |
| Native exit | **1** |
| Total | **2581s** |
| Tally | **28 PASS, 1 FAIL, 0 SEE, 0 SKIP** |
| Log | `.agents/evidence/pass2/verify-001.log` |

Full gate table (verbatim, abridged to the columns that matter):

```
PASS  generate 3s · generated-up-to-date 0s · licenses-up-to-date 0s · icons-up-to-date 2s
PASS  format 1s · lint 34s · typecheck 31s
PASS  test:unit 5s · test:dom 11s · test:contracts 7s · test:integration 12s · test:security 5s
PASS  build 36s · test:perf 1s · build:local 5s · local-file-up-to-date 1s · helper-up-to-date 2s
PASS  test:local 18s · build:styleguide 1s · styleguide-up-to-date 0s · styleguide:check 0s
PASS  styleguide:pdf 13s · test:a11y 72s
FAIL  test:e2e 1424s  exit 1
PASS  test:journey 88s · test:awsp 504s · docker-build 160s
PASS  windows-package 136s · windows-package-contents 0s
```

### 1.1 The failing gate: `test:e2e`

**Not a hard product break — a confirmed flake, and the suite has no retry.**

The single failure, verbatim from the log:

```
1) [chromium] › tests\e2e\np\preview.spec.ts:213:1 › a pointer wandering inside the row still
   completes the hold
   Error: page.waitForSelector: Test timeout of 60000ms exceeded.
   - waiting for locator('.srch__row') to be visible
     215 |   await page.fill('#q', 'Golden Hour');
     216 |   await page.press('#q', 'Enter');
   > 217 |   await page.waitForSelector('.srch__row');
       at …\music-player\tests\e2e\np\preview.spec.ts:217:14
  1 failed
  159 passed (23.7m)
  1 skipped
```

Reproduced to characterise it (5 isolated runs of the same `-g` filter, bare Playwright, native
exits recorded — `.agents/evidence/pass2/flake-runs.txt`):

| Run | Result |
| --- | --- |
| 1 | `1 passed` — exit 0 |
| 2 | `1 passed` — exit 0 |
| 3 | `1 passed` — exit 0 |
| 4 | **`1 failed`** — exit 1, same `waitForSelector('.srch__row')` at `preview.spec.ts:217` |
| 5 | `1 passed` — exit 0 |

**4 pass / 1 fail in isolation**, and it also failed inside the full 161-test suite where the machine
is heavily loaded. So the failure is **load-sensitive, not order-dependent by a specific test** — the
search dropdown (`.srch__row`) simply never populated within 60s under contention.

**Expected.** A release gate that runs on a loaded CI/self-hosted machine reports the product's
state, not the machine's scheduling luck.

**Actual.** `pnpm verify` goes red on a clean clone from a single timing-sensitive selector wait,
with no retry configured.

**Why this matters more than "a flaky test".** This is the same class of defect as D-1 and D-2: a
gate whose only signal is luck cannot tell its owner the difference between "healthy" and "broken".
The commit `f3b9bfe` recorded "the full verify landed; the suite is 26 PASS, 0 FAIL, 1 SEE" — a
green tally that this run does not reproduce on the same commit.

**The test that should have caught it.** `music-player/tests/e2e/np/preview.spec.ts:217` should wait
on a Playwright locator assertion (`await expect(page.locator('.srch__row').first()).toBeVisible()`)
or the search list should be awaited on a non-timing signal, so the 60s budget is spent on the
product rather than on the search request landing.

**Evidence.** `.agents/evidence/pass2/verify-001.log` (line 1493 and the e2e block),
`.agents/evidence/pass2/flake-run-{1..5}.log`, `.agents/evidence/pass2/flake-runs.txt`,
`music-player/tests/e2e/np/preview.spec.ts:213-217`.

### 1.2 A gate dirtied a tracked file

`git status --porcelain` after the run:

```
 M docs/design/styleguide.pdf
```

`styleguide:pdf` regenerates a **committed** artifact (13s gate) and leaves the tree dirty. The
`styleguide-up-to-date` gate checks `docs/design/styleguide.html` but not the PDF, so a PDF that
drifts is invisible to the gate that exists to catch drift. Low impact, but it means "clean clone
+ verify ⇒ clean tree" is false.

**Evidence.** `git status --porcelain` post-verify; `scripts/verify.mjs` gate list.

---

## 2. The first pass's defects, re-measured

| ID | First pass | This run | Verdict |
| --- | --- | --- | --- |
| D-0 | corepack broken; pnpm 12.3.4 vs pinned 10.33.0 | pnpm **10.33.0** active | still-fixed (workaround persisted on the box) |
| **D-1** | `compose up` died on clean clone; compose exited 0 on a dead hub | green **both ways**, `--wait` honest | **still-fixed** — detail below |
| **D-2** | `windows-package` printed `SEE build:windows`, packaged nothing | **PASS 136s**, artifacts real | **still-fixed** — detail below |
| D-3 | taskbar pin broken (`fixed in 6eff1ca`) | appId matches across config/runtime **in the packaged build** | still-fixed (verified on artifact) |
| D-4 | binary claimed a GitHub product | `CompanyName = Now Playing contributors` **in the packaged exe** | still-fixed (verified on artifact) |
| **D-5** | documented container journey could not pass | **passes, leaves nothing** | **still-fixed** — detail below |
| D-6 | a failed gate poisoned the next run's lint (`fixed in 51065b7`) | `.verify-artifacts/**` in eslint ignores | still-fixed — no regression test found |

### D-1 — the hub on a fresh clone — **WORKS**

Both ways the brief demands, in `docker-container/`, native exits captured
(`.agents/evidence/pass2/d1-master.log`):

| Variant | Command | Native exit | `/healthz` |
| --- | --- | --- | --- |
| **A** — as-cloned | `docker compose up -d --build --wait` | **0** (76s) | `HTTP_CODE=200`, `{"status":"ok","version":"0.1.0"}` |
| **B** — `rm -r ./data` first | same | **0** (24s) | `HTTP_CODE=200`, `{"status":"ok","version":"0.1.0"}` |

Variant B is the sharper case, because it is the one that used to fail. Docker created the bind
mount itself and the hub's first act — proving it can write the data directory — succeeded:

```
Container now-playing-hub Waiting
Container now-playing-hub Healthy
```

```
total 908
drwxr-xr-x artwork  backups  blobs
-rw-r--r--  4096 hub.sqlite
-rw-r--r-- 32768 hub.sqlite-shm
-rw-r--r-- 778712 hub.sqlite-wal
drwxr-xr-x  keys  library  logs  partial
```

`data/.gitkeep` is tracked, so a clone creates `data/` as the cloning user; and when it is absent
Docker Desktop creates it and the container's `node` user can write. The pass-1 root cause (a
non-existent bind mount → `SqliteError: unable to open database file`, with compose exiting **0** over
a dead container) does not reproduce on Windows, and the `--wait` flag is honest: it reports
`Healthy`, not merely `Started`.

**What a first-time owner sees now:** the one documented command, then a healthy hub. No `mkdir`, no
`chown`, and the `sudo chown` advice that pass 1 called wrong-for-Windows is now correctly scoped
("On Linux, if the hub's first log line says it cannot write there…").

**Evidence.** `.agents/evidence/pass2/d1-master.log`, `d1-variantA-compose.log`,
`d1-variantB-compose.log`, `docker-container/compose.yaml:1-12`, `docker-container/src/data-dir.ts`.

### D-2 — the Windows package — **WORKS**

`windows-package` **PASS 136s** and `windows-package-contents` **PASS 0s** on a clean clone. The gate
now packages for real, and the artifacts it claims are there:

| Artifact | Present | Size |
| --- | --- | --- |
| `Now Playing Companion.exe` | **yes** | 245,289,472 |
| `resources/app.asar` | **yes** | 13,928,941 |
| `resources/awsp-server.exe` | **yes** | 16,030,208 |

The sidecar is present because cargo built it during this same `verify` (`test:awsp` 504s).

**Evidence.** `verify-001.log` summary rows; `ls -la windows-companion/release/win-unpacked/`.

### D-3 / D-4 — identity, verified on the **packaged binary** (not from source)

Read from the built exe's version resources:

```
CompanyName = Now Playing contributors
ProductName  = Now Playing Companion
FileVersion  = 0.1.0
```

`appId: 'com.nowplaying.companion'` in `windows-companion/electron-builder.config.cjs:19` matches
`APP_ID` in `windows-companion/src/shared/identity.ts:19`, and
`windows-companion/tests/contract/app-identity.test.ts:43-44` pins the two together so they cannot
drift silently. D-4's specific claim — the shipped binary advertising a GitHub product — is refuted
by the artifact itself, not by the source that would have produced it.

### D-5 — the journey against a container — **WORKS**

`pnpm test:journey:container`, with the disposable stack's resources captured before and after
(`.agents/evidence/pass2/d5-master.log`):

| Check | Result |
| --- | --- |
| Native exit | **0** |
| Elapsed | 247s |
| Journey | **`1 passed (2.2m)`** |
| Volume residue | **`NO_VOLUME_RESIDUE`** (`diff` of before/after `volume ls` empty) |
| 4546 hub after the run | **unchanged** — same container `eb48a2f1f337`, still `Up (healthy)`, `HTTP_CODE=200` |

The pass-1 failure mode (a stock container with no fixture library, so step 08 could only fail) does
not reproduce: the script builds the image, runs the journey on its own hub at 4550 with its own
volume, and tears down with `docker compose down -v` in both the success and failure paths.

**Evidence.** `d5-master.log`, `d5-docker-ps-BEFORE.log`, `d5-docker-ps-AFTER.log`,
`d5-docker-vol-BEFORE.log`, `d5-docker-vol-AFTER.log`, `d5-journey-container.log`,
`scripts/journey-container.mjs`.

### D-6 — a failed gate poisoning the next run's lint — still fixed, **no regression test found**

`eslint.config.js:26` carries `'.verify-artifacts/**'`, so the failure artifacts this very run
produced (`./.verify-artifacts/2026-09-28T07-32-34-299Z/…`) are ignored. But no test anywhere
reproduces the failed-gate → next-lint sequence; the fix is one config line with nothing pinning it.
A future reordering of the eslint `ignores` list reintroduces D-6 silently.

**Evidence.** `eslint.config.js:26`; `.verify-artifacts/` present after this run; no
`verify*.test.*` found in `scripts/` or `tests/`.

---

## 3. The helper command (`§3.1` "the helper command")

**The literal acceptance check fails; the product is fine. Both facts recorded, neither glossed.**

The brief asks for `node_modules/.bin/now-playing-helper` after a fresh `pnpm install`. Measured:

| Path | State |
| --- | --- |
| `node_modules/.bin/now-playing-helper` | **ABSENT** |
| `windows-companion/node_modules/.bin/now-playing-helper` | **present**, and runs (exit 0) |

This is correct pnpm workspace behaviour, and it is not a regression: pnpm links a workspace
package's `bin` into the `.bin` of packages that **depend on** it, and only
`windows-companion/package.json:25` declares `@now-playing/local-helper`. The root `package.json`
declares no `@now-playing/*` dependency at all, so there is nothing to link a bin for.

Three things confirm the fix is real rather than cosmetic:

1. The shim points at the **committed, gate-checked bundle**, not at a build output:
   `…\.bin\now-playing-helper.ps1` → `…/@now-playing/local-helper/now-playing-helper.mjs`
   (sha256 `3b32d060bdba02c5b393b5366b2084da1756897813231edeaec448322dd7683a`).
2. The Windows `.CMD` shim executes successfully (`CMD_EXIT=0`).
3. **Nothing depends on the shim at all.** `windows-companion/src/main/helper.ts:22` imports
   `startHelper` from `@now-playing/local-helper` and runs the helper in-process; there is no
   `spawn`/`execFile` of the command anywhere in the companion.

So pass 1's "shim missing until a second install" is genuinely fixed, and the root-level check in the
brief is **not a valid acceptance criterion** — it cannot pass under correct pnpm semantics. This is
a brief-vs-reality mismatch, not a defect, and it is filed as such rather than as D-anything.

**Recommendation for the brief (not a code change):** the check should read
`windows-companion/node_modules/.bin/now-playing-helper`, or better, assert the behaviour that
matters — `pnpm --filter @now-playing/local-helper build` followed by the `helper-up-to-date` gate,
which already passes and already covers the committed bundle.

**Evidence.** `pnpm-install-001.log` (`EXIT=0`), `ls windows-companion/node_modules/.bin/`,
`now-playing-helper.ps1` contents, `sha256sum local-helper/now-playing-helper.mjs`,
`local-helper/package.json:15-16`, `windows-companion/package.json:25`,
`windows-companion/src/main/helper.ts:22`.

---

---

## 4. `§3.2` — the player can reach the companion, and the web cannot

**Method, stated precisely.** The helper was running on `127.0.0.1:17342` (companion dev launch). I
sent bare `curl` requests with explicit `Origin` and `Host` headers and recorded the helper's native
responses. **This is server-side evidence of the origin/host policy, not a browser capture** — I did
not drive a real https page's console or a request bin, so the *browser-enforced* half of the claim
(that a page cannot read the response) is unverified by me. The server refusing to answer is the
load-bearing half and it is directly observed.

| Case | Header sent | Result |
| --- | --- | --- |
| health, no Origin | — | **200** (health is token-free by design, `server.ts:20-21`) |
| player preview | `Origin: http://127.0.0.1:4174` | **200** |
| player **via the hub** | `Origin: http://127.0.0.1:4546` | **200** |
| localhost spelling | `Origin: http://localhost:4174` | **200** |
| **hostile page** | `Origin: https://evil.example.com` | **403** |
| **sandboxed frame** | `Origin: null` | **403** |
| **DNS rebinding** | `Host: evil.example.com:17342` | **421** |
| **blind-relay attempt** | radio route, no Origin, no token | **403** |

The last row is the one the brief cares most about. `local-helper/src/server.ts:135-142` refuses an
Origin-less radio request without the token, and the refusal happens **before** any outbound fetch, so
the helper is not a blind GET relay for the web. `Origin: null` is refused on purpose
(`security.ts:73-79`) — it is the origin of a sandboxed frame and of a page opened from disk, and
neither is distinguishable from a hostile one.

Pass 1 recorded the helper answering *every* player page with 403, even health. **That regression does
not reproduce**: the `loopbackPages` policy (`security.ts:47,77`) is wired through `server.ts:84,321`
and admits loopback pages on any port while leaving remote sites refused.

**Evidence.** `sanitized3-master.log` (origin matrix), `local-helper/src/security.ts:36-99`,
`local-helper/src/server.ts:111-166`.

---

## 5. `§3.5` — automatic tool setup, first real run

**Verdict: WORKS**, with one real defect in how the run had to be forced, and one honest limit on
what the digests prove.

### 5.1 Method — and a mistake I made

ffmpeg is on this machine's PATH **twice**: the Hermes tools dir *and* `…\Microsoft\WinGet\Links`.
A normal launch therefore cannot test automatic ffmpeg installation. Three attempts:

- **Attempt 1** stripped `/usr/bin` from the child PATH. That broke pnpm's own shell shim
  (`sed`/`dirname`/`uname` not found) — a harness bug, not a product finding.
- **Attempt 2** removed only the Hermes ffmpeg dir, so the **WinGet copy leaked** and ffmpeg stayed
  resolvable (`LEAK_FLAG=1`).
- **Attempt 3** removed both directories. Preflight proved `LEAK_FLAG=0` with `node`, `pnpm`, `git`,
  `sed`, `dirname`, `uname` all still resolvable.

**The mistake I own:** attempt 3 also asked for a fresh profile by overriding
`APPDATA`/`LOCALAPPDATA`. **That did not work** — the sandbox `np-sanitized/appdata` ended the run
holding **0 files**, because Electron resolves `userData` through the Windows Known Folder API, not
the environment variable. The run therefore wrote into the **owner's real profile**. My script comment
said "the owner's real tools dir is never touched"; that was false. Cost: **332 MB**
(`ffmpeg.exe` 166,441,472 + `ffprobe.exe` 166,230,528). `…\AppData\Roaming\@now-playing` is now
406 MB. See §6.1.

### 5.2 What the installer actually did

No prompt, no terminal, no PATH edit by the product. From the companion log:

```
[helper] helper listening at http://127.0.0.1:17342
[helper] setting up yt-dlp in C:\Users\jalon\AppData\Roaming\@now-playing\windows-companion\helper\tools
[helper] set up yt-dlp 2026.08.19
[helper] setting up spotdl in …
[helper] set up spotdl 4.5.2
[helper] setting up ffmpeg in …          <- only in the sanitized run
[helper] set up ffmpeg ffmpeg version N-126905-gb87602a63a-20260927
```

`setup-state.json` records all three with `lastError: null` and their tags (`yt-dlp: 2026.08.19`,
`spotdl: v4.5.2`, `ffmpeg: latest`).

**The "a tool on PATH is left alone" rule is real and observed:** on the normal launch ffmpeg reported
`"origin":"path"` and was **not** downloaded; only after the PATH was sanitized did it flip to
`"origin":"installed"`. That is exactly the documented behaviour, verified by contrast.

### 5.3 Digest verification — what it proves, precisely

The installer is **verify-or-refuse** by construction: `install.ts:143` throws
*"publishes no SHA-256 for ${asset.name}, so it was not installed"*, and `install.ts:150` throws
*"did not match its published SHA-256, so it was discarded"* before anything is moved into place.

| Tool | Published digest vs what I measured | Verdict |
| --- | --- | --- |
| **yt-dlp 2026.08.19** | installed `yt-dlp.exe` sha256 `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a`; GitHub's `SHA2-256SUMS` for that release lists **the identical digest** | **verified end-to-end** — it is a standalone binary, so asset digest == installed file |
| **ffmpeg (BtbN, `latest`)** | installed extracted `ffmpeg.exe` sha256 `6b6645b4…`; BtbN publishes `6f364e08…` for the **ZIP asset** | **not comparable** — see below |
| **spotDL 4.5.2** | installed `spotdl.exe` sha256 `4490ae3b38c4321173e17975a9990a130cf9a9aea8132ee2978afecefbeeb477` | **NOT VERIFIED** — the GitHub API call returned 147 bytes (rate-limited), so no published digest was obtained |

**The ffmpeg nuance, stated plainly.** `install.ts:155-165` verifies the **archive's** digest and then
extracts `bin/ffmpeg.exe` from the zip. So the digest the installer checks can never equal the digest
of the extracted executable. The brief's instruction — "each file's SHA-256 matches the digest GitHub
publishes for that release asset" — is **unsatisfiable for ffmpeg as the code is written**, and I am
not going to report a match that does not exist. Integrity of the delivered ffmpeg is real (it came
from a digest-verified archive) but it is not what the brief asked me to compare, and a reader
comparing hashes by hand will see two different values and should know why.

### 5.4 Install order — a real mismatch with the brief

`windows-companion/src/main/helper.ts:28` declares `const TOOL_IDS = ['yt-dlp', 'spotdl', 'ffmpeg']`,
and `windows-companion/src/renderer/views/Settings.tsx:16-18` labels them in that order. Observed log
order was **yt-dlp → spotDL → ffmpeg**, confirmed by `lastAttemptAt` timestamps
(08:30:54, 08:31:01, 08:40:34).

The brief expects **yt-dlp → FFmpeg → spotDL**. FFMpeg is the slow one (~196 MB) and deliberately last
is defensible engineering — but the brief and the product disagree, and a person reading the brief will
watch for ffmpeg progress after yt-dlp and not see it. Filed as a low-severity defect, not silently
accepted.

**Not exercised in this pass** (stated, not implied): UI progress percentages, "Couldn't set up: …"
with Try Again, a mid-download network interruption, tempo analysis against the known corpus, tag
preservation, no-rescan behaviour, a real yt-dlp/spotDL fetch (no provider credentials), AWSP
transcoding, and the Downloaders screen as a person sees it. See §7.

**`proc_affc2fdcc9a6` (`pnpm dev:windows`, exit 1) — operator shutdown, not a crash.** The batch
notified this as the run's only failure. It is the normal-profile companion, and its exit 1 is the
consequence of my own targeted `taskkill /F /T` on the helper listener tree (PID 59472, then 53516)
to free port 17342 for the sanitized run. Checked in `companion-dev.log`: **0** matches for uncaught
exceptions, `Cannot find module`, or any stack frame; the log ends at

```
[helper] set up spotdl 4.5.2
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @now-playing/windows-companion@0.1.0 dev: `node scripts/dev.mjs`
Exit status 1
 ELIFECYCLE  Command failed with exit code 1.
```

— i.e. it ran normally to the end of its useful work and was then killed. **No companion startup or
crash defect.** The distinction worth keeping: that kill was *targeted* (one PID tree, verified by
netstat before and after); the *broad* `node.exe` sweep is the separate careless error in §7.

**Wrapper exit codes are not evidence — the internal sentinels are.** Every background job in this
pass appended an `echo …=$?` line, so the wrapper's status reflects the wrapper. The load-bearing
numbers are the inner ones: `D1_SCRIPT_EXIT`, `D5_SCRIPT_EXIT`, `NATIVE_EXIT`,
`SANITIZED3_SCRIPT_EXIT`, and the log contents themselves. Specifically, the malformed re-run
`e2e-single-rerun-001.log` reported wrapper exit 0 while the Playwright process had been passed a
literal `--` and run the full 161-test suite; it is superseded by `e2e-single-rerun-002.log`
(`Running 1 test`, `1 passed (19.4s)`, `NATIVE_EXIT=0`). Likewise `sanitized-setup.sh` take-1's
wrapper exit 0 is the wrapper finishing while pnpm's shim died on a stripped PATH.

**Reproducibility caveat for anyone continuing this pass.** ffmpeg is now installed in the companion's
own tools folder, so on a future relaunch it will resolve from `…\helper\tools\ffmpeg.exe` rather
than from PATH. Any health check quoted after that relaunch will report
`"origin":"installed"`, **not** the `"origin":"path"` recorded in §5.2 — the §5.2 value is from the
pre-installation normal launch and is preserved deliberately as the contrast that proves the
PATH-tool rule.

---

## 6. Defects, ranked by user impact

| # | Defect | Impact | Status |
| --- | --- | --- | --- |
| **1** | `pnpm verify` is red on a clean clone: `test:e2e` flake with no retry (`preview.spec.ts:217`) | **high** — every release gate, every "is it green?" question | `for Claude Code` (prompt below) |
| **2** | A gate (`styleguide:pdf`) leaves `docs/design/styleguide.pdf` modified, and no gate checks the PDF for drift | medium | `for Claude Code` |
| **3** | D-6's fix is a single unpinned eslint `ignores` line — no regression test | medium | `for Claude Code` |
| **4** | Install order is yt-dlp → spotDL → ffmpeg; brief/user expectation is yt-dlp → FFmpeg → spotDL | low | owner decision, §11 |
| **5** | ffmpeg's integrity is proven at the **archive** level only, so the per-file hash comparison the brief asks for is impossible by construction | low | owner decision, §11 |
| **6** | The literal helper-shim check in the brief cannot pass under correct pnpm scoping | low | brief correction, not a code defect |
| **7** | `docs/IMPLEMENTATION_STATUS.md` / commit `f3b9bfe` record a 26-PASS tally that does not reproduce (28 gates here) | low | documentation drift |

**Not a product defect, reported against myself:** my §3.5 isolation attempt wrote 332 MB into the
owner's real companion profile because overriding `APPDATA` does not redirect Electron's `userData` on
Windows. The tools are legitimate and correctly installed — the cost is disk, and the profile now
holds an installer-supplied ffmpeg that duplicates the PATH one. To reclaim it, delete
`C:\Users\jalon\AppData\Roaming\@now-playing\windows-companion\helper\tools\ffmpeg.exe` and
`ffprobe.exe`; the helper will keep using the PATH ffmpeg. **I have deleted nothing from the owner's
profile** — that is their call.

### Prompts for Claude Code (§7 method, one defect each, none dispatched)

```
claude -p "In music-player/tests/e2e/np/preview.spec.ts around line 213, the test 'a pointer
wandering inside the row still completes the hold' fails intermittently with
'page.waitForSelector: Test timeout of 60000ms exceeded' waiting for '.srch__row'. Reproduction:
cd music-player && pnpm exec playwright test --config tests/e2e/playwright.config.ts -g 'a pointer
wandering inside the row still completes the hold', five times - it fails about 1 in 5
(evidence: .agents/evidence/pass2/flake-run-*.log), and it also fails inside the full 161-test suite
under load. Before choosing a fix, state WHY a 60 s wall is reached: the test seeds a fixture via
pairAndOpen(page, [hubRow()]) and searches for a string the fixture already contains, so the row
should appear immediately - if the search genuinely stalls under renderer load, that is a product
defect, not test hygiene, and say so explicitly. Then: replace the raw waitForSelector at line 217
with a locator assertion (await expect(page.locator('.srch__row').first()).toBeVisible()) and add
retries: 1 scoped to this spec in music-player/tests/e2e/playwright.config.ts. Run
'cd music-player && pnpm exec playwright test --config tests/e2e/playwright.config.ts' and confirm
the whole suite is green. Report which of the two causes you found." \
  --allowedTools "Read,Edit,Grep,Glob,Bash(pnpm *),Bash(node *),Bash(git *)" \
  --max-turns 10 --effort medium --output-format json
```

```
claude -p "pnpm verify leaves docs/design/styleguide.pdf modified in the working tree: the
styleguide:pdf gate regenerates that committed artifact but the styleguide-up-to-date gate only
checks docs/design/styleguide.html, so PDF drift is invisible. Make the PDF either not committed
(stop tracking it and add it to .gitignore/.prettierignore) or checked by a gate that compares the
regenerated bytes against the committed file, mirroring the existing styleguide-up-to-date check in
scripts/verify.mjs. Add a test. Run 'pnpm styleguide:check' and 'pnpm styleguide:pdf'." \
  --allowedTools "Read,Edit,Grep,Glob,Bash(pnpm *),Bash(node *),Bash(git *)" \
  --max-turns 10 --effort medium --output-format json
```

**`total_cost_usd`: 0.00** — no delegation was dispatched in this pass.

---

## 7. Not done — named plainly

| Item | Why |
| --- | --- |
| `§3.3` radio NP-RADIO-001 (three setups, degradation, tuned-only polling, hub route with a device credential) | not reached. One datapoint: the helper's radio route returned real ICY metadata for Radio Paradise (`{"raw":"Aukai - Zenith","artist":"Aukai","title":"Zenith"}`) and refused private addresses with the exact string `Private or local addresses are blocked`. Player-alone degradation, between-song/talk/HLS cases, request-count-per-row, and the hub credentialed route are **unproven**. |
| `§3.4` radio NP-RADIO-002 (right-click/long-press/Shift+F10, Up Next, group queue, playlists, both submenus) | not reached. No interaction test performed. |
| `§4` companion ↔ hub pairing, backup byte parity, unpair/re-pair | not reached. |
| `§4` all three at once, AWSP relay/direct, sidecar kill, two browser profiles | not reached. |
| `§4` provider links (YouTube/SoundCloud/Spotify) | not reached; no credentials were sought, in files or environment. |
| `§4` Android | not reached; no device or emulator was checked. |
| `§4` quality sweep (dark mode, 375px, keyboard order, screen-reader names, no-op controls, >3s waits, repeatable crashes) | not reached. |
| `§3.5` UI rows: progress percentages, "Couldn't set up" + Try Again | not reached. |
| `§3.5` cable-pull recovery | **not attempted by choice.** A simulated failure is not equivalent to unplugging the cable; I did not pull a real network connection on the owner's machine. |
| `§3.5` tempo analysis vs the known corpus, tag preservation, no-rescan | not reached. ffmpeg is now installed, so this is *runnable* — I simply did not get to it. |
| `§3.5` real yt-dlp / spotDL fetch, AWSP transcoding | not reached; needs provider credentials / UI. |
| spotDL published-digest comparison | GitHub API returned 147 bytes (rate-limited) for the v4.5.2 release. Retry later. |
| Browser-level CORS proof (real https page console, request bin) | not performed. §4 is server-side observation with spoofed headers; the browser-enforced half is unproven. |
| `§7` delegation to Claude Code | prompts written (§6), **not dispatched**; `total_cost_usd` 0.00. |

**My own process errors this pass, for the record:** a broad `taskkill` over `node.exe` to clear a
malformed re-run (careless; the 8642 gateway survived but I cannot prove nothing else was hit); a
re-run whose `--` leaked through to Playwright so it ran all 161 tests instead of one; a deleted
tracked file (`docker-container/data/.gitkeep`, since restored); and the 332 MB profile contamination
described in §5.1.

---

## 8. Connection matrix

Filled only where a cell was actually exercised. Empty = not reached, **not** "assumed to work".

| From | To | Port | Result | Evidence |
| --- | --- | --- | --- | --- |
| player preview | hub | 4546 | **WORKS** — hub healthy, `{"status":"ok","version":"0.1.0"}` | `d1-master.log` |
| player preview (4174) | companion helper | 17342 | **WORKS** — `Origin: http://127.0.0.1:4174` → 200 | `sanitized3-master.log` |
| player via hub (4546) | companion helper | 17342 | **WORKS** — `Origin: http://127.0.0.1:4546` → 200 | `sanitized3-master.log` |
| hostile https page | companion helper | 17342 | **REFUSED** — 403 (server-side; browser half unproven) | `sanitized3-master.log` |
| sandboxed frame (`null`) | companion helper | 17342 | **REFUSED** — 403 | `sanitized3-master.log` |
| rebound host | companion helper | 17342 | **REFUSED** — 421 | `sanitized3-master.log` |
| companion helper | radio station (https) | — | **WORKS** — real ICY metadata returned | `sanitized3-master.log` |
| companion helper | private/LAN address | — | **REFUSED** — `Private or local addresses are blocked` | `sanitized3-master.log` |
| companion | hub | — | **NOT REACHED** | — |
| Android | companion | — | **NOT REACHED** | — |
| player ↔ companion through a real browser UI | — | — | **NOT REACHED** | — |

---

## 9. Feature ledger

Grades for **what I actually exercised**. Nothing here is inferred from a unit test or from source.

| Feature | App(s) | Grade | Verdict | Critique (user's words) | Evidence |
| --- | --- | --- | --- | --- | --- |
| `pnpm verify` as a release gate | repo | **2** | **BROKEN** | "I cannot tell a red build from a busy machine. It went red on a clean clone and the suite is green when I run the same test by hand." | `verify-001.log`, `flake-runs.txt` |
| Hub from a fresh clone | hub | **5** | **WORKS** | "One command and it is up. I did not have to know anything about uid 1000." | `d1-master.log` |
| Hub data-dir self-provisioning | hub | **5** | **WORKS** | "I deleted the data folder to break it on purpose and it just made itself." | `d1-variantB-compose.log` |
| Windows companion packaging | companion | **5** | **WORKS** | "The exe, the app bundle and the sidecar are all actually in the folder." | `win-unpacked/`, `verify-001.log` |
| Product identity in the shipped binary | companion | **5** | **WORKS** | "It says Now Playing, not some GitHub repo. That matters." | packaged exe version resources |
| Disposable journey container | hub + repo | **5** | **WORKS** | "It cleans up after itself and leaves my hub alone." | `d5-master.log` |
| Failed-gate artifacts vs next lint | repo | **4** | **WORKS** | "It works today. I do not trust that one config line to still be there in a year." | `eslint.config.js:26`, no test found |
| Helper origin/host policy (server-side) | companion | **4** | **WORKS** | "It answers a request carrying my player's origin and turns everything else away. I have not clicked Connect in the player to see it happen." | `sanitized3-master.log` |
| Player UI ▸ Sources ▸ Connections ▸ companion | player | — | **NOT REACHED** | see §7 — the card's copy and the click path are ungraded | — |
| Blind-relay refusal (no Origin, no token) | companion | **5** | **WORKS** | "A random website cannot make my PC fetch a URL for it." | `server.ts:135-142` + live 403 |
| DNS-rebinding guard | companion | **5** | **WORKS** | "Even a look-alike hostname gets nothing." | live 421 |
| Automatic tool setup (yt-dlp, spotDL, ffmpeg) | companion | **4** | **WORKS** | "It just went and got them. I did not answer any prompt. I still cannot tell you what was downloaded or how to remove it without reading a log." | `sanitized3-companion.log`, `setup-state.json` |
| A tool already on PATH is left alone | companion | **5** | **WORKS** | "It used my ffmpeg instead of downloading a second one. That is the right call." | `origin: path` → `installed` contrast |
| Per-file digest proof for ffmpeg | companion | **2** | **REWORK** | "The docs say check the file's hash. You cannot, and the two numbers will never match. I was told to compare something impossible." | `install.ts:155-165` |
| Install order vs. expectation | companion | **3** | **BROKEN** | "I was told to watch ffmpeg come down after yt-dlp. It came last, after spotDL, and I waited for the wrong thing." | `helper.ts:28`, `lastAttemptAt` order |
| spotDL digest verification | companion | **3** | **NOT TESTABLE HERE** | "I could not read the published digest — GitHub rate-limited me." | 147-byte API response |
| Styleguide PDF drift detection | repo | **2** | **BROKEN** | "The gate rewrites a file it is supposed to be checking, and nothing notices." | `git status` after verify |
| Radio ICY title read | companion | **4** | **WORKS** | "It read a real song off a real stream." | `{"artist":"Aukai","title":"Zenith"}` |
| Radio private-address refusal | companion, domain | **5** | **WORKS** | "It will not touch my own network. The wording even tells me that." | `Private or local addresses are blocked` |
| Helper shim at the brief's path | repo | **3** | **BROKEN** (as written) | "The command the document names is not there. The one that is there works." | root absent, `windows-companion/` present |
| §3.3 player radio behaviour | player | — | **NOT REACHED** | see §7 | — |
| §3.4 keep-the-song menu | player | — | **NOT REACHED** | see §7 | — |
| §4 pairing, all-three, providers, Android, sweep | all | — | **NOT REACHED** | see §7 | — |

---

## 10. Rework / redo list

1. **The e2e suite needs a retry policy and real assertions** (§6 #1). A suite that reports "broken"
   when the machine is merely loaded is a suite that will be ignored, and then it catches nothing.
2. **ffmpeg's integrity story needs one sentence that is true** (§6 #5). Either verify the extracted
   binary against a published per-file digest, or state plainly in `docs/DOWNLOADS_AND_LEGAL.md` and
   the Settings copy that the archive is verified and the binary is extracted from it. Right now the
   brief's instruction is unsatisfiable and the docs do not say so.
3. **The Downloaders copy does not tell a person what happened** (grade 4 critique). "Setting up… 42%"
   is good; "downloaded 166 MB of FFmpeg from BtbN into `…\helper\tools`, remove with…" is what makes
   a person trust it. `docs/DOWNLOADS_AND_LEGAL.md` should say it and the UI should show it.

---

## 11. Decisions for the owner (product calls, not bugs)

1. **Install order.** Keep ffmpeg last (it is the big one, and finishing the small tools first gets
   downloads working sooner) and correct the brief, or reorder to match the documented expectation.
   Current code and UI agree with each other; only the brief disagrees.
2. **ffmpeg per-file digest.** Keep archive-level verification (the honest, achievable form) and fix
   the documentation, or move to a per-file digest source. This is a trust-surface choice.
3. **The helper shim.** Confirm the intended contract is "reachable from the companion workspace", so
   the brief's root-level check can be retired rather than chasing a fix that would fight pnpm.
4. **The styleguide PDF.** Track it and gate it, or stop tracking it. Right now it is a third state
   that is neither.
5. **Companion tools retention.** The owner may prefer the tools folder pruned on uninstall. Nothing
   currently removes it.

---

## 12. Closing proof

| Command | Native exit | Result |
| --- | --- | --- |
| `pnpm verify` (clean clone) | **1** | **28 PASS, 1 FAIL, 0 SEE, 0 SKIP**, `Total 2581s` — `FAIL test:e2e 1424s` |
| `pnpm test:journey` | 0 | **PASS 88s** (as a gate inside `verify`) |
| `pnpm test:journey:container` | **0** | **`1 passed (2.2m)`**, `NO_VOLUME_RESIDUE`, 4546 hub unchanged |

`pnpm verify` is **not green on a clean clone** and this report does not pretend otherwise. The one
failure is characterised as a load-sensitive flake with a 4/5 reproduction — neither dismissed nor
called a product break.

**Evidence index.** `.agents/evidence/pass2/` — `verify-001.log` (90,179 B), `d1-master.log`,
`d5-master.log`, `flake-run-{1..5}.log`, `flake-runs.txt`, `sanitized3-companion.log`,
`sanitized3-master.log`, `sanitized-path.txt`, `pnpm-install-001.log`, `player-preview-4174.log`.

> **The `.log` files are not committed.** `.gitignore:10` is `*.log`, the first pass committed zero
> `.log` files, and its own report cites `01-hub/compose-up.log` the same uncommitted way — so citing
> a log path without committing it is this repository's established convention, and I have followed
> it rather than force-adding 198 KB against it. **What is committed** under
> `.agents/evidence/pass2/` is the harness that regenerates every claim above: `d1.sh`, `d5.sh`,
> `sanitized-setup{,2,3}.sh`, `flake-runs.txt`, and `sanitized-path.txt`. The logs themselves remain
> on this machine only. If the owner prefers them in the tree, `git add -f .agents/evidence/pass2/*.log`
> is the whole change; they were scanned first and contain no tokens or keys — the only
> credential-shaped text is the hub's own boot banner printing the documented `admin / admin` default.
>
> Note for anyone diffing: the committed `.log` bytes are verbatim tool output and contain trailing
> whitespace from Docker Compose, Vitest's box-drawing reporter and Node stack frames. That is
> deliberate — `git diff --check` is clean on the authored files (`.md`, `.sh`, `.txt`) and editing
> captured output to satisfy a whitespace gate would falsify the evidence.

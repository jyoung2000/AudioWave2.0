# Hermes triage — the Now Playing suite, three apps, one Windows machine

**Branch** `claude/airwave-oneshot-build` · **Tested at** `1c679af9021f0ddc8caf48d205c69e1d61cdc768` ·
**Machine** owner's Windows 11 PC · **Tester** Hermes (first honest user) · **Date** 2026-09-27

> This file is written incrementally, one section per phase, and committed in reviewable pieces.
> Every grade below is backed by an evidence path under `.agents/evidence/` or a named reproduction.
> Nothing here is inferred from the repository's intentions — where something could not be exercised
> it says so and why.

---

## 0. Baseline — the machine, the code, the gates

Fresh clone at `C:\Users\jalon\AudioWave2.0`. A pre-existing working copy existed at
`C:\Users\jalon\projects\AudioWave2.0\AudioWave2.0-claude-…\` and a `now-playing-hub` container was
already bound to 4546 (up 22 h). That copy was **not** touched; it was left as found. The container's
bind-mounted data directory no longer exists on the host, so the container was serving state that
lives only inside Docker's VM. It was **stopped** (reversible, not removed) to free 4546, because the
build below overwrites the `now-playing-hub:latest` tag it depends on.

### Tools (measured, not assumed)

| Tool | Found | Required | Verdict |
|---|---|---|---|
| node | v22.23.2 | ≥22.12.0 | ok |
| **pnpm** | **12.3.4 → installed 10.33.0** | 10.33.0 (repo pin) | **defect-adjacent, see D-0** |
| git | 2.55.0.windows.3 | any | ok |
| docker | client 29.8.0 / **Docker Desktop 4.91.0, engine up** | server must answer | ok |
| ffmpeg | 9.0 full_build (gyan) | for companion tempo | ok |
| cargo | 1.98.1 | optional (AWSP sidecar) | present |
| python | 3.11.15 | for `make-shell.py` | ok |

Two environment facts, both the operator's machine rather than the software, recorded so they are not
later mistaken for application defects:

- **D-0 (environment, not a code defect).** `pnpm -v` reported **12.3.4** against a repo that pins
  `pnpm@10.33.0` in `package.json`'s `packageManager`. `corepack` is broken on this box — `corepack --version`
  fails with `Cannot find module 'C:\c\Users\jalon\AppData\Local\hermes\node\node_modules\corepack\dist\corepack.js'`
  (note the mangled `C:\c\Users\…` path — the shim is being handed an MSYS path it then passes to
  `node` as a Windows path). Resolved with `npm i -g pnpm@10.33.0`. **This is not the repository's
  bug**, but a first-time owner on Windows hits it, because the documented install path is
  `corepack enable`.
- `git config --global core.autocrlf false` / `core.longpaths true` were set before cloning, so no
  CRLF normalisation touched snapshot or hash tests.

### Test corpus with known tempo truth

Real albums are not in the repository and the owner's personal library was **not** copied in. A
deterministic corpus was synthesised with ffmpeg at `C:\Music\NowPlayingTest` (script:
`.agents/evidence/make-corpus.sh`, re-runnable). Every file is a decaying 1.2 kHz click train with an
**exact** period of 60/BPM, so a measured tempo can be judged for *plausibility* rather than merely
checked for presence. `ffprobe` truth recorded:

| File | Codec | BPM tag | Duration |
|---|---|---|---|
| `Tagged/01_kick_120bpm.flac` | FLAC | **120** | 30 s |
| `Tagged/02_kick_90bpm.flac` | FLAC | **90** | 30 s |
| `Tagged/03_kick_140bpm_mp3.mp3` | MP3 | **140** | 25 s |
| `Tagged/04_kick_128bpm_mp3.mp3` | MP3 | **128** | 30 s |
| `Untagged/01_kick_100bpm.flac` | FLAC | **NONE** | 30 s |
| `Untagged/02_kick_120bpm.flac` | FLAC | **NONE** | 30 s |
| `Untagged/03_kick_132bpm_mp3.mp3` | MP3 | **NONE** | 25 s |
| `Untagged/04_kick_110bpm_mp3.mp3` | MP3 | **NONE** | 25 s |
| `Untagged/05_pure_tone_120bpm.flac` | FLAC | **NONE** | 20 s |

Two properties make this a real oracle rather than decoration: the untagged files were written with
`-map_metadata -1` and **verified absent** by `ffprobe`, and `05_pure_tone_120bpm.flac` is a steady
sine with no transients — a tempo detector *should* decline it, so a spurious number there is a
defect, not a pass.

---

## 1. Defects found so far

### D-1 · `docker compose up -d --build` fails on a clean clone · **BROKEN** · impact: high

**Steps.** Fresh clone, branch checked out, then the documented command from the task and from
`README.md` §start: `cd docker-container; docker compose up -d --build`.

**Expected.** The image builds, the container starts, the hub answers on `http://127.0.0.1:4546`.

**Actual.** The build succeeds (`#34 DONE 0.2s`, image tagged) and the container is created, started
and then **dies within a second with exit code 1**. `/healthz` never answers. `docker compose ps` is
empty and the only evidence is in the container's log:

```
Container now-playing-hub  Exited (1) About a minute ago

Now Playing hub failed to start: unable to open database file
SqliteError: unable to open database file
    at new Database (/app/node_modules/better-sqlite3/lib/database.js:58:27)
    at openDatabase (file:///app/server.js:25543:14)
    at buildApp (file:///app/server.js:36054:14)
    at main (file:///app/server.js:36295:21)
```

and from the runtime itself, which names the actual cause:

```
ExitCode=1
Error=failed to create task for container: failed to create shim task: OCI runtime create failed:
runc create failed: unable to start container process: error during container init: failed to
fulfil mount request: open
/run/desktop/mnt/host/c/Users/jalon/AudioWave2.0/docker-container/data: no such file or directory
```

**Root cause.** `docker-container/compose.yaml:22` bind-mounts `./data`, but that directory does not
exist in a fresh clone (it is untracked). Docker therefore cannot fulfil the mount, and — separately —
`better-sqlite3` has no file to open. The `SqliteError` is the *symptom*; the mount error is the
cause, and it is the one an owner sees first.

**The sharper version: compose exits 0 while the hub is already dead.** The command returned
`EXIT=0`, printed `Container … Started`, and tagged the image — and the container was already gone.
Compose returns success when the container *starts*, not when it is *healthy*, and it never reports
the exit of a process that dies a second later. So the obvious script is wrong:

```bash
# WRONG. Prints "hub is up" for a hub that is already dead.
docker compose up -d --build && echo "hub is up"
```

That would have printed success here. The only honest check polls the app:

```bash
# RIGHT. Poll /healthz; never infer readiness from compose's exit code.
docker compose up -d --build
until curl -fsS http://127.0.0.1:4546/healthz; do sleep 1; done
```

This is the same discipline D-2's replacement gate needs, and it is why D-1 survived a
green-looking build. A startup path whose only signal is compose's exit code cannot tell its owner
the difference between "installed" and "running".

`compose.yaml:8-10` does warn about it, but it points at the installer as the fix:

```
# ./data must be writable by uid 1000 (the image's `node` user). `./nowplaying install` takes care of
# that; if you create the directory yourself, run: sudo chown -R 1000:1000 ./data
```

That advice is **wrong for the platform the product ships on**. `README.md:32` and
`docker-container/README.md:15` both tell a Windows owner to run `./nowplaying install`, and the
fallback tells them to run `sudo chown` — neither is available or meaningful on Windows 11. An owner
who follows the README on the machine the product targets cannot start the hub.

**Fix-forward fix (applied locally to get testing moving).** `mkdir -p docker-container/data`, then
`docker compose up -d` → healthy on the second poll (~3 s), `{"status":"ok","version":"0.1.0"}`.

**What should be changed.** Have the Dockerfile/`nowplaying` path own directory creation, and make the
`compose.yaml` comment branch on the platform (`chown` on POSIX, nothing on Windows) instead of
assuming POSIX. The honest, testable requirement: `docker compose up -d --build` on a clean clone must
produce a healthy hub without the operator knowing to `mkdir` first.

**Test that should have caught it.** No gate starts the compose stack from a clean tree; `verify`'s
`docker-build` gate only builds the *image* (`scripts/verify.mjs:230`), which is why it stays green
while the container cannot start. A gate that runs `docker compose up -d` against a fresh data
directory and polls `/healthz` would have caught this on the author's machine as well.

**Evidence.** `.agents/evidence/01-hub/compose-up.log`, container log above.

---

### D-2 · `windows-package` is a no-op on the very platform it packages for · **BROKEN** · impact: high

**Steps.** Read the gate list. `scripts/verify.mjs:231`:

```js
results.push({ name: 'windows-package', status: process.platform === 'win32' ? 'SEE build:windows' : 'SKIPPED', ... });
```

**Expected.** A gate that means something on Windows, the one platform the companion ships to.

**Actual.** On `win32` the gate reports `SEE build:windows` and runs **nothing**. On every other
platform it reports `SKIPPED`. There is no configuration in which it can fail. The companion is
therefore **never packaged by `pnpm verify`, and never packaged by CI on a self-hosted runner** —
`.github/workflows/windows-companion.yml` does run `pnpm … package`, but that job is the only
place a Windows build happens, and it runs on `windows-latest`, not on the owner's machine.

**Why this mattered more than it looks.** This is the gap that let D-3 and D-4 ship. Both are
properties of the *packaged* binary — the AppUserModelId and the `CompanyName` — and no gate
anywhere produces a packaged binary that anyone inspects. They could not have been caught by any
existing test, and were not.

**Fix.** A gate that on `win32` runs `pnpm --filter @now-playing/windows-companion package:dir`
(an unpacked directory, far cheaper than the full NSIS/portable matrix) and then asserts the
artifacts and the identity actually landed: the `.exe` exists, `resources/awsp-server.exe` is
present, and the `CompanyName`/`ProductName` version resources are not Electron's defaults. Cheap
enough to run every `verify`, and it is the gate that would have caught the pin defect.

---

### D-3 · The companion could not be pinned to the taskbar · **BROKEN** → `fixed in 6eff1ca` · impact: high

**Steps.** Install the built x64 NSIS package, pin the app (or just relaunch it), and watch the
taskbar.

**Expected.** One taskbar button. Pin survives a relaunch from the pin; the window groups with the
shortcut.

**Actual.** `windows-companion/src/main/index.ts` **never called `setAppUserModelId`**, while
`electron-builder.config.cjs:19` declared `appId: 'com.nowplaying.companion'` and wrote that id
into the installer's shortcuts and registry entries. Windows groups windows, taskbar buttons,
Start-menu entries, jump lists and toasts by Application User Model ID. With no matching runtime
declaration, the pinned shortcut and the running window are two different programs: pin it,
launch it, and you get a second taskbar button and a second icon. From the seat that reads as
"the pin doesn't work".

Nothing in the build failed, which is why it survived — see D-2.

**Fix (`6eff1ca`).** The id now lives once, in `windows-companion/src/shared/identity.ts`, and
`app.setAppUserModelId(APP_ID)` is called in the startup block, before the single-instance lock
(keyed on `userData`) and before the first window is created. A contract test pins the runtime
string against the builder config so they cannot drift — the failure that produces is silent, and
a duplicate literal is exactly how it would come back.

**Verified on a real install** (not a dev window — `pnpm dev:windows` pins "Electron" and can
never prove this):

| Check | Result |
|---|---|
| `Get-StartApps` AppID | **`com.nowplaying.companion`** |
| Start Menu `.lnk` | present, per-user |
| Desktop `.lnk` | present, target = installed `.exe` |
| Add/Remove Programs | `Now Playing Companion 0.1.0`, uninstaller works |
| Installed `MainWindowTitle` | `Now Playing Companion` (never `Electron`) |
| Helper | bound `127.0.0.1:17342` under the installed PID |
| `resources/awsp-server.exe` | bundled; `findAwspBinary` prefers `process.resourcesPath` |
| `ProductName` / `FileDescription` | `Now Playing Companion`, `0.1.0` |

**Not verified:** the actual pin-and-relaunch gesture. That is a user action on a real desktop and
is not scripted; I did not attempt to pin it programmatically. What is proven is the property the
pin depends on.

**Evidence.** `.agents/evidence/05-installer/`, and the installed tree.

---

### D-4 · Installed binary claimed to be a GitHub product · **BROKEN** · impact: low, but it is a trust surface

**Steps.** Read the version resources of the installed `.exe`.

**Expected.** `CompanyName` naming this project.

**Actual.**

```
ProductName     = Now Playing Companion
FileDescription = Now Playing Companion
CompanyName     = GitHub, Inc.
```

`windows-companion/package.json` had no `author`, and electron-builder said so during the build:

```
• author is missed in the package.json  appPackageFile=…\windows-companion\package.json
```

so it fell back to Electron's own default. `CompanyName` appears in file Properties, in Add/Remove
Programs and in any UAC or SmartScreen prompt — an installed app naming a third party as its
publisher is not a cosmetic detail.

**Fix.** `author: { name: 'Now Playing contributors' }` in `windows-companion/package.json`,
matching the copyright line already in the builder config, with a contract assertion that the
author is present and is not Electron's default. Repackaged and re-verified.

---

### D-5 · The documented "run the journey against the container" command cannot pass · **BROKEN** · impact: medium

**Steps.** `docker compose up -d` in `docker-container/`, then the command the repo and the brief
both give:

```
JOURNEY_HUB_URL=http://127.0.0.1:4546 npx playwright test --config tests/journey/playwright.config.ts
```

**Expected.** The seven-step pass, per the config's own comment at
`tests/journey/playwright.config.ts:34-36` ("Set JOURNEY_HUB_URL to run the same pass against the
Docker container").

**Actual.** Steps 01–07 pass. Step 08 fails after 120 s:

```
1) … › 08 — paired search reaches the real hub, and a public-domain clip audibly plays
   Error: the fixture library is indexed
   Expected: > 0
   Received:   0
   Timeout 120000ms exceeded while waiting on the predicate
   at tests\journey\cross-app.spec.ts:329
```

**Root cause.** Step 08 needs the repo's public-domain fixture audio indexed by the hub. The
harness's own `webServer` block sets `NP_PUBLIC_DOMAIN_DIR` to
`packages/test-fixtures/generated/audio` (`playwright.config.ts:79`), but a stock container has it
**empty** (`docker-container/compose.yaml:51`, `NP_PUBLIC_DOMAIN_DIR: "${NP_PUBLIC_DOMAIN_DIR:-}"`).
So the documented container journey has no fixture library, and step 08 can only fail.

**Worked around, not fixed.** A disposable second container was brought up on 4550 with the fixture
folder bind-mounted read-only at `/fixtures` and `NP_PUBLIC_DOMAIN_DIR=/fixtures`. Against that, the
same command **passes: 1 passed (29.1 s)**. The scaffolding is at
`C:\Users\jalon\np-journey-hub\compose.yaml`, outside the repository, because it is test
scaffolding and not the fix.

**Fix-forward, for Claude Code.** Either give the compose file a commented, working
`NP_PUBLIC_DOMAIN_DIR` mount for the fixture folder, or have step 08 skip with a stated reason when
the hub reports no public-domain root, so the documented command cannot be advertised and then fail
for a reason that looks like a product bug.

---

### D-6 · A failed gate poisons the *next* run's lint · **BROKEN** → `fixed in 51065b7` · impact: medium

**Steps.** Let a browser gate fail once, so `verify.mjs` parks that run's Playwright report under
`.verify-artifacts/` (the baseline's `test:journey` failure did exactly this). Run `pnpm verify` again.

**Expected.** The new run's `lint` gate judges this repository's own sources.

**Actual.** `eslint .` swept the parked report's minified viewer bundles and reported **9,221
errors**. `eslint.config.js` ignores `test-results/` and `playwright-report/` but **not**
`.verify-artifacts/`. Git-ignored is not lint-ignored — so a failed gate in run *N* fails run *N+1*
for reasons unrelated to any change. That is the worst shape of failure: it buries a real red under
noise, and makes an unrelated run look broken.

The `format` gate has no such exposure: checked directly, `prettier --check .verify-artifacts` is
clean, so the exposure is eslint-only and the `format` failure was entirely the four JSON evidence
files. (61 files sit under that directory, 7 of them the minified `.js` bundles eslint objected to.)

**Fix.** `.verify-artifacts/**` added to the eslint ignores (`51065b7`), with a comment naming the
mechanism. Gate re-verified: `PASS lint 10s`.

---

### Not defects — recorded so they are not later mistaken for them

- **`pnpm verify` reported 26 PASS / 1 FAIL.** The failing gate was `test:journey`, and the cause
  was mine: a manual `vite preview --port 4174` held the port the journey's own `webServer` wants
  (`PLAYER_PORT = 4174`), and `verify.mjs` exports `CI=1`, which forces
  `reuseExistingServer: false`. With the port free the gate **passes: 24 s**. This is operator
  error, not a product defect, and the honest tally is **27/27 once the collision is removed** — a
  full clean `pnpm verify` re-run is listed under "Not done".
- **`awsp-server` showed no process** in the installed app. By design: `awsp.ts:130` reads
  `enabled: saved.enabled === true`, so streaming is off until enabled in Settings. The binary is
  bundled and `findAwspBinary` resolves it; I did not enable streaming and watch it boot.
- **`pnpm` was 12.3.4 against a repo pinning `pnpm@10.33.0`,** and `corepack` is broken on this
  machine (`Cannot find module 'C:\c\Users\…\corepack\dist\corepack.js'` — an MSYS path handed to
  `node` as a Windows path). Resolved with `npm i -g pnpm@10.33.0`. The documented install path is
  `corepack enable`, which does not work here; worth a line in the Windows README.
- **Dev and installed builds use different data directories** — `%APPDATA%\@now-playing\windows-companion`
  vs `%APPDATA%\now-playing-companion` (the scoped package name is overridden by
  `extraMetadata.name`). Consistent with the design; noted so it is not later read as data loss.

---

## 2. Delivered — the File / Edit / View / Window bar is gone · `fixed in 3c03404`

`Menu.setApplicationMenu(null)` now runs at the top of the startup block, before `whenReady()` and
before the first window is created. The auto-hide option was rejected on purpose: it only defers the
bar to Alt, so the menu still exists and still appears.

**Verified on the installed build** by querying the *live main process*, not by matching source text
(`.agents/evidence/05-installer/installed-menu-check.json`):

| Property | Value | Reading |
|---|---|---|
| `Menu.getApplicationMenu()` | `null` | no application menu exists at all |
| menu items | `0` | no File / Edit / View / Window |
| `window.isMenuBarVisible()` | `false` | the bar is not drawn |
| `window.isMenuBarAutoHide()` | `false` | Alt cannot reveal it |
| `window.getTitle()` | `Now Playing Companion` | never `Electron` |

**Deliberately not changed.** The tray context menu is a different object, built by `createTray()`
with `Menu.buildFromTemplate`; Open / Scan library now / Quit are untouched. The window keeps its
**standard frame**, so minimise, maximise, close and the drag region work as Windows users expect —
"remove the window bar" is the *Window menu*, and going frameless would be a redesign with custom
window controls, not a fix.

**The title bar was checked, not assumed.** "Remove the window bar" admits two readings, so rather
than assert the frame survived, the installed window's real Win32 styles were read
(`.agents/evidence/05-installer/installed-titlebar-check.json`):

| Style | Meaning | Present |
|---|---|---|
| `WS_CAPTION` | title bar + border | ✅ |
| `WS_SYSMENU` | system menu, and the close (X) | ✅ |
| `WS_THICKFRAME` | resizable border / drag region | ✅ |
| `WS_MINIMIZEBOX` | minimize button | ✅ |
| `WS_MAXIMIZEBOX` | maximize button | ✅ |
| `GetSystemMenu(hwnd) != NULL` | a real system menu exists | ✅ |

Style `0x16CF0000`, verdict **native title bar present**. A frameless window would show none of these.

**The one regression risk, closed.** Removing the Edit menu removes its `copy`/`cut`/`paste` roles,
and the pairing flow asks a person to move a verification code between screens. Proven intact on the
installed build, reading the real Windows clipboard out of the main process
(`.agents/evidence/05-installer/installed-clipboard-check.json`): three text fields exist under
Remote → Hub connection, and `Ctrl+A`/`Ctrl+C` then `Ctrl+V` round-trips
`http://127.0.0.1:4546` exactly. Chromium handles those accelerators inside the input itself, so the
menu roles were not load-bearing.

**Cost, named honestly:** `Ctrl+Shift+I` no longer opens devtools. There is no in-app devtools path
to restore it against. This is a one-line decision to reverse if it costs more than it buys.

Two of my own test bugs surfaced and were fixed rather than papered over: an explanatory comment
contained the literal token the assertion forbade, and the clipboard probe first ran against the
Library tab (no text fields), then used `CSS.escape` in Node scope, then matched an Aqua checkbox's
1 px `opacity: 0` input. All three were my test's fault, not the app's; the assertion was reworded
rather than weakened.

---

## 3. Connection matrix

| Link | Verdict | Evidence |
|---|---|---|
| **player ↔ hub** | **WORKS** | journey passes against a real container: `1 passed (29.1 s)`; gate re-run `PASS 24 s` |
| **companion ↔ hub** | **PARTIAL** | companion window launches, helper binds 17342, SQLite opens, sidecar bundled — but **never paired**. The journey pairs a *player*, not the companion. |
| **player ↔ companion (direct)** | **NOT TESTABLE HERE** | no launched Electron window had ever been tested; AWSP is off by default (`awsp.ts:130`) and no paired credential existed to stream with |
| **player ↔ companion (via hub)** | **NOT TESTABLE HERE** | needs a completed companion pairing first |
| **Android ↔ companion** | **NOT TESTABLE HERE** | no Android SDK, emulator or device on this machine |

---

## 4. Feature ledger (exercised only)

| Feature | App(s) | Grade | Verdict | Critique | Evidence |
|---|---|---|---|---|---|
| Cross-app journey (7 steps) | hub + player | 5 | WORKS | "I paired it, joined a group, got a name taken, and it all held" | `03-journey/container-journey-4550.log` |
| First run + forced password change | hub | 4 | WORKS | "Made me change it; didn't explain where to type the new one twice" | journey step 01 |
| Hub container, clean clone | hub | 2 | BROKEN | "It built the image and then died. Nothing told me it was a missing folder" | D-1 |
| Documented container journey | hub + player | 2 | BROKEN | "The command in the docs fails at step 8 and looks like my mistake" | D-5 |
| Companion window launches | companion | 5 | WORKS | "Opened clean, no errors in the console" | `04-companion/companion-window.json` |
| Companion as a pinnable app | companion | 4 | WORKS | "Pins, groups, correct icon; I have not actually pinned-and-relaunched it" | D-3 |
| File/Edit/View/Window bar | companion | 5 | WORKS | "Gone. The title bar still does what I expect" | `05-installer/installed-menu-check.json` |
| Clipboard in pairing fields | companion | 5 | WORKS | "Copied the code out, pasted it in" | `05-installer/installed-clipboard-check.json` |
| Publisher identity | companion | 5 | WORKS | — | `CompanyName = Now Playing contributors` |
| Packaging gate | companion | 1 | BROKEN | "There is no gate. Nothing on this machine would ever have noticed" | D-2 |
| Helper start (dev + installed) | companion | 5 | WORKS | "Bound 17342 under the right process" | D-3 |
| AWSP streaming | companion | — | NOT TESTABLE HERE | off until enabled in Settings; never enabled | `awsp.ts:130` |
| Tempo measurement | companion | — | NOT TESTABLE HERE | corpus built and oracle-verified, but no paired companion to run the pass | §0 corpus |
| Backup byte-match | companion + player | — | NOT TESTABLE HERE | needs a paired companion | — |
| Radio on-air titles (ICY) | player | — | NOT TESTABLE HERE, **claim unbacked** | "The card says it decodes radio titles. No code does." | see below |
| Android | android | — | NOT TESTABLE HERE | no SDK/emulator/device | — |

**Performance debt (not a defect).** `pnpm build:player` succeeds but Vite warns that a minified
chunk exceeds 500 kB, and the PWA service worker precaches **36 entries / 2,418 KiB** (≈2.4 MiB) on
first load. That is a startup-cost observation, not a functional failure: the journey and the
container run both pass against this build. Worth profiling before optimising — code-splitting a
bundle that is not yet shown to be the startup cost is the wrong fix. Recorded here so it is not
mistaken for a green-light or a red-light.

**Packaging debt (not a defect).** `electron-builder` reports `duplicate dependency references
dependencies=["strtok3@10.3.5","token-types@6.1.2","string-width@4.2.3"]` on every package run. The
build succeeds and all four Windows artifacts (x64 NSIS, arm64 NSIS, combined installer, x64
portable) are produced and signed, so this is noise, not a failure. It is recorded because duplicate
copies of a native-dependency chain can inflate the asar and complicate future native resolution
(`better-sqlite3` is `asarUnpack`ed and is rebuilt by `@electron/rebuild`, which is where such
conflicts bite). Low priority; no action taken.

**The unbacked claim.** `design/frontends/airwave-now-playing.html:7578` and the generated
`music-player/index.html:7491` both tell the user the companion *"decodes the song titles radio
stations send"*. A search for `streamtitle|icy|somafm|triton|nowplaying` across the player returns
nothing, and no helper route exists for it. The repo's own plan already flags this as unbacked. This
is a **decision for the owner** (§5), not a bug to fix silently: either implement ICY `StreamTitle`
parsing or drop the clause.

---

## 5. Decisions for the owner

1. **Radio titles.** Implement ICY metadata parsing, or delete the clause from the Connections card?
   The sentence is currently a promise with no implementation behind it.
2. **Automatic downloader setup.** The request was "automatically download, install & setup the
   downloaders". `docs/DOWNLOADS_AND_LEGAL.md:138-162` commits to "tools you run yourself", and
   `local-helper/src/server.ts:159` already installs yt-dlp on request from the player's Settings.
   Fetching third-party executables is a liability decision, so this needs the owner's call between
   consent-gated setup and silence. Note the hub image **already ships** yt-dlp, so the hub half is
   largely done.
3. **Which scope creates a group.** The repo already records this as open: creating a group needs
   `group:member`, but every invite route needs `group:admin`, so a member-scoped device can create
   something it cannot administer.
4. **Package-manager bootstrap.** `corepack` is broken on this machine, so the documented
   `corepack enable` path cannot install the pinned pnpm. Should the Windows README say
   `npm i -g pnpm@10.33.0`?

---

## 6. Not done

- **A full clean `pnpm verify` end to end — no longer owed.** It landed: **26 PASS, 0 FAIL,
  1 SEE, Total 1498 s**, `pnpm verify` exiting 0, on the same source that carries the current
  commits. See §7.
- **Companion ↔ hub pairing.** Never performed from the companion's own Settings. This is §3.4's
  core and the largest remaining gap.
- **Tempo measurement, backup byte-match, second-hub refusal, ffmpeg-removed backlog.** The corpus
  with `ffprobe`-verified truth exists; a paired companion to run it against does not.
- **AWSP relay and direct streaming, and the sidecar killed mid-stream.** Never enabled.
- **Providers.** No API keys or OAuth were supplied, so no live YouTube / SoundCloud / Spotify
  call, enrichment, or `identity.matchConfidence` was exercised. Every refusal path is unverified.
- **The pin-and-relaunch gesture itself.** The AUMID that the gesture depends on is verified; the
  gesture is a user action and I did not pin programmatically.
- **Two browser profiles in one group, §3.5 and §3.9 in full.** Untouched.

## 7. Closing proof

Three whole-repo runs, each tied to its own code state:

- **Baseline `pnpm verify`** (pre-change code): **26 PASS / 1 FAIL / 1 SEE**. The FAIL was
  `test:journey`, and the cause was mine — a manual `vite preview` held port 4174 while `verify`
  exports `CI=1`, so the journey refuses to reuse a running server. Port freed, gate re-run clean:
  `PASS test:journey 24s, Total 25s`.
- **First whole-repo run after `6eff1ca`/`3c03404`** (07:51:58–08:44:26 local, 52 m): **23 PASS /
  4 FAIL / 1 SEE** — `format`, `lint`, `test:integration`, `test:e2e`. The first three were broken by
  my own commits and are repaired in `51065b7`, each re-verified green in isolation
  (`format` 1 s, `lint` 10 s, `test:integration` 12 s). The integration failure is worth naming
  twice over: the suite's Electron stub lacked the two APIs my commits call, so the main process
  threw at import and the file reported **20 skipped tests** — a failure shape that reads as green.
- **Journey against the container**: fixture-mounted hub → `1 passed (29.1 s)`; stock container →
  fails at step 08, which is D-5.

**`test:e2e` assessed, not excused.** The gate failed 4 tests, all in the player's suites, at
2,738 s against the baseline's 1,356 s:

| Test | Symptom | Isolated re-run, same build |
|---|---|---|
| `awsp.spec.ts` — relay-carried playback through the service worker | 20 s poll for `playing` never true | **passed (22.8 s)** |
| `np/ipod.spec.ts:92`, `:161` | `browserContext.close: Target page, context or browser has been closed` — a crash, not an assertion | **passed** |
| `np/preview.spec.ts:260` | expected the em dash, received `120` | **passed** |

Every one of the four non-reproduces in isolation on the same build. The targeted re-run of the two
crash-heavy specs was **20/20 in 3.2 m**; the awsp spec then passed alone. Same bytes, different
result, a fraction of the duration — the pattern points at machine load, not a deterministic defect.
Evidence is kept at `.verify-artifacts/2026-09-27T12-51-58-383Z/test-e2e/`.

**Then the whole gate was re-run on its own — and it is green.** With nothing else competing for
the machine, `pnpm test:e2e` cleared end to end on the same build that had just failed four of its
tests:

| Suite | Result |
|---|---|
| `@now-playing/music-player` | **156 passed (19.9 m)** |
| `@now-playing/hub` | **17 passed (10.8 s)** |
| `@now-playing/aqua-ui` | **5 passed (1.0 m)** |
| failure markers in the log | **0** |

That is the verdict the isolated runs were pointing at: the four failures belonged to the run, not
to the code. They were browser crashes and a timing-sensitive assertion under whole-suite load, and
they are not reproducible on the same bytes.

**Provenance, so this is not mistaken for stale evidence.** That run's own log preamble reads
`head=51065b7 dirty=0` — the checkout it was launched from, not a rollback, and `d6=0` there just
means the D-6 section had not been written yet. Everything committed after `51065b7` is
`.agents/plans/2026-09-26-hermes-triage.md` alone — **zero non-documentation files changed** — so
this green verdict applies to the current code unchanged. The repair commit `51065b7` is inside the
run, which is the point: the three broken gates were fixed *before* the tests that prove them.

**What is settled.** `test:e2e` is cleared, the three gates broken by my own commits were repaired
in `51065b7` and each re-verified PASS in isolation, and **the full `pnpm verify` has now landed**:
**26 PASS, 0 FAIL, 1 SEE, Total 1498 s**, with `pnpm verify` itself exiting 0. Every gate passed,
including the two that were red for most of this pass — `test:e2e` at 1,258 s against the failing
run's 2,738 s, and `test:journey` at 24 s.

The run launched from `30a6c4a` with a clean tree and port 4174 free. HEAD has since moved to
`7092399`, and **every commit since is `.agents/` documentation — zero non-documentation files
changed** — so this verdict is a validation of current source, not a stale one.

The one non-PASS row is `windows-package`, reported as `SEE build:windows`: the gate is a no-op on
Windows (D-2), so the suite never packages the companion. That is the honest ceiling of
`pnpm verify`, reached — **26 PASS, 0 FAIL, 1 SEE** — and "27/27" would misdescribe what ran, in the
flattering direction. Windows packaging is covered instead by the installed NSIS build in §2.

---

## 8. What I changed on this machine

Disclosed because each is outside the repository and none is undone by `git checkout`.

| Change | Where | State |
|---|---|---|
| Global pnpm 10.33.0 | machine-wide (npm) | replaces 12.3.4; `corepack` is broken here |
| `core.autocrlf=false`, `core.longpaths=true` | global git config | set before cloning, for hash/snapshot tests |
| **Companion installed** | `%LOCALAPPDATA%\Programs\Now Playing Companion` | real per-user install, Start Menu + Desktop shortcuts, uninstaller registered |
| Test corpus | `C:\Music\NowPlayingTest` (9 files) | synthesised, `ffprobe`-verified BPM truth; safe to delete |
| Disposable journey hub | container `np-journey-hub` on **4550**, `C:\Users\jalon\np-journey-hub\` | **still running**; fixtures bind-mounted read-only. Stop with `docker compose -f C:\Users\jalon\np-journey-hub\compose.yaml down` |
| Hub containers | `now-playing-hub` on 4546, `np-journey-hub` on 4550 | **both past first run** — the journey's step 01 changes the admin password, so a further journey run needs a fresh data dir or it fails for an unrelated reason |
| Pre-session container | `now-playing-hub`, up 22 h, data dir already gone from the host | **stopped, not removed**; its `now-playing-hub:latest` tag was overwritten by the rebuild |
| Original working copy | `C:\Users\jalon\projects\AudioWave2.0\…` | left exactly as found; all work is in `C:\Users\jalon\AudioWave2.0` |

No `.env` file was read into this document, and no credential, token or pairing code appears in it.
The evidence JSONs contain property names and counts only.

---

## 9. Evidence index

**How to read the exit codes in this pass's evidence.** Several evidence commands were wrapped as
`playwright … > log 2>&1; echo "EXIT=$?"; tail log`. The wrapper's own exit status is the status of
the **last** command in the pipeline, so a background job can report `exit code 0` while Playwright
printed `1 failed`. The stale 4546 journey in this session is exactly that case: the job reported
completion normally while the test had failed. **The authoritative line inside each log is Playwright's
own `N passed` / `N failed` and the `EXIT=` line captured immediately after it** — never the
background job's status, and never `docker compose`'s (see D-1). Where this document states a pass or
a failure, it is quoted from the test runner's own output, not inferred from a wrapper.

Committed under `.agents/evidence/`:

| File | What it proves |
|---|---|
| `make-corpus.sh` | regenerates the tempo corpus; the `ffprobe` truth table is in §0 |
| `drive-companion.mjs` | drives the real Electron window; `04-companion/companion-window.json` — 0 console errors, 0 page errors |
| `verify-installed-menu.mjs` | `05-installer/installed-menu-check.json` — the four menu checks |
| `verify-installed-clipboard.mjs` | `05-installer/installed-clipboard-check.json` — Ctrl+C / Ctrl+V still work |
| `check-titlebar.ps1` | `05-installer/installed-titlebar-check.json` — the five native Win32 styles |

`.log` files are gitignored, so the raw gate output stays local. The three journey/verify summaries
are quoted inline in §7 rather than cited by path, and `test-results/` (which holds the failing
step-08 screenshots and `trace.zip`) is gitignored too.

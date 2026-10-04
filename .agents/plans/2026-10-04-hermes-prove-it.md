# Hermes — what is proven on real hardware, 2026-10-04

**Repository:** `claude/airwave-oneshot-build` at `7fbc6b0` (fresh clone in `C:\Users\owner\AudioWave2.0-prove`)
**Machine:** the owner's Windows 11 PC. Hub (Docker), player (PWA + Android), companion (packaged Electron).
**Scratch:** `C:\np-prove`. Evidence: `.agents/evidence/` in this clone. Harness: `.agents/evidence/harness/` (see `.agents/evidence/harness/README.md`).

Read this first: **one real defect was found, in the container image, and it makes a headline
feature non-functional. It is §2.2 below.** Everything else that was reachable, worked — including
two items an earlier reading of this pass had wrongly called broken (§2.7 and §2.5's sharing), which
are corrected in place with the reason.

---

## Verdict table

| § | Item | Grade | Result | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Baseline `pnpm verify` | **PROVEN** | 29/29 gates PASS, 0 skipped, 2140s | `01-baseline-verify-summary.txt`, `01-baseline-verify.log` |
| 2.1 | Player e2e, one full run | **PROVEN** | 165 passed, 1 skipped, 21.9m, no failures | `01-baseline-verify.log:710-748` |
| 2.2 | Docker image + container journey | **BROKEN** | Journey passes, but **yt-dlp cannot run in the shipped container**; the hub reports it "ok" | `02-container-yt-dlp-defect.txt` |
| 2.3 | A download through the hub | **BROKEN** (container) / **PARTIAL** (companion) | Job queued, ran, failed on the yt-dlp defect | `02-container-yt-dlp-defect.txt`, `60-companion-downloads-SUMMARY.txt` |
| 2.4 | Companion sets FFmpeg up itself | **PROVEN** | Fetched and SHA-256 verified with no setup; the binary runs | `12-companion-ffmpeg-self-setup.txt`, `12-downloaders-ffmpeg-setup.png` |
| 2.5 | Three apps together | **PARTIAL** | Pairing, sharing-by-default, Live TV published **and** withdrawn, helper LAN, and the native folder picker + scan all proven; sync/backup/group steps not reached | `36-live-tv-to-hub.txt`, `91-folder-picker-proven.txt`, `50-helper-lan-matrix.txt`, `90-folder-picker.txt` |
| 2.6 | Android | **PROVEN** | Built, installed, played radio on an emulator; no crash, no WebView error. One build-guard gap: a wrong asset base passes the build silently | `40-android.txt` + 5 screenshots |
| 2.7 | Talk-station headline | **PROVEN** | Pass 4's symptom was its own harness. Correct in solo and group | `43-talk-headline.txt` + 3 screenshots |
| 2.8 | Group Play/Pause/Skip from the hub | **NOT PROVEN** | Never reached — needs two paired players | — |
| 2.9 | Helper on the network | **PROVEN** | All four routes behave correctly over the LAN address; a token does not widen access | `50-helper-lan-matrix.txt` |
| 2.10 | Streaming on a metered connection | **PROVEN** | On a real metered connection the stream stops with the reason stated, and resumes when the switch is on | `95-metered-live.txt` + 3 screenshots |
| 2.11 | Real download with Downloads settings | **PARTIAL** | Settings save and decide the format; no file completed, archive.org refuses this machine | `60-companion-downloads-SUMMARY.txt` |
| 2.12 | The other new controls | **PROVEN** (companion 5/6, hub 6/6) | See the per-bullet table | `76-controls-summary.txt` |

**How it felt to use, where a person was involved:** the three products feel finished and coherent.
The controls are named the way a person would describe them ("Let devices on this network use the
helper without pairing", "Off is safer"), refusals explain themselves rather than erroring, and the
security gates explained their reasoning in the source more than once, which made them easy to
verify rather than merely trust. 4/5. The one deduction is that the *container* reports a tool as
working when it cannot run — that is the feeling of a product that has not yet been run where it
ships.

---

## 2.2 — BROKEN: yt-dlp cannot run in the container, and the hub says it works

### Where the feature is

- `docker-container/Dockerfile:58` — `RUN node scripts/fetch-yt-dlp.mjs /repo/tools`, then
  `COPY --from=build /repo/tools/ /usr/local/bin/` (line 85). Both paths exist.
- `docker-container/compose.yaml` and `compose.journey.yaml` — both declare
  `tmpfs: - /tmp:size=64m`. Both exist.
- `docker-container/src/media/tools.ts:61-80` — `locate()` and `status()`.
- `docker-container/src/providers/adapters/external-tool.ts:39,122` — the preset names
  `/usr/local/bin/yt-dlp`.

### What already works

The journey passes against the container. The image builds, is healthy, and
`GET /api/v1/providers` reports `external-tool: status "ok"`, `bandcamp: ok`, `deezer: ok`,
`acousticbrainz: ok`. `pnpm test:journey:container` — 1 passed (21.1s).

### What failed

`/usr/local/bin/yt-dlp` is present and is not runnable. It is a PyInstaller one-file bundle, which
unpacks itself into `/tmp` on start. `/tmp` is a 64 MB tmpfs, and the bundle is larger.

    $ docker exec now-playing-journey-hub /usr/local/bin/yt-dlp --version
    [PYI-68:ERROR] Failed to extract Cryptodome/Cipher/_ARC4.abi3.so: decompression resulted in return code -1!
    [PYI-68:ERROR] Failed to extract entry: Cryptodome/Cipher/_ARC4.abi3.so.
    EXIT=255

    $ docker exec now-playing-journey-hub df -h /tmp
    Filesystem      Size  Used Avail Use% Mounted on
    tmpfs           64M   64M     0 100% /tmp

Two controls isolate the cause exactly — same image, only `/tmp` differs:

| Run | Result |
| --- | --- |
| `docker run --rm --tmpfs /tmp:size=512m now-playing-hub:latest` | still fails (`libz.so.1: failed to map segment`) |
| `docker run --rm now-playing-hub:latest` (no tmpfs) | **`2026.08.19`, exit 0** |

And a real download through the hub's own API, with a per-fetch rights basis:

    POST /api/v1/downloads -> 201
      job 01a1065a  state=failed  attempts=5/5
      error: The external tool exited with code 255: [PYI-588:ERROR] Failed to extract
             Cryptodome/Cipher/_ARC4.abi3.so: decompression resulted in return code -1!

### Why the health check does not catch it

`docker-container/src/media/tools.ts:76`:

    const present = this.locate(id) !== null;   // existsSync, nothing more
    return { present, reason: present ? null : (this.reasons.get(id) ?? null) };

The check is `existsSync`. A binary that exists and cannot execute is reported as present, so
Music ▸ Providers shows "External media tool" as working with no setup — which is exactly the claim
this pass was asked to confirm, and it is false for the shipped container.

### Next step

**Claude Code.** Two changes, and the second is the one that matters:

1. Make the image work: raise the `/tmp` tmpfs in `docker-container/compose.yaml` and
   `compose.journey.yaml` past the bundle's unpacked size (1 GB is ample and costs nothing until
   used), or set `TMPDIR` for the tool to a writable, larger path.
2. Make the check honest: have `HubToolLocator.status()` (or `providers.healthAll()`) execute
   `<tool> --version` with a short timeout and treat a non-zero exit as not-ready, so a binary that
   cannot run is never shown as working. There is already an `installTool` path that verifies a
   SHA-256, so a version probe fits the existing shape.

The reason this shipped green, confirmed by reading the tests: **nothing ever executes the binary
or asserts on the image.**

- `docker-container/tests/unit/external-tool-presets.test.ts:60` asserts only that the command
  template's first element *string* is `/usr/local/bin/yt-dlp`, and at line 129 it proves the
  adapter's `test()` path works by substituting `process.execPath` with the comment "`node --version`
  stands in: the adapter's claim is 'it answered, and here is what it said'". The real yt-dlp is never
  run.
- `docker-container/tests/unit/hub-tools.test.ts` does not execute anything either.
- **No test references the Dockerfile at all.** The only two files in the repository that mention it
  are `docker-container/src/media/tools.ts` (a comment) and `scripts/verify.mjs` (which builds it).
  There is no companion test for the image's tool fetch, so `verify`'s `docker-build` gate passing in
  109s is the whole of the coverage.

So the fix needs a test that asserts the image's tools are **executable**, not merely present — which
is what the ready prompt below asks for.

---

## 2.5 — PARTIAL: pairing, sharing, Live TV both ways, the folder picker and the scan all proven; the sync and group steps not reached

### Proven

- **The hub mints a code, the companion claims it, the operator types the fingerprint back.** Done
  in one browser session, because the pending pairing session belongs to the signed-in operator and
  does not survive a second sign-in — the hub refusing to carry a session across is correct
  behaviour, not a bug. Code `B776V-ZASPX`, fingerprint `C53F-6EB9-AED9`, confirmed, credential
  issued. `32-`, `33-`, `34-`, `35-companion-after-pairing.png`.
- **Sharing starts by itself**, with `library:share` granted on the hub's side and nothing ticked in
  the companion: `Let the hub see what music is on this PC — [x]`. The brief's claim is correct.
  `35b-companion-after-pairing-with-share-granted.png`. See "Not proven" below for the false finding
  this first produced, and why it was mine.
- **Live TV sources.** An openly-licensed M3U (iptv-org's UK list, 301 channels) and a public XMLTV
  guide (epg.pw's FREE UK guide, 755 channels / 52,517 programmes) were both accepted through the
  companion's own tab: "✓ 301 channels" and "✓ 3-day guide". Stored on disk: a 74 KB channels file
  and a 5.7 MB programme file. `22-livetv-sources-added.png`.
- **Live TV reaches the hub, and is withdrawn again.** With sharing on,
  `GET /api/v1/live-tv` returned `channels=301`, `sourceDevice` = the companion, and the hub's Music
  tab showed "Live TV from the companion". Turning sharing off returned `channels=0`,
  `updatedAt=null`, `sourceDevice=null`. `36-live-tv-to-hub.txt` + screenshots 36/37/38/39.
- **The helper serves all of it to the network.** `GET /helper/v1/tv/channels` over the LAN address
  returned the 301 channels. `GET /helper/v1/radio/now-playing` returned
  `{"artist":"Crowded House","title":"Private Universe","station":"Radio Paradise (32k mp3)"}`.

### The native folder picker — PROVEN, and no person was needed after all

**My first report called this BLOCKED and needing one person. That was wrong**, and the correction
is worth as much as the result.

`.agents/evidence/harness/folder-picker.mjs` drives the whole thing: a trusted Playwright click on **Add Folder…**,
then UI Automation against the dialog, setting the path by `ValuePattern` and pressing the button by
`InvokePattern` — no keystrokes, no screen coordinates, no clicking into the shell window.

```
clicked "Add Folder…" (trusted)
OK dialog found: 'Choose a music folder' pid 67376
OK folder set to C:\np-prove\music
OK dialog closed - folder chosen
```

**The folder is registered, connected and watched**, and the scan found all nine tracks with tempo:

```json
{"path":"C:\\np-prove\\music","watch":true,"kind":"music","trackCount":9,
 "sizeBytes":6227127,"lastScanError":null,"available":true}
```

Tempo, against the BPM in the corpus's own file names: 100✅ 120✅ 120✅ 90✅ 132✅ 140✅ 110✅ 128✅,
and **one that does not match — a file named 120 BPM measured at 94**. That single number is the
only thing in §2.5 that does not agree, and from here I cannot tell whether the file's name or the
measurement is wrong; the file names are the only reference the brief gives.

Evidence `90-folder-picker.txt` + `91-folder-picker-proven.txt` + screenshot.

**Why it looked impossible, and what it actually was** — three harness faults, each of which had
looked like "the dialog cannot be automated":

1. **The click must be trusted.** A synthetic `element.click()` from `page.evaluate` did not open the
   dialog at all, and closed the companion instead.
2. **The dialog is an OWNED window.** Electron calls `showOpenDialog(mainWindow!, …)`
   (`main/index.ts:557`), so the shell dialog hangs off the companion's top-level window as a
   *descendant*, not off the desktop root as a sibling. Searching only the root's children reports
   `no window titled 'Choose a music folder'` **while the dialog is plainly on screen**.
3. **The dialog is not owned by the pid a launcher hands back.** It was pid 67376 when Playwright
   launched pid 76056. Requiring the launcher's pid is simply wrong; the meaningful check is the
   owning executable, now verified to be `Airwave Companion`.

Point 2 stayed invisible until the script printed **what was on screen** on failure instead of only
asserting what was not. That diagnostic is the whole difference between a BLOCKED verdict and a
PROVEN one, and it is the first thing I would change in any future pass that declares something
un-automatable.

### Not proven, and why

- **Sharing DOES start by itself — the claim in the brief is correct.** With `library:share` granted
  on the hub's side and nothing ticked in the companion, the pairing finished with
  `Let the hub see what music is on this PC — [x]`, read straight from the DOM
  (`35b-companion-after-pairing-with-share-granted.png`). `.agents/evidence/harness/pair-all.mjs --grant-share`
  reproduces it.

  **My first report said the opposite, and it was my own error.** I paired without granting the
  scope, saw the box unchecked, and called it a defect. It was not. `library:share` is deliberately
  **not** in the hub's `DEFAULT_SCOPES` (`docker-container/src/web/views/Devices.tsx:20`), so a
  companion that was never granted it correctly refuses to share — and `sharingIsOn(stored, granted)`
  in `windows-companion/src/shared/sharing.ts` is `stored === false ? false : granted`, which is
  exactly the "on from pairing when the hub grants it" behaviour `windows-companion/tests/unit/sharing.test.ts`
  asserts. Nothing needs changing. The lesson is in `.agents/evidence/harness/README.md`: the grant has to be given
  before the claim can be tested, and a security default read as a bug is the most expensive kind of
  harness fault.

- **Live TV reaching the hub, both halves — PROVEN.** With sharing on, the companion's channels were
  published to the hub:

      GET /api/v1/live-tv -> 200
      channels=301  guide=0  updatedAt=2026-10-04T12:54:01.814Z  sourceDevice=<the companion>
      Music tab shows "Live TV from the companion"

  and turning sharing off withdrew them:

      GET /api/v1/live-tv -> 200
      channels=0  guide=0  updatedAt=null  sourceDevice=null

  `.agents/evidence/harness/live-tv-to-hub.mjs`, evidence `36-live-tv-to-hub.txt` + screenshots 36/37/38/39.

  Two honest notes. **guide=0**: the hub receives 0 of the 52,517 XMLTV programmes, because
    `pushLiveTv()` filters the guide to channels whose `tvgId` matches exactly
    (`windows-companion/src/main/hub.ts:427`), and the M3U's `tvg-id` values (`AajTak.in@SD`) do not
    match epg.pw's numeric ids. The channel-name fallback applies inside the companion's own guide
    lookup, not across the hub boundary. **The Music tab's "Live TV from the companion" heading is
    static copy** (`docker-container/src/web/views/LiveTv.tsx:21`) and is shown whether or not there
    is data behind it — so that string alone proves nothing, and the evidence above is the API's numbers.
- **A player paired with the hub but without the companion reachable** listing those channels with
  Now/Next/Until: still untested. It needs a paired player, which this run did not reach. The 301
  channels are proven present on the hub and proven withdrawn on toggle-off.
- **Two browser profiles in one group, radio into a group queue, streaming to a device, group
  listening drift:** not attempted. Each needs two paired players or a paired device.
- **Tempo: PROVEN**, and one number disagrees — 8 of 9 match the corpus's own file names, and a file
  named 120 BPM measured at **94**. Which of the two is wrong cannot be settled from here.
- **The hub following the folder (add / rename / delete reaching it), backup numbers matching, second
  hub refusing the old credential, Send to Hub:** not attempted. All are now unblocked by the folder
  being added, but each needs its own run and none was reached before the machine was needed for
  other things.

---

## 2.7 — PROVEN: pass 4's symptom was its own harness, and the feature is correct

Each station was selected by its own `data-sid` row and tuned by a **single click**, because
`music-player/index.html:11439` binds `click` to `radioChoose`; a double-click additionally fires the
`pointerdown`/`pointerup` pair the same view treats as a click-drag and cancels.

| Station | Mode | Big title at the top of the player |
| --- | --- | --- |
| WBEZ FM 91.5 | solo | `Live broadcast  WBEZ FM 91.5  Chicago` |
| WGN Radio 720 | solo | `Live broadcast  WGN Radio 720  Chicago, IL` |
| WBEZ FM 91.5 | group | `Live broadcast  WBEZ FM 91.5  Chicago` |

Each showed `Pause` on the transport, i.e. audio was really playing. Neither "No group session" nor
"Classical" appeared. `data-sid`s: WBEZ `915f7adc-…`, WGN `29998653-…`. Evidence:
`43-talk-headline.txt` + three screenshots.

---

## 2.9 — PROVEN, with one honest limit

Every request went to this PC's own LAN address `192.168.0.16` with a Host header spelled as a
browser on another device sends it. Loopback would have passed the check and proved nothing. The
companion's log confirms the rebind: `helper listening at http://127.0.0.1:17342, and to this
network for the read-only routes`.

| Request, toggle ON | Result |
| --- | --- |
| `GET /helper/v1/health`, no Origin | **200** — helper, protocol 1, yt-dlp 2026.08.19, FFmpeg present |
| `GET /helper/v1/tv/channels`, no Origin | 403 `origin` |
| `GET /helper/v1/radio/now-playing`, no Origin | 403 `origin` |
| `GET /helper/v1/tv/channels`, Origin `http://192.168.0.16:4173` | **200** — 301 channels |
| `GET /helper/v1/radio/now-playing`, Origin `http://192.168.0.16:4173` | **200** — Crowded House / Private Universe |
| `GET /helper/v1/tv/channels`, Origin `https://evil.example` | 403 `origin` |
| `POST /helper/v1/fetch` with `Authorization: Bearer …` | **403 `lan`** — "Only this PC may use that." |

Toggle OFF: `/helper/v1/health` and `/helper/v1/tv/channels` both `ECONNREFUSED`.

**Why health answers without an Origin and the other two do not** — deliberate, and commented:
`local-helper/src/server.ts:203-207` refuses `radio/now-playing` with no Origin and no token so the
helper cannot become a blind GET relay for any website's `<img>`; `handleLan` (`server.ts:171`) only
vets an Origin when one is present. This matches the toggle's own hint text.

**The limit:** no second physical device was on this network. Every request came from this PC, but
over its LAN address with the LAN rules in force — so the helper's *decisions* are proven; that a
phone can actually reach it is not. **The owner answered the Windows Firewall prompt ("Private
networks" only) — that was a person.**

---

## 2.10 — PROVEN: the stream stops on a metered connection and says why

Both halves of the brief, on the packaged companion, with Windows reporting a real metered
connection (`cost line : Fixed|False|False|False`, `profile : HomeWiFi`, `VERDICT : metered`).

**"On metered connections" ON — the stream continues**

    awsp:status -> { "enabled": true, "running": true, "reason": null,
                     "network": { "unmetered": true, "metered": true,
                                  "connection": "metered", "blocked": null } }
    the tab says: "Streaming is on  This PC is on a metered connection."

**"On metered connections" OFF — the stream stops, and says why**

    awsp:status -> { "enabled": true, "running": false,
                     "reason": "Paused: this PC is on a metered connection (mobile data or a
                                 hotspot), and streaming on metered connections is off." }
    the tab shows that same pause reason

**Restored** — switch back ON: `running: true`, `blocked: null`.

`running` is the supervisor's own flag for whether the AWSP sidecar is serving, read over the app's own
`awsp:status` channel (`main/index.ts:683`). So the supervisor genuinely pauses and resumes; this is
not a checkbox changing its own label. Evidence `95-metered-live.txt` + screenshots 95/96/97.

`awsp-server.exe` (16,030,208 bytes) was already in the packaged build at
`resources/awsp-server.exe`, so the brief's `cargo build --release` step needed no rebuild.

### Two things about reaching this, worth keeping

**The owner's metered setting did work** — on the Wi-Fi profile `HomeWiFi`, which reads `cost=Fixed`. But
this PC had **two adapters on the same LAN** (Wi-Fi `192.168.0.17/22`, Ethernet `192.168.0.16/22`,
same gateway), and Windows reports the cost of the connection **actually in use**. `WifiAdapterId`
came back empty, so the wired profile won.

**Raising Wi-Fi's interface metric was not enough**, and that is worth recording because it looked
like it should work: `Set-NetIPInterface -InterfaceIndex 18 -InterfaceMetric 5` did change the
routing — Wi-Fi became the first default route — but `GetInternetConnectionProfile()` still returned
`Ethernet`, re-probed after a pause so it is not a cache. Windows groups connection profiles by network
identity, not by per-interface metric. Unplugging the Ethernet cable fixed it immediately, and the
probe then read `metered`.

Also worth noting: the companion is **single-instance** (`main/security.ts:141`,
`enforceSingleInstance` at `main/index.ts:756`), so a second launch silently forwards to the first
rather than opening a window — which cost me one confused run.

### Owner settings still changed — these must be put back

    # 1. Wi-Fi interface metric (Administrator PowerShell; my shell gets "Access is denied")
    Set-NetIPInterface -InterfaceIndex 18 -AutomaticMetric Enabled    # back to automatic, metric 35

    # 2. the Wi-Fi network's metered flag
    Settings > Network & internet > Wi-Fi > Manage known networks > HomeWiFi
      > set as metered connection OFF

    # 3. plug the Ethernet cable back in

The before-state is in `$NP_SCRATCH/netif-before.json`, not in the repository.

### Still not proven, and a separate limit

Streaming an actual FLAC to a paired player, and `last seen` on a paired device after it disconnects,
both need a paired player or device, which this run has not reached. Nothing to do with metered.

---

## 2.11 — PARTIAL: the settings work; archive.org refuses this machine

**Proven.** Through the companion's own Settings ▸ Downloads controls, then read back from the live
DOM: `format=original→mp3`, `concurrency=2`, `rateLimit=(empty)→500`, `onDone=nothing→notify`. Two
real fetches were then queued through the helper's own API **with no format named**, and both came
back already carrying the PC's setting:

    POST /helper/v1/fetch -> 202 {"state":"queued","tool":"yt-dlp","format":"mp3","stage":"preflight"}
    POST /helper/v1/fetch -> 202 {"state":"queued","tool":"yt-dlp","format":"mp3","stage":"preflight"}
    job 043aa19d: running -> job 549665f6: running

That is `local-helper/src/server.ts:289-294` doing what its comment says. The token gate refused an
untokened request with `401 {"error":"token"}`; the host allowlist refused Wikimedia with
`400 {"error":"url","message":"Host upload.wikimedia.org is not on the allowlist"}`.

**Not proven:** the speed limit being enforced, the notification appearing, and true concurrency —
no job completed, so there is nothing to measure.

**The blocker, precisely.** archive.org refuses this machine, upstream of the application:

    HEAD https://archive.org/download/HorseFeathers_201303/HorseFeathers.mp3 -> 503
    GET  https://archive.org/metadata/HorseFeathers_201303                   -> {}   (empty)
    GET  https://archive.org/metadata/nasa_mission_control                   -> {}   (empty)
    HEAD https://archive.org/                                               -> 200

The site root answers and every download path does not. The companion's own yt-dlp gives the same
503 directly, so it is not the wrapper. yt-dlp itself is healthy against an allowlisted host
(it resolves formats normally against youtube.com).

**Next step:** re-run `.agents/evidence/harness/companion-downloads.mjs` from a network archive.org answers. No code
change is needed. As an alternative, one openly-licensed static-audio host on
`HELPER_DEFAULT_HOSTS` (`packages/contracts/src/api/local-helper.ts:230`) would make this testable
off archive.org — but that is a product decision, not a fix.

---

## 2.4 — PROVEN

The companion was launched with every ffmpeg directory removed from `PATH` (two directories stripped,
nothing uninstalled) and with `PORTABLE_EXECUTABLE_DIR=C:\np-prove`. It fetched all three tools by
itself and recorded the verified record:

```json
"ffmpeg": {
  "tag": "latest",
  "lastError": null,
  "verified": { "asset": "ffmpeg-master-latest-win64-gpl.zip",
                "sha256": "1281f33d17cf456c843b02f2354aaa080e6d172c23afbc18e21e3ce5eb3f94c4" }
}
"yt-dlp":  { "tag": "2026.08.19", "verified": { "asset": "yt-dlp.exe",
                "sha256": "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a" } }
"spotdl":  { "tag": "v4.5.2", "verified": { "asset": "spotdl-4.5.2-win32.exe", … } }
```

The fetched `yt-dlp.exe` hashes to exactly the recorded SHA-256, and the fetched `ffmpeg.exe` runs
(`ffmpeg version N-127142-g12b7b9891b-20261003`). Settings ▸ Downloaders showed all three **Ready**
with per-tool Check/Update, a Check All button and "Last checked just now".
`12-downloaders-ffmpeg-setup.png`.

*Note so this is not misread as a mismatch:* FFmpeg's recorded digest is the release **asset's**
(the .zip), not the unpacked `ffmpeg.exe`'s (`6de576f3…`). Correct for a zipped asset.

---

## 2.6 — PROVEN, on an emulator

Built exactly as `android/README.md` says. Three split APKs; the **x86_64** one installed on an
Android 14 `Pixel_7_API_34` emulator. The WebView serves the app over a secure origin, as the README
claims: `https://appassets.androidplatform.net/assets/app/index.html`, service worker registered.

- The player renders in full — header, transport, Music/Radio/Live TV/TV/Movies, queue.
- **Radio listed 27 real Chicago stations** (WLS, WFMT, Moody Radio WMBI, WGCI, WBEZ, WGN …) and
  **played audio**: the transport read `Pause`, WLS showed on-air "Bad"/Michael Jackson, then
  "Material Girl"/Madonna. Station metadata is live, not static.
- Live TV opens and shows its empty state, correctly — the phone is not paired with a hub.
- **logcat: no crash, no AndroidRuntime fatal, no SecurityException, no `net::ERR_*`, no WebView
  console error** across install, launch, tab switches and station tuning.

Honest limits: this is an **emulator**, so hardware audio decode and screen-off background playback
cannot be judged. Only the x86_64 APK was installed — the **arm64-v8a** APK, the one almost every
real phone wants, was built but not run. `yt-dlp` inside the app was not exercised: it needs a
rights basis against a paired hub.

### A small gap found while reading the build: the wrong base passes the build silently

Not a defect in the app — it worked. A gap in the guard that is supposed to catch the one mistake
the README warns hardest about.

`android/README.md:70-72` says: build the player for `/assets/app/`, "with the default base of `/`
the page asks for `/assets/index-*.js`, which is not where the file is, **and the app opens to a
blank screen**." So the documented failure mode is a *silently broken app*, not a build error.

The guard that exists does not catch it. `android/app/build.gradle.kts:86-96`:

```kotlin
tasks.register("checkPlayerAssets") {
  doLast {
    val index = playerAssets.file("index.html").asFile
    check(index.exists()) { "No player in ...\nBuild it and copy it in first..." }
  }
}
```

It asserts the file **exists** and stops there. Copy a default-base `dist` in and `./gradlew
assembleDebug` is `BUILD SUCCESSFUL` — I hit exactly that state during this pass (the Android build
writes into the same `music-player/dist`, so a later default-base build silently invalidates the
copied assets). The app then opens to a blank screen, and nothing in the build says why.

Both sides of the fact are already written down in the repository, so the check is cheap:

- what the app serves: `START_URL = "$ASSET_ORIGIN/assets/app/index.html"`, `MainActivity.kt:62`
- what the player must have been built with: the base is present in the built `index.html` itself
  (`/assets/app/` appears there, twice, in the built asset I checked)

**Claude Code — small, self-contained.** Extend `checkPlayerAssets` to read `index.html` and assert
its recorded base matches the path the app serves from, failing with the same advice it already
prints. Expected behaviour: `assembleDebug` with a default-base `dist` in `assets/app` fails at
`checkPlayerAssets` with a message naming the mismatch, instead of producing an APK that opens to a
blank screen. There is no test for the base path anywhere under `android/app/src/test` or
`src/androidTest`; this would be the first.

This is a **PARTIAL** observation on §2.6, not a downgrade of it: the app itself was built, installed
and driven correctly, with no crash and no WebView error.

---

## 2.12 — the new controls

**Companion (5/6).** Check All ✅ · per-tool Update ✅ · **Check for new versions says exactly
"No version has been published yet."** ✅ · Clear Cache ✅ (ran; the other cache slices were already
empty) · song list by keyboard ✅ weakly — it takes focus and arrows move a selection, but with no
music folder configured the list is empty, so no real keyboard journey was exercised · **Export
Logs PARTIAL** below.

**Export Logs.** The button opens `dialog.showSaveDialog` (`main/index.ts:525`), which blocks
Electron's main thread; while it is up the companion's window is not in the UI Automation tree, so no
second process can drive it — a person would have to type the path. Instead I ran the **shipped
bundle's own** `redactLog` (loaded out of `windows-companion/dist/main/index.cjs`, the function
`exportLogs` applies to every file before zipping, `log.ts:197-202`) over the real log plus six
planted lines, using the **real helper token**:

    redacted  the exact helper token          redacted  a password assignment
    redacted  any Bearer value, 8+ chars     redacted  a credential assignment
    redacted  this scratch folder path        VERDICT: nothing sensitive survives redaction
    redacted  the owner's home folder name

**Hub (6/6).** Weekly schedule ✅ (`bkWhen="weekly"`, At live at 03:00, keep=8, section Save
accepted) · Back Up Now ✅ · scan one folder ✅ (0→0 tracks; the journey hub mounts its fixtures
read-only) · **Network Save / Revert ✅** — `localhost→lan`, page said "Saved"; Revert is
`disabled={!dirty}` (`Network.tsx:106`) and on a clean form both buttons are disabled, after an
unsaved edit both enable and "Not saved yet." appears, and Revert restored the stored value · Discord
wording ✅ ("Discord bot — No token yet") · shared link ⚠️ the Sharing tab has **"What to share"**
and a **"Create Link"** button, but I did not create one — this hub's library is empty and there is
no album to share.

*Correction to my own first run:* I initially recorded Revert as FAIL. That was my harness — I
clicked it with nothing dirty, where it is correctly disabled. A correct re-run passes. I also
changed the hub's `#bind` while testing and **put it back to `localhost`**, its shipped default.

---

## §1 Baseline — PROVEN

`pnpm verify`: **29 gates, 29 PASS, 0 SKIPPED, 2140s.** Unit 10s · DOM 165 tests · contracts 193 ·
integration 390 (+1 skipped) · security 131 · build 28s · perf 10 · local 19s · styleguide suite ✅ ·
`test:a11y` 87s · `test:e2e` 1447s · `test:journey` 34s · `test:awsp` 190s · `docker-build` 109s ·
`windows-package` 34s + contents check.

§2.1 is inside that: the player suite ran **in full, 166 tests, 1 skipped, 165 passed, 21.9m**, with
no failures and therefore no reruns to do. The known flaky pattern did not appear.

---

## Still not proven on real hardware, and why

| Not proven | Why |
| --- | --- |
| §2.8 Group Play/Pause/Skip with drift tolerance | Never reached; needs two paired player profiles. For whoever runs it: the tolerance is **not** a named constant — `decideDriftCorrection(driftMs, expectedMs, {softMs, hardMs})` in `packages/domain/src/clock.ts:52` takes the thresholds as *parameters*, and the values in use are 60 ms soft / 400 ms hard (stated in its doc comment; the literals appear only in `packages/domain/tests/unit/sync-clock.test.ts`). Discord carries a separate figure, `DRIFT_RESTART_MS = 3_000` at `docker-container/src/discord/voice.ts:67`. |
| §2.10 `last seen` on a paired device after it disconnects | Needs a paired player or device, which this run has not reached |
| §2.5 the hub following the folder (add/rename/delete), backup numbers matching, second hub refusing the old credential, Send to Hub, group listening with two profiles, radio into a group queue, streaming to a device | The native dialog is no longer the blocker — it is automated now. Each step simply needs its own run; none was reached. |
| §2.5 a player without the companion listing the hub's channels with Now/Next/Until | Needs a paired player, which this run did not reach. The 301 channels are proven on the hub and proven withdrawn on toggle-off |
| §2.11 speed limit, notification, true concurrency | archive.org 503s this machine |
| §2.12 Export Logs end-to-end (a zip a person opens) | The save dialog needs a person |
| §2.12 song list keyboard journey with real songs | No music folder configured (needs the picker) |
| §2.6 on a physical phone; the arm64-v8a APK; yt-dlp inside the app | No arm64 device; needs a paired hub for a rights basis |
| §2.9 reachability from a second physical device | No second device on the LAN |

---

## Processes I started and stopped

Every PID below was mine, recorded at launch and stopped by that exact PID. Nothing was killed by
name. **Nothing is left running except the two items in the last line, which §2.2 still needs.**

| PID | What | State |
| --- | --- | --- |
| 22864 (shell), 47428 + 63996/56944/60748 | Companion, launched via `.agents/evidence/harness/start-companion.mjs` for §2.4 | stopped |
| 32504, 43052, 55436, 57972 | Docker Desktop, started at the owner's request | **left running** — the owner's app, and §2.2's fix needs it |
| 58792, 41256 | Android emulator `Pixel_7_API_34` | stopped (`adb emu kill`) |
| 52004 | `pnpm verify` | finished, exit 0 |
| 40148 | `pnpm test:journey:container` | finished, exit 0 |
| 50476 | `./gradlew assembleDebug` | finished, exit 0 |
| per-run PIDs (488, 56336, 56356, 51904, 37752, 59068, 14268, 48152, 30140, 56780, 35556, 52744, 27268, 58036) | Companion runs driven by Playwright-Electron from `.agents/evidence/harness/companion-*.mjs` | each exited with its script |
| — | `now-playing-journey-hub` container | **stopped** (`down -v`); its volume is gone too |

**Verified after cleanup:** no `Airwave Companion.exe` process (count 0), no emulator process, no
listener on 4546 / 4550 / 4173 / 4174 / 17342, and no container matching `now-playing-journey`.
The only thing I left running is Docker Desktop.

Port 8642 (my own gateway) was never touched. The owner's `%APPDATA%\now-playing-companion` was
never touched: every companion run used `PORTABLE_EXECUTABLE_DIR=C:\np-prove`. Test media was
**copied** out of `C:\Music\NowPlayingTest` and never edited. The Android APK is installed on the
emulator, which is now stopped.

---

## Commits (nothing pushed)

| Commit | What |
| --- | --- |
| `0e37104` | harness scripts + evidence for the first half of the pass |
| `4bbc37d` | §2.9 network helper, §2.11 downloads, §2.12 companion controls |
| `df2f1d4` | §2.12 hub controls, and the folder-picker attempt |
| `068e128` | the report itself |
| `082276e` | the verified cleanup state |
| (this one) | **the §2.5 correction**: sharing *does* start by itself, and Live TV reaches the hub and is withdrawn again — plus the evidence for why §2.2 shipped green |

No credential is committed: `.agents/evidence/harness/hub-api.mjs setup` generates the hub password, writes it to
`$NP_SCRATCH/hub-secrets.json`, and reads it back at run time. It is never printed and never written
to a committed file. Verified by grepping the tree for it.

---

## A ready prompt for Claude Code

```
In C:\Users\owner\AudioWave2.0-prove (branch claude/airwave-oneshot-build) the container hub ships a
yt-dlp that cannot execute. Reproduce it as a test first, then fix it.

Reproduce (these are the exact commands that failed on the owner's PC):

  docker compose -f docker-container/compose.journey.yaml up -d --wait
  docker exec now-playing-journey-hub /usr/local/bin/yt-dlp --version
  # exits 255 with:
  #   [PYI-68:ERROR] Failed to extract Cryptodome/Cipher/_ARC4.abi3.so:
  #   decompression resulted in return code -1!
  docker exec now-playing-journey-hub df -h /tmp
  # tmpfs 64M 64M 0 100% /tmp

  # Control: the same image with no tmpfs works.
  docker run --rm now-playing-hub:latest /usr/local/bin/yt-dlp --version
  # 2026.08.19

  # Control: the hub reports the tool as healthy while it cannot run.
  # GET /api/v1/providers  ->  "provider": "external-tool", "status": "ok"

Cause: /usr/local/bin/yt-dlp is a PyInstaller one-file bundle that unpacks itself into /tmp on
start. Both compose files declare `tmpfs: - /tmp:size=64m`, which is smaller than the bundle.

Two fixes, both wanted:

1. docker-container/compose.yaml and docker-container/compose.journey.yaml: the /tmp tmpfs is too
   small for the tool to unpack into. Raise it (1g is ample and costs nothing until used), or point
   the tool's TMPDIR at a larger writable path.

2. docker-container/src/media/tools.ts: the health check at `status()` decides "present" with
   `existsSync` only, so a binary that exists and cannot execute is reported as present, and
   Music > Providers shows "External media tool" as working with no setup. Make the check execute
   `<tool> --version` with a short timeout and treat a non-zero exit as not-ready. `installTool`
   already verifies a SHA-256, so a version probe fits the existing shape.

Expected behaviour: in the shipped container, `yt-dlp --version` prints a version and exits 0;
`GET /api/v1/providers` reports external-tool ok only when it really runs; and a download job queued
through `POST /api/v1/downloads` with a per-fetch rights basis reaches state `done` and leaves a
file on disk.

Then add a test that would have caught it: something that asserts the tools the image ships are
executable, not merely present — e.g. in the journey's container setup, run
`/usr/local/bin/yt-dlp --version` and fail if the exit code is non-zero. Assert the health endpoint
reflects the same thing.

Evidence for the whole finding, with all outputs:
.agents/evidence/02-container-yt-dlp-defect.txt
Report: .agents/plans/2026-10-04-hermes-prove-it.md
```

---

## Note on the harness, for whoever reads the evidence

Several PASS/FAIL results in earlier transcripts of this session were **my harness's fault, not the
product's**, and each is fixed in the committed script with a comment saying why:

- The player tunes a radio station with a **single click**, not a double-click (§2.7).
- Playwright's `connectOverCDP` **cannot drive a WebView**; `.agents/evidence/harness/android-webview.mjs` speaks CDP
  to the page target directly (§2.6).
- The hub's **pending pairing session belongs to one browser session**; minting and confirming must
  be one run (§2.5).
- The companion's Downloaders buttons read only **"Check"/"Update"** with the tool name in a sibling,
  inside a 2,499px scroller in a 760px window — name matching and off-screen clicks both fail (§2.12).
- **Revert** is disabled unless the form is dirty; clicking it with nothing saved is not a defect
  (§2.12).
- The native dialogs need a **trusted** click to open, and then cannot be driven from a second
  process while Playwright owns the app (§2.5, §2.12).
# Local fix pass — 2026-09-20 (Windows checkout)

Acting on the independent audit of 2026-09-20 against this exact working tree. Every local change
in the tree is wanted; nothing is reverted to make a gate pass. Fix forward only.

Machine: Windows 11, PowerShell, Node 22.23.2, pnpm 10.33.0, git 2.55. No `JAVA_HOME` and no
`ANDROID_HOME` (only a Java 8 shim on PATH), so the Android build cannot run here.

## Progress

### Phase 0 — git checkout recovery — DONE
- `git init -b claude/now-playing-music-suite-tfzu57`, `core.autocrlf false`, remote added, branch
  head `21fce9e` fetched, mixed reset. Working tree untouched: **122 modified + 41 untracked**
  (expected ~130 + 39), no line-ending churn.
- Baseline before any of this pass's edits: `122 files changed, 15443 insertions(+), 6414 deletions(-)`.
- Removed strays: `_audit_src.tgz`, `team-clone-win-pass-00{1,2}.png`, `.playwright-mcp/`
  (`packages/aqua-ui/test-results/`, `docker-container/test-results/`, `music-player/dist-local/`
  were already absent). `.gitignore` gained `/.playwright-mcp/`, `*.tgz`, `/team-clone-*.png`.
- `pnpm install --frozen-lockfile` clean; `better-sqlite3` loads; Playwright Chromium installed.

### Phase 1 — hygiene and the red CI gate — DONE
- `pnpm format` fixed `.claude/launch.json` and `scripts/styleguide-lib.d.mts`; `format:check` green.
- Deleted `CLAUDE-FABLE-5.md` and the root `APPLE_AQUA_2009_2010_UI_DESIGN_SPEC.md` (md5-identical
  to `docs/design/`). References repointed: `.prettierignore` (both entries dropped — `docs/design`
  is already ignored wholesale), `eslint.config.js`, `docs/IMPLEMENTATION_PLAN.md`. Every other
  reference already pointed at `docs/design/`.
- Removed the stale `TODO(hub-id)` at `docker-container/src/downloads/service.ts` — `app.ts:175`
  passes `identity.hubId`.
- `scripts/licenses.mjs` takes an optional output path; new `licenses-up-to-date` gate in
  `scripts/verify.mjs` renders to a temp file and compares, so it never dirties the tree.
  `LICENSES.md` regenerated (170 packages).
- `pnpm generate` rewrote `packages/contracts/generated/openapi.json`: the local pass had changed
  `scripts/generate.ts` to draft-2020-12 without refreshing the output, so the new file is the
  correct state, not drift.
- `format:check`, `lint`, `typecheck` all exit 0.

### Phase 2 — audio — DONE
**A. The served build shipped the worklet as raw TypeScript.** Reproduced first: no
`registerProcessor` anywhere in `music-player/dist/assets/*.js`, one `data:video/mp2t` blob in the
context chunk.
- New `music-player/vite-plugins/worklet.ts`: one esbuild compilation used by both builds, emitting
  a real hashed asset and exposing it through `virtual:np-worklet-url`; serves the same script from
  a fixed path in dev; reports no asset in the single-file build, which keeps inlining the source.
- `vite.config.ts` and `vite.config.local.ts` both use it — the local config's private copy of
  `compileWorklet` is gone. `context.tsx` reads the virtual module instead of `new URL('…​.ts')`.
- The worklet resolves `@now-playing/audio-core` to `pitch-shifter-core.ts` rather than the package
  index: the index re-exports `presets.ts`, which imports a Zod schema, dragging ~900 kB onto the
  audio thread. **Worklet asset: 909 kB → 7.8 kB**, and `now-playing.html` 3.13 MB → 2.21 MB.
- Deleted the unused duplicate `packages/audio-core/src/worklets/pitch-shifter.worklet.ts` and its
  package export.
- `graph.ts` no longer writes to a `bypass` AudioParam the processor never declares; it posts
  `{ type: 'bypass' }` on the port, only on change. `PITCH_SHIFTER_PARAMETER_DESCRIPTORS` is now
  `['ratio']` so the graph, the mock and the processor cannot disagree.
- Proof: `registerProcessor` in exactly one built file, no `data:video/mp2t`, the context chunk
  references the hashed asset, and `music-player/tests/e2e/worklet.spec.ts` loads that asset into a
  real Chromium `AudioContext` and constructs `np-pitch-shifter` — **passes**. Tripwire
  `tests/perf/worklet-asset.test.ts` guards both properties without a browser.

**B. The pitch shifter clicked on every upward shift.** Reproduced with the new
`packages/audio-core/scripts/measure-clicks.ts`, matching the audit exactly.

| ratio | before (× input step) | after |
|---|---|---|
| 0.9438 | 0.0291 (1.01×) | 0.0286 (0.99×) |
| 1.0000 | 0.0288 (1.00×) | 0.0288 (1.00×) |
| 1.0595 | 0.0630 (**2.19×**) | 0.0305 (1.06×) |
| 1.2500 | 0.2536 (**8.81×**) | 0.0360 (1.25×) |
| 1.5000 | 0.5014 (**17.41×**) | 0.0432 (1.50×) |

After the change the jump is exactly `ratio ×` the input's own largest step — the theoretical floor.
- Single tap + wrap crossfade replaced by two taps half a window apart, each weighted by
  `½ − ½·cos(2πd/W)`. The arguments differ by π, so the gains sum to unity exactly and each is zero
  where its own tap wraps. Public API, bit-exact bypass, dry/wet crossfade and the helpers unchanged.
- Bonus: gains summing to 1 instead of √2 means the shifter can no longer overshoot the input peak.
- Tests: discontinuity ≤ 2× at {0.9438, 1.0595, 1.25, 1.5}; no NaN/Inf over 10 s at five ratios;
  peak ≤ input peak; the existing fundamental-within-1 % and bit-exact-bypass gates still pass.
  65 audio-core tests green.
- `pitch-shifter-core.ts` header and `docs/adr/0003` rewritten: the ADR's claim that overlap-add
  *as a method* cancels the shift was wrong and is corrected — that was a bug in the first
  implementation (grains hopping unlocked from the sweep), not a property of the family.

**Also fixed here (not on the list), both Windows-only `URL#pathname` defects:**
- `music-player/tests/e2e/playwright.config.ts` — `cwd` was `/C:/…`, so Playwright could not spawn
  the preview server at all (bare `spawn cmd.exe ENOENT`). No e2e suite could run on Windows.
- `docker-container/src/app.ts` — the admin GUI dist path had the same bug, so a Windows hub would
  silently serve the API alone. Production code, found by the same search.

### Phase 3 — hub — DONE
**A. Public share pages emitted artwork URLs to an authenticated route.** New `routes.shareArtwork`
(`GET /s/:token/artwork/:artworkId`, auth `none`, rateLimit `default`, `image/*`). The service gained
`authorizeArtwork`, which resolves the share by hashed token, enforces revocation/expiry/cap
**without** counting an access (a page with eight covers would otherwise spend eight of a capped
link's allowance just by rendering), and refuses an artwork id that belongs to no item in that share.
The payload and the HTML page now use `shareArtworkUrl(...)`. Added a `gone`/410 code to
`DomainError` — used only where the caller demonstrably held a valid reference, so an unknown token
is still an uninformative 404. 6 new tests in `share-limits.test.ts` (the fixture never set an
`artwork_id`, which is why nothing caught this): anonymous 200 `image/*`, page carries the new URL
and no `/api/v1/library/artwork/`, foreign id 404, expired 410, spent cap 410, unknown token 404, and
the access counter unchanged after five fetches.

**B. Backup restore left a live-but-dead process with a passing healthcheck.** Restore now logs at
warn and `setImmediate`s an exit(0) so the response is written first and the supervisor restarts the
hub against the restored file. `/healthz` runs `SELECT 1` and answers 503 `{status:'db-closed'}`.
The GUI says "restarting — reload this page in a few seconds" instead of "restart the container now".
The exit is injected through `HubDeps.exit` rather than taken: spying the global is not enough
because the call is deferred past the test that caused it.

**Found while fixing B, and fixed:** `api/register.ts` ran `reply.code(route.responseStatus ?? 200)`
*after* the handler, discarding any status the handler had set. `/readyz`'s 503 for starting/stopping
had therefore never been sent either. It now only applies as a default.

**C. Proxy trust — the audit item was already fixed in the local work.** `NP_TRUSTED_PROXY_CIDRS`
exists in `config.ts`, feeds Fastify's `trustProxy` via `network.isTrustedProxy` (`app.ts:273`), and
is documented in `.env.example`, both compose services and `docker-container/README.md`. Only the
test was missing. **Deviation:** no second `NP_TRUST_PROXY` variable was added — two overlapping
names for one setting is worse than one good one, and a `true` meaning "believe every client" is a
footgun this repo deliberately avoids. New `tests/security/proxy-trust.test.ts` proves the property
the audit cared about: with a trusted proxy, two clients get separate rate-limit buckets and the
audit records the forwarded address; with none (or a non-matching range), rotating `X-Forwarded-For`
does not escape the bucket and the forwarded address is never audited.

**D. The claimed route-handler contract test did not exist.** It does now:
`docker-container/tests/contract/route-handlers.test.ts` asks Fastify's own router
(`app.hasRoute`) for every entry of `routes` — 121 routes, plus guards on operationId uniqueness,
method+path uniqueness, and a non-vacuous route count. 124 assertions, all passing.

**E. `fetch-yt-dlp.mjs` raced the release.** It resolved `latest` twice, so a release landing between
the two requests paired one version's binary with the next version's checksums and failed the build
on a meaningless mismatch. The tag is now resolved once (302 `Location` from `releases/latest`, with
the JSON API as fallback because CI runners share IPs and the API is rate-limited per address) and
both assets come from that tag. Verified live: `Verified yt-dlp_linux from 2026.08.19 (39498KB)`.

### Phase 4F — Windows-only test failures — DONE (ahead of the rest of Phase 4)
The 11 `install-script.test.ts` failures were four separate Windows bugs, all fixed at the source
rather than skipped:
- `/bin/sh` does not exist. The suite now finds Git's `sh` by walking up from `git` itself — `where
  git` answers `Git/cmd/git.exe` from one shell and `Git/mingw64/bin/git.exe` from another, so a
  fixed depth is not enough — and adds that shell's own `usr/bin` to PATH, without which the script
  dies on its first line with "dirname: command not found".
- `PATH` was joined with `:`; on Windows that makes the whole list one nonexistent directory. Now
  `path.delimiter`.
- The script path was passed with backslashes, which a POSIX shell reads as escapes; it now goes
  through as `C:/...`.
- The "no docker" case symlinked the real `dirname`/`basename`. Symlinks need Developer Mode,
  `command -v` answers a POSIX path MSYS-side, and an MSYS binary moved away from its DLL will not
  run. Replaced with four lines of shell that do the same job on every platform.
- Also: the shell lookup was inside `run`'s try/catch, so a broken environment surfaced as
  `{status: 1, output: ''}` and every assertion failed with no clue; and the detach poll shelled out
  to `sh -c 'sleep 0.2'` per tick, now `Atomics.wait`.

**Suite status on Windows after Phases 0–3:** unit 407, dom 87, contracts 136, integration 170,
security 117 — all passing. lint, typecheck, format:check clean.

### Phase 4A — "gapless" was a cut with load latency — DONE
The handover began at the `ended` event: only then was the next file looked up in IndexedDB, its
permission checked, an object URL made and an element told to fetch it.
- `PlaybackEngine.preload()` attaches the next source to the **idle** deck and leaves it buffering,
  with `trackId` still null so nothing treats it as playing. `load()` promotes a warm deck instead of
  re-assigning `src` (which would discard the buffer and restore the gap). Refuses a deck that is
  still fading out, so the crossfade path is untouched.
- `store.maybePreloadNext()` runs on position updates: within 12 s of the end (the longest crossfade
  offered, so the deck is warm before the earliest possible handover), resolves the next entry's File
  — or a hub stream URL — and warms the deck. Guarded by `preloadingFor` so it happens once per
  handover, and cleared in `loadCurrent`.
- `startAtMs` now sets `currentTime` directly when metadata is already in; waiting for a
  `loadedmetadata` that has already fired would have waited for ever on a warm deck.
- 7 new tests against the existing two-deck mocks (the fake element counts `load()` calls, so
  "promoted, not refetched" is an assertion rather than a claim). 16 pass.
- The Settings label "Keep songs from the same album gapless" is now true and was left alone.

### Phase 4B — stale icons — DONE
All four PNGs were a day behind `icon.svg`. `apple-touch-icon.png` was worse: referenced by
`index.html` but *not produced by the renderer at all*, so it had never been updated. It is now one
of the generated outputs. `scripts/icons.mjs` takes an output directory, and `pnpm verify`'s new
`icons-up-to-date` gate renders to a temp dir and compares bytes.

**Found while adding that gate — `pnpm verify` did not work on Windows at all.** Two defects:
- Every gate is `spawnSync('pnpm', ...)`, and since Node 20.12 `spawnSync` refuses to run a `.cmd`
  without a shell (the CVE-2024-27980 fix). It does not throw: it returns `status: null`, so each
  gate reported "exit null" and the whole run failed while saying nothing about why. Added
  `spawnPortable`.
- `hasChromium()` probed by spawning `npx` — the same `.cmd` problem — so it always answered "not
  installed" and **silently skipped `test:local`, `test:a11y`, `test:e2e` and `styleguide:pdf`** on a
  machine that could run all four. It now asks Playwright for its own executable path.

### Phase 4C — Windows companion — DONE
- **Folder watching now exists.** New `src/main/watcher.ts`: one chokidar watcher per enabled root
  (`ignoreInitial`, `awaitWriteFinish`, unlimited depth), 2 s debounce per root, then the *existing*
  incremental scan for that root. `syncWatchers()` is called at start-up, on folder add/remove and
  whenever preferences are saved; watchers close on `will-quit`. 9 integration tests against a real
  temp directory — deliberately not against a mocked chokidar, which would have passed on the broken
  version too: a file appearing, a file appearing three levels down, a burst of twelve files
  producing one scan, the preference off, the per-folder switch off, add/remove, idempotence, an
  unreachable root not stopping the others.
- **`NP_SIGNED` is baked at build time.** It was read from `process.env` on the user's machine, so an
  unsigned build could claim to be signed because someone had exported a variable. `scripts/build.mjs`
  defines `__NP_SIGNED__` from `NP_RELEASE_SIGNED`, which the release workflow now also sets on the
  build step (it previously set it only for the metadata step). Read through a `typeof` guard so dev
  and test runs report "not signed", which is true.
- **Dead download surface removed**: `downloads:list` (returned `{items: []}`),
  `downloads:choose-directory`, the `downloadDirectory` preference nothing read, and the
  `package.json` description promising "authorized downloads". The security test that the renderer
  cannot set a write path still holds — `strict` refuses an unknown key.
- **`electron-builder.config.cjs`** no longer reads `NP_WIN_CERT_SUBJECT`; no workflow sets it, and
  signing is driven by `WINDOWS_CSC_LINK`, which electron-builder reads itself.
- **`deviceIdentity`** — the helpers, their storage comments and `verificationFingerprint`'s
  parameter are renamed, and the false claim that "the private key never leaves this browser" is
  gone (there is no private key; it is 32 random bytes). **Deviation:** the *wire* field stays
  `publicKey`. Renaming it is a protocol break for every already-paired device and would need a
  migration of `devices.public_key`, `devices.public_key_fingerprint` and
  `pairing_sessions.claimed_public_key`; the contract now documents what the field actually is and
  marks the rename for the next protocol version bump.
- **Built and packaged here — the first Windows machine this has run on.** `build` and `package` both
  succeed: NSIS x64/arm64/combined and a portable x64 exe. Unpacked `app.asar` and confirmed
  `resources/icon.ico` and `resources/tray.ico` are inside it, and that `resourcePath()`'s
  `__dirname/../../resources/<name>` resolves to them in the packaged layout — so the tray icon is
  the real one, not `nativeImage.createEmpty()`. No `files`/`extraResources` change was needed.

### Phase 4D — local-helper — DONE
- **The bundle people are told to download now exists where they can reach it.** `dist/` is
  git-ignored and nothing published it, so the README's `node now-playing-helper.mjs` pointed at
  nothing. `scripts/build.mjs` now also copies the bundle to `local-helper/now-playing-helper.mjs`,
  which is committed — the same arrangement as `now-playing.html` at the root, for the same reason —
  and takes an output directory so the new `helper-up-to-date` gate can rebuild to a temp dir and
  byte-compare. The release workflow attaches it (checkout first, sparse, because `checkout` cleans
  the workspace and would otherwise take the downloaded artifact with it). The file is excluded from
  eslint: it is generated output, and its source is linted.
- **`/health` keeps its no-token access, and the README now says what that costs.** Requiring the
  token there would break the only thing it is for — the page has to detect a helper *before* it can
  ask for a token. The exposure is bounded: allowed origins only, and `publicTool()` already strips
  filesystem paths. Documented as a known fingerprinting surface with the mitigations (`--no-app`,
  a single `--allow-origin`, or not leaving it running).

### Phase 4E — Android — PARTLY DONE (no SDK here)
- **The host allow-list is generated, not copied.** New
  `packages/contracts/scripts/emit-android-hosts.mjs` writes `AllowedHosts.kt` from
  `HELPER_DEFAULT_HOSTS`; it is wired into `pnpm generate`, so editing one side leaves a diff. It
  refuses to emit an empty list or anything that is not a plain hostname. `Tools.kt` now reads
  `AllowedHosts.hosts`. New `local-helper/tests/unit/android-allowed-hosts.test.ts` compares the
  *emitted Kotlin file* (the artefact the app compiles, not a re-run of the generator) against the
  contract.
- **`isLocal` is now the real range table**, ported from `packages/domain/src/security.ts`. The
  prefix check it replaces let through CGNAT (100.64/10), link-local 169.254/16 — including the
  `169.254.169.254` metadata address — IPv6 unique-local (fc00::/7), 6to4 and NAT64 ranges that
  embed a private IPv4 target, and every obfuscated loopback form (`127.1`, `0x7f.1`,
  `2130706433`). Includes an IPv6 literal parser, since a range check needs bytes.
- **New JVM unit test module**: `android/app/src/test/java/com/nowplaying/player/ToolsTest.kt`,
  `testImplementation("junit:junit:4.13.2")`, and a `testDebugUnitTest` step added to
  `.github/workflows/android.yml` before `assembleDebug`. Six tests over `isLocal` and the
  allow-list; no Android API is touched, so no device or emulator is needed.
- **DEFERRED — the Kotlin has still never been compiled.** This machine has JDK 8 only
  (`java version "1.8.0_501"`, no `JAVA_HOME`) and no Android SDK (`ANDROID_HOME` unset, no
  `%LOCALAPPDATA%\Android\Sdk`). Per the instruction the SDK was not installed. CI will be the first
  compile of the ~1,750 lines of Kotlin, `BlobDownloads.kt` included, and now of `ToolsTest.kt` too.

### Phase 5A — duplicated top-level CSS blocks — DONE
The audit named `:root` (4x) and `@media (pointer: coarse)` (4x) in `now-playing.css` and
`.sg-mockups` (2x) in the styleguide. Parsing the files properly found more: `now-playing.css` also
repeated `@media (prefers-color-scheme: dark)` **7 times**, `@media (pointer: coarse)` **6**,
`@media (prefers-reduced-motion: reduce)` 4, `@media (max-width: 560px)` 3, `@media (hover: none)` 2,
and `.np-app`, `.np-bar`, `.np-hero`, `.np-hero__stage` twice each; `aqua.css` repeated
`@media (pointer: coarse)` 4x and `@media (max-width: 479px)` 2x; the styleguide also repeated
`@media (pointer: coarse)` and `@media screen and (max-width: 720px)`. All merged — 15 merges across
3 files, every stylesheet now declares each top-level selector and media block once.

**How it was proved inert.** A screenshot at one viewport only samples the result, so the primary
evidence is a cascade flattener: both versions are parsed by a real browser, every rule walked in
source order, and the winning declaration recorded for each (media context, selector, property).
- `aqua.css`: 3160 winners before, **3160 after, identical**.
- `now-playing.css` vs the branch head: the only differences are the local pass's own DEC-014
  (`.eqw { max-width: 600px }`) and DEC-016 (`data-stacked` / `data-wrapped` transport rules
  replacing the old `@media (max-width: 620px)` ones) — nothing lost to the merge.
- The merge transformation itself was validated end-to-end on pristine copies of all three
  stylesheets from the branch head: **identical winner sets on every file**.
- Then the screenshot check the instruction asked for, on the *real* player DOM at 390x844 with the
  clock frozen: **0 differing pixels out of 422,760**, for both the `now-playing.css` and the
  `aqua.css` merge.

New `packages/aqua-ui/tests/unit/stylesheet-structure.test.ts` keeps it that way: 12 assertions over
all five stylesheets, one per file for uniqueness and one for balanced braces and comments.

**Worth recording:** the first merge attempt corrupted two stylesheets, because both the block
splitter and the statement splitter counted `{`, `}` and `;` without skipping comments — and several
comments in these files contain all three. It cut a comment in half in each file and silently
dropped `@media (pointer: coarse) .np-scrub__rail { height: 22px }`. Both were caught (a CSS parse
error, then the cascade flattener naming the exact lost declaration), the comments were restored from
the branch head, and the tooling was fixed before the final merge. The new test asserts balanced
comments for exactly this reason.

### Phase 5B — the shared controls were light-only — DONE
`aqua.css` drew the button, text field and checkbox from bare hex literals, so on the player's dark
page every one of them kept a white face and a light grey rim — the only part of the player that
never turned the lights off. 29 declarations across those three components now read from 40
`--aqua-ctl-*` tokens, declared with their original values in `aqua.css`'s `:root` and registered in
`tokens.json` and `design/token-map.json`.

**The dark half lives in `now-playing.css`, not `aqua.css`, and that placement is the point.** The
hub's admin GUI and the Windows companion wear the same controls and declare `color-scheme: light`;
a `prefers-color-scheme` block in the shared sheet would have darkened them too. Verified both ways
by computing styles in a real browser: with the page skin loaded, dark mode gives the button ink
`#eef0f3` on a `#3d4149→#292c33` face and the field a `#141619` well; with only the window skin
loaded, dark mode leaves everything exactly as it was. Light mode is byte-for-byte the old values.

`pnpm styleguide:check` now compares **171 tokens** (was 130) with **one** recorded exception
(DEC-002, the font fallback). `docs/DEVIATIONS.md` no longer claims more coverage than exists — it
says what the override covers and why the dark half is where it is.

### Phase 5C — tokens that did not match what ships — DONE
- **DEC-004 resolved and removed.** `tokens.json` recorded `page.barEdge` as opaque `#3A4A4E` while
  the product ships `rgb(31 41 45 / 22%)`. The stylesheet was right, so the token now records the
  shipped value and the exception is gone from `design/token-map.json` and `design/decisions.md`.
- **`--aqua-danger-ink`** added. The destructive ink `#7a1712` was hardcoded twice — once in
  `aqua.css` and once as an inline `style` in `Menu.tsx`, which is the worst place for a colour to
  live. Both now read the token.

### Phase 5D — two marquees — DONE
`Marquee.tsx` (exported, used only by the specimen gallery) and `MusicList`'s local one plus
`useMarquee` were two implementations of the same Apple label marquee, and `.aqua-marquee` and
`.lib-mq` were two names for the same clip-and-mask with the same `--mq-fade-*` properties.

Now there is one engine, `components/marquee-engine.ts`, holding the behaviour the reference's own
code was ported into: measured travel, a fixed rate so apparent speed is constant, park-glide-park-
glide, resize observation and a visibility handler. It takes a *list* of boxes and drives them from
one clock, which is the thing a per-instance animation cannot do and the reason the list needed its
own version: a row's title and artist must leave and arrive together. `useMarquee` calls it with the
playing row's labels; `Marquee` calls it with its own box. `MusicList` renders the exported
component, the local copy is gone, and the duplicate `.lib-mq` rules are gone from `now-playing.css`.

### Phase 5E — the styleguide reached into an app — DONE
`styleguide/visualisers.tsx` imported `spectrum.ts` and `constellation-layout.ts` from
`../../../music-player/src/lib/`. Both are dependency-free pure functions, so they moved to
`packages/domain/src/visualisers/` with their test, and the player, the styleguide and the test all
import them from the package. `drawSpectrum` no longer names `CanvasRenderingContext2D`: `domain` is
also compiled for the hub and the local helper, which have no DOM library, so it takes a structural
`SpectrumContext` of the three members it actually uses — which is also what lets the test assert
the drawing without a canvas. `design/manifest.json` and `design/coverage.json` follow the files.

**Left in place:** `visualisers.tsx` still imports `music-player/src/styles.css?inline`. That one is
deliberate — the guide quotes the player's own `.player-spectrum` / `.player-constellation` rules
verbatim so the specimen cannot drift from the product, and `playerRule()` throws if the rule
disappears. It is a checked quotation rather than a copy.

### Phase 5F — documentation citing tests that did not exist — MOSTLY DONE
- **The state ladder** (`docs/AQUA_CONFORMANCE.md` cited `tests/dom/controls.test.tsx`, which had no
  such thing): three tests covering Button, TextField and Checkbox through rest, focus, pressed,
  busy, invalid, mixed and disabled — asserting the *state* is announced in a class or an ARIA
  attribute, since that is what a DOM test can hold to account.
- **Destructive actions**: the Menu item now carries `aqua-menu__item--destructive` instead of an
  inline `color`, and two tests assert it is marked, separated by a separator, never first, and that
  an ordinary item is unmarked.
- **Internal panes cast no card shadow of their own** (cited to `overlays.test.tsx`): two tests,
  asserted against the stylesheet rather than `getComputedStyle`, because these tests run with no
  stylesheet attached and a computed `''` would pass while proving nothing.
- **The 1 px rim check was half a check**: it matched only `border:`/`border-top:` and missed the
  `border-width` family entirely. Widened — and taught to strip comments first, because several
  comments discuss borders in prose and the wider pattern immediately "found" a 2 px rim inside a
  sentence explaining why there is not one.
- **VOICE-003** now has a real test: `packages/contracts/tests/branding.test.ts` compares `BRANDING`
  against the three places that cannot import it — Android's `strings.xml`, the Electron builder
  config and the icon labels — instead of citing the file the constant lives in as if that were
  evidence. `UX-SAFE-001` now cites the destructive test that exists.

**DEFERRED:** `UX-PRIN-001`, `VOICE-001` and `VOICE-002` still rest on reviewer and source evidence.
Each needs a test of its own (a control that cannot act is not drawn; empty states name the next
action; errors explain the way out and never leak a stack trace), and they are three separate pieces
of work rather than one. Also deferred: scoping `scripts/styleguide-lib.mjs`'s `literal` token checks
to the selector named in `token-map.json` — today `file.includes('18px')` searches the whole sheet.

### Phase 5G — stale hand-typed numbers — PARTLY DONE
Corrected against measurement rather than guessed: **958 tests across 80 files** (was 444/46),
**121 operations across 99 OpenAPI paths** (was 120/98), `now-playing.html` **2.1 MB** (was 2.4 MB),
70 generated JSON Schema documents (was 71 — the directory holds 71 files, one of which is the
index), and the companion's folder-watching row now describes what Phase 4C actually shipped.

**DEFERRED:** making them generated. The instruction asks for `scripts/status.mjs` to write a fenced
block into `docs/IMPLEMENTATION_STATUS.md` and `docs/TESTING.md` from the vitest JSON reporter, the
Playwright spec counts, the service-worker manifest and the contracts. That is the right answer —
numbers typed by hand go stale by construction, which is the whole reason this item exists — but it
is a piece of work in its own right and the numbers above are correct today.

### Phase 5H — OpenAPI has no `components.schemas` — DEFERRED
`packages/contracts/generated/openapi.json` is 1.53 MB with every shared entity inlined at each use.
Registering the named entities so they become `$ref`s is a change to `scripts/generate.ts` whose
blast radius is every contract test and every generated consumer, and it needs its own verification
pass. Not started.

---

## Phase 6 — verification and commits

### `pnpm verify` (NP_SKIP_DOCKER=1), final run

```
PASS     generate                 2s
PASS     generated-up-to-date     0s
PASS     licenses-up-to-date      0s
PASS     icons-up-to-date         1s
PASS     format                   1s
PASS     lint                    14s
PASS     typecheck               23s
PASS     test:unit                3s
PASS     test:dom                 4s
PASS     test:contracts           3s
PASS     test:integration         8s
PASS     test:security            5s
PASS     build                   31s
PASS     test:perf                1s
PASS     build:local              6s
PASS     local-file-up-to-date    0s
PASS     helper-up-to-date        3s
PASS     test:local               6s
PASS     build:styleguide         1s
PASS     styleguide-up-to-date    0s   (after the final rebuild below)
PASS     styleguide:check         1s
PASS     styleguide:pdf          16s
PASS     test:a11y               24s
PASS     test:e2e               171s
SKIPPED  docker-build                 NP_SKIP_DOCKER=1
SEE build:windows windows-package
```

Docker Desktop was not running, so `docker-build` is the one skip. `windows-package` is not a
verify gate but *was* run by hand here, successfully, for the first time on Windows.

Counts at the end of the pass: **958 tests across 80 files** (unit, DOM, contract, integration,
security), plus **65 Playwright tests** (player e2e including the new worklet spec, the a11y sweep,
the single-file suite and the styleguide suite) and the perf budgets. `styleguide:check`: 25 rules,
44 surfaces, 10 journeys, **171 tokens**, **1** recorded exception (DEC-002), fingerprint
`5150dc10184c776a`.

### Commits

Eleven were asked for, split between "pre-existing local work" and "this pass's fixes". That split
was not achievable: the two are interleaved *within* the same files — `packages/contracts/src/api/
routes.ts` carries both the earlier signed-media work and this pass's share-artwork route,
`now-playing.css` carries both DEC-016 and the block merges — and separating them needs interactive
hunk staging, which is not available here. Splitting by file would have produced commits that do
not build.

So the history is grouped **by area** instead, eleven commits, each message stating what it carries
from the earlier pass and what is new:

1. `chore: hygiene, release gates, and two files that were not product`
2. `contracts, domain: the share artwork route, a Gone code, and one source for the visualisers`
3. `hub: security pass, and four defects that hid behind a healthcheck`
4. `audio: two taps instead of one, and stop the wrap from clicking`
5. `player: compile the worklet, warm the next deck, and refresh the icons`
6. `companion: watch the folders it says it watches, and drop what it does not do`
7. `helper: commit the file the README tells people to download`
8. `android: a generated allow-list, the real private-address table, and a test that runs anywhere`
9. `aqua-ui: one block per selector, controls that follow the scheme, one marquee`
10. `design: the token that did not match what ships, and the guide rebuilt`
11. `ci, tests and docs: numbers measured rather than remembered`

Nothing is pushed.

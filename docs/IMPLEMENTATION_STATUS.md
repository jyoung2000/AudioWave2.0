# Implementation status

What is built, what is partial, and what is not built. Anything marked **Done** has tests that
exercise it; anything **Partial** says exactly what is missing.

Current: **444 tests** across 46 files (unit, DOM, contract, integration, security, performance),
plus **45 end-to-end tests** in real browsers — 26 for the player, 19 for the hub. `pnpm verify` runs every gate available on the machine
and reports platform-unavailable ones as skipped, never as passed.

## Shared packages

|  | Status | Notes |
| --- | --- | --- |
| `contracts` — one canonical Zod schema per concept | **Done** | 71 generated JSON Schema documents; 119 operations across 97 OpenAPI paths; CI fails if the generated files are stale |
| `domain` — ids, queue reducer, EQ precedence, retune maths, sync, CSV, metrics, pairing, permissions | **Done** | 75 tests |
| `aqua-ui` — the component library | **Done** | Built to the design spec; state ladder and a11y tested |
| `audio-core` — DSP graph, EQ, level-matched bypass, retune worklet | **Done** | 44 tests, including offline renders that measure the actual response |
| `recommendations` — candidate sources, ranking, diversity, evaluation | **Done** | 48 tests plus an offline evaluation harness |
| `test-fixtures` — generated audio and libraries | **Done** | Deterministic; shared by every suite |

## music-player

|  | Status | Notes |
| --- | --- | --- |
| Library from a directory handle or a file picker | **Done** | Rescans skip unchanged files; unreadable files are reported, not silently dropped |
| Playback, queue, shuffle, repeat, history | **Done** |  |
| Equalizer, level-matched bypass, headroom, per-scope binding | **Done** | Precedence: per-track-per-playlist › track › playlist › global › Flat. The rail keeps all ten graphic centres under every preset; ones a preset does not act on are dimmed rather than dropped |
| Solfeggio presets | **Done** | Parametric, one band per named frequency |
| Retuning with honest reporting of what was applied | **Done** | Including the fallback that changes tempo, and says so |
| Playlists, star, add to playlist | **Done** | In the transport row, which is now in the hero and therefore on every section |
| Shareable links (song, album, playlist, library) | **Done** | Requires a paired hub; explains why when there is none |
| Listening metrics, CSV/JSON export | **Done** | Computed on device from an append-only log |
| Constellation view with a full 2D equivalent | **Done** | Three.js code-split; table has the same keyboard model |
| Installable, offline, Media Session | **Done** | See [PWA_AND_CAR.md](PWA_AND_CAR.md) for what a PWA cannot do in a car |
| A single-file build you open with no server | **Done** | Committed as `now-playing.html` at the repository root — 2.4 MB, nothing to build; a gate fails if it drifts from the source. [LOCAL_FILE.md](LOCAL_FILE.md) records what a `file://` origin allows, measured rather than assumed |
| Hub client: pairing, search, shares, sync | **Done** |  |
| Shared listening: create or join a group, follow its queue over the realtime socket, propose changes | **Done** | The hub always had the group API; the player now uses it. Revisioned, idempotent commands — a refused skip is shown, not swallowed |
| The 2010 page shell: status bar, section strip, hero, iTunes 10 list, dark scheme | **Done** | [UI_REDESIGN.md](UI_REDESIGN.md) maps every feature from the old window shell, and §6 records where each one is now |
| A four-entry strip in solo — Music Library, Queue, Playlists, Listening history | **Done** | Shared mode adds Now playing and Constellation and drops them again on the way out; nothing became unreachable |
| Settings on the avatar, with the equalizer inside it | **Done** | The silhouette is grey: a tinted portrait read as a status light for something the mode switch already reports |
| A styleguide built from the components | **Done** | `docs/design/STYLEGUIDE.md` is the rules; `docs/design/styleguide.html` renders every element of both skins from the real components and stylesheets (`pnpm build:styleguide`), mapped to the product that imports it |
| yt-dlp preset for the external-tool provider | **Done** | Still off by default and still behind the rights notice. What changed: `extra.preset: yt-dlp` fills in the command line and hosts from `TOOL_PRESETS`, so the arguments are reviewed in the repository rather than typed into a web form, the image ships a checksum-verified yt-dlp so enabling it is a toggle, and `test()` reports the real version — an old yt-dlp is the failure mode that wastes the most time |
| spotDL preset for the hub | **Deliberately absent** | A hub download job is one track to one path; spotDL turns one link into a set of tracks and wants a directory. That fits the local helper, which gives each job its own directory, so it is supported there rather than shipped broken here |
| Windows companion download | **Done** | Settings asks the hub's release route, which had been served and never consumed. Shows version, size, SHA-256 and signing state, and says which piece is missing rather than offering a dead button |
| The reference's music list, copied rather than reinterpreted: nine columns, marquee on the playing row, gel overlay scroller, context menu, New Playlist sheet | **Done** | Its stylesheet block is the reference's own text; the behaviours are ports of its code. The component is `aqua-ui`'s `MusicList`, so the styleguide renders the one the player uses |
| The reference's search popover: count and Clear, fifteen-second audition with a countdown ring, source badges, tempo, pager | **Done** | Auditions pause playback and resume it after |
| The 3D jewel case: shut and turning while paused, open on play, disc rising and spinning, drag with momentum | **Done** | Sleeve and disc label from the real cover, tray card from the real running order. Lazily mounted at idle, over the flat cover, and left alone where WebGL is unavailable. `JewelStage` and the stage module live in `aqua-ui`; the styleguide mounts the same ones |
| The equalizer as the iTunes window: On, preset menu, preamp and ten bands on a ±12 dB scale | **Done** | Matches the supplied screenshot; every existing EQ feature kept |
| Crossfade: a checkbox and a 1–12 s slider, equal-power fades in the graph, two decks, same-album songs kept gapless | **Done** | The fade runs on per-element faders inside the audio graph; where a source cannot enter it, on the element volume; where the volume is fixed (iOS), the outgoing track is cut rather than overlapped at full level. Skips crossfade too |
| Service worker registered, with a Reload notice for new versions | **Done** | It had been built and never registered, so the app did not start offline. An e2e test now reloads with the network off |
| Copies of chosen files kept in the app's private storage, so phones have an offline library | **Done** | On by default where folders cannot be connected; a writable stream where the browser has one, a worker with a sync access handle where it does not. Persistent storage is requested with the first copy |
| Phone readiness: iOS head and touch icon, safe-area insets, audio session, interruption recovery, honest lock-screen and volume rows | **Done** | The list drops the number and artist columns under 480 px and shows the artist under the title; a stale rule from the old table had been hiding every text column on phones |
| A GitHub Pages workflow, so the player has an https address with no server | **Done** | `pages.yml`; enable Pages with the GitHub Actions source once. `NP_BASE_PATH` rebases the app, manifest and worker for a project page |
| Readable and tappable on a phone: a touch layer for both skins | **Done** | On a coarse pointer the type steps up two points, controls and rows grow, and nothing interactive is under 44px — compact controls keep their drawn size and take taps from a transparent overlay. The desktop is untouched, including a narrow window. Measured at 320/390/768px by `responsive.spec.ts`, which also asserts the desktop still renders its 18px row of 11px text |
| Shuffle as a dealt pass, not a random pick | **Done** | Every track plays once before any repeats; the playing song survives the toggle; Previous walks the order actually heard; repeat-all reshuffles and avoids opening on the song that just closed. The old implementation picked a fresh random index each time, so it repeated songs while others never played |
| Discover: keep playing past the end of the queue, and "play similar to this" | **Done** | The recommender runs in the page over the local library, seeded by the last track. Every pick carries its reason. Nothing is sent anywhere; with nothing suitable it says so and stops |
| Download your own music as FLAC, WAV or the original | **Done** | FLAC and WAV encoded on the device by `audio-core`; MP3 only where the file already is one, with the reason shown otherwise. Verified by decoding a downloaded FLAC in the browser and comparing it to the source |
| Choosing where downloads are saved | **Done** | A folder handle kept in the same database as the music folders, with write permission re-checked at each save; optional Artist/Album filing; collision-safe names; falls back to the browser and says so when the folder cannot be written to. Where a browser has no directory picker the panel says that rather than offering a control that cannot work |
| Platform marks instead of a grey initials pill | **Done** | A 16px Aqua tile in each platform's own published colour with a plain glyph — not a redrawn logo, which their brand terms forbid and which none of them would let this repository ship. The glyph rather than the colour carries the distinction, so the set reads in greyscale. Anyone holding a platform's official asset can supply it in Settings → Platforms and it replaces the mark everywhere |
| Settings → Platforms: what each platform allows, with no hub paired | **Done** | Play here / Keep offline / Save a file, per platform, each with its reason and a link to the terms that decide it. A paired hub can only narrow the table, never widen it — pinned by a test, because a hub reporting "Spotify downloads work" must not make the app say so |
| Importing the archive a platform hands you | **Done** | A Bandcamp purchase, a Google Takeout of your own YouTube Music uploads, a set of downloadable SoundCloud tracks — all arrive as a `.zip`, and the player unpacks one with the browser's own inflater and no dependency, so a purchase made on a phone becomes tracks on that phone. Audio only; password-protected entries are skipped by name with the reason |
| Running yt-dlp or spotDL from the player | **Done, through a helper you start** | A browser page cannot start a program — installed or not, it is the same sandbox — so `local-helper/` is one file you run beside `now-playing.html`. It serves the player and the tools from the same origin, so there is nothing to configure: no CORS, no allowlisted origin, and the per-run token travels in the document. The player detects it, names the versions it found, and offers "Add from a link" only while a tool is actually there. Every fetch records what entitles you to the file and the helper refuses without one |
| A tool on your machine changing what the app claims | **Deliberately not** | YouTube's "Save a file" stays **No** with a helper running. What appears is a separate line — "Your yt-dlp: can reach it" — because what a platform permits and what is possible on your own machine are two facts, and merging them would be the app claiming a standing it has not got |
| Downloading audio from Spotify or YouTube | **Not built, and will not be** | There is no permitted route: Spotify's Web API offers no audio download and its playback is protected; YouTube's API terms prohibit downloading and its embed exposes no audio. Either would mean circumventing protection or scraping. [DOWNLOADS_AND_LEGAL.md](DOWNLOADS_AND_LEGAL.md) states this in the app's own words, and Settings → Platforms says it where someone would look for the button |
| A large-target driving view | **Not built** | The Media Session path covers the car; a driving-specific layout was not asked for |

## android

|  | Status | Notes |
| --- | --- | --- |
| The PWA as a standalone Android app | **Written, built in CI, not run on a device** | A plain WebView shell — no Capacitor — serving the player over **https** from `appassets.androidplatform.net`. Not `file://`: that is not a secure context, and without one there is no service worker, no IndexedDB, no origin-private file system and no audio worklet. One class buys the whole application |
| yt-dlp inside the app | **Written, not run on a device** | `youtubedl-android` carries a Python runtime and FFmpeg per ABI, so the APK is split by architecture. It unpacks itself on first run and the app reports "still setting up" honestly meanwhile rather than offering a button that would fail |
| One protocol, two transports | **Done and tested** | The player already spoke to "something that can run the tools" through one interface; the shell is a second implementation of it over a JavaScript bridge. The Platforms panel, the fetch sheet and the store did not change to gain an Android build. `music-player/tests/dom/tool-backend.test.ts` drives a fake bridge through the same assertions as the HTTP transport |
| spotDL on Android | **Not possible** | A Python application with no Android build, whose Spotify half needs an API key the app does not have. Reported as a named absence, not a failing button. A helper on a computer still runs it |
| Background playback in the app | **Worse than the browser** | In a browser the browser is the foreground app and Media Session keeps audio alive; in a WebView inside this app Android may suspend it. Fixing it properly needs a playback foreground service driven by the page, which is not in this version. Said plainly in `android/README.md` rather than discovered |
| On the Play Store | **Not going to happen** | Apps that fetch audio from YouTube get removed. Sideload or F-Droid, which also means no store updates |
| Compiled before it was committed | **No** | The development container cannot reach Google's Maven or the Android SDK. `.github/workflows/android.yml` is where the first real build happens. What *was* verified first: the library's coordinates and API, read out of the actual artifacts on Maven Central, and every XML file parsing |

## local-helper

|  | Status | Notes |
| --- | --- | --- |
| One file, no dependencies, no install | **Done** | `pnpm build:helper` produces `dist/now-playing-helper.mjs`. Put it beside `now-playing.html` and that is the product |
| Serves the player as well as the tools | **Done** | Which is what removes every awkward part of talking to localhost: same origin, so no CORS, no configured origin, and the token is injected into the document rather than copied from a terminal |
| Finds the tools, and fetches yt-dlp on request | **Done** | PATH, a configured path, or its own tools directory. A fetch is verified against the `SHA2-256SUMS` published in the same release; spotDL is not fetched, because its releases cannot be verified that way, and says the line that installs it instead |
| Loopback only, token on everything that acts | **Done** | Health needs no token, because the app has to find a helper before it can be given one. Everything that starts work or returns bytes does |
| No argument from the page reaches a command line | **Done** | The page names a URL, a tool and a format. Every flag is written in `src/jobs.ts`, `--ignore-config` first — a `yt-dlp.conf` could otherwise add `--exec` |
| Refuses without a rights basis | **Done** | Five options in plain words, chosen per fetch, sent with the request. The app cannot tell whether the answer is true; the person choosing it can |
| Tested end to end without the network | **Done** | A stub that behaves like yt-dlp: unit tests for the command line and the refusals, integration tests over a real socket, and `music-player/tests/e2e/helper.spec.ts` from the browser's side, which copies a real fixture so the track that lands is decoded and played like any other |
| A packaged binary per platform | **Not built** | It runs on Node, which is one dependency more than ideal but far fewer than the alternatives. A single-file executable per platform would be the next step |

## docker-container (the hub)

|  | Status | Notes |
| --- | --- | --- |
| First-run gate: `admin`/`admin`, forced change before anything else | **Done** | Enforced at the API, not only in the interface; e2e proves it with direct API calls |
| Auth: argon2id, HttpOnly SameSite cookie, CSRF double-submit, CSP | **Done** | Weak-password denylist added after a test accepted `password1234` |
| The GUI is readable on a phone or tablet | **Done** | It wears the shared window skin, so the touch layer covers its controls; its own hint, legend and fingerprint classes step up beside them. The sign-in and first-run screens had been rendering outside any `aqua-root`, in the browser's default serif — see DEVIATIONS.md |
| All 119 API operations | **Done** | A contract test asserts every declared route has a handler |
| Device pairing: short-lived single-use codes, fingerprint confirmation | **Done** | 50-bit Crockford base32, no ambiguous characters |
| Group listening: authoritative queue, revisions, drift, vote-skip | **Done** | Two defects found and fixed by tests: non-deterministic history order, and play restarting the current track |
| Sync: manifests, deltas, tombstones, conflict resolution | **Done** | Partial cursors fixed (`z.record` over an enum is exhaustive in Zod 4) |
| File transfers: chunked, resumable, hash-verified | **Done** | A mismatched hash discards the upload rather than storing a corrupt file |
| Shared links with expiry, caps and revocation | **Done** | Tokens hashed at rest; one indistinguishable response for missing/revoked/expired/capped |
| Provider adapters: MusicBrainz, YouTube, SoundCloud, Spotify, Bandcamp, local, fixture, external tool | **Done** | Capability-driven; see [PROVIDER_CAPABILITIES.md](PROVIDER_CAPABILITIES.md) |
| Discovery engine: canonical tracks, per-user OAuth, taste profile, job queue, rate-limit manager, seven modes | **Done** | End-to-end test through the API; incremental sync fixed (it had been re-importing everything on every run) |
| Downloads, conversion with FFmpeg | **Done** | Capability reported; no FFmpeg means byte-for-byte copies only, and the API says so |
| Metrics, diagnostics, backup, releases | **Done** |  |
| Admin GUI | **Done** | 13 views, error boundary per panel so one failure cannot blank the shell |
| Discord bot, slash and prefix parity | **Done** | One command service; a test runs every command through both transports |
| `nowplaying` install/update command, detached and schedulable | **Done** | systemd timer or cron; survives a closed terminal |
| Multi-user accounts | **Not built** | One administrator plus scoped device credentials |
| Server-side transcoding of provider streams | **Not built** | Deliberate; see [DOWNLOADS_AND_LEGAL.md](DOWNLOADS_AND_LEGAL.md) |

## windows-companion

|  | Status | Notes |
| --- | --- | --- |
| Folder watching, indexing, quick and full hashing | **Done** | Rescan skips unchanged files; deletions become tombstones |
| Full-text search | **Done** | An FTS5 defect meant _nothing_ was ever indexed; found by the first test written against it |
| Hub pairing, sync, chunked transfers | **Done** | Integration tests run the real client against the real hub |
| Path containment | **Done** | Segment-wise; a `startsWith` check had accepted `C:\MusicSecret` as inside `C:\Music` |
| Backup and playlist export | **Done** | Playlists, presets and folder _names_ — not music, not paths |
| Electron hardening | **Done** | Context isolation, sandbox, CSP, navigation pinning, permissions denied, 26-channel allowlist |
| Packaging: NSIS installer (x64, arm64) and portable (x64) | **Done** | Portable keeps its data beside the .exe, Electron caches included |
| `latest.json` with checksums | **Done** | `signed: false` unless CI held a certificate |
| Code signing | **Not configured** | Needs a certificate secret; the app and the manifest both report the build as unsigned |
| Provider OAuth from the companion | **Partial** | Providers are connected through the hub; the companion uses the hub's connections rather than holding its own |

## Cross-cutting

|  | Status |
| --- | --- |
| One canonical schema generating types, JSON Schema and OpenAPI | **Done** |
| Honest capability reporting throughout | **Done** |
| Append-only listening events | **Done** |
| Deterministic recommender | **Done** |
| Remote-access truth table, including the rows that say "No" | **Done** |
| Accessibility: axe on the player's nine screens and the hub's thirteen admin views, keyboard-only navigation, reduced motion | **Done** |
| Performance budgets measured from built output | **Done** |
| Documentation set | **Done** |
| Linux CI (lint, typecheck, every test project, builds, a11y, e2e) | **Done** |
| Windows CI (packaging, checksums, release manifest) | **Done** |
| Docker image build in CI | **Done** |

## Verified how

Claims here are not from reading the code. The hub was booted and driven with real HTTP requests; the
player and the admin GUI were built for production, served, and driven in a real browser; the
companion's main process was booted with Electron stubbed and its IPC exercised. Where something
could not be run in this environment — Windows packaging, `docker build` without a daemon — it is
marked as such rather than assumed to work.

## Defects found by the tests

Each was fixed at the root and has a test that fails without the fix:

1. **`z.record` over an enum is exhaustive in Zod 4**, so `POST /sync/delta` rejected every partial
   cursor map — companion sync was impossible.
2. **The password policy accepted `password1234`.**
3. **Discord users have no group membership**, so `requireMember` refused every bot command.
4. **The companion's FTS5 table was contentless**, which SQLite will not upsert into: every scanned
   file was recorded as unreadable, so the library was always empty.
5. **Path containment used `startsWith`**, accepting a sibling directory with a shared prefix.
6. **Group history ordering tiebroke on a UUIDv7's random bits**, so history came back in a different
   order on every read.
7. **Play on the already-playing track restarted it** for everyone in the group and filed a phantom
   "stopped" history entry.
8. **The hub's own typecheck had been failing** — DOM tests in the Node tsconfig with no `--jsx`.
9. **`music-metadata` was in the player's entry chunk**: ~300 KB downloaded by everyone, including
   people who never scan a folder.
10. **Incremental sync wrote the pre-run snapshot back**, so every scheduled sync re-imported every
    connected library in full, forever.
11. **The app icons shipped a mirrored music note** — heads on the wrong side of the stems, and the
    player's icon missing a stem entirely.

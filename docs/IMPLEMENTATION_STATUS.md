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
| A large-target driving view | **Not built** | The Media Session path covers the car; a driving-specific layout was not asked for |

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

# Now Playing Companion for Windows

A desktop app that reads the music already on your computer, keeps a searchable index of it, and —
if you want — connects to a [Now Playing hub](../docker-container/README.md) so the rest of your
devices can see what you have.

It is optional. The [player](../music-player/README.md) works on its own, and so does the hub. This
app exists for the one thing a web page cannot do: read a folder full of files off a Windows disk
and keep watching it.

## What it does

- **Watches folders you choose.** Add a folder, and every audio file in it is indexed with its tags,
  duration, format and a content hash. Rescans skip files whose size and modification time have not
  changed, so a hundred-thousand-file library rescans in seconds.
- **Searches.** Full-text over titles, artists and albums, matching on prefixes so results appear
  while you are still typing.
- **Pairs with a hub.** A short code and a fingerprint you compare on both screens. Nothing is sent
  before you pair, and nothing but metadata is sent after.
- **Sends files, when you ask.** Transfers are chunked, resumable, and verified by hash at the far
  end; a truncated upload is discarded rather than stored as a corrupt file.
- **Backs up what it knows.** Playlists, equalizer presets and folder names, as a JSON file you can
  read. Not your music — the files stay where they are.

## What it does not do

- It never moves, copies, renames or edits your music files.
- It sends no analytics, no telemetry and no crash reports. There is no server to send them to.
- **Folder paths never leave this computer.** Synced records carry a folder id and a path *relative*
  to that folder; the absolute path stays in the app's own process. This is enforced in one place
  (`sanitize` in `src/main/hub.ts`) and tested by reading the hub's database after a full sync
  (`tests/integration/companion-and-hub.test.ts`).
- It does not bypass any provider's terms, strip DRM, scrape a site or read a browser's cookies.

See [docs/PRIVACY.md](../docs/PRIVACY.md) for the whole picture across the three products.

## Running it from source

```sh
pnpm install
pnpm --filter @now-playing/windows-companion dev
```

`dev` starts Vite for the interface, esbuild in watch mode for the main process, and Electron
pointed at the dev server. Editing a renderer file hot-reloads; editing a main-process file needs a
restart.

```sh
pnpm --filter @now-playing/windows-companion typecheck   # both tsconfigs: main process and renderer
pnpm --filter @now-playing/windows-companion build       # dist/main/*.cjs + dist/renderer/
pnpm --filter @now-playing/windows-companion package     # installer + portable build into release/
pnpm --filter @now-playing/windows-companion icons       # re-render resources/ from the SVGs
```

Packaging runs on Windows. On Linux or macOS `build` works, `package` does not.

## The two builds

|  | Installer (`Setup … .exe`) | Portable (`Portable … .exe`) |
| --- | --- | --- |
| Installs to | your user profile (no administrator needed) | nowhere — it runs from where it is |
| Data lives in | `%APPDATA%\Now Playing Companion` | `NowPlayingCompanion-data` beside the .exe |
| Start-menu entry | yes | no |
| Uninstaller | yes; it leaves your database and music alone | delete the folder |
| Architectures | x64, arm64 | x64 |

The portable build sets its own data directory from `PORTABLE_EXECUTABLE_DIR`, including Electron's
caches, so running it from a USB stick and taking the stick away leaves nothing behind.

## About the SmartScreen warning

Builds from CI are **not code-signed** unless a certificate is configured, and a certificate costs
money and is tied to a legal identity. An unsigned Windows app makes SmartScreen show a blue
"Windows protected your PC" dialog the first time it runs; choose **More info**, then **Run anyway**.

The app's About screen says the same thing, and `latest.json` records `signed: false`. Nothing in
this repository will tell you a build is signed when it is not — a person deciding whether to click
past that dialog is relying on the answer being true.

Verify a download against `SHA256SUMS.txt` from the same release:

```powershell
Get-FileHash '.\Now Playing Companion Setup 0.1.0 x64.exe' -Algorithm SHA256
```

## How it is put together

```
src/
  shared/channels.ts   the channel allowlist — names only, so the preload stays tiny
  shared/ipc.ts        the same channels with a Zod schema for every request and response
  preload/index.ts     the bridge: an allowlist check and nothing else on window.companion
  main/                the only code with filesystem or network access
    index.ts             window, tray, IPC handlers, startup
    security.ts          CSP, navigation pinning, permission denial, single instance
    store.ts             SQLite: folders, tracks, playlists, presets, search index
    library.ts           scanning, hashing, tag reading, path containment
    hub.ts               pairing, sync, chunked transfers, and the sanitiser
  renderer/            ordinary web code with no privileges of its own
```

The security boundary is the channel list. The renderer has no Node access, no remote module and no
filesystem; everything it can do is one of the 26 channels in `shared/channels.ts`, validated on the
way in *and* on the way out. Adding a capability means adding a channel — there is no ambient way to
reach the operating system, and `tests/security/companion.test.ts` asserts the preload's allowlist
and the schema registry cannot drift apart.

Electron's own hardening is in `src/main/security.ts`: context isolation, sandboxed renderer, no
node integration, no webviews, a strict CSP with no inline or remote script in a packaged build,
navigation pinned to the app's own origin, every permission request denied rather than prompted, and
`shell.openExternal` restricted to `http(s)` — a `file:` or custom-scheme link is a way to start a
program, so it is refused with a reason.

## Tests

```sh
pnpm exec vitest run --project unit --project dom --project contracts --project integration --project security windows-companion
```

- `tests/unit` — scanning, hashing, the search index, path containment.
- `tests/dom` — the interface, including what it does when the bridge is missing.
- `tests/contract` — the `latest.json` the release workflow publishes, parsed with the canonical schema.
- `tests/integration` — the main process booting with Electron stubbed, and the companion talking to
  a **real hub**: pairing, sync, transfers, and a hub that turns out to be a different hub.
- `tests/security` — the sanitiser, the channel allowlist, the CSP, and link handling.

Packaging itself is exercised by
[`.github/workflows/windows-companion.yml`](../.github/workflows/windows-companion.yml), which runs
on `windows-latest` and produces the installer, the portable build, `SHA256SUMS.txt` and
`latest.json`.

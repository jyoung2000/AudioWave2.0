# The local helper

One small program that serves the player and runs yt-dlp or spotDL for it.

```
node now-playing-helper.mjs
```

That is the whole setup. It finds `now-playing.html` or a built player beside it, serves both on
`http://127.0.0.1:17342`, opens a browser, and the player comes up with the tools already wired in.
No container, no desktop app, nothing to configure — and nothing to install first: whatever of
yt-dlp, spotDL and FFmpeg is missing is set up in the background (see below).

## The tools set themselves up

Since 2026-09-27 (owner decision; `docs/DOWNLOADS_AND_LEGAL.md`) the helper does not wait to be
asked. On start it looks for each tool — a path you gave it, a copy it set up before, or one on PATH —
and installs every one that is missing, one at a time: yt-dlp, then FFmpeg, then spotDL.

- **From the project's own GitHub release, verified.** The release is read once through the GitHub
  API; the file must match the SHA-256 GitHub publishes for it (or, for an older release, the checksum
  file in that same release). No published SHA-256 means nothing is installed. The verified file must
  then answer its version flag before it is used.
- **Into its own folder.** `%LOCALAPPDATA%\NowPlaying\tools` on Windows,
  `~/Library/Application Support/NowPlaying/tools` on macOS, `~/.local/share/now-playing/tools` on
  Linux, or `--tools-dir`. Delete that folder to remove them. Copies on PATH or given with `--yt-dlp`
  and friends are yours and are never replaced.
- **FFmpeg on Windows only.** On macOS and Linux the helper names the package-manager command instead.
- **Retried, and kept current.** A failure is recorded in `setup-state.json` and tried again on the
  next start or after six hours. The yt-dlp it set up is compared with the latest release at most once
  a day and replaced when it differs (never while a download is running).
- **Watchable.** `/helper/v1/health` reports each tool's `setup` state — `ready`, `installing` with a
  progress, `failed` or `unsupported` with the reason — and `POST /helper/v1/tools/<id>/install`
  installs one now.

`--no-auto-tools` turns all of this off: the helper then uses only what is already installed.

## Why this exists at all

A page in a browser cannot start a program. That is not a rule this project chose — it is the
sandbox every page lives in, and it is the same thing that makes the player safe to open from a
link. Installing the PWA does not change it either: an installed PWA is the same engine in a
different window, with the same sandbox and the same cross-origin rules. So yt-dlp needs something
outside the page, and this is the smallest honest version of that something.

Serving the page is what makes it one download instead of two. The page and the tools share an
origin, so there is no CORS to configure, no origin to allowlist and no token to copy — the token
goes into the document on its way out and the app finds it there.

## What it will not do

- **It ships no tools, and runs nothing unverified.** It sets the tools up from their projects'
  releases, as above, and refuses any file whose SHA-256 was not published or does not match.
- **It listens on loopback only.** Not a setting. A program that runs subprocesses should not be
  reachable from anywhere its operator is not already sitting.
- **It takes no arguments from the page.** The player names a URL, a tool and an output format. Every
  flag on the command line is written in `src/jobs.ts`, `--ignore-config` among them — because a
  `yt-dlp.conf` in your home directory could otherwise add `--exec`.
- **It refuses a request with no rights basis.** Each fetch carries why you are entitled to the file,
  and the helper will not start without one.
- **It fetches from an allowlist.** Eleven hosts by default, and never an address on your own
  network.

## Options

| | |
| --- | --- |
| `--port <n>` | Default 17342. The player probes this and the next three, so a helper that had to move is still found. |
| `--app <path>` | The player to serve: a built directory or `now-playing.html`. Found automatically when it is nearby. |
| `--no-app` | Serve the API only, for a player hosted somewhere else. |
| `--allow-origin <o>` | Let a player on that origin call this helper. Needed only with `--no-app`. |
| `--allow-host <h>` / `--only-hosts <a,b>` | Add to, or replace, the host allowlist. |
| `--yt-dlp` / `--spotdl` / `--ffmpeg` `<path>` | Use a particular binary instead of looking for one. |
| `--tools-dir <path>` | Where the tools it sets up are kept between runs. |
| `--no-auto-tools` | Do not set up missing tools on start, and do not update the yt-dlp it set up. |
| `--work-dir <path>` | Where downloads are staged. Default: the system temp directory. Each run makes its own new folder inside it and deletes only that folder on exit. |
| `--timeout <seconds>` | Give up on one job after this long. Default 900. |
| `--no-open` | Do not open a browser. |

## Using it with a player hosted somewhere else

```
node now-playing-helper.mjs --no-app --allow-origin https://you.github.io
```

It prints a token. Paste the address and the token into **Settings → Platforms**, under "My player
is hosted somewhere else". The browser will ask the helper's permission to reach a local address
before it allows the first request; the helper answers that preflight for allowed origins only.

This path has more moving parts than letting the helper serve the page, which is why it is the one
behind a disclosure triangle.

## FFmpeg

Set up automatically on Windows; on macOS and Linux, install it with your package manager. Until it
is there, its absence is reported rather than worked around: nothing can be converted and yt-dlp is
asked for the best single audio stream a site offers rather than told to extract one, so you get
whatever container that was. The player's format buttons grey out accordingly.

## One thing `/health` gives away

`/health` is the only route that answers without the token. That is deliberate: the page has to be
able to tell that a helper is running, and which tools it found, *before* it can sensibly ask you to
paste a token. Everything that does anything, or returns bytes, needs the token.

So it is worth being plain about what that costs. A page on an allowed origin can learn, without any
token:

- that a helper is running on this machine, and its version;
- which of yt-dlp, spotDL and FFmpeg are installed, their versions, and how their setup is going;
- which hosts the helper will fetch from, and how long it has been up.

It does **not** reveal any filesystem path — `publicTool()` strips the path before the record leaves
the process, because a path says something about the machine — and it cannot be read by a page on an
origin you did not allow, because the origin check runs first.

If that fingerprint matters to you, run the helper with `--no-app` and a single `--allow-origin`, or
do not leave it running when you are not using it. The trade was made knowingly: a discovery
endpoint that needs a token cannot be used for discovery.

## What you are responsible for

Running yt-dlp against YouTube is against YouTube's terms, whatever you fetch. That is between you
and them; no amount of software settles it, and this program does not pretend to. What it does is
make the question explicit — every request records what entitles you to the file — and stay out of
the way of the answers that are clearly fine: your own uploads, Creative Commons and public-domain
material, a creator's own archive, a podcast.

It contains no DRM circumvention, passes no cookies to the tools, and reads nothing from your
browser profile. See `docs/DOWNLOADS_AND_LEGAL.md`.

## Building it

```
pnpm --filter @now-playing/local-helper build
```

Produces `dist/now-playing-helper.mjs`, one file with no runtime dependencies, and copies it to
`local-helper/now-playing-helper.mjs`, which is committed. That committed copy is what the
instruction at the top of this file refers to: `dist/` is git-ignored, so without it there was
nothing to download. `pnpm verify` rebuilds and compares the two, so the committed copy cannot drift
from the source, and the release workflow attaches it to every release.

Put it beside `now-playing.html` and it is the whole product.

## Tests

`tests/unit` covers the parts where being wrong is dangerous rather than merely broken: the command
line it builds, the environment it hands a subprocess, which origins it answers, which paths it
serves — and the installer, the zip reader and automatic setup, against a fake GitHub, so a file that
does not match its published SHA-256 is proven to be refused without anything reaching the network.
`tests/integration` runs the whole chain over a real socket against a stub that behaves like
yt-dlp — so the wiring is tested without the suite depending on a video still existing somewhere.
`music-player/tests/e2e/helper.spec.ts` does the same from the browser's side.

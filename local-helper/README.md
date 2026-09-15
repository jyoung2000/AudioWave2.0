# The local helper

One small program that serves the player and runs yt-dlp or spotDL for it.

```
node now-playing-helper.mjs
```

That is the whole setup. It finds `now-playing.html` or a built player beside it, serves both on
`http://127.0.0.1:17342`, opens a browser, and the player comes up with the tools already wired in.
No container, no desktop app, nothing to configure.

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

- **It ships no tools.** It finds what you have installed. It can fetch yt-dlp for you, verified
  against the checksums published in that same release; it will not fetch spotDL, whose releases it
  cannot verify the same way, and says so with the line that installs it.
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
| `--tools-dir <path>` | Where an installed yt-dlp is kept between runs. |
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

Optional, and its absence is reported rather than worked around. Without it nothing can be converted
and yt-dlp is asked for the best single audio stream a site offers rather than told to extract one,
so you get whatever container that was. The player's format buttons grey out accordingly.

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

Produces `dist/now-playing-helper.mjs`, one file with no runtime dependencies. Put it beside
`now-playing.html` and it is the whole product.

## Tests

`tests/unit` covers the parts where being wrong is dangerous rather than merely broken: the command
line it builds, the environment it hands a subprocess, which origins it answers, which paths it
serves. `tests/integration` runs the whole chain over a real socket against a stub that behaves like
yt-dlp — so the wiring is tested without the suite depending on a video still existing somewhere.
`music-player/tests/e2e/helper.spec.ts` does the same from the browser's side.

# Now Playing — the player

An offline-first music player for the music already on your device. It is a web app you can install;
everything it needs is in the bundle, and nothing is fetched from anywhere else.

It works entirely on its own. Pairing a [hub](../docker-container/README.md) adds search across
providers, shared listening and sync — it never becomes a requirement.

## How it is laid out

A sticky status bar, a hero player, and an iTunes 10 list underneath — the arrangement of
[`docs/reference/now-playing-header.html`](../docs/reference/now-playing-header.html), rather than
the desktop window the hub's admin GUI uses. [docs/UI_REDESIGN.md](../docs/UI_REDESIGN.md) maps
every feature from the old shell to this one and explains what was taken from the reference and
what was deliberately left out of it.

The controls are always at the top of the page, so the song you are hearing is one glance away from
whatever section you are in. Nine sections live in a strip under the bar: Music, Now playing, Up
next, Playlists, Search, Constellation, Listening, Equalizer, Settings.

## Listening alone, or together

The switch in the status bar is the app's one mode:

- **Solo** — your library, your queue, your equalizer, your history. Nothing leaves the device.
- **Shared** — a hub group. Everyone hears the same queue, the hub keeps the order, and skipping is
  a request the hub grants or refuses rather than something one player does alone. Your library and
  your listening history still stay on your own device.

Shared listening needs a paired hub that this device can reach, and a WebSocket — so it is
unavailable from a `file://` page. When it cannot be used the switch says why, on the bar and again
under Settings, rather than disappearing.

## Playback

Songs follow each other with a plain cut unless you turn on **Crossfade songs** under Settings →
Playback: a checkbox and a one-to-twelve-second slider, as iTunes had it. The song on its way out
fades along an equal-power curve while the next fades in, skips fade too, and songs from one album
follow each other without a fade unless you switch that rule off, so a live recording stays whole.
The fades run inside the equalizer path; see
[docs/architecture/AUDIO_PIPELINE.md](../docs/architecture/AUDIO_PIPELINE.md) for the mechanics
and what happens where a source cannot enter that path.

## Shuffle, and what comes after the queue

**Shuffle deals a pass.** Turning it on shuffles the order once and plays it: every song comes up
exactly once before any comes up twice, Previous walks back through what you actually heard, and the
song already playing keeps playing — an iPod never cut the track you were on to start shuffling.
With repeat-all the pass is dealt again at the end, reshuffled, and never opens on the song that
just closed the last one. Adding a song to the queue while shuffle is on deals it somewhere into the
part that has not played yet, rather than pinning it to the end.

**Discover keeps going.** With it on, a queue that runs out does not stop the room: the last song
you heard becomes the seed and the player picks more from this device. The picking is done here, by
the recommender in [`packages/recommendations`](../packages/recommendations) — deterministic,
CPU-only, no model and no service — reading the listening history that never leaves the device.
Every pick carries the reason it was made, and the player shows it. **Play similar to this** in a
row's context menu does the same thing on demand, as its own queue.

With nothing on the device that fits, it says so and stops, rather than playing you what you just
heard.

## Getting your music back out

**Download…** in a row's context menu, or the download key in the transport, saves your own music as
a file: the original bytes, a FLAC, or a WAV. FLAC and WAV are encoded on your device — the FLAC
encoder is part of `audio-core`, not a download — and both are lossless. MP3 is offered only when
the file already is one, because making an MP3 means encoding one and this player carries no MP3
encoder; the sheet says that rather than producing something else quietly.
[docs/DOWNLOADS_AND_LEGAL.md](../docs/DOWNLOADS_AND_LEGAL.md) has the whole matrix.

**Settings → Downloads** decides where they go: a folder you pick once and are never asked about
again, the system save dialog each time, or the browser's own downloads folder. A chosen folder can
file tracks under the artist and album. The player holds a permission rather than a path — it is
never told where the folder is — it never overwrites a file already using the name, and if the
folder stops working the download falls back to the browser rather than vanishing.

## Setting it up, which is to say, not

There is no account, no key and no server in the player. Open it, choose music, play. On a computer
with Chrome or Edge, connect a folder and it is read in place; anywhere else — every phone included —
choose files and the player keeps its own copies inside the app, so they play offline and are still
there after a reload. Everything the hub adds is optional and stays optional.

To get it onto a phone it needs an address, and the repository's Pages workflow gives it one:
enable GitHub Pages with the **GitHub Actions** source and the player is served from
`https://<owner>.github.io/<repository>/`, ready to add to a home screen.
[docs/PWA_AND_CAR.md](../docs/PWA_AND_CAR.md) has the phone-by-phone details.

## Running it

```sh
pnpm install
pnpm --filter @now-playing/music-player dev       # http://localhost:5173
pnpm --filter @now-playing/music-player build     # dist/, with a service worker
pnpm --filter @now-playing/music-player preview   # serve the production build
```

### Or with no server at all

**[`now-playing.html`](../now-playing.html)** at the root of the repository is the whole player in
one committed file — about 2.4 MB, with nothing beside it. Download it and open it; there is nothing
to build. Rebuild it only if you change the source:

```sh
pnpm --filter @now-playing/music-player build:local   # updates the committed now-playing.html
```

Copy it anywhere and open it in a browser. Your
library, playback, the equalizer, retuning, playlists and metrics all work; group listening and
installing it as an app do not, because a page opened from a file cannot open a WebSocket or
register a service worker. The app says which is which on its Settings screen, and
[docs/LOCAL_FILE.md](../docs/LOCAL_FILE.md) has the measurements behind that list.

## Where your music comes from

Two ways in, depending on what the browser supports:

- **A folder** (Chromium): grant a directory once with the File System Access API and the player
  keeps the handle. Rescans pick up new files; the permission survives a restart.
- **Files you pick** (everywhere else): a one-shot picker. The files are indexed for this session and
  the browser does not let the app re-open them later without asking again — the player says so
  rather than appearing to lose your library.

Either way, **the player never copies your audio.** It reads tags from the first 256 KB of each file
and stores the index — titles, artists, durations, artwork thumbnails, playlists, listening history —
in IndexedDB. "Space used" in Settings counts that index, not your music.

## What is in it

- **Playback** through one reused `<audio>` element, with a Web Audio graph on top: preamp → retune
  → ten-band EQ → headroom trim → limiter → analyser.
- **An equalizer** with level-matched bypass, so switching it off compares _tone_ rather than
  loudness — a louder signal always sounds better, and matching the level is the only way the
  comparison means anything. The headroom trim that stops boosts from clipping is shown with its
  value. Presets bind per track, per playlist, per track-within-a-playlist, or globally, resolved in
  that order.
- **Retuning** to a different concert pitch (415, 432, 440, 442, 444 Hz, or anything between 400 and
  480), through an AudioWorklet pitch shifter that preserves duration. It states the shift in cents
  and the ratio, and if the worklet is unavailable and the fallback changed playback rate, it says
  the tempo changed too rather than continuing to claim otherwise.
- **Solfeggio presets** — nine narrow filters, one per frequency, plus one that lifts all nine.
  Described as what they are: filters that emphasise what the recording already contains.
- **A queue** with shuffle, repeat, and a history that records why each track ended.
- **Playlists**, and a star and add-to-playlist button in the same row as the transport controls.
- **Shareable links** for a song, album, playlist or your whole library — through a paired hub, which
  is the only thing that can serve them. Without one, the app explains why instead of failing.
- **Listening metrics**, computed on the device from an append-only event log that never leaves it,
  exportable as CSV or JSON.
- **A constellation view**: your library as a star field, one star per album, clustered by artist.
  Three.js loads only when you open it, and every star has a row in a table beside it with the same
  keyboard navigation — the same information, not a fallback.

## Privacy, concretely

- No analytics, no telemetry, no crash reporting. There is nothing to send them to.
- The app makes **no network request at all** unless you pair a hub — asserted by an end-to-end test
  that fails if anything is loaded from outside its own origin.
- Your listening history is local. Sending it to a hub is a separate, per-device permission, and it
  can be deleted from Settings in one action that really removes it.
- Everything is bundled: no CDN, no web fonts, no third-party scripts.

## Offline and installing

See [docs/PWA_AND_CAR.md](../docs/PWA_AND_CAR.md) for installing, what still works offline, and what
does and does not work in a car — including the part that will not: a web app cannot appear as a tile
on the Android Auto or CarPlay home screen. What works, once playback starts on the phone, is the
track and its controls on the car's display, from the steering wheel and from headset buttons.

## Accessibility

Every screen passes an axe check in CI (and so does the hub's admin GUI, in its own suite), and the keyboard model is tested rather than assumed: every
section reachable with the keyboard alone, every transport control focusable and named, focus visible
wherever it lands (including where the visible ring is on an ancestor), and reduced motion honoured.
The interface follows `docs/design/APPLE_AQUA_2009_2010_UI_DESIGN_SPEC.md` under the
`snow-leopard-itunes-9` profile.

## Tests

```sh
pnpm exec vitest run --project unit --project dom music-player
pnpm --filter @now-playing/music-player test:e2e    # 26 tests, real browser, production build
pnpm --filter @now-playing/music-player test:a11y
pnpm build && pnpm test:perf                        # first-load budget, measured from dist/
```

The e2e suite runs against a real production build served by `vite preview`, because the service
worker, the code-split chunks and the minified bundle are part of what is being tested and none of
them exist in dev mode.

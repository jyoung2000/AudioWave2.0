# Provider capabilities

Capabilities are configuration-driven (`provider_app_configs` + adapter descriptors) and reported live by `GET /api/v1/providers`. This matrix records what each adapter is allowed to do, why, and what it needs. **Reviewed: 2026-09-03** against the linked official documentation. A provider failure degrades only that provider (partial results).

Legend: ✔ available · 🔑 requires credentials/user auth · ⛔ unsupported (provider terms/technology) · ◐ restricted (per item) · Sync grade: exact / near / best-effort / unsupported.

| Provider | Role | Docs | Auth | Metadata | Search | Preview | Playback | Import likes/playlists | Creator download | User-owned download | Group sync | EQ | Attribution | Rate / quota strategy | Cache | Discord | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Local / hub library | audio source | — | device credential | ✔ | ✔ | ✔ | ✔ | — | — | ✔ (files you own) | exact | ✔ | none | none | — | ✔ | Range streaming of hub-hosted files; content hash identity |
| Windows companion library | library | — | device credential | ✔ | ✔ | ◐ | ◐ after transfer | — | — | ✔ after the owning companion authorizes a transfer | exact after transfer, else unsupported | ✔ (local) | none | none | manifest/delta | ◐ | Playback/download only via completed hub transfers |
| MusicBrainz | metadata only | https://musicbrainz.org/doc/MusicBrainz_API · https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting | none (descriptive User-Agent with contact) | ✔ | ✔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | unsupported | ⛔ | "Data from MusicBrainz" | 1 request/second token bucket, single concurrency | 24 h | ⛔ | Identifies/catalogs music; never an audio source. Latest releases come from release-groups. |
| YouTube (Data API v3 + IFrame Player) | audio source (embed) | https://developers.google.com/youtube/v3 · https://developers.google.com/youtube/terms/api-services-terms-of-service | API key (search/metadata); user OAuth for permitted account data | ✔ 🔑 | ✔ 🔑 | ⛔ | ◐ embed only, in the browser | 🔑 (liked videos/playlists via OAuth `youtube.readonly`) | ⛔ | ⛔ | best-effort | ⛔ (embed audio not exposed to Web Audio) | YouTube branding/link required on results | 10,000 units/day default; search = 100 units; cached aggressively; background discovery P3 | 1 h search, 24 h metadata | ⛔ (no bot-playable stream) | No audio download; API data not reused outside permitted terms |
| SoundCloud | audio source | https://developers.soundcloud.com/docs/api/guide.html | OAuth 2.1 client credentials (app) + PKCE user auth | ✔ 🔑 | ✔ 🔑 | ◐ | ◐ when track `access = playable`, stream resolved by the hub | 🔑 (user likes/playlists) | ◐ when `downloadable` and permitted | ⛔ | best-effort | ◐ (CORS-dependent) | Required: link + "on SoundCloud" | Client-level limits; 429 honoured with backoff; token reuse | 1 h | ◐ (playable streams) | |
| Bandcamp | discovery / outbound link | https://bandcamp.com/developer (label/merch API, access-approved) | none public | ◐ (URL parsing only) | ⛔ | ⛔ | ⛔ (open at source) | ⛔ | ⛔ | 🔑 import of purchased exports via the companion | unsupported | ⛔ | link to Bandcamp | n/a | n/a | ⛔ | No official public API; credentials may not be shared between users. Optional external-tool adapter is off by default. |
| Spotify | metadata + library import (+ browser SDK playback) | https://developer.spotify.com/documentation/web-api · https://developer.spotify.com/documentation/web-playback-sdk | app client credentials + user PKCE | ✔ 🔑 | ✔ 🔑 | ⛔ (previews removed for new apps) | ◐ Web Playback SDK, Premium, browser only | 🔑 (`user-library-read`, `playlist-read-private`) | ⛔ | ⛔ | unsupported | ⛔ | Spotify attribution rules | 30 s rolling limits, `Retry-After`, batch endpoints, playlist `snapshot_id` checks | 1 h | ⛔ | Development mode limits authenticated users; extended quota required for multi-user deployments |
| Public-domain fixture | audio source | in-repo | none | ✔ | ✔ | ✔ | ✔ | — | ✔ | ✔ | exact | ✔ | "Synthetic fixture" | none | — | ✔ | Real end-to-end provider serving generated tone files |
| External media tool (optional) | tool | configured binary | admin-enabled + rights notice | ◐ | ⛔ | ⛔ | ⛔ | ⛔ | ◐ | ◐ only for content you own / are authorized to download | unsupported | — | preserved from source | serialized, timeouts | none | ⛔ | Off by default; allowlisted hosts; no cookies, no DRM bypass |

## Setup limitations (known)
- YouTube: API key must be restricted to the hub; quota resets at midnight Pacific; embed playback needs a visible player element.
- SoundCloud: app registration currently requires a request form; client credentials tokens expire and are reused until then.
- Spotify: development-mode apps allow a limited allowlist of users; production multi-user use requires extended quota approval. Do not plan around one dev credential for unlimited users.
- MusicBrainz: set a contact email in the hub provider config; requests without a descriptive User-Agent are throttled.
- Bandcamp: only deep links and user-supplied purchased exports.

## How the UI uses this
Every result carries `ProviderCapabilities`; actions (Preview, Play, Add to queue, Add to playlist, Open at source, Download, Import) are enabled from that structure only, with a "Why unavailable?" explanation from `reason`. A stream URL never implies download permission.

## What the player itself says, with no hub

The matrix above is the hub's. The player carries its own reviewed copy in `music-player/src/lib/platforms.ts` and shows it in **Settings → Platforms**, because the question "can I get my Spotify library in here?" is asked before anyone pairs anything. It answers three questions per platform — *play here*, *keep offline*, *save a file* — each with its reason, and it never leaves a "no" unexplained.

A paired hub can only **narrow** that table, never widen it (`withHubReport`): a hub reporting `creatorDownload: available` for Spotify changes nothing, because Spotify's terms decide that and not a hub's configuration. A unit test pins this, and pins that every provider in `KNOWN_PROVIDERS` has a row here, a row in the player's table, and a mark.

## Getting your own music in: the archive route

No platform lets an application take audio out of its stream, and this project does not try. What every one of them does offer is an export of the music that is already yours, and those arrive as a `.zip`:

| Platform | What it hands you | How it gets here |
|---|---|---|
| Bandcamp | Your purchase, in the format you chose at checkout, FLAC included | Import a .zip |
| YouTube Music | Google Takeout of the tracks *you* uploaded | Import a .zip |
| SoundCloud | Tracks whose creator turned on Download | Add the folder, or import the .zip |
| Spotify | Nothing — the Web API offers no audio download | Playlists import as *lists*, matched to copies you own |

`music-player/src/lib/zip.ts` reads these with the browser's own inflater (`DecompressionStream('deflate-raw')`) and no dependency: the central directory is parsed, audio entries are decompressed one at a time, non-audio entries are left in the archive, and password-protected entries are skipped by name with the reason. Nothing is written outside the library.

## Marks and artwork

Each platform gets a 16 px Aqua tile in **its own published colour** carrying a plain glyph for what it is to this app — a play triangle for video, a cloud for SoundCloud's namesake, a tag for buying from an artist. None of them is a redrawn logo. Colour is not what a trademark protects; the logo is, and every one of these platforms publishes brand terms asking that only their official, unmodified file be used. So none is shipped in this repository.

The glyph rather than the colour carries the distinction, so the set still reads in greyscale (the `itunes-10-transition` profile desaturates the source list; colour-blind readers get the same treatment for free), and the platform's name is always in the accessible name and the tooltip.

Anyone who holds a platform's official asset under that platform's terms can supply it in **Settings → Platforms → Use official artwork**. It is stored on that device, used whole — no tile behind it, no crop, no recolour — and replaces the built-in mark everywhere in the app at once.

## Running the tools yourself

A browser page cannot start a program, so yt-dlp and spotDL need something outside it. There are two supported somethings, and both are off until someone deliberately turns them on.

### The local helper

`local-helper/` builds to one file, `now-playing-helper.mjs`. Put it beside `now-playing.html`, run it with `node`, and it serves the player on `http://127.0.0.1:17342` and runs the tools for it. Because it serves the page, the two share an origin: no CORS to configure, no origin to allowlist, and the per-run token travels in the document rather than through a terminal. Its own README covers the options; the constraints are:

| | |
| --- | --- |
| Reachable from | 127.0.0.1 only, and not configurable |
| Tools | Found on PATH or configured. yt-dlp can be fetched on request, verified against the `SHA2-256SUMS` published in the same release. spotDL is not fetched — its releases cannot be verified the same way — and reports the line that installs it |
| Arguments | Built in `src/jobs.ts` and nowhere else. The page names a URL, a tool and a format; it can name no flag. `--ignore-config` is always first, because a `yt-dlp.conf` could otherwise add `--exec` |
| Authorisation | Every fetch carries a `DownloadAuthorizationBasis`; without one the helper refuses |
| Hosts | An allowlist, and never a private address |
| Credentials | None. No cookies are passed, no browser profile is read, and the subprocess gets a minimal environment |

**yt-dlp is deliberately not pinned.** Pinning is usually the careful choice and here it is the opposite: the tool works by keeping up with sites that change, so an old copy does not age into something safer, it ages into something that fails confusingly. What is kept is integrity — the bytes are checked against that release's own checksums — rather than a frozen version.

### The hub's external-tool provider

The same capability for people running the container, through the provider that was always there. It stays **off by default**; an administrator enables it and accepts the rights notice. What is new is that `extra.preset: yt-dlp` fills in the command line and the hosts from `TOOL_PRESETS`, so the arguments are written in the repository and reviewed rather than typed into a web form, and the image now ships a verified yt-dlp so enabling it is a toggle rather than an install. `test()` reports the tool's real version, because an old yt-dlp is the failure mode that wastes the most time.

There is no spotDL preset on the hub, and that is a decision rather than an omission: a hub download job is one track to one path, while spotDL turns one link into a set of tracks and wants a directory. That shape fits the local helper, which gives every job its own directory, so spotDL is supported there and honestly absent here rather than shipped broken.

### What none of this changes

The three columns in **Settings → Platforms** — play here, keep offline, save a file — answer what the *platform* permits, and a tool on your own machine does not change that answer. So YouTube's "Save a file" stays **No** while a running helper adds a separate line beside it: "Your yt-dlp: can reach it". Two different facts, kept in two different places, because merging them would have the app claim a standing it does not have.

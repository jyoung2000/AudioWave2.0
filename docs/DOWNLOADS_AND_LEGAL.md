# Downloads, and when a download is not offered

Downloading is the feature most likely to be dishonest in software like this. This page states what
this suite does, so the boundary is not something you have to infer from a greyed-out button.

## The rule

**A stream URL never implies permission to download.** The two are separate capabilities in
[`ProviderCapabilities`](../packages/contracts/src/entities/providers.ts), and the interface is
rendered from that structure. Where the capability is unsupported, no download control appears at
all — not a disabled one, not one that fails when clicked, not one that quietly saves an incomplete
file.

Where an action is unavailable, the reason is on screen. That is `reason` on the capability record,
written for the person reading it rather than as an error code.

## What is offered, and when

|                                                             | Downloadable?                                  | Why                                                                                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Files you already own — on your device, or on a hub you run | Yes                                            | They are your files. The hub streams them by byte range and the companion transfers them intact.                                                                   |
| A file another of your devices holds                        | Yes, after that device authorizes the transfer | The owning device decides; the hub relays the bytes and verifies the SHA-256 before accepting them.                                                                |
| SoundCloud, where the creator enabled downloads             | Yes                                            | SoundCloud exposes this per track. The adapter reads `downloadable` and `has_downloads_left`, and offers the download only when both allow it.                     |
| SoundCloud, where the creator did not                       | No                                             | The creator chose that. The result says "Streaming allowed; the creator did not enable downloads".                                                                 |
| Spotify                                                     | No                                             | The Web API offers no audio download. Playback is through the Web Playback SDK, in a browser, for Premium accounts.                                                |
| YouTube                                                     | No                                             | Downloading is prohibited by the API terms of service. Playback is the embedded player only.                                                                       |
| Bandcamp                                                    | No, in the app                                 | There is no public API. Bandcamp is a link out; if you buy something there, the file you bought can be imported through the companion like any other file you own. |
| MusicBrainz                                                 | Not applicable                                 | Metadata only. It is never an audio source.                                                                                                                        |

## What this software does not do

- **No DRM circumvention.** Nothing here removes, weakens or works around content protection.
- **No scraping.** Providers are used through their documented APIs. There is no HTML parsing of a
  web player, no reverse-engineered private endpoint, no signature-solving.
- **No cookie extraction.** Nothing reads your browser's cookies, session storage or profile to
  borrow an authenticated session.
- **No terms bypass.** Where an API's terms forbid something — reusing YouTube data outside permitted
  purposes, for instance — the adapter does not do it, and the capability matrix records why.

## The optional external tool

The hub can be configured to call an external media tool for content you own or are authorized to
download. It is **off by default** and has to be enabled deliberately by an administrator, who is
shown a rights notice when doing so.

When enabled it is constrained: an allowlist of hosts, no cookies passed to it, serialized execution
with timeouts, and no DRM handling. It exists because "I own this and want a copy" is a legitimate
thing to want, and refusing to acknowledge that would push people to worse tools. It is not a way
around any of the rules above, and enabling it does not change what the provider adapters permit.

## Converting a file you own

FFmpeg is included in the hub image and used to convert files the owner already has — a FLAC to AAC
for a phone, for example. `GET /api/v1/version` reports whether FFmpeg is present, and the interface
offers conversion only when it is. Without FFmpeg, only byte-for-byte copies are possible and the
API says so rather than failing at transfer time.

Transcoding a _provider's_ stream in flight is a different thing, legally and technically, and is not
built.

## If you think something here is wrong

The capability matrix in [PROVIDER_CAPABILITIES.md](PROVIDER_CAPABILITIES.md) carries the date it was
reviewed and links to each provider's own documentation. Terms change. If an adapter permits
something a provider now forbids, that is a bug — the fix is in the adapter's `capabilities()`, and
the interface follows it automatically because it renders from that structure rather than from
hard-coded assumptions.

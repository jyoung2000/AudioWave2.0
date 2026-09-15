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

|  | Downloadable? | Why |
| --- | --- | --- |
| Files you already own — on your device, or on a hub you run | Yes | They are your files. The hub streams them by byte range and the companion transfers them intact. |
| A file another of your devices holds | Yes, after that device authorizes the transfer | The owning device decides; the hub relays the bytes and verifies the SHA-256 before accepting them. |
| SoundCloud, where the creator enabled downloads | Yes | SoundCloud exposes this per track. The adapter reads `downloadable` and `has_downloads_left`, and offers the download only when both allow it. |
| SoundCloud, where the creator did not | No | The creator chose that. The result says "Streaming allowed; the creator did not enable downloads". |
| Spotify | No | The Web API offers no audio download. Playback is through the Web Playback SDK, in a browser, for Premium accounts. |
| YouTube | No | Downloading is prohibited by the API terms of service. Playback is the embedded player only. |
| Bandcamp | No, in the app | There is no public API. Bandcamp is a link out; what you buy there, Bandcamp gives you, and the player imports the `.zip` it arrives in directly. |
| MusicBrainz | Not applicable | Metadata only. It is never an audio source. |

## Saving a copy from the player

The player can hand you your own music as a file. Which formats it offers depends on what it can
honestly produce, and it lists them all either way with the reason attached.

| | What you get |
| --- | --- |
| **Original** | A byte-for-byte copy of the file on your device. Nothing is decoded, so nothing can change. Always available for a file the player can reach. |
| **FLAC** | Lossless, and usually about half the size of a WAV. Encoded on your device by `packages/audio-core`. |
| **WAV** | Uncompressed and readable by anything. Also encoded on your device. |
| **MP3** | Only when the file *is already* an MP3, where "convert" means "copy" and is exact. |

**Why MP3 is the odd one.** Making an MP3 means encoding one, and the player carries no MP3
encoder. It could fetch one, and it will not: a player whose whole premise is that it works with no
network does not quietly download a codec the first time you press a button. So the option is shown,
disabled, saying exactly that — and pointing at FLAC, which is lossless, and at a paired hub, whose
FFmpeg can produce an MP3. An enabled button that silently produced a different format would be the
dishonest alternative.

**What it will not do.** A provider's track offers nothing here. The player is given a stream and not
a file to keep, and a stream has never implied a right to the bytes — the same rule as the rest of
this page. The sheet says so rather than hiding the option.

**Converting is not recovering.** Saving an MP3 as FLAC produces a lossless copy *of the MP3*: it
cannot put back what the MP3 discarded, and it will be larger than the file you started with. The
sheet says that too, on the FLAC line, when the source is already compressed.

### Where the file lands

By default a browser drops a download wherever it drops everything else. That is right for a
spreadsheet and wrong for music, so the player can be given a folder once and write into it from
then on. **Settings → Downloads** offers whichever of these the browser can honour:

| | |
| --- | --- |
| **A folder you choose** | Written into directly, with no dialog after the first. Chrome, Edge and Opera on a desktop. |
| **Ask every time** | The system save dialog, per file. Anywhere with a save picker. |
| **The browser's downloads folder** | What every browser does by default, and the only option on Firefox, Safari and phones. |

A chosen folder can also **file tracks under the artist and album**, creating those folders as
needed, which is how a music library is usually arranged.

Three things are worth stating plainly.

**It is a permission, not a path.** The browser hands the app an opaque handle to the folder. The
player can write through it and cannot learn where the folder is on disk — so there is nothing to
log and nothing to leak, and `docs/PRIVACY.md`'s rule that filesystem paths never leave the owning
device holds without an exception.

**Nothing is overwritten.** A file already holding the name is left alone and the new one is
numbered beside it. The file in the way belongs to you and you did not ask for it to be replaced.

**A folder that stops working does not lose the file.** Permission lapses between sessions, drives
get unplugged. When the chosen folder cannot be written to, the download goes to the browser instead
and the player says which happened — a file that silently lands somewhere else is worse than one
that explains itself.

### The encoder

`packages/audio-core/src/export/flac.ts` is a FLAC encoder written for this project rather than
imported, because the player's bundle budget is measured in kilobytes and a codec dependency would
not fit. It implements the stream header and fixed-predictor subframes under Rice coding — no LPC
analysis, which costs some ratio and saves a great deal of code. Output is ordinary FLAC that any
decoder reads.

It is verified rather than asserted: `music-player/tests/e2e/features.spec.ts` downloads a FLAC
through the interface, decodes it with the browser's own decoder, and compares it sample by sample
against the file that went in. "Lossless" is a claim about a file, and a claim about a file can be
checked.

## What this software does not do

- **No DRM circumvention.** Nothing here removes, weakens or works around content protection.
- **No scraping.** Providers are used through their documented APIs. There is no HTML parsing of a
  web player, no reverse-engineered private endpoint, no signature-solving.
- **No cookie extraction.** Nothing reads your browser's cookies, session storage or profile to
  borrow an authenticated session.
- **No terms bypass.** Where an API's terms forbid something — reusing YouTube data outside permitted
  purposes, for instance — the adapter does not do it, and the capability matrix records why.

## "Download from every streaming platform"

This is asked for often enough to deserve a straight answer: **it cannot be built, by anyone,
legitimately.** Not because the app is cautious, but because there is no permitted route.

- **Spotify.** The Web API offers no audio download endpoint at all. Playback exists only through
  the Web Playback SDK, which plays protected audio into its own output and hands the page nothing.
  Getting a file out would mean circumventing that protection.
- **YouTube / YouTube Music.** The API Services Terms of Service prohibit downloading content. The
  only sanctioned playback is the IFrame embed, whose audio is not exposed to the page. Getting a
  file out would mean scraping or signature-solving.
- **SoundCloud.** Downloads exist, but per track, and only where the creator turned them on. That
  flag is the creator's decision and the app honours it.
- **Bandcamp.** No public API to search or stream. Purchases are downloaded from Bandcamp itself.

So the app does not offer a download button that would have to lie. What it offers instead is the
route that does work and needs no key, no hub and no account here: **the export each platform gives
you of the music that is already yours.** A Bandcamp purchase, a Google Takeout of your own YouTube
Music uploads, a set of downloadable SoundCloud tracks — all arrive as a `.zip`, and the player
unpacks one directly (`music-player/src/lib/zip.ts`), so a purchase made on a phone becomes library
tracks on that phone without a desktop in between. Password-protected archives are skipped rather
than attacked; non-audio entries are left where they are.

Settings → Platforms states all of this per platform, in the app, with the reason attached to every
"no". `docs/PROVIDER_CAPABILITIES.md` records the sources.

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

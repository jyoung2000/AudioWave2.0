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

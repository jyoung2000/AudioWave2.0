# Now Playing — Implementation Plan

```text
AQUA_PROFILE=snow-leopard-itunes-9
```

This plan was written after reading, completely, the two supplied references:

- `docs/design/APPLE_AQUA_2009_2010_UI_DESIGN_SPEC.md` (byte-identical copy of the supplied Aqua specification; sha256 `6f32304772fc…`)
- `docs/reference/now-playing-header.html` (byte-identical copy of the supplied header/player HTML; sha256 `cf70898c6364…`)

The repository contained no prior code — only the two references and an unrelated personal file (`CLAUDE-FABLE-5.md`), which is preserved untouched.

## 1. Audit of the supplied references

### 1.1 What the HTML reference does well (reused, refactored)

| HTML behaviour | Where it lands in the suite |
|---|---|
| Sticky neutral status header with "Now Playing" label, centred rounded search pill, Solo/Group segmented radiogroup, clock, avatar | `packages/aqua-ui` `Toolbar`, `SearchField`, `SegmentedControl`, `AvatarButton`; consumed by `music-player` app shell |
| Search results popover (count header, 40 px rows, preview ring, platform badges, pager, `role=combobox` + `aria-activedescendant`) | `packages/aqua-ui` `ResultsPopover`; `music-player/src/features/search` |
| iPod-style scrubber with keyboard seek, elapsed/remaining, LIVE marker for group broadcast | `packages/aqua-ui` `Scrubber`; LCD/now-playing display |
| Transport keys (download/prev/play/next/repeat) with pressed/latched states, volume slider with keyboard | `packages/aqua-ui` `Transport`, `VolumeSlider` |
| iTunes-style striped sortable table with `aria-sort`, marquee on the playing row, roving tabindex, context menu, playlist sheet, toast | `packages/aqua-ui` `AquaTable`, `ContextMenu`, `Sheet`, `Toast`; `music-player` Songs view |
| Procedural Three.js jewel case + CD (diffraction grating shader, device tiers, visibility pause, pose persistence, disposal) | `music-player/src/features/now-playing/jewel-case/` (bundled `three`, no CDN) |
| Motion character: parked marquee, 2.3 s open/close sequence, reduced-motion switches | preserved, with `prefers-reduced-motion` honoured everywhere |

### 1.2 What the HTML reference does that must NOT ship

- Direct browser call to `https://api.anthropic.com/v1/messages` (no key may live in the PWA; removed entirely).
- `itunes.apple.com`/Deezer JSONP fallbacks (script-injection JSONP is a code-execution channel; removed).
- `noembed.com` relay, `http://127.0.0.1:8642` companion assumption, hard-coded platform search URLs.
- CDN import map for `three` (bundled locally instead).
- Demo tracks (`window.LIBRARY`, `window.ALBUMS`) — replaced by real indexed local data; a clearly labelled demo mode exists only behind `VITE_DEMO_MODE=true`.
- iOS-style blurred context menu / sheet (`backdrop-filter`), 12–14 px radii — replaced by Aqua menus/sheets per the spec (5–8 px radii, opaque, one shadow).
- Dark colour-scheme variant — the Aqua profile is `color-scheme: light`; a dark scheme is not part of the 2009 profile (recorded in `docs/DEVIATIONS.md`).

### 1.3 Aqua specification MUST items treated as release requirements

All Section 17/18 MUST items of the Aqua spec are release gates. Their verification lives in `packages/aqua-ui/tests` (state ladder, a11y) and `music-player/tests/e2e` (composition, keyboard, zoom, reduced motion, inactive window). Deviations and reasons are recorded in `docs/DEVIATIONS.md`.

## 2. Architecture assumptions

- **Monorepo**: pnpm workspace, TypeScript strict (`6.0.x` — the latest release supported by typescript-eslint; see ADR-0001), ESM everywhere, Vitest 5, Playwright 1.62, ESLint 10 flat config, Prettier 3.
- **One canonical schema**: `packages/contracts` holds every entity, API route, WebSocket envelope and file format as Zod 4 schemas. JSON Schema and OpenAPI are generated from it (`pnpm --filter @now-playing/contracts generate`) and committed under `packages/contracts/generated/`.
- **Three products, three trust domains**:
  - `music-player/` (browser): owns browser directory handles/OPFS, Solo queue, Solo history, local metrics, EQ bindings. Never receives secrets. Talks outbound to a hub over HTTPS/WSS using a scoped device credential obtained through pairing.
  - `docker-container/` (hub): authoritative for Group state, provider credentials, pairing, downloads, Discord. Binds to loopback until the bootstrap password is replaced.
  - `windows-companion/` (desktop): owns filesystem roots, provider OAuth tokens (OS-protected), durable downloads, backups. Connects outbound to the hub; direct same-network pairing only over an authenticated TLS transport.
- **Locators are opaque**: `MediaLocator` union; a locator resolves only on the device that owns it. Absolute paths never leave the companion.
- **Identity**: UUIDv7 ids generated in `packages/domain`; content hashes (SHA-256 of file bytes, or a fast size+head+tail prefix hash while a full hash is pending) dedupe files; provider/MusicBrainz ids are aliases on `TrackIdentity`.
- **Persistence**: IndexedDB (`idb`) in the PWA, SQLite WAL via `better-sqlite3` in the hub and the companion, all with versioned migrations and tombstones.
- **Realtime**: WebSocket envelopes `{ eventId, type, occurredAt, schemaVersion, actorId, payload }`, authenticated handshake, per-mutation authorization, revisioned queue commands with idempotency keys, heartbeat, replay-from-ack, snapshot resync.
- **Audio**: `packages/audio-core` builds `source → preamp → retune worklet → 10× biquad EQ → limiter → analyser → output gain → destination`. Preserve-tempo retune is an original granular/OLA AudioWorklet (MIT, in-repo) because the mature pitch-shift libraries are LGPL/GPL (ADR-0003). Its added latency is measured and displayed.
- **Providers**: one adapter interface in the hub; every result carries `ProviderCapabilities`; UI actions are rendered from capability state only. Providers without credentials report `requires_auth`; providers with no permitted download path report `unsupported` with a reason.

## 3. Capability reality (stated plainly in the UI and docs)

| Capability | Reality |
|---|---|
| Browser folder access | File System Access API in Chromium-based browsers over a secure context; handles persist in IndexedDB but permission must be re-granted per session in most browsers → explicit "Reconnect Folder" state. Firefox/Safari get drag-and-drop and multi-file picker fallbacks (files are copied into OPFS only on explicit user action). |
| Remote pairing by code only | Works only when the app already knows the hub endpoint or a configured rendezvous directory resolves the hub id. Otherwise QR/deep link (which carries endpoint + fingerprint) or same-network direct pairing. No UPnP, no tunnels provisioned. |
| YouTube | Official Data API v3 for search/metadata (API key on the hub), IFrame Player embed for playback in the browser; no audio download; no Web Audio EQ on the embed (CORS) → "EQ unavailable for this source"; group sync `best_effort`. |
| SoundCloud | Official API with OAuth 2.1 client credentials/PKCE; streaming only where the track's `access` is `playable`; download only when `downloadable === true` and permitted; attribution required. |
| Bandcamp | No official public API → `resolve` + deep link + user-supplied purchased-file import only. Broader automation is an opt-in, disabled-by-default external-media-tool adapter with a rights notice. |
| Spotify | Metadata/library import via Web API with user OAuth (PKCE); playback only through the official Web Playback SDK for Premium accounts in the browser; never file download. |
| MusicBrainz | Metadata only (1 req/s, descriptive User-Agent, cached). Not an audio source. |
| Group exact sync | Only when every member plays the same seekable, authorized representation (hub-hosted or local file with identical hash). Otherwise `near`/`best_effort`/`unsupported`, displayed. |
| Discord voice | Plays only bot-playable authorized streams or hub-hosted/user-owned files; shown as a connected output with measured/best-effort status, never as sample-accurate sync. |
| Windows signing | Signing only when CI secrets are provided; local Linux builds cannot produce a Windows installer — the CI workflow does. |

## 4. Component mapping (product concept → Aqua-era component)

| Product concept | Aqua component | Reason |
|---|---|---|
| Sources (Library, Songs, … Settings) | Pale-blue source list, ≤2 levels | persistent navigator controls dominant content |
| Now playing | Inset LCD display in unified toolbar | central, glanceable |
| Play/prev/next | Neutral dimensional transport cluster | physical-player metaphor |
| Search with scopes | Rounded search field + scope bar + results popover | standard utility |
| Songs/queue/history/downloads/devices | Striped sortable `<table>` (virtualized) | dense scanning |
| Albums/artists | Artwork grid / column browser | recognition by cover |
| Solo/Group | Segmented control in toolbar | mode switch, radiogroup |
| Settings/profile | Sheet/dialog window with source-list sections | attached secondary configuration |
| Metrics constellation | Dark stage (QuickTime X exception) with 2D table equivalent | contextual dark media surface |
| Hub admin | Same window grammar, utility density, no KPI cards | administrative utility |

## 5. Phased plan (executed in this order)

0. Preserve references; write this plan. ✔
1. Skeleton: workspace, configs, `contracts`, `domain`, `test-fixtures`; generated schemas; green `pnpm typecheck && pnpm test:unit`.
2. `aqua-ui`, `audio-core`, `recommendations`; then `music-player` standalone (directory persistence, worker indexing, playback state machine, Solo queue/history, playlists, EQ/retune, profile/settings, metrics + constellation + jewel case, PWA offline shell, companion link state).
3. Hub: forced first-run auth, sessions/CSRF/CSP, pairing, providers, search aggregation, group + realtime, history CSV/JSON, download jobs, metrics, remote-access modes, admin GUI, Dockerfile/compose.
4. Discord worker on the shared group queue service; slash/prefix parity; templates.
5. Windows companion: secure Electron boundary, library, providers, transfers, pairing/sync, packaging, CI workflow, release metadata consumed by the PWA.
6. Cross-product hardening and every acceptance test that the current platform can run.
7. Documentation and `IMPLEMENTATION_STATUS.md` with evidence.

## 6. Verification commands

```text
pnpm install
pnpm verify            # lint + typecheck + unit + contracts + integration + a11y + e2e (platform-neutral gates)
pnpm dev:player        # http://localhost:5173
pnpm dev:hub           # http://localhost:4546
pnpm dev:windows       # Electron dev (Windows/macOS/Linux dev shell)
docker compose -f docker-container/compose.yaml up --build
```

## 7. Addendum — Personalized cross-platform discovery & recommendation engine

A second specification was supplied mid-build. It is implemented as follows (no separate product; it extends the shared package and the hub):

| Spec area | Implementation |
|---|---|
| Canonical music record + `track_platforms` mapping | Hub tables `canonical_tracks`, `canonical_artists`, `track_platforms`, `artist_relations`; matching by MusicBrainz recording id → ISRC → normalized title/artist/duration (±2 s) in `packages/domain/src/identity.ts` |
| Admin configures app credentials once; users connect their own accounts | Hub `provider_app_configs` (encrypted, admin only) + `platform_connections` (per user, encrypted access/refresh tokens, never returned to clients). PWA "Connect Your Music" screen under Discover → Accounts drives OAuth 2.0 authorization-code + PKCE through the hub. |
| Multi-dimension taste profile with contexts | `packages/recommendations/src/profile.ts`: track/artist/genre/tag/era/popularity/discovery/platform affinities plus contextual profiles (playlist, genre, mood, activity, session). |
| Behaviour learning with configurable weights, skip intelligence, time decay | `packages/recommendations/src/learning.ts` — `DEFAULT_WEIGHTS` (immediate skip −5 … favorite +10) are configuration; a single skip only lowers track affinity; artist/genre affinity moves after repeated evidence (configurable threshold); exponential time decay with configurable half-life. |
| Candidate generation from ten sources | `packages/recommendations/src/candidates.ts` merges similar artists/tracks/genres, collaborative, related artists, new releases, recently discovered, platform discovery, library gaps, exploration/wildcard. |
| Ranking with configurable weights and penalties, then diversity | `ranking.ts` (30/20/15/10/10/5/5/5 defaults; repeat/skip/overexposure penalties) and `diversity.ts` (artist cap, genre share cap, 40/30/20/10 tiers, user-adjustable). |
| Modes | For You, Playlist Discovery, Genre Discovery, Similar to This, Deep Discovery, New Releases, More Like My Recent Listening. |
| Discovery cache, background discovery, incremental sync, rate-limit manager, request budgeting | Hub `discovery_cache`, `discovery_jobs`, `user_platform_sync` (cursor/snapshot/etag), `RateLimitManager` with per-platform token buckets, concurrency limits, `Retry-After`, backoff and P0–P4 priority classes with budget-aware shedding. |
| Storage | SQLite (WAL) in the one-container default; the design keeps a repository layer so PostgreSQL/Redis can be added without weakening the single-container path. |
| Spotify development-mode limits, YouTube quota, SoundCloud 429 handling, Bandcamp access approval | Documented in `docs/PROVIDER_CAPABILITIES.md`; enforced by adapters and the rate-limit manager; nothing bypasses quotas, rotation or scraping. |

## 8. Addendum — sharing, transport-row actions, Android media integration

| Request | Implementation | Honest limit |
|---|---|---|
| Shareable links for songs, albums, libraries, playlists | Hub-served revocable links (`/s/<token>`, token hashed at rest, expiry, access caps, stream/download flags, public Aqua share page, `shares:create` scope). The player creates links for its own library/playlists by uploading item metadata; hub-hosted content streams publicly when allowed. Without a hub, the player offers Web Share API / file export (playlist JSON, M3U) and copy-to-clipboard instead. Admin sees and can revoke every link. | A link is reachable only where the hub is reachable; browser-local files are shared as metadata + open-at-source links unless their bytes were transferred to the hub. |
| Star / add-to-playlist in the transport row | `Transport` aux slots: Star (toggles like and membership in the built-in "Starred Songs" playlist), "Add to Playlist…" menu, Share. | — |
| Android Auto | Full Media Session API integration (metadata, artwork, play/pause/prev/next/seek/stop handlers, position state), background audio continuity, a large-control **Car mode** view. Bluetooth/AVRCP head units and the Android media notification control the player. | Android Auto shows only native Android media apps (Media3/MediaBrowserService). A PWA cannot register as an Android Auto app; the UI and docs say so plainly instead of pretending. |

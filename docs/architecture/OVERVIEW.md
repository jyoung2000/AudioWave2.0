# Architecture overview

```text
                      ┌────────────────────────── packages (build-time only) ──────────────────────────┐
                      │ contracts · domain · aqua-ui · audio-core · recommendations · test-fixtures    │
                      └───────────────┬───────────────────────────┬───────────────────────────┬────────┘
                                      │                           │                           │
                 ┌────────────────────▼──────┐     ┌──────────────▼───────────────┐   ┌───────▼─────────────────────┐
                 │ music-player/ (PWA)        │     │ docker-container/ (Hub)      │   │ windows-companion/ (Electron)│
                 │ React + Vite + Workbox     │     │ Fastify 5 + SQLite WAL + WS  │   │ main / preload / renderer    │
                 │ IndexedDB · Web Audio      │     │ providers · groups · Discord │   │ SQLite · chokidar · DPAPI    │
                 │ Three.js (bundled)         │     │ downloads · metrics · shares │   │ electron-builder             │
                 └────────────┬──────────────┘     └──────────────┬───────────────┘   └──────────────┬──────────────┘
                              │ HTTPS/WSS device credential        │ outbound HTTPS                    │ HTTPS/WSS device credential
                              └───────────────────────────────────►│◄─────────────────────────────────┘
                                                                   ▼
                                                    official provider APIs, Discord gateway/voice
```

## Products
- **Player** — offline-first PWA. Everything in Solo mode is local: directory handles, indexing worker, playback state machine, Solo queue/history, playlists, EQ/retune, profile, metrics, recommendations from local behaviour. Optional: hub client (pairing, search aggregation, groups, shares, hub-side personalisation with opt-in), companion link (download metadata).
- **Hub** — one container, one port (4546). Admin GUI and API share the process. Authoritative for groups; mediates providers with app-level credentials; per-user OAuth connections; discovery cache and background jobs; downloads; realtime; Discord worker; shareable links.
- **Companion** — Windows desktop. Durable filesystem authority: watched roots, hashing, duplicates, metadata edits without touching files, transfers, backups; provider OAuth on the desktop; manifest/delta sync with the hub.

## Shared packages
| Package | Responsibility |
|---|---|
| `contracts` | Zod schemas for all entities, routes, WS envelopes, file formats; generated JSON Schema/OpenAPI; branding |
| `domain` | Pure logic: ids, identity matching, queue reducer, EQ precedence, retune maths, CSV, pairing, security helpers, templates, permissions, sync merge rules, clock offset, metrics aggregation, local search, capability gating, playlist formats |
| `aqua-ui` | Aqua (Snow Leopard/iTunes 9) React components, tokens, icons, state components, gallery |
| `audio-core` | Web Audio DSP chain with an original pitch-shift worklet |
| `recommendations` | Deterministic hybrid recommender and evaluation |
| `test-fixtures` | Generated tone audio with tags, event streams, provider/Discord fixtures |

## Key flows
- **Pairing**: admin creates a session → device claims with an ephemeral public key → both sides show the verification fingerprint → admin confirms → device completes once and receives a scoped, revocable credential (`docs/architecture/PAIRING_AND_SYNC.md`).
- **Group playback**: hub timeline, absolute `startAt`, revisioned commands with idempotency keys, replay/snapshot on reconnect, drift correction policy (`GROUP_PLAYBACK.md`).
- **Audio**: `source → preamp → retune → EQ → limiter → analyser → output` (`AUDIO_PIPELINE.md`).
- **Recommendations**: events → multi-dimension taste profile → seeds → cached discovery → ranking → diversity (`RECOMMENDATIONS.md`).

## Versioning and compatibility
- `CONTRACTS_VERSION` (semver), `WS_PROTOCOL_VERSION` + minimum, `SCHEMA_VERSIONS` per persisted format, migration version per database. A newer client against an older hub (or the reverse) receives an explicit upgrade-required state; nothing is written in an unknown format.

## Non-goals (honest limits)
- No cloud relay: the hub is reachable only where you make it reachable (`docs/REMOTE_ACCESS.md`).
- No DRM bypass, scraping or credential extraction; capabilities are what providers permit (`docs/PROVIDER_CAPABILITIES.md`).
- Android Auto tiles require native apps; the PWA integrates through the Media Session API instead.

# AWSP — the AudioWave Streaming Protocol

Streaming from the **Windows companion** (which holds the library) to the **player clients** —
the PWA in a browser and the Android app — directly between devices, with no traffic through the
Docker hub. Version 1, ALPN `awsp/1`.

**Scope of this revision.** The iOS native client is **deferred by decision**; nothing here is built
for it and no Swift exists. The PWA is the client that must work; it is **lossless-only** and
**relay-carried** (a browser cannot hole punch). Android is native and may connect directly.

## 0. The transport, as it is today (researched 2026-09-22)

Checked against the published crates and packages, not memory:

| Piece | What exists | Version | Source |
|---|---|---|---|
| Rust endpoint | `iroh` — `Endpoint::builder(presets::N0)`, `.secret_key()`, `.alpns()`, `.bind()`, `endpoint.accept()`, `conn.remote_id() -> EndpointId`, `open_bi`/`accept_bi` (QUIC via `noq`) | **1.2.0** (2026-09-09) | crates.io/crates/iroh; `examples/listen.rs`, `connect.rs` |
| Identity | `SecretKey::generate()`, `to_bytes() -> [u8;32]`, `from_bytes`; `EndpointId = PublicKey` | iroh-base 1.2.0 | `iroh-base/src/key.rs` |
| Tickets | `iroh_tickets::endpoint::EndpointTicket::new(endpoint.addr())`; string `"endpoint" + base32(postcard)` | iroh-tickets **1.0.0** | crates.io/crates/iroh-tickets; dumbpipe `src/main.rs` |
| Relay-only (forced) | builder `.clear_ip_transports()` (not on wasm); `RelayMode::{Default, Staging, Custom, Disabled}` | 1.2.0 | `src/endpoint.rs`, test `endpoint_two_relay_only_no_ip` |
| Local relay for tests | `iroh::test_utils::run_relay_server()` (feature `test-utils`); binary `iroh-relay --dev` (HTTP on `[::]:3340`) | 1.2.0 | `src/test_utils.rs`, `iroh-relay/src/main.rs` |
| Browser | official wasm32 build, **relay-only**, end-to-end encrypted QUIC carried over the relay's WebSocket; no UDP, no hole punching, no DNS lookup; no npm package — compiled with `wasm-bindgen --target web` **=0.2.122**, `default-features = false, features = ["tls-ring"]`, `getrandom_backend="wasm_js"` | 1.2.0 | docs.iroh.computer/deployment/wasm-browser-support; iroh-examples `browser-echo` |
| Kotlin / Android | `computer.iroh:iroh-android` AAR with `libiroh_ffi.so` for arm64-v8a, armeabi-v7a, x86, x86_64 (tracks iroh 1.0.2) | **1.1.0** (2026-07-16) | repo1.maven.org/maven2/computer/iroh/iroh-android/1.1.0 |
| Node | `@number0/iroh` with win32-x64 prebuild | 1.1.0 | npmjs.com/package/@number0/iroh |

Consequences for this design:

- The **server is a Rust sidecar** (`windows-companion/awsp-server`, iroh 1.2.0) supervised by the
  Electron main process. The wire protocol is compatible across iroh 1.x, so Android's 1.0.2 and the
  server's 1.2.0 interoperate.
- The **PWA uses iroh's browser build** (a small Rust crate compiled to wasm, `music-player/awsp-web`).
  It is viable, so §4.6's WebSocket bridge is **not** the PWA's path. iroh does not document running
  inside a service worker, so the endpoint lives in the page (a dedicated worker) and the service
  worker is a byte-range bridge in front of it (§6).
- A page served over HTTPS needs an HTTPS relay: in use, n0's public relays (no account); in tests,
  a local `iroh-relay --dev` over plain HTTP, which a page on `127.0.0.1` may reach.
- There is **no environment variable for relay-only mode** in iroh. AWSP defines its own:
  `AWSP_RELAY_ONLY=1` on the server (and a client option) calls `.clear_ip_transports()`.

## 1. Roles and identity

- **Server** — the companion's sidecar. One iroh endpoint with a `SecretKey` generated on first run,
  kept by the Electron main process under **DPAPI** (`safeStorage`), handed to the sidecar on stdin at
  start, never written in the clear. The key makes the `EndpointId` — and so the ticket — stable.
- **Client** — a PWA or Android install. Its own keypair: PWA in IndexedDB, wrapped with a
  non-extractable WebCrypto AES-GCM key; Android in the Keystore. Its `EndpointId` is its identity.
- **Allowlist** — the server keeps the `EndpointId`s of paired clients (with a name, a tier cap and
  the time paired), under DPAPI. A connection whose `conn.remote_id()` is not on it is closed with
  application error `0x1` (`unknown-device`) **before any stream is accepted**.

## 2. Pairing

1. The companion's Settings ▸ Remote shows the **ticket** (`EndpointTicket` of the server's current
   `EndpointAddr`, relay URL included) as text and as a QR code, and a **pairing code**: six digits,
   valid for ten minutes, once.
2. The client scans or pastes the ticket, connects with ALPN `awsp/1`, opens the control stream and
   sends `pair {code, device_name, client_kind}` instead of `hello`.
3. The server checks the code (constant-time; five wrong codes void it), adds `remote_id()` to the
   allowlist, and answers `paired {server_name}`. The client stores the ticket with its keypair.
4. Revoking a device in Settings removes it from the allowlist and closes its live connection.

Nothing in pairing touches the hub, a third-party account, or a public directory beyond the relay.

## 3. One connection, two kinds of stream

One QUIC connection per client carries **one control stream** (bidi, opened by the client at once)
and **one bidi stream per audio fetch**. Audio never queues behind control, and control never waits
behind audio.

### 3.1 Control stream

Frames: `u32` big-endian length, then UTF-8 JSON `{id, type, seq, payload}`. `id` is the sender's
monotonically increasing message id; `seq` is the server's state sequence (0 on client frames). A
frame over 256 KiB closes the stream with `frame-too-large`.

Client → server:

| type | payload |
|---|---|
| `hello` | `{device_name, client_kind: 'pwa'|'android', protocol_version: 1, resume_token?}` |
| `pair` | `{code, device_name, client_kind}` (first frame of a pairing connection only) |
| `play` | `{track_id, offset_ms}` |
| `pause` | `{}` |
| `seek` | `{ms}` |
| `next` / `prev` | `{}` |
| `set_queue` | `{track_ids}` |
| `browse` | `{path?, query?, page}` → `library_page` |
| `get_artwork` | `{track_id, size}` → `artwork` |
| `prefetch` | `{track_id}` (a hint; the server may warm its cache) |
| `report` | `{buffer_ms, throughput_kbps, dropouts}` (every 10 s while playing) |
| `ping` | `{}` |

Server → client: `welcome {server_name, resume_token, connection: 'direct'|'relay'}`, `state
{playing, track_id, position_ms, queue, volume}` (on every change and every 5 s), `library_page`,
`library_delta`, `artwork`, `error {code, message}`, `pong`, `paired`.

**The server is authoritative** for queue and state. Clients render `state` and send intents.

**Liveness and reconnection.** Ping every 5 s; three missed pongs is a lost connection. The client
reconnects with exponential backoff 250 ms → 30 s (full jitter), sends `hello` with its
`resume_token`, receives a fresh `state`, and re-issues its audio fetch **from the last contiguous
byte it holds** (§4). A `resume_token` is 32 random bytes the server issues in `welcome`, valid for
10 minutes, bound to the client's `EndpointId`.

### 3.2 Audio streams

The client opens a bidi stream and writes one request frame (same length-prefixed JSON):

```json
{ "track_id": "…", "byte_start": 0, "byte_end": null, "tier": "lossless" }
```

HTTP-Range semantics: `byte_end` inclusive, `null` = to the end. A seek is a new request; the old
stream is reset with `STOP_SENDING`.

The server answers with a **16-byte header** and then the bytes:

| offset | size | field |
|---|---|---|
| 0 | 8 | `track_id_hash` — first 8 bytes of BLAKE3(track_id) |
| 8 | 6 | `total_len` — the whole file's length in bytes, big-endian |
| 14 | 1 | `codec` — 1 FLAC, 2 ALAC(m4a), 3 MP3, 4 Opus(ogg), 5 WAV, 6 AAC(m4a) |
| 15 | 1 | `tier` — 0 lossless, 1 high, 2 saver |

then exactly `byte_end - byte_start + 1` bytes (clamped to the file), then `finish()`. An error
before the header is a stream reset with a code (`not-found` 0x10, `range` 0x11, `tier` 0x12).

The server reads from the file in 64 KiB chunks and writes each only when QUIC flow control accepts
it — **backpressure end to end, never the whole file in memory**.

## 4. Tiers, buffering, ABR

- `lossless` (default): the original file's bytes, untouched — FLAC, ALAC, MP3 as they are on disk.
  **Bit-identical by construction**, and tested so (§8).
- `high`: Opus 256 kb/s; `saver`: Opus 128 kb/s. Produced by `ffmpeg -c:a libopus`, cached on disk
  keyed by `(track_id, tier, source mtime)` in the companion's data folder; a range request against a
  tier the cache does not hold yet waits for the encode (the first request) and streams from the
  cache afterwards. A per-device tier cap on the server clamps what a client may ask for.
- **Buffering (all clients):** target 20 s ahead, low-water 5 s — the fetch loop pauses above the
  target and resumes below the low-water mark. When the current track has < 45 s left, prefetch the
  first 30 s of the next queued track.
- **ABR (Android only; the PWA never switches tiers):** over a 10 s window compare delivered to
  consumed bytes; if sustained throughput < 1.2 × the source bitrate, request the following ranges
  at `high` and tell the UI; return to `lossless` after 60 s of headroom.

## 5. Connection type, surfaced and logged

Both sides log at INFO when a connection is established and whenever its path changes:
`awsp connection <peer> type=direct|relay|bridge rtt=<ms>`. The server reads it from the
connection's selected path (`paths_stream()`, `is_relay()`); the browser is always `relay` (or
`bridge`, §7). Each client shows it as a small indicator beside the transport: **direct**,
**relay-carried**, **bridge**.

## 6. The PWA client

- `music-player/awsp-web` — a Rust crate compiled to wasm (iroh 1.2.0, `tls-ring`, wasm-bindgen
  0.2.122) exposing `connect(ticket)`, `pair(code)`, a control channel and `fetch(track_id, start,
  end)` returning a `ReadableStream`. It runs in a **dedicated worker** owned by the page, so the
  endpoint outlives view changes but not the page.
- **Service-worker bridge.** The media element's source is a same-origin URL,
  `/awsp/track/<id>`. The service worker answers it with HTTP semantics — `206` and `Content-Range`
  for a `Range` request — by asking the page's worker for those bytes over a `MessageChannel` and
  streaming them back. Chromium plays FLAC by progressive download over this bridge (seek = a new
  `Range` request = a new AWSP audio stream). Safari plays **FLAC-in-fMP4 HLS** natively from
  `/awsp/hls/<id>/index.m3u8`, segmented by the server with
  `ffmpeg -c:a flac -f hls -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4`. **hls.js is
  never used on Safari** — it cannot play lossless FLAC HLS.
- Media Session API for lock-screen controls and artwork. **No Wake Lock** is requested: an actively
  playing `<audio>` keeps the page, its worker and the network alive with the screen off on mobile
  browsers. iOS Safari still suspends a *paused* PWA; resuming reconnects (§3.1).
- Keys: the client keypair in IndexedDB, wrapped by a non-extractable WebCrypto key.

## 7. The WebSocket bridge (fallback)

For a browser where the wasm build cannot run, the companion can expose AWSP over **WSS** on a local
port, reachable over the user's own tailnet. It is **off by default**, behind a Settings toggle, and
uses the same frames as §3 multiplexed over one WebSocket (a stream id prefixed to each frame).
Clients on it show **bridge**. It is not the PWA's normal path (§0).

## 8. Verification

- **Bit identity.** A Playwright test pairs a real browser with a real running sidecar and a local
  relay, streams a generated FLAC through the service-worker bridge, and asserts the bytes the page
  received equal the source file's bytes (SHA-256).
- **Seek and resume.** The same test seeks (a new range) and drops the connection mid-stream
  (killing and restarting the relay), and asserts the client resumed at its last contiguous byte.
- **Outage.** A Rust integration test runs two real iroh endpoints on this machine, relay-only via
  `AWSP_RELAY_ONLY=1`, streams a 24-bit/96 kHz FLAC fixture generated by ffmpeg, pauses the relay for
  3 s, and asserts zero underruns against the 20 s buffer.
- **NAT simulation.** n0's netsim tooling is Linux-side. The netsim test lives in
  `.github/workflows/awsp-netsim.yml` as a CI-only Linux job; **it has not been run on this machine**.
- The manual matrix is `TESTING.md`.

## 9. Constraints

No third-party accounts; no Docker-container involvement in streaming; no plaintext on the wire (QUIC
end to end; WSS for the bridge); secrets under OS protection (DPAPI on Windows, Android Keystore,
IndexedDB + WebCrypto in the browser). iOS native: deferred.

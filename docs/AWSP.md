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
| Local relay for tests | `iroh::test_utils::run_relay_server()` (feature `test-utils`; self-signed TLS, so clients need `CaTlsConfig::insecure_skip_verify()` — itself gated on `test-utils`); binary `iroh-relay --dev` (HTTP on `[::]:3340`) | 1.2.0 | `src/test_utils.rs`, `iroh-relay/src/main.rs` |
| Path type | `conn.paths()` / `conn.paths_stream()` → `Path::{is_selected, is_relay, is_ip, rtt}` | 1.2.0 | `src/socket/remote_map/remote_state/path_watcher.rs` |
| Browser | official wasm32 build, **relay-only**, end-to-end encrypted QUIC carried over the relay's WebSocket; no UDP, no hole punching, no DNS lookup; no npm package — compiled with `wasm-bindgen --target web` **=0.2.122**, `default-features = false, features = ["tls-ring"]`, `getrandom_backend="wasm_js"` | 1.2.0 | docs.iroh.computer/deployment/wasm-browser-support; iroh-examples `browser-echo` |
| Kotlin / Android | `computer.iroh:iroh-android` AAR with `libiroh_ffi.so` for arm64-v8a, armeabi-v7a, x86, x86_64 (tracks iroh 1.0.2); the Kotlin API is in its dependency `computer.iroh:iroh` (Java 21 bytecode; D8 accepts it). `Connection.watchPaths(callback)` panics when called from a JVM thread ("no reactor running"), so Kotlin clients poll `paths()` | **1.1.0** (2026-07-16) | repo1.maven.org/maven2/computer/iroh/iroh-android/1.1.0; `iroh-1.1.0-sources.jar` |
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
  application error `0x1` (`unknown-device`) **before any other stream is accepted**: the server
  accepts exactly one stream from it, and that stream's first frame must be a `pair` (§2) arriving
  within 10 s. Anything else — `hello`, an audio request, silence — closes with `0x1`. The sidecar
  holds the allowlist in memory; the Electron main process owns the DPAPI copy (§10).

## 2. Pairing

1. The companion's Settings ▸ Remote shows the **ticket** (`EndpointTicket` of the server's current
   `EndpointAddr`, relay URL included) as text and as a QR code, and a **pairing code**: six digits,
   valid for ten minutes, once.
2. The client scans or pastes the ticket, connects with ALPN `awsp/1`, opens the control stream and
   sends `pair {code, device_name, client_kind}` instead of `hello`.
3. The server checks the code (constant-time; five wrong codes void it), adds `remote_id()` to the
   allowlist with tier cap `lossless`, and answers `paired {server_name}`. The client stores the
   ticket with its keypair and continues on the same control stream with `hello`. A wrong code is
   answered `error {code: 'pair-rejected'}`, no live code (never issued, used, expired or voided)
   `error {code: 'pair-no-code'}`; both then close the connection with `0x1`.
4. Revoking a device in Settings removes it from the allowlist and closes its live connection with
   `0x1`.

Nothing in pairing touches the hub, a third-party account, or a public directory beyond the relay.

## 3. One connection, two kinds of stream

One QUIC connection per client carries **one control stream** (bidi, opened by the client at once)
and **one bidi stream per audio fetch**. Audio never queues behind control, and control never waits
behind audio.

### 3.1 Control stream

Frames: `u32` big-endian length, then UTF-8 JSON `{id, type, seq, payload}`. `id` is the sender's
monotonically increasing message id; `seq` is the server's state sequence (0 on client frames). A
server frame answering a client frame (`pong`, `welcome`, `paired`, `library_page`, `artwork`, an
`error`) also carries `re`, the `id` it answers. A frame over 256 KiB closes the stream with
`frame-too-large` (`0x20`, as `STOP_SENDING` and `RESET_STREAM`).

Client → server:

| type | payload |
|---|---|
| `hello` | `{device_name, client_kind: 'pwa'|'android', protocol_version: 1, resume_token?}` |
| `pair` | `{code, device_name, client_kind}` (first frame of a pairing connection only) |
| `play` | `{track_id, offset_ms}` (without `track_id`: resume the current track) |
| `pause` | `{}` |
| `seek` | `{ms}` |
| `next` / `prev` | `{}` |
| `set_queue` | `{track_ids}` |
| `browse` | `{path?, query?, page}` → `library_page`; `path` is a `relative_path` prefix, `query` full-text, `page` 0-based |
| `get_artwork` | `{track_id, size}` → `artwork` |
| `prefetch` | `{track_id}` (a hint; the server may warm its cache) |
| `report` | `{buffer_ms, throughput_kbps, dropouts}` (every 10 s while playing) |
| `ping` | `{}` |

Server → client: `welcome {server_name, resume_token, connection: 'direct'|'relay', resumed}`,
`state {playing, track_id, position_ms, queue, volume}` (right after `welcome`, on every change and
every 5 s), `library_page {page, page_size: 100, total, items: Track[]}`, `library_delta {since,
until, items: Track[], removed: id[]}` (when the index changes), `artwork {track_id, size, mime,
data}` (`data` base64 JPEG, or `mime`/`data` null when the file has no picture), `error {code,
message}`, `pong`, `paired {server_name}`.

Frames other than `hello`, `pair` and `ping` before `hello` get `error {code: 'hello-required'}`. A
`protocol_version` other than 1 gets `error {code: 'protocol-version'}` and a close with `0x2`.

**The server is authoritative** for queue and state. Clients render `state` and send intents. The
state is one per server, shared by every connected client.

**Liveness and reconnection.** Ping every 5 s; three missed pongs is a lost connection. The client
reconnects with exponential backoff 250 ms → 30 s (full jitter), sends `hello` with its
`resume_token`, receives a fresh `state`, and re-issues its audio fetch **from the last contiguous
byte it holds** (§4). A `resume_token` is 32 random bytes (64 hex digits) the server issues in
every `welcome`, valid once for 10 minutes, bound to the client's `EndpointId`; `welcome.resumed`
says whether the one presented was accepted.

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
| 14 | 1 | `codec` — 0 other, 1 FLAC, 2 ALAC(m4a), 3 MP3, 4 Opus(ogg), 5 WAV, 6 AAC(m4a) |
| 15 | 1 | `tier` — 0 lossless, 1 high, 2 saver |

`total_len` and the range are those of the bytes actually served — the original file for
`lossless`, the cached Opus file for `high`/`saver` (codec 4). The tier byte is the tier served,
after the device's cap clamps the request. An `.m4a` is ALAC or AAC by the indexed `format.codec`,
failing that by an `alac` atom in the file.

then exactly `byte_end - byte_start + 1` bytes (clamped to the file), then `finish()`. An error
before the header is a stream reset with a code (`not-found` 0x10, `range` 0x11 — `byte_start`
past the end or `byte_end < byte_start`, `tier` 0x12 — an unknown tier or a failed encode,
`bad-request` 0x13 — no valid request frame within 10 s).

**Error codes.** Connection close: `0x0` normal, `0x1` unknown-device (not allowlisted, revoked,
or failed pairing), `0x2` protocol. Audio stream reset: `0x10`–`0x13` above. Control stream:
`0x20` frame-too-large.

The server reads from the file in 64 KiB chunks and writes each only when QUIC flow control accepts
it — **backpressure end to end, never the whole file in memory**.

## 4. Tiers, buffering, ABR

- `lossless` (default): the original file's bytes, untouched — FLAC, ALAC, MP3 as they are on disk.
  **Bit-identical by construction**, and tested so (§8).
- `high`: Opus 256 kb/s; `saver`: Opus 128 kb/s. Produced by `ffmpeg -c:a libopus`, cached on disk
  keyed by `(track_id, tier, source mtime)` under the sidecar's `cache_dir` (§10; `tiers/`, and
  `art/` for artwork), older encodes of the same track removed; a range request against a
  tier the cache does not hold yet waits for the encode (the first request) and streams from the
  cache afterwards. A per-device tier cap on the server clamps what a client may ask for.
- **Buffering (all clients):** target 20 s ahead, low-water 5 s — the fetch loop pauses above the
  target and resumes below the low-water mark. When the current track has < 45 s left, prefetch the
  first 30 s of the next queued track. A client pauses by not reading its open audio stream, so QUIC
  flow control stops the server; up to one stream receive window (about 1.2 MB against the sidecar)
  still arrives after the pause.
- **ABR (Android only; the PWA never switches tiers):** over a 10 s window compare delivered to
  consumed bytes; if sustained throughput < 1.2 × the source bitrate, request the following ranges
  at `high` and tell the UI; return to `lossless` after 60 s of headroom. Throughput is measured
  over the time the fetch loop was actually pulling. Idle time spent above the buffer target does
  not count, or a full buffer would read as a slow link. Tiers are different files (different
  lengths, and Opus rather than the original codec), so "the following ranges" cannot continue the
  current byte stream. A switch re-opens the track at its current position: at once when playback
  is starving, otherwise from the next track.

## 5. Connection type, surfaced and logged

Both sides log at INFO when a connection is established and whenever its path changes:
`awsp connection <peer> type=direct|relay|bridge rtt=<ms>`. The server reads it from the
connection's selected path (`paths_stream()`, `is_relay()`); the browser is always `relay` (or
`bridge`, §7). Each client shows it as a small indicator beside the transport: **direct**,
**relay-carried**, **bridge**.

## 6. The PWA client

Built and tested end to end (`music-player/tests/e2e/awsp.spec.ts`, §8). Four pieces:

- **`music-player/awsp-web`** — a Rust crate compiled to wasm (iroh 1.2.0, `tls-ring`,
  wasm-bindgen 0.2.122, getrandom `wasm_js`), following iroh-examples `browser-echo`. It is the
  transport and the wire format only: `AwspClient.create(secret, relays)` (secret key bytes in,
  `secret_key()` out), `connect(ticket, relay_override?)` → a connection with `connection_type()`
  (`relay` in a browser, read from the selected path), `open_control()` → `send(json)` / `recv()`
  frames, and `fetch(track_id, byte_start, byte_end|null, tier)` → the parsed 16-byte header
  (`total_len`, `codec`, `tier`; the `track_id_hash` is checked) and a pull-based `read()` of the
  range's chunks, `cancel()` = `STOP_SENDING`. The client's home relay is the **ticket's relay** (or
  an override): nothing else is contacted, n0's relays included, unless the ticket names them.
  Its wasm-bindgen output (`awsp_web.js` + a 2.3 MB `awsp_web_bg.wasm`, 954 KB gzipped) is
  **committed** in `music-player/src/shell/awsp-web`, so the player builds without Rust;
  `node music-player/scripts/build-awsp-web.mjs` regenerates it (needs cargo, wasm-bindgen-cli
  =0.2.122, and a C compiler for wasm32 for `ring` — clang, or zig through `scripts/zig-cc.mjs`),
  and a unit test fails when the crate's sources no longer match the hash recorded with the build.
- **The dedicated worker** (`music-player/src/shell/awsp-worker.ts`), owned by the page, hosts the
  wasm client and the policy: `pair` then `hello` on the same control stream, the `resume_token`,
  a ping every 5 s with three missed pongs counted as a lost connection, reconnection with backoff
  250 ms → 30 s (full jitter), `unknown-device` (0x1) ending the retries, and audio fetches that
  survive a reconnection: a fetch interrupted mid-range waits for the new connection and asks again
  from `byte_start + bytes already handed on` — the last contiguous byte it holds. The worker logs
  `awsp connection <server> type=relay rtt=<ms>` with `console.info` (§5).
- **The service-worker bridge** (`music-player/public/awsp-sw.js`, pulled into the generated
  Workbox `sw.js` with `importScripts`). The media element's source is the same-origin
  `/awsp/track/<id>`; the service worker answers `200`, or `206` with `Content-Range` for a
  `Range` request (`bytes=a-b`, `bytes=a-`, and `bytes=-n` through a one-byte probe for the length),
  with `Content-Length`, `Accept-Ranges: bytes` and a `Content-Type` from the header's codec; a
  range past the end is `416`, an unknown track `404`. It posts the request to the page that made
  it with a `MessagePort`; the page hands the port to its dedicated worker untouched, and the two
  workers exchange `header`, then one `chunk` per `pull`, then `end` — so the element's reading pace
  is the QUIC stream's pace. A cancelled request (a seek) stops its AWSP stream. The service worker
  claims clients on `activate`, so the first visit streams without a reload. It holds the fetch
  event open with `waitUntil` while the body streams; a browser that still ends it (Chromium's cap
  on one event) makes the element ask again with a `Range`, which is a new AWSP stream.
  Chromium plays FLAC by progressive download over this bridge, measured by the e2e test.
- **The page's side** (`music-player/src/shell/awsp.ts`, a lazy chunk the bridge imports; none of
  this is in the first load, and the 2.3 MB wasm is fetched only when someone pairs or a PC was
  paired before): `window.NP_AWSP = { pair(ticket, code), connect(), status(), browse(page,
  query), connectionType(), on(event), … }`. The PC's library joins `window.LIBRARY` as rows with
  `remote: true`, played through the engine like the device's own (`engine.load({track, url:
  '/awsp/track/<id>'})`). Settings ▸ Sources ▸ Connections ▸ **Stream from a PC** takes the ticket
  and the six-digit code and shows the PC's name, the connection type and the track count; while a
  PC track plays, the indicator beside the transport reads **relay-carried** (or direct, bridge).
  Not in the single-file build: a `file://` page has no service worker to be the bridge.
- **Safari's HLS path is not implemented.** `/awsp/hls/<id>/index.m3u8` (FLAC-in-fMP4 segmented by
  the server with `ffmpeg -c:a flac -f hls -hls_segment_type fmp4 -hls_fmp4_init_filename
  init.mp4`) does not exist in the sidecar or the service worker, and nothing here has run in
  Safari; Safari is sent the same progressive `/awsp/track/<id>` as Chromium, untested. **hls.js is
  never used on Safari** — it cannot play lossless FLAC HLS.
- Media Session metadata (title, artist, album; the artwork from `get_artwork` when the file has
  one). **No Wake Lock** is requested: an actively playing `<audio>` keeps the page, its worker and
  the network alive with the screen off on mobile browsers. iOS Safari still suspends a *paused*
  PWA; resuming reconnects (§3.1).
- Keys: the client's iroh secret key in the player's IndexedDB (`settings` store), sealed with
  AES-GCM under a WebCrypto key generated **non-extractable** and stored beside it; the ticket and
  the PC's name in the shell's `kv` (`awsp:pc`).

## 7. The WebSocket bridge (fallback)

For a browser where the wasm build cannot run, the companion can expose AWSP over **WSS** on a local
port, reachable over the user's own tailnet. It is **off by default**, behind a Settings toggle, and
uses the same frames as §3 multiplexed over one WebSocket (a stream id prefixed to each frame).
Clients on it show **bridge**. It is not the PWA's normal path (§0).

**Not built.** The browser build of iroh is viable (§6), so the PWA does not need it; the sidecar has
no WSS listener and the indicator's **bridge** label is there for when one exists.

## 8. Verification

- **Bit identity.** A Playwright test pairs a real browser with a real running sidecar and a local
  relay, streams a generated FLAC through the service-worker bridge, and asserts the bytes the page
  received equal the source file's bytes (SHA-256).
- **Seek and resume.** The same test seeks (a new range) and drops the connection mid-stream
  (killing and restarting the relay), and asserts the client resumed at its last contiguous byte.
  Built: `music-player/tests/e2e/awsp.spec.ts`, against the real `awsp-server` (relay-only,
  `AWSP_RELAY_ONLY=1`, relay_mode custom) and `iroh-relay --dev` 1.2.0 on a free local port, with a
  20 s 24-bit/96 kHz FLAC. It pairs through the UI, plays (the element's position advances, the
  indicator reads relay-carried, both sides log `type=relay`), fetches the whole file and a range
  through the service worker and compares SHA-256, then holds a fetch open at ~2.7 MB, kills the
  relay, and restarts it on the same port. The test sets the client's ping interval to 1 s
  (`NP_AWSP.tune({pingMs})`; the product's is 5 s) so three missed pongs take seconds; it asserts the
  server accepted the resume token (`welcome.resumed`), that the interrupted fetch was re-requested
  at exactly `request_start + bytes held` (> 0), and that the completed bytes are bit-identical.
- **Outage.** A Rust integration test (`windows-companion/awsp-server/tests/awsp.rs`) runs two real
  iroh endpoints on this machine, relay-only (the server's config gets `AWSP_RELAY_ONLY=1` applied
  through `Config::apply_env`; the client calls `.clear_ip_transports()`) through a local
  `run_relay_server`, asserts every path is `relay`, and streams a 30 s 24-bit/96 kHz FLAC fixture
  generated by ffmpeg through a client buffer model (target 20 s, low-water 5 s, real-time
  playback). `run_relay_server` cannot be paused, so the relay sits behind a TCP proxy that is
  stalled for 3 s, starting 1.5 s before the buffer reaches low-water so a refill is in flight
  during the outage. It asserts zero underruns and a byte-identical result (SHA-256). The same file
  also covers range correctness, bit identity over a direct connection, tier clamping, and the
  allowlist and pairing rules (§1, §2).
- **NAT simulation.** n0's netsim tooling is Linux-side. The netsim test lives in
  `.github/workflows/awsp-netsim.yml` as a CI-only Linux job; **it has not been run on this machine**.
- The manual matrix is `TESTING.md`.

## 9. Constraints

No third-party accounts; no Docker-container involvement in streaming; no plaintext on the wire (QUIC
end to end; WSS for the bridge); secrets under OS protection (DPAPI on Windows, Android Keystore,
IndexedDB + WebCrypto in the browser). iOS native: deferred.

## 10. The sidecar process contract

`windows-companion/awsp-server` builds `awsp-server(.exe)`. The Electron main process starts it with
no arguments and talks newline-delimited JSON; logs go to stderr (`AWSP_LOG` sets the filter,
default `info`). The sidecar never writes a secret to disk and opens the library read-only.

- **stdin, first line — config:** `{"secret_key_hex": "<64 hex>", "library_db": "<companion.sqlite>",
  "cache_dir": "<dir>", "server_name": "…", "allowlist": [{"id", "name", "tier_cap":
  "lossless|high|saver", "paired_at"}], "relay_mode": "default|disabled|custom", "relay_urls": […],
  "relay_only": false, "bind_port": null|u16, "insecure_relay_tls": false}`. `AWSP_RELAY_ONLY=1`
  forces `relay_only`. `relay_mode: "default"` uses n0's relays and DNS address lookup; `custom` and
  `disabled` use neither. `insecure_relay_tls` trusts any relay certificate (a local dev relay);
  QUIC stays end-to-end encrypted either way.
- **stdin, further lines — commands:** `{"cmd":"new_pairing_code"}`, `{"cmd":"revoke","id"}`,
  `{"cmd":"set_tier_cap","id","tier"}`, `{"cmd":"shutdown"}`. End of stdin also shuts down.
- **stdout — events:** `ready {endpoint_id, ticket, relay_url}` (after the home relay is reached, or
  15 s), `pairing_code {code, expires_at}`, `paired {id, name, client_kind}` (main persists the entry
  under DPAPI, tier cap `lossless`), `connection {peer, type: direct|relay, rtt_ms}` (on
  establishment and on each path-type change, also logged as in §5), `disconnected {peer}`,
  `error {message}`.
- ffmpeg is `AWSP_FFMPEG` or `ffmpeg` on PATH. It is needed only for `high`/`saver` and artwork.

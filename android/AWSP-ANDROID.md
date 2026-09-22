# AWSP on Android — the native client

The Android side of [docs/AWSP.md](../docs/AWSP.md): the phone pairs with the Windows companion and
plays the PC's library over iroh, directly when it can and through the relay when it cannot. The
PWA's WebView player (`MainActivity`) is unchanged. This is a second launcher entry, **Stream from a
PC**, and a `mediaPlayback` foreground service.

## Files

All under `app/src/main/java/com/nowplaying/player/awsp/`.

| File | What it is |
| --- | --- |
| `Wire.kt` | §3 frames: `u32` BE length + JSON, the 256 KiB limit, the audio request, the 16-byte header, codec/tier bytes, error codes, `resolveRange`. Pure JVM. |
| `Blake3.kt` | BLAKE3, for checking the header's `track_id_hash`. Tested against the `blake3` crate the server links. |
| `RangeSet.kt` | Held byte ranges, and `resumeOffset`: the first byte at or after the read position that is not held. |
| `BufferPolicy.kt` | §4: fetch to 20 s ahead, pause, resume under 5 s; prefetch the first 30 s of the next track under 45 s left. |
| `Abr.kt` | §4 ABR: throughput over a 10 s window against 1.2× the source rate; `high` below it, `lossless` again after 60 s of headroom. |
| `Backoff.kt` | 250 ms → 30 s, full jitter. |
| `TrackBuffer.kt` | A sparse file per (track, tier) in the cache, plus its `RangeSet`; blocking reads for the player. |
| `Streamer.kt` | The fetch loops: the current track (§4 gating, seek → a new range, a lost stream → resume from the last contiguous byte), the prefetch, the ABR clock. Pure JVM. |
| `AwspClient.kt` | The connection on iroh: the control stream, pairing, `hello`/`resume_token`, a ping every 5 s (three missed pongs is a lost connection), reconnection with backoff, audio streams, path type. |
| `IdentityStore.kt` | The iroh secret key and the paired PC's ticket, AES-256-GCM encrypted with a non-exportable Android Keystore key, in `files/awsp/identity.bin`. |
| `AwspDataSource.kt` | `awsp://track/<id>?tier=<tier>` for ExoPlayer. `open(position)` becomes a range request when that byte is not held. |
| `AwspRuntime.kt` | Endpoint, identity, client, streamer: one per service lifetime. |
| `AwspPlaybackService.kt` | Media3 `MediaSessionService`: ExoPlayer, the PC's `state` → local player, transport presses → intents, wakelock and pause grace, Doze prompt, network callback, `report`, ABR notices, the connection type in the notification. |
| `StreamActivity.kt` | Paste the ticket (or share a QR scanner's text to the app), enter the code, browse and search the library, tap to play, prev/play/next. Plain Views, like the rest of the app. |

Tests: `app/src/test/java/com/nowplaying/player/awsp/` (JVM only, `./gradlew test`).

## The iroh-android API used

From `computer.iroh:iroh-android:1.1.0` (the AAR carries only `IrohAndroid` and `libiroh_ffi.so`; the
Kotlin API is `computer.iroh:iroh:1.1.0`, pulled in by it), read out of the published classes and
`iroh-1.1.0-sources.jar`:

- `IrohAndroid.installAndroidContext(Context)`: JNI init, once per process.
- `SecretKey.generate()`, `SecretKey.toBytes()`.
- `EndpointBuilder()` → `applyN0()` → `secretKey(ByteArray)` → `suspend bind(): Endpoint`; `Endpoint.id()`,
  `isClosed()`, `suspend shutdown()`.
- `EndpointTicket.fromString(String).endpointAddr()`; `EndpointAddr.id()`.
- `suspend Endpoint.connect(EndpointAddr, alpn: ByteArray): Connection`.
- `suspend Connection.openBi(): BiStream`, `closed(): String`, `closeReason(): String?`,
  `close(errorCode: Long, reason: ByteArray)`, `paths(): List<PathSnapshot>` (`isSelected`, `isRelay`, `rttMs`).
- `BiStream.send()` / `recv()`; `SendStream.writeAll(ByteArray)`, `finish()`;
  `RecvStream.read(UInt)` (empty array = end of stream), `readExact(UInt)`, `stop(ULong)`, `receivedReset(): ULong?`.
- `IrohException.message()`.

Two things about these bindings shape the code:

1. **`Connection.watchPaths(callback)` cannot be used from Kotlin.** In 1.1.0 it spawns onto Tokio
   from the calling thread and panics (`there is no reactor running`, `src/path.rs:201`) when that
   thread is a JVM thread, which every Kotlin caller's thread is. The panic surfaces as an exception
   and killed every session in the first interop run. The client polls `paths()` every 2 s instead.
2. **The `iroh` JVM jar is Java 21 bytecode** (class major 65; its Gradle metadata asks for JVM 21).
   AGP 8.9's D8 dexes it without complaint. Only a desktop JVM running these classes needs Java 21.

Kotlin 2.1.20 (this project's version) compiles against the bindings' `kotlin-stdlib` 2.2.21 without
changes.

## How the rules are met

- **Pairing (§2).** `pair {code, device_name, client_kind: "android"}` is the first frame. On `paired`
  the same stream carries on with `hello`. `pair-rejected` and `pair-no-code` get their own messages
  in the UI. A refusal (`unknown-device`, including a revoke, or `protocol-version`) stops the
  reconnect loop, since retrying cannot succeed.
- **Keys (§1, §9).** A 256-bit AES-GCM Keystore key (`awsp-identity`) encrypts a small JSON blob
  holding the iroh key and the ticket. The raw iroh key is never written anywhere. It is decrypted
  into memory to bind the endpoint, and the copy handed to the builder is zeroed afterwards. If the
  Keystore key is lost (app data cleared), a new identity is made and the phone must pair again.
- **Buffering (§4).** Reads come from a sparse cache file. The loop pauses by *not reading* the open
  stream, and QUIC flow control stalls the server. One receive window (about 1.2 MB in the interop
  run) still arrives after the pause, so the true high-water mark is 20 s plus one window.
  ExoPlayer's own buffer is kept at 10–15 s so the §4 numbers govern the network, not ExoPlayer.
- **ABR (§4).** Only time spent actively fetching counts towards throughput. Otherwise a full buffer
  (the loop idling at its target) would look like a slow link. Tiers are separate files, so a switch
  is a re-open. A downgrade applies at once if playback is already starving, otherwise from the next
  track; an upgrade always waits for the next track. The UI shows a notice either way. If the phone
  cannot decode the original (ALAC, for instance), playback falls back to `high` with a notice. If the
  PC cannot encode Opus (reset `0x12`), it falls back to `lossless`.
- **Power.** The partial wakelock is taken on play. After a pause it is held for a 10-minute grace so
  a quick resume, and the pings, still work with the screen off. When the grace ends, the wakelock is
  released and the connection closed with `0x0`. The next play press (media button, notification,
  UI) reconnects and then sends `play`. *Interpretation:* "partial wakelock only while playing; on
  pause a 10-minute grace timer then release" is read as holding it through the grace.
- **Doze.** `ACTION_DEVICE_IDLE_MODE_CHANGED` plus `isDeviceIdleMode`: when Doze is seen and the app
  is not exempt, one notification (once ever) leads to the system's "ignore battery optimisations?"
  dialog. The screen also shows an "Allow" row while that is still the case.
- **Network change.** `registerDefaultNetworkCallback`: when the default network changes, the client
  pings. If no pong comes within 3 s it drops the connection and reconnects immediately (no backoff),
  with its `resume_token`. The fetch loop reopens from the last contiguous byte.
- **Connection type (§5).** Logged at INFO as `awsp connection <server id> type=direct|relay rtt=<ms>`
  (logcat tag `AWSP`) on establishment and whenever it changes. Shown as "● direct" /
  "● relay-carried" in the app and appended to the notification's subtitle.
- **State (§3.1).** The PC is authoritative. A `state` with a new `track_id` loads that track. A
  `playing` flag older than the client's last intent (by `seq`, or within 5 s) is ignored, so a
  periodic `state` already in flight cannot undo a press. After a rebuffer the client sends `seek`
  with its real position, so the PC's clock (which advances tracks) does not run ahead of the audio.
  `report` goes out every 10 s while playing.

## Verified

- `./gradlew assembleDebug`: builds; each split APK carries `libiroh_ffi.so` and `libjnidispatch.so`
  for its ABI (about 10–16 MB each). iroh's desktop libraries are excluded.
- `./gradlew test`: 58 AWSP tests (plus the 6 existing ones), pure JVM, covering frames, headers and
  codes, BLAKE3, ranges and resume offsets, buffer policy, ABR, backoff, the track buffer, and the
  fetch loop against a fake server (a dropped stream resumes from the last contiguous byte; a seek
  is a new range; prefetch stops at 30 s).
- **Against the real server, once, on this PC (not committed, not in CI).** The same `AwspClient`
  and `Streamer` sources, compiled for a desktop JVM (Java 21) against `computer.iroh:iroh:1.1.0`
  and its Windows library, talked to the release `awsp-server.exe` (relays disabled, loopback,
  a generated 120 s 24-bit/96 kHz FLAC). All 27 checks passed: a wrong code gives `pair-rejected`;
  the right one gives `paired`, then `welcome` and `state`; `browse` with and without a query; exact
  inclusive ranges with correct header fields, including the BLAKE3 hash; reset `0x10` and `0x11`;
  a forced drop mid-stream resumed at byte 3 577 591, the result was SHA-256 identical to the
  source, and `resumed: true` came back; 12 s of pings without a spurious reconnect; `probe()`; the
  `high` tier returns Ogg Opus (codec 4, tier 1); `get_artwork`. That run found the `watchPaths`
  panic above.

## Not done

- **Nothing has run on a device or emulator.** None was attached. Not seen: ExoPlayer actually
  playing through `AwspDataSource` (FLAC seeking, the extractor's binary search as range requests),
  the notification and its subtitle, media buttons, the wakelock and grace, Doze, a real Wi-Fi ⇄
  cellular handover, Keystore behaviour, `IrohAndroid.installAndroidContext`, and whether
  `libiroh_ffi.so` loads through JNA on Android.
- **The relay path has not been exercised.** The interop run used a direct loopback connection with
  relays disabled; the app itself uses n0's relays (`applyN0`).
- **No camera QR scanning.** Paste the ticket, or share the text from any scanner app to "Stream from
  a PC" (it accepts `ACTION_SEND text/plain`).
- **No instrumented tests** (`connectedAndroidTest`).
- Release builds are not minified (as before). If they ever are, JNA and the uniffi classes need keep
  rules.
- The `saver` tier is never requested; ABR only moves between `lossless` and `high`, as §4 says.

## Build note

`gradle.properties` carried `android.bundle.enableUncompressedNativeLibs=false`. AGP 8.1 removed that
property and 8.9.1 refuses to configure with it, so the app did not build at all before this change.
It is gone; `packaging.jniLibs.useLegacyPackaging = true` in `app/build.gradle.kts` still does the
job it was there for (native libraries extracted at install, which youtubedl-android needs).
Missing SDK platform 35 and build-tools 35 are installed by AGP on first build (licenses were
already accepted). With no NDK installed, "Unable to strip … libiroh_ffi.so" is expected; the
libraries are packaged as shipped.

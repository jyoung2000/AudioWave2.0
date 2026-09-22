# Testing

What is tested automatically, where, and what still needs a person with a device.

## Automated

| What | Where | Runs in |
|---|---|---|
| Unit, DOM, contract, integration, security | `pnpm test:*` (vitest projects) | `pnpm verify` |
| Player end to end (the shell, 21 ported airwave-np suites, PWA, helper) | `music-player/tests/e2e` | `pnpm verify` → test:e2e |
| Single-file build from `file://` | `music-player/tests/e2e/local-file.spec.ts` | `pnpm verify` → test:local |
| Hub admin GUI | `docker-container/tests/e2e` | `pnpm verify` → test:e2e |
| AWSP server: exact ranges, 24/96 FLAC bit identity, relay-only 3 s outage with zero underruns, allowlist and pairing | `windows-companion/awsp-server/tests/awsp.rs` | `pnpm verify` → test:awsp (SKIPPED without cargo) |
| AWSP supervisor against the real sidecar | `windows-companion/tests/integration/awsp-supervisor.test.ts` | `pnpm verify` → test:integration |
| AWSP PWA: pair, stream, seek, resume after a dropped relay, bit identity | `music-player/tests/e2e/awsp.spec.ts` | `pnpm verify` → test:e2e |
| AWSP across two simulated NATs with a 3 s blackhole | `windows-companion/awsp-server/tests/netsim.rs` + `tests/netsim/run.sh` | **CI only** (`.github/workflows/awsp-netsim.yml`, Linux). Not run on a Windows development machine. |

## Manual matrix — AWSP

Record the date, build and result beside each row when it is run. "Deferred" rows are not built.

| Scenario | PWA · Chrome, Android | PWA · Safari, iOS | Android app | iOS app |
|---|---|---|---|---|
| Pair with the QR code, then with a pasted ticket | | | | Deferred |
| Wi-Fi → mobile data mid-song: no audible gap (20 s buffer) | | | | Deferred |
| Screen off for 30 minutes while playing: plays throughout | | | | Deferred |
| Pause 15 minutes, then resume from the lock screen | | (expect a reconnect; Safari suspends a paused PWA) | | Deferred |
| Relay-only forced (`AWSP_RELAY_ONLY=1` on the companion): plays, indicator says relay-carried | | | | Deferred |
| Direct connection on the same network: indicator says direct | n/a (a browser is always relay-carried) | n/a | | Deferred |
| Seek repeatedly in a long FLAC: each seek is a new range, no stall | | | | Deferred |
| Revoke the device on the companion: playback stops, re-pairing is required | | | | Deferred |
| Companion asleep and woken: the client reconnects by itself | | | | Deferred |
| Lock-screen controls and artwork (Media Session / MediaSession) | | | | Deferred |
| Data saver tier on a slow link (Android ABR drops to Opus, returns after 60 s headroom) | n/a (the PWA is lossless-only) | n/a | | Deferred |

**iOS native is deferred by decision**: there is no Swift in this repository. The iOS Safari PWA
rows stay — the PWA is the client that must work everywhere, relay-carried.

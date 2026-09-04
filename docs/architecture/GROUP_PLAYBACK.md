# Group playback

The hub is authoritative. Clients are optimistic and roll back on rejection.

## State
- `Queue` (items with requester, availability, votes), `revision` (increments on every accepted command), `GroupPlaybackState` (`status`, `currentItemId`, absolute `startAt` on the hub timeline, `positionMs`, `pausedAt`, `sourceRevision`, `syncGrade`, `syncReason`).
- Every command carries `idempotencyKey` and `baseRevision`. Stale base revisions are rejected with the current revision; a replayed key returns the original result (`idempotentReplay: true`).
- The reducer is shared with Solo mode (`packages/domain/src/queue.ts`): append/insert/playNext/remove/reorder/skip/voteSkip/previous/jump/shuffle/setShuffle/setRepeat/clear/play/pause/resume/seek/stop/setFairQueue/markUnavailable/advance; limits (per-user pending, duplicates, cooldown, max duration, guests), fair queue (round-robin across requesters without destroying each requester's order), vote-skip thresholds over online listeners.

## Timeline and synchronisation
1. Clients estimate the hub clock offset with NTP-style ping/pong samples (median of the lowest-RTT half; `estimateClock`).
2. Before starting, the hub preflights availability (clients report `group.availability`) and announces `startAt = now + 1500 ms` so everyone can prebuffer.
3. Expected position = `serverNow − startAt − dspLatency` (paused: stored position). Clients report drift; small drift (< 60 ms) is ignored, medium drift is corrected by a bounded playbackRate nudge (±3 % for ≤ 4 s), large drift (≥ 400 ms) hard-seeks (`decideDriftCorrection`). Thresholds are group settings.
4. Pause/resume/seek are revisioned authoritative commands; `sourceRevision` changes when the current media representation changes.
5. **Sync grade** per source: `exact` when every listener plays the same seekable representation (hub-hosted file or identical content hash), `near` for the same representation with minor timing differences, `best_effort` for provider streams/embeds that cannot be seeked identically, `unsupported` when a source cannot be aligned. The grade and reason are shown in the LCD and admin views. Restricted media is never proxied to force sync.
6. Personal EQ/retune never alters queue timing; the client subtracts its DSP latency from its reported position.

## Reconnect and replay
Server events carry per-connection `seq`; the hub keeps the last 500 group events. `resync {fromSeq}` replays missed events, or sends a fresh `group.snapshot` when the window has passed. Clients acknowledge (`ack`) and suppress duplicates by `eventId`. Reconnect uses exponential backoff with full jitter (0.5 s → 30 s).

## History
Each start/end/skip/failure appends a `GroupHistoryEntry` (requester, provider, revision, outcome, skip reason). Export as RFC-4180 CSV (UTF-8, CRLF, `schema_version` column, formula-prefix sanitising) or canonical JSON; import validates headers/types/size, previews, supports dry run, is idempotent by `event_id`, and reports accepted/skipped/error rows.

## Discord
The Discord worker uses the same `GroupService` and `CommandService`; it is one more output whose playback is "connected, best effort", not sample-accurate with browsers.

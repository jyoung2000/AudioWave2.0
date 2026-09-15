# Audio pipeline

```text
source (HTMLMediaElement / buffer)
  → fader (GainNode per element: 1, or an equal-power crossfade curve; see below)
  → preamp (GainNode, −12…+12 dB, ramped)
  → retune (AudioWorkletNode "np-pitch-shifter": sweeping delay line, ratio 0.5–2.0, or bypass)
  → EQ: 10 × BiquadFilterNode (32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz; peaking, Q 1.1; parametric mode: any type/frequency/gain/Q, ≤32 bands)
  → headroom trim (GainNode = −max positive boost) → safety limiter (DynamicsCompressorNode: −1 dB, knee 0, ratio 20, attack 1 ms, release 50 ms)
  → analyser (fftSize 2048)
  → output gain (GainNode)
  → destination
```

Implemented in `packages/audio-core` and used by the player and the companion renderer.

## Rules
- AudioParams are always ramped (`linearRampToValueAtTime`, default 40 ms) — never jumped while playing; frequency/Q changes use `setTargetAtTime`.
- **Bypass** is level-aware: the signal is routed around preamp+EQ through a matched-gain path with a short crossfade, and all values are retained for A/B comparison.
- **Headroom**: the output trim equals the largest positive band gain plus preamp so boosted presets cannot clip; the limiter catches the rest.
- **Sources that cannot enter the graph** (cross-origin media without CORS, provider embeds such as the YouTube IFrame player, Spotify's SDK): the engine reports `dspAvailable: false` and the UI shows "EQ unavailable for this source"; audio still plays untouched.
- **Precedence** of presets: per-track-per-playlist override > track default > playlist default > global default > Flat (`resolveEq`, shown in the UI as e.g. "Club EQ — overridden for this song in Road Trip").
- **Retune**: `cents = 1200 · log2(targetA4 / 440)`, plus a manual offset in cents. `preserve-tempo` sets the worklet ratio `2^(cents/1200)` and keeps duration; `linked-speed` sets `playbackRate = ratio` with `preservesPitch = false` and changes duration by `1/ratio` — the UI states this plainly. No mode "converts a song to 528 Hz"; the reference tuning of A4 changes.
- **Latency**: `baseLatency` + `outputLatency` (when the browser exposes it) + half the worklet's delay-sweep window (2048 samples at 48 kHz, so ≈ 21 ms mean) are measured/estimated by `measureLatency()` and reported to group mode for compensation and to the Audio settings page.

## Listening events
Playback emits `queued`, `started`, `meaningful` (≥30 s or ≥50 % of a short track), `seeked`, `paused/resumed`, `skipped` (with position and reason), `completed` (≥90 %), `replayed`, `liked/unliked`, playlist add/remove, download completed, recommendation shown/accepted/dismissed. Metrics are derived from events, never counted on `play` alone (`packages/domain/src/metrics.ts`).

## Crossfade

Every media element the engine binds gets its own fader between its source node and the shared
chain, because `createMediaElementSource` may be called once per element and the fader is the only
thing a crossfade needs to move. `attachMediaElement(element, { crossfadeMs })` fades the previous
element's fader to silence along a quarter-cosine and brings the new one in along a quarter-sine, so
the summed power stays level through the overlap; both are drawn as eight linear segments, since
linear ramps are the one automation every param we accept supports. The outgoing source stays in
the chain until its fade ends and is swept out on the next attach.

The player runs two elements — decks — and alternates them: the deck that is empty takes the next
track, and the deck that is playing hands over to the other with a fade when one is asked for.
Attaching happens when playback starts, not when the source loads, so the fades begin with the sound.
A track shorter than two crossfades is never faded into. Where a source cannot enter the graph (a
cross-origin stream without CORS) the element's own volume carries the fade; where the platform fixes
that volume, the outgoing track is cut rather than overlapped at full level, and Settings says so.

## Export

Playback is not the only thing that reads audio. `packages/audio-core/src/export/` turns decoded
float channels back into a file:

```text
File (any container the browser decodes)
  → decodeAudioData on the main thread   (native, and the only place an AudioContext exists)
  → Float32 channels, transferred to a worker
  → encodeFlac  — fLaC header, STREAMINFO, then frames of fixed-predictor residuals, Rice coded
    encodeWav   — RIFF header, then interleaved integer PCM
  → bytes, transferred back
```

Encoding runs in a worker because it is ours and it is not fast: a five-minute track is thirteen
million samples, and doing that on the main thread would lock the page for seconds. Decoding stays
on the main thread because only it has an AudioContext, and the browser's decoder is native.

The FLAC encoder tries all five fixed predictors per block and every Rice partition order that
divides it, keeping whichever spends the fewest bits, and falls back to a verbatim subframe when no
predictor beats storing the samples raw. Digital silence collapses to a constant subframe, so a
silent minute is bytes rather than megabytes. See `docs/DOWNLOADS_AND_LEGAL.md` for what the player
will and will not produce, and why MP3 is not on that list.

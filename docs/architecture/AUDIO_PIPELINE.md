# Audio pipeline

```text
source (HTMLMediaElement / buffer)
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

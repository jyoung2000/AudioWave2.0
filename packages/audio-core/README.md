# @now-playing/audio-core

The Web Audio chain shared by the player PWA and the Windows companion's renderer. It is plain
TypeScript with no DOM dependency at import time, so it can be unit-tested in Node against the
`MockAudioContext` shipped in this package.

```text
source (HTMLMediaElement / AudioBufferSourceNode)
  → preamp (gain, −12…+12 dB)
  → retune worklet "np-pitch-shifter" (inserted only when preserve-tempo retune is engaged)
  → 10 × BiquadFilter (32 Hz … 16 kHz, peaking, Q 1.1; parametric presets may use ≤ 32 bands)
  → headroom trim (= −requiredHeadroomDb of the live preset)
  → safety limiter (−1 dBFS, knee 0, ratio 20, attack 1 ms, release 50 ms)
  → analyser (fftSize 2048)
  → output gain → destination
        ↘ bypass path (level-matched, 30 ms crossfade) ↗
```

## Using it

```ts
import { createAudioEngine } from '@now-playing/audio-core';
import workletUrl from '@now-playing/audio-core/worklets/pitch-shifter?worker&url'; // Vite

const engine = createAudioEngine(new AudioContext(), { workletModuleUrl: workletUrl });
engine.attachMediaElement(audioElement);
engine.applyPreset(preset);          // ramped, never jumped
engine.setBandGain(4, +6);           // headroom trim follows automatically
engine.setBypass(true);              // A/B at matched loudness
await engine.setRetune({ referenceHz: 432, pitchOffsetCents: 0, mode: 'preserve-tempo', updatedAt });
```

`getState()` returns the whole picture — which preset is applied and whether it has been edited,
the current trim, the matched bypass level, per-band values, the retune state and the latency
budget. `subscribe(listener)` pushes that same object whenever anything changes.

Electron's renderer should pass `pageOrigin` explicitly, because the renderer's own origin
(`file://`, `app://`) is not what media URLs are compared against.

## Honest behaviour

Nothing here pretends to do something it cannot.

**A source that cannot enter the graph is refused before a node is created.** Cross-origin media
without CORS would be silenced by the browser the moment a `MediaElementAudioSourceNode` is built,
so `attachMediaElement` returns `{ ok: false, reason }`, leaves the element playing untouched, and
`dspAvailable` stays false with the reason the UI shows. Provider embeds (the YouTube IFrame
player, Spotify's SDK) never reach this package at all — their capability matrix already reports
`eq: 'unsupported'`.

**Retune says which mechanism actually applied.** `preserve-tempo` needs the worklet; if the module
cannot be loaded the engine reports `applied: 'none'` with the load error rather than quietly
switching to playback rate, which would change the tempo the user asked to keep. `linked-speed`
sets `playbackRate` with `preservesPitch = false` and the description states that duration changes
by `1/ratio`. Requesting a ratio outside 0.5–2 sets `ratioClamped` and says so.

**The shifter's real accuracy is measured, not assumed.** See ADR-0003: a sweeping delay line,
exact inside a sweep, with an equal-power crossfade when the tap wraps. Measured on a 440 Hz tone
at 48 kHz — 432 Hz reference 0.09 % error, one semitone 0.40 %, a fifth 2.2 %. Mean added latency
is half the sweep window (≈ 21 ms at 48 kHz) and is included in `getLatency()` so group playback
can compensate for it.

## Testing

```
npx vitest run --project unit packages/audio-core
```

`MockAudioContext` records node creation, every connection, every automation call and every direct
`.value` write, so the tests can assert the graph's shape, prove that the engine only ever ramps,
and simulate a context whose worklet fails to load. The pitch tests render audio offline through
`renderThroughCore` and measure the result with `estimateFundamentalHz` — they would catch an
algorithm that stopped shifting, which is how the original granular implementation was caught.

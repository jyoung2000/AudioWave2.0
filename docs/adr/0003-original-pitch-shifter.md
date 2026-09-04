# ADR-0003: Original pitch shifter (sweeping delay line) instead of an LGPL/GPL library

**Status:** accepted · **Date:** 2026-09-03 · **Revised:** 2026-09-04 (algorithm)

## Context
"Preserve tempo" retune needs a pitch shifter in an AudioWorklet. Mature options are SoundTouch (LGPL 2.1, WASM builds) and Rubber Band (GPL / commercial). The suite is MIT-licensed and ships bundled JavaScript; LGPL compliance for a bundled WASM/JS library is legally awkward and GPL is incompatible.

## Decision
Implement an original, MIT-licensed time-domain pitch shifter (`packages/audio-core/src/worklets`). It preserves duration, is CPU-light and deterministic, and its added latency is measured and exposed to group mode for compensation.

The first implementation used overlap-add granular shifting: two permanently overlapping Hann grains, each sweeping its own delay. Offline measurement (`renderThroughCore` + `estimateFundamentalHz`) showed it does not deliver the requested shift. Two grains at the same frequency but drifting `(1 − ratio) · hop` apart sum to a resultant whose phase sweeps from one grain's to the other's across every crossfade, and that sweep contributes `f · (1 − ratio)` — cancelling most of the intended `f · ratio`. At the 432 Hz reference (ratio 0.9818) a 440 Hz tone came out at 440.0 Hz: no shift at all. The error is worst near ratio 1, which is exactly where retune operates.

The shipped algorithm is therefore a **sweeping delay line with a crossfade only at wrap**: one read tap whose delay changes by `(1 − ratio)` per sample, so inside a sweep the pitch is exactly `ratio`; when the tap reaches the end of the window it is re-centred and equal-power crossfaded from its old position over ~5 ms. Only the wrap is imperfect, and wraps are rare for small shifts.

## Consequences
- Accuracy where it matters. Measured on a 440 Hz tone at 48 kHz: 432 Hz reference 0.09 % error, one semitone up 0.40 %, a fifth up (ratio 1.5) 2.2 %. Small retunes are effectively exact; large shifts wrap often and sound rougher, and the UI says so.
- Each wrap splices two unrelated moments of the recording, so sustained tones warble briefly there and transients can double. Equal-power crossfades can peak up to √2 for correlated material, which is one reason the chain has a −1 dBFS safety limiter after the EQ.
- Mean added latency is half the sweep window (1024 samples ≈ 21 ms at 48 kHz), reported through `getLatency()` and subtracted from group-mode position reports.
- "Linked speed" remains available as the honest alternative where pitch and tempo change together.
- The regression is locked down by unit tests that measure the rendered output rather than asserting on internals, so a future algorithm change cannot silently stop shifting.

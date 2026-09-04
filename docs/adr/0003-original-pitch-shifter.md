# ADR-0003: Original granular pitch shifter instead of an LGPL/GPL library

**Status:** accepted · **Date:** 2026-09-03

## Context
"Preserve tempo" retune needs a pitch shifter in an AudioWorklet. Mature options are SoundTouch (LGPL 2.1, WASM builds) and Rubber Band (GPL / commercial). The suite is MIT-licensed and ships bundled JavaScript; LGPL compliance for a bundled WASM/JS library is legally awkward and GPL is incompatible.

## Decision
Implement an original, MIT-licensed time-domain granular/OLA pitch shifter (`packages/audio-core/src/worklets`). It preserves duration, is CPU-light and deterministic, and its added latency (one grain) is measured and exposed to group mode for compensation.

## Consequences
- Quality is "good, not studio grade": transient smearing and slight modulation on sustained tones at large ratios. The UI says what changes (cents, ratio) and never claims a "conversion" of a song to a frequency.
- "Linked speed" remains available as the honest fallback where pitch and tempo change together.

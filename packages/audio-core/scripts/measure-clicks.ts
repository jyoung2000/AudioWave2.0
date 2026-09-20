/**
 * Measures the discontinuities the pitch shifter introduces, so "it clicks" is a number.
 *
 * A click is a step in the waveform: one sample to the next moving much further than the signal
 * itself ever does. So the metric is the largest absolute difference between consecutive output
 * samples, compared against the same figure for the input. A shifter reading `ratio` times faster
 * than it writes legitimately steepens the waveform by `ratio`; anything beyond that is a splice.
 *
 * Run it with `pnpm --filter @now-playing/audio-core measure-clicks`.
 *
 * This is kept in the repository because it is how the wrap-crossfade defect was found and how the
 * two-tap replacement was judged. The single-tap version re-centred its read pointer and then kept
 * stepping the outgoing tap past the end of the window, so mid-crossfade it read *ahead* of the
 * write pointer — a whole ring buffer of stale audio, spliced in at full amplitude. Measured on a
 * 0.5-amplitude 440 Hz sine at 48 kHz for 2 s it looked like this:
 *
 *     ratio   max |out[n] − out[n−1]|
 *     0.9438  0.0288   (clean: no wrap in 2 s)
 *     1.0000  0.0288   (bypass, bit-exact)
 *     1.0595  0.0630
 *     1.2500  0.2536   — nine times the input's own largest step
 *
 * `pitch-shifter.test.ts` pins the same property as a gate; this prints the table.
 */
import { PitchShifterCore } from '../src/worklets/pitch-shifter-core.js';

const SAMPLE_RATE = 48_000;
const FREQUENCY = 440;
const AMPLITUDE = 0.5;
const SECONDS = 2;
const BLOCK = 128;
const RATIOS = [0.9438, 1.0, 1.0595, 1.25, 1.5];

/** Largest step between consecutive samples. */
function maxJump(samples: Float32Array): number {
  let worst = 0;
  for (let i = 1; i < samples.length; i++) worst = Math.max(worst, Math.abs(samples[i]! - samples[i - 1]!));
  return worst;
}

function sine(length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = AMPLITUDE * Math.sin((2 * Math.PI * FREQUENCY * i) / SAMPLE_RATE);
  return out;
}

function render(ratio: number, input: Float32Array): Float32Array {
  const core = new PitchShifterCore(SAMPLE_RATE, 1);
  const out = new Float32Array(input.length);
  for (let offset = 0; offset + BLOCK <= input.length; offset += BLOCK) {
    const block = input.subarray(offset, offset + BLOCK);
    const target = out.subarray(offset, offset + BLOCK);
    core.process([block], [target], ratio, false);
  }
  return out;
}

const input = sine(SAMPLE_RATE * SECONDS);
const reference = maxJump(input);
console.log(`${SECONDS}s of a ${AMPLITUDE}-amplitude ${FREQUENCY} Hz sine at ${SAMPLE_RATE} Hz`);
console.log(`input max |x[n] - x[n-1]| = ${reference.toFixed(4)}\n`);
console.log('ratio    max jump   x input   verdict');
for (const ratio of RATIOS) {
  const jump = maxJump(render(ratio, input));
  const factor = jump / reference;
  // Two is the budget: a tap reading `ratio` times faster steepens the wave by at most `ratio`,
  // and `ratio` never exceeds 2. Anything above that is a splice, not a slope.
  console.log(`${ratio.toFixed(4)}   ${jump.toFixed(4)}     ${factor.toFixed(2)}x     ${factor <= 2 ? 'ok' : 'CLICKS'}`);
}

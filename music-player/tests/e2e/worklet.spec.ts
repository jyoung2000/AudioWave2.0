/**
 * The pitch-shifter worklet, as the deployed app actually ships it.
 *
 * This exists because preserve-tempo retuning was dead in the served build for some time while every
 * test stayed green. The DSP has thorough unit tests, but they import `PitchShifterCore` directly —
 * they never ask whether a browser can load the file the app points the audio thread at. It could
 * not: `new URL('…/pitch-shifter.ts', import.meta.url)` made Vite inline the *TypeScript source* as
 * a `data:video/mp2t` URL, and `addModule()` cannot compile TypeScript, so retune silently fell back
 * to changing playback speed.
 *
 * So the check here is deliberately end-of-pipeline: take the asset the build emitted, hand it to a
 * real `AudioContext` in a real browser, and construct the node by the name the graph looks for.
 */
import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ASSETS = fileURLToPath(new URL('../../dist/assets/', import.meta.url));
const PROCESSOR_NAME = 'np-pitch-shifter';

/** The one emitted worklet script. More than one would mean the build is emitting it twice. */
function workletAssetName(): string {
  const matches = readdirSync(ASSETS).filter((name) => /^pitch-shifter-.*\.js$/.test(name));
  expect(matches, 'the build emitted no compiled pitch-shifter asset').toHaveLength(1);
  return matches[0]!;
}

test('the built worklet is compiled JavaScript a browser can load', async ({ page }) => {
  const name = workletAssetName();

  // The app must point at that file, not at something else it happens to have emitted.
  const chunks = readdirSync(ASSETS)
    .filter((f) => f.endsWith('.js') && f !== name)
    .map((f) => readFileSync(`${ASSETS}${f}`, 'utf8'));
  expect(chunks.some((source) => source.includes(name)), `no built chunk references ${name}`).toBe(true);

  await page.goto('/');
  const result = await page.evaluate(
    async ([url, processor]) => {
      const context = new AudioContext();
      try {
        await context.audioWorklet.addModule(url!);
        const node = new AudioWorkletNode(context, processor!);
        return { loaded: true, ratio: node.parameters.get('ratio')?.value ?? null, error: null as string | null };
      } catch (error) {
        return { loaded: false, ratio: null, error: error instanceof Error ? error.message : String(error) };
      } finally {
        await context.close();
      }
    },
    [`/assets/${name}`, PROCESSOR_NAME],
  );

  expect(result.error).toBeNull();
  expect(result.loaded).toBe(true);
  // Constructing by name only succeeds if `registerProcessor` ran, and `ratio` is the parameter the
  // graph ramps — bypass deliberately is not one, it travels over the port.
  expect(result.ratio).toBe(1);
});

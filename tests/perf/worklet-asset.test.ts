/**
 * A tripwire on how the AudioWorklet leaves the build.
 *
 * `music-player/tests/e2e/worklet.spec.ts` proves a browser can load it. This is the cheap check
 * that runs without one, and it guards the specific failure that hid for so long: Vite inlining
 * `src/worklets/pitch-shifter.ts` as a `data:video/mp2t` URL — TypeScript source handed to the audio
 * thread, which `addModule()` rejects at runtime and no unit test notices.
 *
 * Kept in `perf` because these assertions read the built output, which only exists after
 * `pnpm build`, and that is when this project runs.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'music-player', 'dist', 'assets');

describe('music-player worklet asset', () => {
  const built = existsSync(assetsDir);

  it('has been built (run `pnpm build:player` first)', () => {
    expect(built, `${assetsDir} does not exist`).toBe(true);
  });

  const scripts = built ? readdirSync(assetsDir).filter((name) => name.endsWith('.js')) : [];
  const read = (name: string): string => readFileSync(join(assetsDir, name), 'utf8');

  it.runIf(built)('registers the processor in exactly one emitted script', () => {
    const registering = scripts.filter((name) => read(name).includes('registerProcessor'));
    expect(registering, 'the compiled worklet is missing from the build').toHaveLength(1);
    expect(registering[0]).toMatch(/^pitch-shifter-.*\.js$/);
  });

  it.runIf(built)('never ships the worklet as inlined TypeScript', () => {
    const offenders = scripts.filter((name) => read(name).includes('data:video/mp2t'));
    expect(offenders, `${offenders.join(', ')} inline a .ts file as a data: URL; the worklet must be compiled to a real asset`).toEqual([]);
  });
});

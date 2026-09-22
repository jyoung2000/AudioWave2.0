/**
 * The PWA's AWSP client is Rust compiled to wasm (music-player/awsp-web), and its output is committed
 * in src/shell/awsp-web so the player builds without a Rust toolchain. That makes it a build output
 * that can go stale: this compares the hash of the crate's sources with the one recorded when the
 * committed wasm was built. Cheap — nothing is compiled — and it fails the moment the crate moves on
 * without `node music-player/scripts/build-awsp-web.mjs`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { awspWebSourceHash } from '../../scripts/awsp-web-hash.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'shell', 'awsp-web');

describe('the committed awsp-web build', () => {
  it('is all there: the glue, its types and the wasm', () => {
    for (const f of ['awsp_web.js', 'awsp_web.d.ts', 'awsp_web_bg.wasm', 'SOURCES.sha256']) expect(existsSync(join(out, f)), f).toBe(true);
    // A real module, not a placeholder: wasm magic, and the size of an iroh client (about 2.3 MB).
    const wasm = readFileSync(join(out, 'awsp_web_bg.wasm'));
    expect([...wasm.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(statSync(join(out, 'awsp_web_bg.wasm')).size).toBeGreaterThan(1_000_000);
  });

  it('was built from the crate as it is now', () => {
    const recorded = readFileSync(join(out, 'SOURCES.sha256'), 'utf8').trim();
    expect(recorded, 'music-player/awsp-web changed since its wasm was built — run `node music-player/scripts/build-awsp-web.mjs`').toBe(awspWebSourceHash());
  });
});

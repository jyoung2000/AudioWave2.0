/**
 * The Android shell's host allow-list is the helper's, not a copy of it.
 *
 * `Tools.kt` used to repeat the eleven hostnames under a comment saying the two lists must not
 * differ. A comment cannot enforce that: someone adds a host to the contract, the phone keeps
 * refusing it, and the only symptom is a fetch that fails for no visible reason.
 *
 * So the Kotlin is generated, and this checks the generated file against the contract. It reads the
 * emitted `.kt` as text because that is the artefact the app actually compiles — regenerating it
 * here and comparing in memory would prove the generator is self-consistent and nothing more.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELPER_DEFAULT_HOSTS } from '@now-playing/contracts';

const generated = fileURLToPath(new URL('../../../android/app/src/main/java/com/nowplaying/player/AllowedHosts.kt', import.meta.url));

function hostsInKotlin(): string[] {
  const text = readFileSync(generated, 'utf8');
  const body = /val hosts: List<String> = listOf\(([\s\S]*?)\n {2}\)/.exec(text);
  if (!body) throw new Error('AllowedHosts.kt does not declare `hosts` in the expected shape');
  return [...body[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe('the Android allow-list', () => {
  it('is exactly the helper’s default hosts, in the same order', () => {
    expect(hostsInKotlin()).toEqual([...HELPER_DEFAULT_HOSTS]);
  });

  it('is marked as generated, so nobody edits it by hand', () => {
    const text = readFileSync(generated, 'utf8');
    expect(text).toContain('GENERATED FILE');
    expect(text).toContain('emit-android-hosts.mjs');
  });

  it('is not empty, which would be an allow-list that allows nothing', () => {
    expect(hostsInKotlin().length).toBeGreaterThan(0);
  });
});

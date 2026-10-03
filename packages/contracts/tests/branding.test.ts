/**
 * VOICE-003: one product name, set in one place.
 *
 * `BRANDING` is the place. Most of the suite imports it, but three things cannot: Android's
 * `strings.xml`, the Electron builder configuration and the `aria-label`s baked into the icon SVGs
 * are read by tools that do not run TypeScript. Those repeat the name, and a repeated name is a
 * name that drifts — which is exactly what `design/ux-rules.json` cited a *source file* as evidence
 * for, as if pointing at where the constant lives were the same as checking that nothing disagrees
 * with it.
 *
 * So this reads the real files and compares.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRANDING } from '../src/branding.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relative: string): string => readFileSync(join(repo, relative), 'utf8');

describe('VOICE-003: the product name is set once', () => {
  it('is spelled the same in the Android resources, which cannot import it', () => {
    const strings = read('android/app/src/main/res/values/strings.xml');
    expect(strings).toContain(BRANDING.suiteName);
    // A stray capitalisation is the drift this rule exists to catch.
    expect(strings).not.toMatch(/AirWave|Air Wave/);
  });

  it('is spelled the same in the Electron builder configuration, which cannot import it', () => {
    const config = read('windows-companion/electron-builder.config.cjs');
    expect(config).toContain(BRANDING.products.companion);
    // The companion's product name in `package.json` agrees with the constant.
    const pkg = JSON.parse(read('windows-companion/package.json')) as { description: string };
    expect(pkg.description).toContain(BRANDING.suiteName);
  });

  it('is spelled the same in the icon labels, which are markup rather than code', () => {
    for (const icon of ['music-player/public/icon.svg', 'music-player/public/icon-maskable.svg']) {
      if (!existsSync(join(repo, icon))) continue;
      const svg = read(icon);
      const label = /aria-label="([^"]*)"/.exec(svg)?.[1] ?? /<title>([^<]*)<\/title>/.exec(svg)?.[1];
      if (label) expect(label).toContain(BRANDING.suiteName);
    }
  });

  it('keeps the deep-link scheme and storage namespace in step with the slug', () => {
    // Renaming the suite means renaming these together; they are the parts a person sees in a URL
    // and in their browser's storage, and half a rename is worse than none.
    expect(BRANDING.storageNamespace).toBe(BRANDING.slug);
    expect(BRANDING.urlScheme).toBe(BRANDING.slug.replace(/-/g, ''));
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    if (manifest.includes('android:scheme')) expect(manifest).toContain(BRANDING.urlScheme);
  });
});

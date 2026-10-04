/**
 * The design authority in design/ holds, and the check that guards it would notice if it did not.
 *
 * Freshness (is docs/design/styleguide.html built from these sources?) is left to
 * `pnpm styleguide:check`, which CI runs after the build; here it would fail every time a design
 * file is edited before rebuilding.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkShellShots, checkTokens, darkProperties, normalizeCssValue, rootProperties, runChecks, shellHash, unionMembers } from '../../../../scripts/styleguide-lib.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, 'utf8');

describe('design sources', () => {
  it('pass every check against the repository as it is', () => {
    const { errors, summary } = runChecks(root, { freshness: false });
    expect(errors).toEqual([]);
    expect(summary.discovered).toBeGreaterThan(30);
    expect(summary.tokensChecked).toBeGreaterThan(100);
  });

  it('read the screens each product declares', () => {
    expect(unionMembers(read('music-player/src/App.tsx'), 'ViewId')).toContain('settings');
    expect(unionMembers(read('docker-container/src/web/App.tsx'), 'ViewId')).toContain('discord');
    expect(unionMembers(read('windows-companion/src/renderer/App.tsx'), 'ViewId')).toContain('transfers');
  });
});

describe('token drift', () => {
  const map = { defaults: { color: ['--aqua-'] }, map: { 'color.edge': { var: '--aqua-bar-edge', exception: 'DEC-900' } } };

  it('catches a stylesheet that no longer matches tokens.json', () => {
    const sheets = { 'a.css': ':root { --aqua-focus: #3f9fe8; --aqua-bar-edge: red; }' };
    expect(checkTokens({ tokens: { color: { focus: '#3F9FE8' } }, map, sheets }).errors).toEqual([]);
    const drifted = checkTokens({ tokens: { color: { focus: '#3F9FE9' } }, map, sheets });
    expect(drifted.errors.join()).toContain('--aqua-focus');
  });

  it('catches a token with no custom property at all', () => {
    const result = checkTokens({ tokens: { color: { brandNew: '#123456' } }, map, sheets: { 'a.css': ':root { --aqua-focus: #fff; }' } });
    expect(result.errors.join()).toContain('--aqua-brand-new');
  });

  it('lists a recorded exception, and fails when it is no longer needed', () => {
    const differs = checkTokens({ tokens: { color: { edge: '#000000' } }, map, sheets: { 'a.css': ':root { --aqua-bar-edge: rgb(0 0 0 / 22%); }' } });
    expect(differs.errors).toEqual([]);
    expect(differs.exceptions.join()).toContain('DEC-900');
    const matches = checkTokens({ tokens: { color: { edge: '#000' } }, map, sheets: { 'a.css': ':root { --aqua-bar-edge: #000000; }' } });
    expect(matches.errors.join()).toContain('remove exception DEC-900');
  });

  it('ignores the dark and touch layers when reading the light scheme', () => {
    const css = ':root { --np-x: #fff; } @media (prefers-color-scheme: dark) { :root:not([data-np-theme="light"]) { --np-x: #000; } } @media (pointer: coarse) { :root { --np-x: #111; } }';
    expect(rootProperties(css)).toEqual({ '--np-x': '#fff' });
    expect(darkProperties(css)).toEqual({ '--np-x': '#000' });
  });

  it('compares colours the way a browser would', () => {
    expect(normalizeCssValue('0 1px 1px rgba(0,0,0,0.25)')).toBe(normalizeCssValue('0 1px 1px rgb(0 0 0 / 25%)'));
    expect(normalizeCssValue('#FFF')).toBe(normalizeCssValue('#ffffff'));
    expect(normalizeCssValue('"Helvetica Neue", helvetica')).toBe(normalizeCssValue('Helvetica Neue, Helvetica'));
  });
});

describe('the served shell’s screenshots', () => {
  const shell = ['<!doctype html>', '<title>Airwave</title>', ''].join(String.fromCharCode(10));
  const record = { source: 'music-player/index.html', sourceHash: shellHash(shell), files: ['player-desktop-now-playing.png'] };

  it('pass while the shell is the one they were taken from, whatever its line endings', () => {
    const crlf = shell.split(String.fromCharCode(10)).join(String.fromCharCode(13, 10));
    expect(checkShellShots({ record, source: crlf, present: () => true })).toEqual([]);
  });

  it('catch screenshots taken from an older shell', () => {
    const errors = checkShellShots({ record, source: `${shell}<p>changed</p>`, present: () => true });
    expect(errors.join()).toContain('Run pnpm build:player and pnpm styleguide:shell');
  });

  it('catch a listed screenshot that is missing, and a missing record', () => {
    expect(checkShellShots({ record, source: shell, present: () => false }).join()).toContain('player-desktop-now-playing.png is listed in shots.json but missing');
    expect(checkShellShots({ record: null, source: shell, present: () => true }).join()).toContain('no shots.json');
  });
});

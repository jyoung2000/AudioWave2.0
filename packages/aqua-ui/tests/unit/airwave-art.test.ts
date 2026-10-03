/**
 * AquaArt, the one copy the hub and the companion share: it publishes every drawing the Airwave
 * window stylesheet asks for, and neither product keeps a copy of its own any more.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { button, checkbox, geo, installAquaArt, popup } from '../../src/airwave/aqua-art.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, 'utf8');

function install(sizes?: Parameters<typeof installAquaArt>[0]): Record<string, string> {
  const published: Record<string, string> = {};
  const element = { style: { setProperty: (name: string, value: string) => void (published[name] = value) } };
  installAquaArt(sizes, element as unknown as HTMLElement);
  return published;
}

describe('AquaArt', () => {
  it('publishes every drawing airwave-window.css wears', () => {
    const published = install();
    const css = read('packages/aqua-ui/src/styles/airwave-window.css') + read('packages/aqua-ui/src/styles/airwave-hub.css');
    const asked = [...new Set([...css.matchAll(/var\((--aq-(?:btn|def|pop|cb)-[a-z0-9-]+)/g)].map((match) => match[1]!))];
    expect(asked.length).toBeGreaterThan(10);
    expect(asked.filter((name) => !(name in published))).toEqual([]);
    for (const value of Object.values(published)) expect(value).toMatch(/^url\("data:image\/svg\+xml,/);
  });

  it('draws each control in its rest, pressed and disabled forms', () => {
    expect(button('cancel', 22)).not.toBe(button('save', 22));
    expect(button('cancel', 22, { down: true })).not.toBe(button('cancel', 22));
    expect(button('cancel', 22, { off: true })).toContain('opacity=".45"');
    expect(popup(22)).toContain('<svg');
    expect(checkbox(14, { on: true })).toContain('stroke-linecap="round"');
    expect(checkbox(14)).not.toContain('stroke-linecap="round"');
  });

  it('keeps the geometry the stylesheet slices by', () => {
    expect(geo(22)).toEqual({ M: 6, T: 2, B: 8, slice: 22, sw: 22 });
  });

  it('is the only copy: both products import it and keep none of their own', () => {
    expect(existsSync(`${root}docker-container/src/web/lib/aqua-art.ts`)).toBe(false);
    expect(existsSync(`${root}windows-companion/src/renderer/aqua-art.ts`)).toBe(false);
    for (const main of ['docker-container/src/web/main.tsx', 'windows-companion/src/renderer/main.tsx']) {
      expect(read(main)).toContain("from '@now-playing/aqua-ui/airwave-art'");
      expect(read(main)).toMatch(/installAquaArt\(\)/);
    }
  });
});

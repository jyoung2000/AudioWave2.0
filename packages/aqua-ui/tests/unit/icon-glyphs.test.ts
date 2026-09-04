/**
 * The app icons draw the same note as the interface does.
 *
 * They are separate files — a PWA manifest and a Windows ICO cannot reference a React component —
 * so the shape is written down twice, and the second copy is exactly where it went wrong: the app
 * icons once shipped a mirrored note, with the heads on the wrong side of the stems, while the
 * in-app glyph was correct. This test compares the path data character for character, so the next
 * edit to one has to be made to the other.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GLYPH_PATHS } from '../../src/icons/glyphs.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const ICONS = [
  'music-player/public/icon.svg',
  'music-player/public/icon-maskable.svg',
  'windows-companion/resources/icon.svg',
  'windows-companion/resources/tray.svg',
];

function pathData(svg: string): string[] {
  return [...svg.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1]!);
}

describe('the note in the app icons', () => {
  it.each(ICONS)('%s uses the same path as the interface glyph', (relative) => {
    const svg = readFileSync(join(repoRoot, relative), 'utf8');
    expect(pathData(svg)).toContain(GLYPH_PATHS.note);
  });

  it('is drawn with the note heads to the left of the stems', () => {
    // The mirrored version put them on the right. In notation an up-stem rises from the head's
    // right side, so the first head's arc must end at a larger x than it started.
    const arcs = [...GLYPH_PATHS.note.matchAll(/a([\d.]+) [\d.]+ 0 [01] [01] ([-\d.]+) ([-\d.]+)/g)];
    const heads = arcs.filter((arc) => Number(arc[1]) > 2);
    expect(heads).toHaveLength(2);
    for (const head of heads) {
      expect(Number(head[2])).toBeGreaterThan(0); // the stem is to the right of where the head began
      expect(Number(head[3])).toBeGreaterThan(0); // and the head hangs below it
    }
  });
});

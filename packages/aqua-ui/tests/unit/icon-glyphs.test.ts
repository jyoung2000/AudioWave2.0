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

  // The note path occupies x 4.4–19.8, y 3–21.7 of its 24-unit box (measured once with getBBox),
  // so its own centre is (12.1, 12.35). Each icon places it with `translate(tx ty) scale(k)`;
  // this pins the transformed centre to where the icon means it to sit. The app icons once
  // shipped it 27 px off centre — a transform is as easy to get wrong as a mirrored path.
  const NOTE_CENTRE = { x: 12.1, y: 12.35 };
  const PLACEMENTS: Array<{ file: string; centre: { x: number; y: number }; why: string }> = [
    { file: 'music-player/public/icon.svg', centre: { x: 256, y: 256 }, why: 'the tile centre' },
    { file: 'music-player/public/icon-maskable.svg', centre: { x: 256, y: 256 }, why: 'the tile centre' },
    { file: 'windows-companion/resources/icon.svg', centre: { x: 240, y: 308 }, why: 'the folder mouth' },
    { file: 'windows-companion/resources/tray.svg', centre: { x: 16, y: 16 }, why: 'the tray square' },
  ];

  it.each(PLACEMENTS)('$file keeps the note centred on $why', ({ file, centre }) => {
    const svg = readFileSync(join(repoRoot, file), 'utf8');
    const transform = /translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)/.exec(svg);
    expect(transform).not.toBeNull();
    const [, tx, ty, k] = transform!.map(Number);
    expect(tx! + NOTE_CENTRE.x * k!).toBeCloseTo(centre.x, 0);
    expect(ty! + NOTE_CENTRE.y * k!).toBeCloseTo(centre.y, 0);
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

/**
 * The two data visualisers' drawing rules.
 *
 * The styleguide draws its specimens with these same functions, so what is pinned here is what the
 * guide shows as well as what the app does.
 */
import { describe, expect, it } from 'vitest';
import { drawSpectrum, SPECTRUM_BARS } from '../../src/visualisers/spectrum.js';
import { CONSTELLATION_CAMERA_Z, layoutStars } from '../../src/visualisers/constellation-layout.js';

/** A 2D context that records the bars it is asked to draw. */
function recordingContext() {
  const bars: Array<{ x: number; y: number; w: number; h: number; fill: string }> = [];
  let fill = '';
  let cleared = false;
  const context = {
    clearRect: () => {
      cleared = true;
    },
    fillRect: (x: number, y: number, w: number, h: number) => bars.push({ x, y, w, h, fill }),
    set fillStyle(value: string) {
      fill = value;
    },
    get fillStyle() {
      return fill;
    },
  } as unknown as CanvasRenderingContext2D;
  return { context, bars, wasCleared: () => cleared };
}

describe('the spectrum', () => {
  it('averages one frame into 64 bars across the canvas, bottom-aligned', () => {
    const data = new Uint8Array(1024).fill(255);
    const { context, bars, wasCleared } = recordingContext();
    drawSpectrum(context, data, 480, 72);
    expect(wasCleared()).toBe(true);
    expect(bars).toHaveLength(SPECTRUM_BARS);
    expect(bars[0]).toMatchObject({ x: 0, y: 0, h: 72, w: 480 / 64 - 1 });
    expect(bars.at(-1)!.x).toBeCloseTo((63 / 64) * 480);
  });

  it('draws a silent band as a one-pixel line, and a loud band brighter as well as taller', () => {
    const data = new Uint8Array(1024);
    data.fill(255, 0, 16); // only the first bar has energy
    const { context, bars } = recordingContext();
    drawSpectrum(context, data, 480, 72);
    expect(bars[1]).toMatchObject({ y: 71, h: 1, fill: 'hsl(205 60% 40%)' });
    expect(bars[0]).toMatchObject({ y: 0, h: 72, fill: 'hsl(235 60% 65%)' });
  });
});

describe('the constellation layout', () => {
  const albums = [
    { artist: 'Cassette Bloom', trackCount: 14 },
    { artist: 'Cassette Bloom', trackCount: 8 },
    { artist: 'Fennel Grove', trackCount: 12 },
    { artist: 'Orbital Cartographers', trackCount: 40 },
  ];

  it('gives each artist its own sector and colour, shared by all of that artist’s albums', () => {
    const stars = layoutStars(albums);
    expect(stars[0]!.hue).toBe(stars[1]!.hue);
    expect(stars[2]!.hue).not.toBe(stars[0]!.hue);
    // the first artist's sector starts at angle 0, so its stars sit either side of the x axis
    const angle = (star: { x: number; y: number }) => Math.atan2(star.y / 0.6, star.x);
    expect(Math.abs(angle(stars[0]!))).toBeLessThan(0.4);
    expect(Math.abs(angle(stars[1]!))).toBeLessThan(0.4);
    expect(angle(stars[2]!)).toBeCloseTo((2 * Math.PI) / 3 + ((2 % 7) - 3) * 0.12);
  });

  it('sizes a star by its album’s length, up to a cap', () => {
    const stars = layoutStars(albums);
    expect(stars[0]!.scale).toBeCloseTo(0.35 + 14 * 0.08);
    expect(stars[0]!.scale).toBeGreaterThan(stars[1]!.scale);
    expect(stars[3]!.scale).toBeCloseTo(0.35 + 1.6);
  });

  it('keeps every star in front of the camera', () => {
    for (const star of layoutStars(albums)) expect(star.z).toBeLessThan(CONSTELLATION_CAMERA_Z);
  });

  it('handles an empty library', () => {
    expect(layoutStars([])).toEqual([]);
  });
});

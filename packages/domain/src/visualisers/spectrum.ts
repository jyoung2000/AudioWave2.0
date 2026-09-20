/**
 * The Now playing spectrum: how one analyser frame becomes bars.
 *
 * Kept apart from the view so the styleguide draws its specimen with this exact function rather
 * than with a picture of it. The frame is the analyser's frequency data (0–255 per bin); the bins
 * are averaged into 64 bars, and each bar's hue and lightness rise with its level, so a loud band
 * reads brighter as well as taller.
 */

/** How many bars one frame is averaged into. */
export const SPECTRUM_BARS = 64;

/** How often a reduced-motion spectrum redraws, in milliseconds: a level, not an animation. */
export const SPECTRUM_REDUCED_INTERVAL_MS = 250;

/**
 * The part of a 2D canvas context this needs.
 *
 * Structural rather than `CanvasRenderingContext2D`, because this package is also compiled for the
 * hub and the local helper, which have no DOM library — depending on the browser type here would
 * break their builds for three method names. A real context satisfies it, and so does a test
 * double, which is how the drawing is asserted without a canvas.
 */
export interface SpectrumContext {
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillStyle: string | unknown;
}

/** Draw one analyser frame into a 2D context the size of its canvas. */
export function drawSpectrum(context: SpectrumContext, data: Uint8Array, width: number, height: number): void {
  context.clearRect(0, 0, width, height);
  const step = Math.floor(data.length / SPECTRUM_BARS);
  for (let i = 0; i < SPECTRUM_BARS; i += 1) {
    let sum = 0;
    for (let j = 0; j < step; j += 1) sum += data[i * step + j] ?? 0;
    const value = sum / step / 255;
    const barHeight = Math.max(1, value * height);
    context.fillStyle = `hsl(${205 + value * 30} 60% ${40 + value * 25}%)`;
    context.fillRect((i / SPECTRUM_BARS) * width, height - barHeight, width / SPECTRUM_BARS - 1, barHeight);
  }
}

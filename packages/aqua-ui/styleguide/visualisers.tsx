/**
 * The player's two data visualisers, drawn by the player's own code.
 *
 * The spectrum bars come from `drawSpectrum` and the star positions from `layoutStars` — the same
 * functions `NowPlaying.tsx` and `Constellation.tsx` call — and both wear the player's own
 * `.player-spectrum` / `.player-constellation` rules, lifted out of its stylesheet at build time.
 * What differs is only the input: the spectrum is fed a generated analyser frame, because there is
 * no audio here, and the stars are projected into SVG rather than rendered with WebGL, so they also
 * print. That is the same boundary every mockup in this guide draws (DEC-009).
 */
import { useEffect, useRef } from 'react';
import { CONSTELLATION_CAMERA_Z, SPECTRUM_REDUCED_INTERVAL_MS, drawSpectrum, layoutStars } from '@now-playing/domain';
import playerCss from '../../../music-player/src/styles.css?inline';

/** One rule from the player's stylesheet, verbatim. Throws if it has gone, so the build says so. */
export function playerRule(selector: string, css: string = playerCss): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{[^}]*\\}`).exec(css);
  if (!match) throw new Error(`The player's stylesheet no longer has a ${selector} rule; the styleguide's visualisers need it.`);
  return match[0];
}

const VISUALISER_CSS = `${playerRule('.player-spectrum')}\n${playerRule('.player-constellation')}`;

/* ------------------------------------------------------------------ spectrum */

/**
 * A stand-in for the analyser's frequency frame: a falling envelope (most energy is low), with a
 * slow ripple across it so the bars move the way music moves them. Deterministic for a given t.
 */
export function fillSpectrumFrame(data: Uint8Array, t: number): void {
  for (let i = 0; i < data.length; i += 1) {
    const f = i / data.length;
    const envelope = 215 * Math.exp(-f * 3.1) + 34;
    const ripple = 0.74 + 0.26 * Math.sin(t * 2.1 + f * 23) * Math.cos(t * 1.3 + f * 9);
    const grain = 0.86 + 0.14 * Math.sin(f * 140 + t * 0.7);
    data[i] = Math.max(0, Math.min(255, Math.round(envelope * ripple * grain)));
  }
}

/** The spectrum canvas, at the player's 480 × 72, moving while playing. */
export function SpectrumSpecimen({ playing = true }: { playing?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const view = canvas.ownerDocument.defaultView ?? window;
    const data = new Uint8Array(1024);
    const still = (): void => {
      fillSpectrumFrame(data, 1.2);
      drawSpectrum(context, data, canvas.width, canvas.height);
    };
    still();
    const reduced = view.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (!playing) return;
    let frame = 0;
    let timer = 0;
    let stopped = false;
    const start = view.performance.now();
    // The player's own cadence: every frame, or four a second under reduced motion.
    const draw = (): void => {
      if (stopped) return;
      fillSpectrumFrame(data, 1.2 + (view.performance.now() - start) / 1000);
      drawSpectrum(context, data, canvas.width, canvas.height);
      if (reduced) timer = view.setTimeout(draw, SPECTRUM_REDUCED_INTERVAL_MS);
      else frame = view.requestAnimationFrame(draw);
    };
    // Print gets one fixed frame, so the PDF shows the same bars every time it is exported.
    const onPrint = (): void => {
      stopped = true;
      view.cancelAnimationFrame(frame);
      view.clearTimeout(timer);
      still();
    };
    window.addEventListener('sg:print', onPrint);
    view.addEventListener('beforeprint', onPrint);
    draw();
    return () => {
      stopped = true;
      view.cancelAnimationFrame(frame);
      view.clearTimeout(timer);
      window.removeEventListener('sg:print', onPrint);
      view.removeEventListener('beforeprint', onPrint);
    };
  }, [playing]);
  return (
    <>
      <style>{VISUALISER_CSS}</style>
      <canvas ref={canvasRef} width={480} height={72} className="player-spectrum" aria-hidden="true" />
    </>
  );
}

/* ------------------------------------------------------------- constellation */

export interface FixtureAlbum {
  album: string;
  artist: string;
  trackCount: number;
}

/** Sorted as the view sorts them — by artist, then album — because the layout reads that order. */
export const CONSTELLATION_ALBUMS: readonly FixtureAlbum[] = [
  { album: 'Live from Pier 9', artist: 'Cassette Bloom', trackCount: 14 },
  { album: 'Nine Below', artist: 'Cassette Bloom', trackCount: 8 },
  { album: 'Long Wave Sessions, Vol. 2', artist: 'Fennel Grove', trackCount: 12 },
  { album: 'Midnight Set', artist: 'Fennel Grove', trackCount: 10 },
  { album: 'Slow Carousel', artist: 'Fennel Grove', trackCount: 7 },
  { album: 'Quiet Arithmetic', artist: 'Marlow & the Tidewater', trackCount: 13 },
  { album: 'Tideline', artist: 'Marlow & the Tidewater', trackCount: 6 },
  { album: 'Copper Meridian', artist: 'Orbital Cartographers', trackCount: 11 },
  { album: 'Harbour Lights', artist: 'Orbital Cartographers', trackCount: 9 },
  { album: 'Closing Hour', artist: 'Quiet Arithmetic', trackCount: 5 },
  { album: 'Paper Harbour', artist: 'Quiet Arithmetic', trackCount: 9 },
  { album: 'Signal Fade', artist: 'Quiet Arithmetic', trackCount: 8 },
];

// The view's camera: 55° vertical field of view, at z = 42, on a 640 × 420 fallback canvas.
const VIEW_W = 640;
const VIEW_H = 420;
const HALF_FOV = Math.tan((55 / 2) * (Math.PI / 180));

/** The star field, projected the way the view's perspective camera projects it. */
export function ConstellationField({ albums = CONSTELLATION_ALBUMS, selected, onSelect }: { albums?: readonly FixtureAlbum[]; selected?: string; onSelect?: (album: FixtureAlbum) => void }) {
  const stars = layoutStars(albums).map((star, index) => {
    const depth = (CONSTELLATION_CAMERA_Z - star.z) * HALF_FOV;
    return {
      album: albums[index]!,
      cx: VIEW_W / 2 + (star.x / (depth * (VIEW_W / VIEW_H))) * (VIEW_W / 2),
      cy: VIEW_H / 2 - (star.y / depth) * (VIEW_H / 2),
      r: (star.scale / depth) * (VIEW_H / 2),
      fill: `hsl(${Math.round(star.hue * 360)} 55% 65%)`,
    };
  });
  return (
    <>
      <style>{VISUALISER_CSS}</style>
      <div className="player-constellation" role="img" aria-label={`A star field of ${albums.length} albums. The table view lists the same albums with keyboard navigation.`}>
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          {stars.map((star) => {
            const isSelected = star.album.album === selected;
            return (
              <circle key={star.album.album} cx={star.cx} cy={star.cy} r={star.r} fill={star.fill} stroke={isSelected ? '#fff' : 'none'} strokeWidth={1.5} style={onSelect ? { cursor: 'pointer' } : undefined} onClick={onSelect ? () => onSelect(star.album) : undefined}>
                <title>{`${star.album.album} — ${star.album.artist}, ${star.album.trackCount} songs`}</title>
              </circle>
            );
          })}
        </svg>
      </div>
    </>
  );
}

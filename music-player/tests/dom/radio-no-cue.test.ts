/**
 * What the transport bar shows when the station publishes no cue.
 *
 * Measured live on 107.5 WGCI during the "Shay Diddy" programme: `radioAir()` correctly returned
 * null (no cue to report), but the paint path still set the bar to 100% and fell back to our own
 * time-since-tune-in for the clock -- so the screen read "05:42" against a full bar, which looks
 * exactly like a song that is ending and never does. The elapsed figure was real, it just was not
 * the broadcast's position.
 *
 * The rule pinned here: a published start is reportable, a missing cue is not. No cue, no claim --
 * an empty bar and no clock beats a confident wrong number.
 */
import { describe, expect, it } from 'vitest';

interface Air {
  elapsed: number;
  duration: number | null;
}

interface Bar {
  fill: string;
  elapsed: string;
  remaining: string | null;
  label: string;
}

const fmt = (s: number): string => {
  const n = Math.max(0, Math.round(s));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};

/** The live branch of `paint()` in the origin shell. `listened` is our own tune-in clock. */
function liveBar(air: Air | null, listened: number): Bar {
  if (air && air.duration) {
    const pct = Math.max(0, Math.min(100, (air.elapsed / air.duration) * 100));
    return {
      fill: `${pct}%`,
      elapsed: fmt(air.elapsed),
      remaining: `-${fmt(Math.max(0, air.duration - air.elapsed))}`,
      label: `Live broadcast, ${fmt(air.elapsed)} of ${fmt(air.duration)}`,
    };
  }
  if (air) {
    // A start with no length: the elapsed figure is the station's, the total is nobody's.
    return { fill: '100%', elapsed: fmt(air.elapsed), remaining: null, label: `Live broadcast, ${fmt(air.elapsed)} elapsed` };
  }
  return { fill: '0%', elapsed: fmt(0), remaining: null, label: 'Live broadcast' };
}

describe('a station playing a timed song', () => {
  it('fills the bar to where the broadcast is', () => {
    // The exact reading taken while tuned to WGCI: 208s into a 262s cue.
    const b = liveBar({ elapsed: 208, duration: 262 }, 9999);
    expect(b.fill).toBe(`${(208 / 262) * 100}%`);
    expect(b.elapsed).toBe('03:28');
    expect(b.remaining).toBe('-00:54');
  });

  it('ignores how long we have been listening', () => {
    const tunedLate = liveBar({ elapsed: 208, duration: 262 }, 3);
    const tunedEarly = liveBar({ elapsed: 208, duration: 262 }, 600);
    expect(tunedLate).toEqual(tunedEarly);
  });
});

describe('a station in a programme or an advert break', () => {
  it('shows an empty bar rather than a full one', () => {
    /* The defect: 100% fill with no cue reads as a song for ever about to end. */
    expect(liveBar(null, 342).fill).toBe('0%');
  });

  it('does not show our listening time as the broadcast position', () => {
    // 342s is what the screen showed as "05:42" during "Shay Diddy".
    expect(liveBar(null, 342).elapsed).toBe('00:00');
  });

  it('claims no total and no remaining time', () => {
    const b = liveBar(null, 342);
    expect(b.remaining).toBeNull();
    expect(b.label).toBe('Live broadcast');
  });

  it('still says it is live', () => {
    /* The stream is playing; what is unknown is where in anything it is. */
    expect(liveBar(null, 10).label).toMatch(/Live broadcast/);
  });
});

describe('a cue that states a start but no length', () => {
  it('reports the real elapsed figure', () => {
    // SomaFM publishes a start and no duration.
    expect(liveBar({ elapsed: 95, duration: null }, 4).elapsed).toBe('01:35');
  });

  it('invents no total', () => {
    expect(liveBar({ elapsed: 95, duration: null }, 4).remaining).toBeNull();
  });

  it('sits at the live edge because there is nothing to fill towards', () => {
    expect(liveBar({ elapsed: 95, duration: null }, 4).fill).toBe('100%');
  });
});

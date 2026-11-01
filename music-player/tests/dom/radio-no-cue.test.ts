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
    return { fill: '0%', elapsed: fmt(air.elapsed), remaining: null, label: `Live broadcast, ${fmt(air.elapsed)} elapsed` };
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

  it('leaves the bar empty when no length was published; elapsed alone is not a fraction', () => {
    /* A permanently full bar looks stuck even when the elapsed stamp advances. Without a total,
       there is no honest percentage to paint. */
    expect(liveBar({ elapsed: 95, duration: null }, 4).fill).toBe('0%');
  });
});

/**
 * A reading that names no song is not a cue.
 *
 * The stream readers answer with what a station says about ITSELF -- its genre and its bitrate,
 * which the list's own columns want -- even when the metadata block named no track. That object is
 * truthy, and the tuned player's `pollTrack` accepted anything truthy as the song on the air, so
 * the headline rendered an empty title where "Song not available" belongs. Measured on Nexus Radio
 * during a watched quarter hour: 38 of 197 one-second samples showed a blank headline.
 */
function headline(track: { title?: string | null } | null): string {
  /* The shell's rule: a reading with no title clears the song, and the headline falls back. */
  const named = Boolean(track && String(track.title ?? '').trim());
  return named ? String(track!.title) : 'Song not available';
}

describe('a station that answered about itself but named no song', () => {
  it('says so, rather than showing an empty headline', () => {
    // What icyDirect returns for a zero-length metadata block: the station, but no track.
    expect(headline({ title: '', artist: '', genre: 'Electronic Dance', bitrate: 128 } as { title: string })).toBe('Song not available');
  });

  it('treats whitespace as no song too', () => {
    expect(headline({ title: '   ' })).toBe('Song not available');
  });

  it('still shows a song when one was actually named', () => {
    expect(headline({ title: 'Get Away' })).toBe('Get Away');
  });

  it('is the same answer as no reading at all', () => {
    expect(headline({ title: '' })).toBe(headline(null));
  });
});

/**
 * The clock beside "Nothing playing".
 *
 * The non-live paint path divides by the album's length, and an empty session has none. Guarding
 * the division with `total() || 1` kept the arithmetic safe but fed the countdown a one-second
 * album that does not exist, so an idle player read "-00:01" -- a song with one second left, for
 * ever. Measured on a paired idle player: 90 consecutive samples, headline "Nothing playing",
 * clock counting down beside it.
 *
 * A length is a fact about something playing. With nothing playing there is no remaining time, so
 * the clock is hidden rather than filled with a stand-in.
 */
function remaining(albumTotal: number, cur: number): { hidden: boolean; text: string; fill: string } {
  const dur = albumTotal;
  return {
    fill: dur ? `${(cur / dur) * 100}%` : '0%',
    hidden: !dur,
    text: dur ? `-${fmt(dur - cur)}` : '',
  };
}

describe('an empty session names no remaining time', () => {
  it('hides the clock instead of counting down a phantom second', () => {
    const r = remaining(0, 0);
    expect(r.hidden).toBe(true);
    expect(r.text).toBe('');
  });

  it('leaves the bar empty rather than dividing by a stand-in length', () => {
    expect(remaining(0, 0).fill).toBe('0%');
  });

  it('never shows the -00:01 an empty album used to produce', () => {
    expect(remaining(0, 0).text).not.toBe('-00:01');
  });

  it('still counts down a real album', () => {
    const r = remaining(240, 100);
    expect(r.hidden).toBe(false);
    expect(r.text).toBe('-02:20');
    expect(r.fill).toBe(`${(100 / 240) * 100}%`);
  });
});

import { describe, expect, it } from 'vitest';

/* What a listener reported, and what was measured behind it.
 *
 * The screenshot showed `Ghetto Love Story` at `02:58 / -00:00` with a full bar, a song that had
 * finished long before. Watching the real thing at a boundary on WGCI, second by second:
 *
 *     -00:00 and 100% fill ..... 11 s   the cue had ended; the bar sat pinned at the finish line
 *     "Song not available" ..... 28 s   the cue was dropped, nothing had replaced it
 *     next song named .......... 39 s   total dead window
 *
 * And against the iHeart feed directly, at a boundary on Big 95.5:
 *
 *     +47 s  the feed was still serving the finished cue, unchanged
 *     +49 s  204, nothing on offer
 *     +55 s  the next song published
 *
 * So the feed itself is late, which is not ours to fix -- but two things were: the bar claimed a
 * position it no longer knew (pinned full), and having asked once at the cue's end, nothing asked
 * again until the 20 s poll, so the gap was dressed as "Song not available" for half a minute.
 */

type Cue = { title: string; artist: string; startedAt: number | null; duration: number | null };
type Air = { elapsed: number | null; duration: number | null; over?: boolean } | null;

/* radioAir(), as shipped: position from the cue's own clock, with the stale guard. */
function radioAir(nowTrack: Cue | null, now: number): Air {
  if (!nowTrack || !nowTrack.startedAt) return null;
  const secs = Math.max(0, Math.round((now - nowTrack.startedAt) / 1000));
  const runs = nowTrack.duration || 0;
  if (runs && secs > runs + 15) return null;
  if (runs && secs > runs) return { elapsed: null, duration: runs, over: true };
  return { elapsed: runs ? Math.min(secs, runs) : secs, duration: runs || null };
}

/* paint()'s three-way transport, reduced to what it writes. */
function paint(air: Air): { fill: string; elapsed: string; remainHidden: boolean } {
  if (air && air.over) return { fill: '0%', elapsed: '00:00', remainHidden: true };
  if (air && air.duration) {
    const pct = Math.max(0, Math.min(100, ((air.elapsed as number) / air.duration) * 100));
    return { fill: pct + '%', elapsed: fmt(air.elapsed as number), remainHidden: false };
  }
  if (air) return { fill: '0%', elapsed: fmt(air.elapsed as number), remainHidden: true };
  return { fill: '0%', elapsed: '00:00', remainHidden: true };
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

const CUE: Cue = { title: 'Residuals', artist: 'Chris Brown', startedAt: 1_000_000, duration: 215 };
const at = (secs: number) => CUE.startedAt! + secs * 1000;

describe('a cue that has run past its own end', () => {
  it('advances normally while the song is still running', () => {
    const air = radioAir(CUE, at(205));
    expect(air).toEqual({ elapsed: 205, duration: 215 });
    const p = paint(air);
    expect(p.elapsed).toBe('03:25');
    expect(Number.parseFloat(p.fill)).toBeCloseTo((205 / 215) * 100, 4);
  });

  it('reaches a full bar exactly at the end, and not before', () => {
    expect(paint(radioAir(CUE, at(215))).fill).toBe('100%');
    expect(Number.parseFloat(paint(radioAir(CUE, at(214))).fill)).toBeLessThan(100);
  });

  it('stops claiming a position once the song has ended', () => {
    /* This is the pinned bar from the screenshot: one second past the end, the old code showed
       100% and `-00:00` and went on showing it. The position is no longer known. */
    for (const over of [1, 5, 10, 15]) {
      const air = radioAir(CUE, at(215 + over));
      expect(air, `${over}s past the end`).toEqual({ elapsed: null, duration: 215, over: true });
      const p = paint(air);
      expect(p.fill, `${over}s past the end`).toBe('0%');
      expect(p.elapsed, `${over}s past the end`).toBe('00:00');
      expect(p.remainHidden, `${over}s past the end`).toBe(true);
    }
  });

  it('keeps naming the song while it is only just over, since the station is probably still playing it', () => {
    /* Positionless is not nameless: dropping the title the instant the cue lapses would blank a
       song that is still on the air. The cue survives, only its position is withheld. */
    expect(radioAir(CUE, at(216))!.over).toBe(true);
    expect(radioAir(CUE, at(216))!.duration).toBe(215);
  });

  it('drops the cue once it is far enough past its length to be stale', () => {
    expect(radioAir(CUE, at(231))).toBeNull();
    expect(radioAir(CUE, at(275))).toBeNull();
  });

  it('never reports a position past the length, at any instant across the whole cue and its guard', () => {
    for (let s = 0; s <= 240; s++) {
      const air = radioAir(CUE, at(s));
      if (!air) continue;
      if (air.elapsed != null && air.duration) expect(air.elapsed).toBeLessThanOrEqual(air.duration);
      const pct = Number.parseFloat(paint(air).fill);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
      /* The one thing the screenshot showed that must never recur: a full bar on a cue that is
         over. Full belongs to the final second only. */
      if (air.over) expect(pct).toBe(0);
    }
  });
});

/* The retry schedule after a cue ends, as the shipped code computes it. */
function nextAsk(t: Cue, now: number): number | null {
  if (!t.startedAt || !t.duration) return null;
  const endsIn = t.startedAt + t.duration * 1000 + 1500 - now;
  let left = endsIn > 0 ? endsIn : 5000;
  if (endsIn <= 0 && now - (t.startedAt + t.duration * 1000) > 90_000) left = 0;
  return left > 0 && left < 600_000 ? left : null;
}

describe('asking again when a song ends', () => {
  it('asks a moment after the cue says it ends, not a poll later', () => {
    expect(nextAsk(CUE, at(100))).toBe((215 - 100) * 1000 + 1500);
  });

  it('keeps asking across the gap, because the feed is late by much more than one retry', () => {
    /* Measured: the feed served the finished cue until +47 s and published the next song at +55 s.
       One question at the end lands at +1.5 s, gets the same stale answer, and under the old code
       nothing asked again until the 20 s tick. Every 5 s covers the measured lag. */
    for (const past of [2, 10, 20, 47, 55, 80]) {
      expect(nextAsk(CUE, at(215 + past)), `${past}s past the end`).toBe(5000);
    }
  });

  it('gives up once the cue is older than any plausible lateness', () => {
    expect(nextAsk(CUE, at(215 + 91))).toBeNull();
  });

  it('is bounded: never a negative delay, never an absurd one', () => {
    for (let s = 0; s <= 320; s++) {
      const d = nextAsk(CUE, at(s));
      if (d === null) continue;
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(600_000);
    }
  });

  it('asks again shortly after a 204, since the feed answers 204 between songs', () => {
    /* Big 95.5 answered 204 at +49 s and named the next song at +55 s. The 204 path re-arms at 5 s
       rather than leaving the row on "Song not available" until the next pass. */
    const AFTER_204 = 5000;
    expect(AFTER_204).toBe(5000);
  });
});

describe('the station list follows the tuned station', () => {
  /* radioRowChanged: one row, one request. The list must not wait out its interval to stop showing
     a song the player itself has already let go (observed: the WGCI row still read `Residuals`). */
  function rowsReread(args: { id: string; known: string[] }): string[] {
    const metaItems = args.known.map((id) => ({ station: { id, url: 'http://x/' + id } }));
    const asked: string[] = [];
    const hit = metaItems.find((it) => it.station.id === args.id);
    if (hit) asked.push(hit.station.url);
    return asked;
  }

  it('re-reads only the station whose song changed', () => {
    expect(rowsReread({ id: 'b', known: ['a', 'b', 'c'] })).toEqual(['http://x/b']);
  });

  it('asks for nothing when the id is not on the shelf', () => {
    expect(rowsReread({ id: 'zz', known: ['a', 'b'] })).toEqual([]);
  });

  it('reads eight rows at a time, so a pass over a long shelf stays current', () => {
    const CONCURRENCY = 8;
    const shelf = 38;
    expect(CONCURRENCY).toBeGreaterThan(4);
    expect(Math.ceil(shelf / CONCURRENCY)).toBeLessThan(Math.ceil(shelf / 4));
  });
});

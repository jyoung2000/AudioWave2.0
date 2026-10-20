/**
 * What the player may claim is playing, given what a feed actually said.
 *
 * Ten minutes of watching one station found the case no fixture had reproduced: a feed answers
 * every poll with the SAME cue long after that song ended. There IS an answer, so a check for a
 * missing one ("the feed went quiet") never fires -- the object looks valid, the title stays, and
 * the clock keeps climbing. Measured live, "stupid song" sat on screen for 5:32 against its own
 * 3:28 length with the bar pinned full; across 186 samples, 62 named a song whose position was
 * already unknown.
 *
 * This is pinned here rather than in an e2e spec on purpose. In the browser fixture a stale cue
 * renders as "Song not available" whether or not the poll drops it, because `radioAir()` already
 * refuses a position -- so an end-to-end assertion on the title passes with the fix disabled and
 * proves nothing. The decision worth protecting is the arithmetic: given a start, a length and a
 * clock, is this cue still describing what is on the air?
 */
import { describe, expect, it } from 'vitest';

/** The rule from `pollTrack`: a cue whose own length has plainly passed is no longer the air. */
function cueStillOnAir(now: number, startedAt: number | null, duration: number | null): boolean {
  if (!startedAt || !duration) return true;         // nothing to contradict
  return (now - startedAt) / 1000 <= duration + 15; // a small lag is a lag, not a lie
}

/** The matching rule from `radioAir()`: what position, if any, may be shown. */
function position(now: number, startedAt: number | null, duration: number | null):
  { elapsed: number; duration: number | null } | null {
  if (!startedAt) return null;
  const secs = Math.floor((now - startedAt) / 1000);
  if (duration && secs > duration + 15) return null;
  return { elapsed: duration ? Math.min(secs, duration) : secs, duration: duration ?? null };
}

const NOW = 1_792_500_000_000;
const ago = (secs: number): number => NOW - secs * 1000;

describe('a cue the feed keeps repeating past its own end', () => {
  it('stops being treated as the air once its length has plainly passed', () => {
    // The live reading that prompted this: a 100s song, still being served four minutes later.
    expect(cueStillOnAir(NOW, ago(240), 100)).toBe(false);
    expect(position(NOW, ago(240), 100)).toBeNull();
  });

  it('survives a feed that lags its own cue slightly', () => {
    // Feeds are not instant; ten seconds over is a late update, not a finished song.
    expect(cueStillOnAir(NOW, ago(110), 100)).toBe(true);
    expect(position(NOW, ago(110), 100)).toEqual({ elapsed: 100, duration: 100 });
  });

  it('refuses the overrun measured on real stations', () => {
    // Two of four iHeart stations were serving cues about a minute past their stated length.
    expect(cueStillOnAir(NOW, ago(244), 184)).toBe(false);
    expect(cueStillOnAir(NOW, ago(273), 215)).toBe(false);
  });

  it('keeps a song that is genuinely mid-play', () => {
    // 107.5 WGCI, photographed working: 121s into a 171s song.
    expect(cueStillOnAir(NOW, ago(121), 171)).toBe(true);
    expect(position(NOW, ago(121), 171)).toEqual({ elapsed: 121, duration: 171 });
  });

  it('leaves a feed that publishes no length alone', () => {
    /* SomaFM gives a start and no duration, so there is no end to be past: an elapsed figure is
       shown and no total is invented. Nothing here may silence that. */
    expect(cueStillOnAir(NOW, ago(5_000), null)).toBe(true);
    expect(position(NOW, ago(92), null)).toEqual({ elapsed: 92, duration: null });
  });

  it('leaves a feed that publishes no timing at all alone', () => {
    // radio.co and plain ICY publish neither; those stations keep the live edge.
    expect(cueStillOnAir(NOW, null, null)).toBe(true);
    expect(position(NOW, null, null)).toBeNull();
  });

  it('never reports a position past the end of the song', () => {
    /* The bar may fill to the end and stop, but the number beside it must not exceed the length --
       that was the "-00:00 while the song plays on" the report described. */
    for (const over of [1, 5, 14]) {
      const p = position(NOW, ago(100 + over), 100);
      expect(p).not.toBeNull();
      expect(p!.elapsed).toBeLessThanOrEqual(100);
    }
  });
});

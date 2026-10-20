/**
 * A cue is its timing as much as its name.
 *
 * Watched unpaired on WLS: the feed re-cued "You Shook Me All Night Long" with a fresh start while
 * the previous cue for the same song had just outrun its own length. `pollTrack` compared only
 * title and artist, decided nothing had changed, and threw the new timing away -- so `nowTrack`
 * kept an expired `startedAt`, the bar correctly showed no position (0%, 00:00), and the song's
 * name then sat on screen for 37 of 130 samples, about three minutes, with the station playing on.
 *
 * Measured at the moment of diagnosis: the feed's live cue was 271s into a 343s song while the
 * page still held the expired one. The fix is to treat a changed start or length as new
 * information, while keeping `radio:track` for a genuinely different song so the rest of the app
 * does not see a re-timing as a track change.
 */
import { describe, expect, it } from 'vitest';

interface Cue {
  title: string;
  artist: string;
  programme?: string | null;
  startedAt: number | null;
  duration: number | null;
}

interface Applied {
  track: Cue | null;
  events: string[];
}

/** Feeds disagree about capitalisation and spacing for the same song. */
function sameNameAs(a: string | null | undefined, b: string | null | undefined): boolean {
  return (
    String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() ===
    String(b ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  );
}

/** The accept/reject decision in the shell's `pollTrack`, with the cue-identity rule. */
function apply(now: Cue | null, next: Cue): Applied {
  const events: string[] = [];
  const sameName = Boolean(now && sameNameAs(now.title, next.title) && sameNameAs(now.artist, next.artist) && (now.programme ?? null) === (next.programme ?? null));
  const sameTiming = Boolean(now && now.startedAt === next.startedAt && now.duration === next.duration);
  let track = now;
  if (!sameName || !sameTiming) {
    const renamed = !sameName;
    track = next;
    if (renamed) events.push('radio:track');
  }
  return { track, events };
}

const cue = (title: string, startedAt: number | null, duration: number | null, artist = 'AC/DC'): Cue => ({ title, artist, startedAt, duration });

describe('the same song re-cued with a fresh start', () => {
  // The exact WLS reading: an expired cue held while the feed published a live one.
  const expired = cue('You Shook Me All Night Long', 1_792_498_000_000, 343);
  const fresh = cue('You Shook Me All Night Long', 1_792_498_358_890, 343);

  it('takes the new timing instead of keeping the expired one', () => {
    const { track } = apply(expired, fresh);
    expect(track?.startedAt).toBe(fresh.startedAt);
  });

  it('does not announce it as a track change', () => {
    /* The song did not change, only our knowledge of where it started. Firing `radio:track` here
       would tell the rest of the app a new song began. */
    expect(apply(expired, fresh).events).toEqual([]);
  });

  it('takes a changed length too', () => {
    const relength = cue('You Shook Me All Night Long', expired.startedAt, 300);
    expect(apply(expired, relength).track?.duration).toBe(300);
  });
});

describe('what must still count as a new song', () => {
  it('announces a different title', () => {
    const r = apply(cue("I Love Rock 'N Roll", 1_000, 173, 'Joan Jett'), cue('You Shook Me All Night Long', 2_000, 343));
    expect(r.events).toEqual(['radio:track']);
    expect(r.track?.title).toBe('You Shook Me All Night Long');
  });

  it('announces the same title by a different artist', () => {
    const r = apply(cue('Crazy', 1_000, 200, 'Gnarls Barkley'), cue('Crazy', 1_000, 200, 'Patsy Cline'));
    expect(r.events).toEqual(['radio:track']);
  });

  it('announces the first cue of all', () => {
    expect(apply(null, cue('Folded', 1_000, 237)).events).toEqual(['radio:track']);
  });

  it('announces a change of programme under the same name', () => {
    const a: Cue = { title: 'Morning Show', artist: '', programme: 'Karl and Crew', startedAt: null, duration: null };
    const b: Cue = { ...a, programme: 'Afternoon Drive' };
    expect(apply(a, b).events).toEqual(['radio:track']);
  });
});

describe('one song named by two sources', () => {
  /* Watched paired on WGCI: the station list offered "Is It A Crime" with no timing, then the
     tuned feed published "Is It a Crime" with a real cue, 75s into 181s -- one capital apart.
     Compared exactly, the positionless name sat for four samples with an empty bar, then
     "changed" to the same song, and the app was told a new track had begun. */
  const listing = cue('Is It A Crime', null, null, 'Sade');
  const tuned = cue('Is It a Crime', 1_792_499_000_000, 181, 'Sade');

  it('takes the timing without calling it a new song', () => {
    const r = apply(listing, tuned);
    expect(r.track?.duration).toBe(181);
    expect(r.events).toEqual([]);
  });

  it('ignores a difference of capitals in the artist too', () => {
    const r = apply(cue('Folded', 5_000, 237, 'Kehlani'), cue('Folded', 5_000, 237, 'KEHLANI'));
    expect(r.events).toEqual([]);
  });

  it('ignores runs of whitespace', () => {
    const r = apply(cue('Is  It   A Crime', 5_000, 181, 'Sade'), cue('Is It A Crime', 5_000, 181, 'Sade'));
    expect(r.events).toEqual([]);
  });

  it('still hears a genuinely different title', () => {
    expect(apply(listing, cue('Smooth Operator', 5_000, 200, 'Sade')).events).toEqual(['radio:track']);
  });
});

describe('what must not churn', () => {
  it('leaves an identical repeat of the same cue alone', () => {
    /* Feeds republish the same cue every poll; re-applying it each time would restart the bar. */
    const c = cue('Folded', 1_792_498_000_000, 237);
    const r = apply(c, { ...c });
    expect(r.events).toEqual([]);
    expect(r.track).toBe(c);
  });

  it('keeps a timing-free cue stable across polls', () => {
    // Icecast publishes a title and no timing; repeated reads must not look like changes.
    const c = cue('Wet Gravity', null, null, 'Failure');
    expect(apply(c, { ...c }).events).toEqual([]);
  });

  it('accepts timing arriving later for a song first seen without it', () => {
    const bare = cue('Wet Gravity', null, null, 'Failure');
    const timed = cue('Wet Gravity', 5_000, 180, 'Failure');
    const r = apply(bare, timed);
    expect(r.track?.startedAt).toBe(5_000);
    expect(r.events).toEqual([]);
  });
});

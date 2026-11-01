/**
 * Triton publishes a HEARTBEAT, not just a start.
 *
 * Measured on the live WLSFM feed while chasing a reported stuck/lagging progress bar: the cue on
 * the air is republished roughly every twelve seconds with the title, artist, programme and length
 * unchanged and only `cue_time_start` moved forward. "Take Me Home Tonight" (205.6s) carried 14
 * such stamps spanning 198.1s; "Fantasy" (225.7s) carried 13 spanning 150.1s.
 *
 * Reading only the newest entry therefore reports a song that has been playing for minutes as
 * having just begun. Compared against the oldest stamp of the run, the bar was a measured 102.1s
 * behind the broadcast on every sample of a ten-minute watch, and each poll that saw a newer
 * stamp knocked the position backwards. The oldest stamp of an unbroken run is the real start.
 *
 * This is the shell's Triton `read()` rule, exercised on the feed's real XML shape.
 */
import { describe, expect, it } from 'vitest';

interface Cue { title: string; artist: string; startedAt: number | null; duration: number | null }

/** The generated shell's Triton reader (music-player/scripts/make-shell.py). */
function readTriton(t: string): Cue | null {
  function prop(block: string, n: string): string {
    const m2 = String(block).match(new RegExp('name="' + n + '"><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>'));
    return m2 && m2[1] ? m2[1].trim() : '';
  }
  const items = String(t).match(/<nowplaying-info[\s\S]*?<\/nowplaying-info>/g) || [];
  if (!items.length) return null;
  const head = items[0]!;
  const title = prop(head, 'cue_title');
  if (!title) return null;
  const artist = prop(head, 'track_artist_name');
  const prog = prop(head, 'program_id');
  const runs = Number(prop(head, 'cue_time_duration'));
  let began = Number(prop(head, 'cue_time_start'));
  for (let i = 1; i < items.length; i++) {
    const item = items[i]!;
    if (prop(item, 'cue_title') !== title
        || prop(item, 'track_artist_name') !== artist
        || prop(item, 'program_id') !== prog) break;
    const earlier = Number(prop(item, 'cue_time_start'));
    if (isFinite(earlier) && earlier > 0 && (!isFinite(began) || earlier < began)) began = earlier;
  }
  return { title, artist,
    startedAt: isFinite(began) && began > 0 ? began : null,
    duration: isFinite(runs) && runs > 0 ? Math.round(runs / 1000) : null };
}

/** One `<nowplaying-info>` element in the feed's own shape. */
const entry = (o: { title: string; artist: string; start: number; durMs: number; prog: string }) =>
  '<nowplaying-info mountName="WLSFM" type="track">'
  + `<property name="cue_time_duration"><![CDATA[${o.durMs}]]></property>`
  + `<property name="cue_time_start"><![CDATA[${o.start}]]></property>`
  + `<property name="cue_title"><![CDATA[${o.title}]]></property>`
  + `<property name="program_id"><![CDATA[${o.prog}]]></property>`
  + `<property name="track_artist_name"><![CDATA[${o.artist}]]></property>`
  + '</nowplaying-info>';
const list = (items: string[]) => `<?xml version="1.0" encoding="UTF-8"?><nowplaying-info-list>${items.join('')}</nowplaying-info-list>`;

/* The exact WLSFM reading, newest first, as captured live. */
const FANTASY = { title: 'Fantasy', artist: 'Mariah Carey', durMs: 225_723, prog: '436894' };
const EDDIE = { title: 'Take Me Home Tonight', artist: 'Eddie Money', durMs: 205_631, prog: '274053' };
const fantasyBeats = [1_792_512_407_126, 1_792_512_395_120, 1_792_512_382_942, 1_792_512_370_998,
  1_792_512_359_150, 1_792_512_346_984, 1_792_512_334_980, 1_792_512_323_050, 1_792_512_311_090,
  1_792_512_298_930, 1_792_512_286_953, 1_792_512_269_006, 1_792_512_257_014];
const eddieBeats = [1_792_512_255_451, 1_792_512_243_430, 1_792_512_231_361, 1_792_512_213_290];

describe('the cue on the air, republished every twelve seconds', () => {
  const live = list([
    ...fantasyBeats.map((start) => entry({ ...FANTASY, start })),
    ...eddieBeats.map((start) => entry({ ...EDDIE, start })),
  ]);

  it('reports the oldest stamp of the run, not the newest heartbeat', () => {
    const cue = readTriton(live);
    expect(cue?.title).toBe('Fantasy');
    expect(cue?.duration).toBe(226);
    expect(cue?.startedAt).toBe(1_792_512_257_014);
  });

  it('is 150 seconds of position that reading one entry would have thrown away', () => {
    const newestOnly = list([entry({ ...FANTASY, start: fantasyBeats[0]! })]);
    const lost = (readTriton(live)!.startedAt! - readTriton(newestOnly)!.startedAt!) / 1000;
    expect(lost).toBeCloseTo(-150.1, 1);
  });

  it('stops at the previous song rather than borrowing its start', () => {
    expect(readTriton(live)!.startedAt).toBeGreaterThan(eddieBeats[0]!);
  });

  it('reads the previous song the same way when it is the one on the air', () => {
    const earlier = list(eddieBeats.map((start) => entry({ ...EDDIE, start })));
    expect(readTriton(earlier)).toEqual({ title: EDDIE.title, artist: EDDIE.artist,
      startedAt: 1_792_512_213_290, duration: 206 });
  });
});

describe('what must not be merged into one cue', () => {
  it('does not join a later replay of the same song to its earlier airing', () => {
    /* A real repeat is hours apart and must keep its own start: the station played it again, it
       did not play for four hours. */
    const replay = list([
      entry({ ...FANTASY, start: 1_792_512_407_126 }),
      entry({ ...EDDIE, start: 1_792_512_255_451 }),
      entry({ ...FANTASY, start: 1_792_498_000_000 }),
    ]);
    expect(readTriton(replay)!.startedAt).toBe(1_792_512_407_126);
  });

  it('does not join two songs that share a title under different programmes', () => {
    const shared = list([
      entry({ title: 'Crazy', artist: 'Gnarls Barkley', start: 2_000_000, durMs: 180_000, prog: '1' }),
      entry({ title: 'Crazy', artist: 'Gnarls Barkley', start: 1_000_000, durMs: 180_000, prog: '2' }),
    ]);
    expect(readTriton(shared)!.startedAt).toBe(2_000_000);
  });

  it('does not join the same title by a different artist', () => {
    const shared = list([
      entry({ title: 'Crazy', artist: 'Patsy Cline', start: 2_000_000, durMs: 170_000, prog: '1' }),
      entry({ title: 'Crazy', artist: 'Gnarls Barkley', start: 1_000_000, durMs: 180_000, prog: '1' }),
    ]);
    expect(readTriton(shared)!.startedAt).toBe(2_000_000);
  });
});

describe('what the feed may leave out', () => {
  it('claims no position when the cue carries no start', () => {
    const noStart = '<nowplaying-info type="track">'
      + '<property name="cue_title"><![CDATA[Only A Name]]></property>'
      + '<property name="track_artist_name"><![CDATA[Radio Test]]></property>'
      + '</nowplaying-info>';
    expect(readTriton(list([noStart]))).toEqual({ title: 'Only A Name', artist: 'Radio Test',
      startedAt: null, duration: null });
  });

  it('keeps a start with no length, so elapsed can still be shown', () => {
    const noLength = '<nowplaying-info type="track">'
      + '<property name="cue_time_start"><![CDATA[1792512257014]]></property>'
      + '<property name="cue_title"><![CDATA[Only A Start]]></property>'
      + '</nowplaying-info>';
    expect(readTriton(list([noLength]))).toEqual({ title: 'Only A Start', artist: '',
      startedAt: 1_792_512_257_014, duration: null });
  });

  it('is nothing at all for an empty list or an unnamed cue', () => {
    expect(readTriton(list([]))).toBeNull();
    expect(readTriton('')).toBeNull();
    expect(readTriton(list([entry({ ...FANTASY, title: '', start: 1 })]))).toBeNull();
  });

  it('reads a programme the station times like a song', () => {
    /* WMBI times its programmes this way: one stamp, a 1498s length, no heartbeat run. */
    const programme = list([entry({ title: 'Living Hope', artist: 'Philip Miller',
      start: 1_792_511_976_790, durMs: 1_498_000, prog: '9001' })]);
    expect(readTriton(programme)).toEqual({ title: 'Living Hope', artist: 'Philip Miller',
      startedAt: 1_792_511_976_790, duration: 1498 });
  });
});

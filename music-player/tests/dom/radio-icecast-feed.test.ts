/**
 * Reading what an Icecast server says it is playing.
 *
 * Unpaired, the station list named a song for 9 of 38 stations where the paired list named 31 --
 * and the gap was not something the PC had to supply. Icecast publishes the current title at
 * `<origin>/status-json.xsl` with CORS open, and 28 of the 112 Illinois stations in the directory
 * stream from an Icecast server, more than any other family. Measured directly from the page's
 * origin: `Herbie Hancock - Gentle Thoughts` on icecast.will.illinois.edu (mount WILL-HD2-48) and
 * `Failure - Wet Gravity` on wzrd.streamguys1.com, both answering Access-Control-Allow-Origin.
 *
 * Two things this must get right: pick the mount actually being listened to out of a server
 * carrying several, and report only what the server states -- its genre and bitrate are the
 * station's own words, while a cue time it never published may not be invented.
 */
import { describe, expect, it } from 'vitest';

interface Source {
  listenurl?: string;
  title?: string;
  yp_currently_playing?: string;
  artist?: string;
  genre?: string;
  bitrate?: number;
}

interface Track {
  title: string;
  artist: string;
  genre: string;
  bitrate: number | null;
  startedAt: number | null;
  duration: number | null;
}

/** The `read` of the Icecast entry in the origin shell's TRACK_FEEDS. */
function readIcecast(body: unknown, match: string[]): Track | null {
  const j = body as { icestats?: { source?: Source | Source[] } } | null;
  const src = j?.icestats?.source;
  if (!src) return null;
  const all = Array.isArray(src) ? src : [src];
  const mount = String(match[2] ?? '').toLowerCase();
  let pick: Source | null = null;
  for (const s of all) {
    const u = String(s.listenurl ?? '').replace(/\/$/, '').toLowerCase();
    if (mount && u.slice(-(mount.length + 1)) === `/${mount}`) {
      pick = s;
      break;
    }
  }
  if (!pick && all.length === 1) pick = all[0] ?? null;
  if (!pick) return null;
  const line = String(pick.title || pick.yp_currently_playing || '').trim();
  const at = line.indexOf(' - ');
  let title = at > 0 ? line.slice(at + 3) : line;
  let artist = at > 0 ? line.slice(0, at) : pick.artist || '';
  title = String(title).replace(/\s*-\s*/g, ' ').trim();
  artist = String(artist).trim();
  if (/^[\s-]*$/.test(title)) title = '';
  if (/^[\s-]*$/.test(artist)) artist = '';
  if (!title && artist) {
    title = artist;
    artist = '';
  }
  return title
    ? { title, artist, genre: pick.genre || '', bitrate: pick.bitrate || null, startedAt: null, duration: null }
    : null;
}

/** `[full, origin, mount]`, as the URL pattern produces. */
const m = (origin: string, mount: string): string[] => ['', origin, mount];

describe('a server carrying one station', () => {
  it('reads the title and splits the artist off the front', () => {
    // wzrd.streamguys1.com, read from the page's own origin.
    const t = readIcecast(
      { icestats: { source: { listenurl: 'https://wzrd.streamguys1.com/live', title: 'Failure - Wet Gravity', bitrate: 96, genre: 'World' } } },
      m('https://wzrd.streamguys1.com', 'live'),
    );
    expect(t).toEqual({ title: 'Wet Gravity', artist: 'Failure', genre: 'World', bitrate: 96, startedAt: null, duration: null });
  });

  it('takes the only source even when the mount does not match', () => {
    /* Servers disagree about what they put in listenurl; one source means no ambiguity. */
    const t = readIcecast({ icestats: { source: { listenurl: 'http://example.org/stream', title: 'A - B' } } }, m('https://example.org', 'live'));
    expect(t?.title).toBe('B');
  });
});

describe('a server carrying several stations', () => {
  const body = {
    icestats: {
      source: [
        { listenurl: 'http://icecast.will.illinois.edu/WILL-Classical', title: '', bitrate: 80 },
        { listenurl: 'http://icecast.will.illinois.edu/WILL-HD2-48', title: 'Herbie Hancock - Gentle Thoughts', bitrate: 56, genre: 'Illinois Soul' },
        { listenurl: 'http://icecast.will.illinois.edu/WILL-IRR', title: '', bitrate: 48 },
      ],
    },
  };

  it('picks the mount being listened to', () => {
    // The exact shelf reading: three mounts, one playing.
    const t = readIcecast(body, m('https://icecast.will.illinois.edu', 'WILL-HD2-48'));
    expect(t?.title).toBe('Gentle Thoughts');
    expect(t?.artist).toBe('Herbie Hancock');
  });

  it('reports the station\'s own genre and bitrate', () => {
    const t = readIcecast(body, m('https://icecast.will.illinois.edu', 'WILL-HD2-48'));
    expect(t?.genre).toBe('Illinois Soul');
    expect(t?.bitrate).toBe(56);
  });

  it('claims nothing for a mount that is silent', () => {
    /* Naming the neighbouring mount's song would be worse than naming none. */
    expect(readIcecast(body, m('https://icecast.will.illinois.edu', 'WILL-Classical'))).toBeNull();
  });

  it('claims nothing for a mount this server does not carry', () => {
    expect(readIcecast(body, m('https://icecast.will.illinois.edu', 'not-here'))).toBeNull();
  });

  it('is case-insensitive about the mount', () => {
    expect(readIcecast(body, m('https://icecast.will.illinois.edu', 'will-hd2-48'))?.title).toBe('Gentle Thoughts');
  });
});

describe('stations that fill the template loosely', () => {
  /* CRIS Radio publishes 'Peter Katt -  -  ' on chicagolighthouse.streamguys1.com: an artist with
     the title left blank. Split naively, the song column showed a lone dash. */
  it('says the artist when the title is blank', () => {
    const t = readIcecast({ icestats: { source: { listenurl: 'http://chicagolighthouse.streamguys1.com/Live', title: 'Peter Katt -  -  ' } } }, m('https://chicagolighthouse.streamguys1.com', 'Live'));
    expect(t).toMatchObject({ title: 'Peter Katt', artist: '' });
  });

  it('never leaves a dash standing in for a song', () => {
    /* Either a real name, or nothing at all -- but never a row whose song is punctuation. */
    for (const title of ['Peter Katt -  -  ', ' - - ', 'A -  - ', '-']) {
      const t = readIcecast({ icestats: { source: { listenurl: 'http://x/live', title } } }, m('http://x', 'live'));
      if (t) expect(t.title).not.toMatch(/^[\s-]*$/);
    }
  });

  it('says nothing at all for a title that is only punctuation', () => {
    expect(readIcecast({ icestats: { source: { listenurl: 'http://x/live', title: ' - - ' } } }, m('http://x', 'live'))).toBeNull();
  });

  it('still splits a well-formed line', () => {
    const t = readIcecast({ icestats: { source: { listenurl: 'http://x/live', title: 'Failure - Wet Gravity' } } }, m('http://x', 'live'));
    expect(t).toMatchObject({ title: 'Wet Gravity', artist: 'Failure' });
  });
});

describe('what it refuses to invent', () => {
  it('publishes no cue timing, because Icecast states none', () => {
    /* No start and no length means the bar reports no position -- the rule the radio bar already
       follows. A title is not a licence to guess where in it the broadcast is. */
    const t = readIcecast({ icestats: { source: { listenurl: 'http://x/live', title: 'A - B', bitrate: 128 } } }, m('http://x', 'live'));
    expect(t?.startedAt).toBeNull();
    expect(t?.duration).toBeNull();
  });

  it('leaves the artist empty rather than splitting a title with no separator', () => {
    const t = readIcecast({ icestats: { source: { listenurl: 'http://x/live', title: 'Just A Title' } } }, m('http://x', 'live'));
    expect(t).toMatchObject({ title: 'Just A Title', artist: '' });
  });

  it('falls back to yp_currently_playing when title is absent', () => {
    const t = readIcecast({ icestats: { source: { listenurl: 'http://x/live', yp_currently_playing: 'C - D' } } }, m('http://x', 'live'));
    expect(t?.title).toBe('D');
  });

  it('says nothing for a response that is not Icecast', () => {
    // A non-Icecast server answering the probe path: no claim, not an error.
    expect(readIcecast({ hello: 'world' }, m('http://x', 'live'))).toBeNull();
    expect(readIcecast(null, m('http://x', 'live'))).toBeNull();
  });

  it('says nothing when the server lists no sources', () => {
    expect(readIcecast({ icestats: {} }, m('http://x', 'live'))).toBeNull();
  });
});

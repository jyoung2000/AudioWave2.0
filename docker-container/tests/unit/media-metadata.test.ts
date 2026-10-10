/**
 * Reading a link without a key: what yt-dlp and spotDL say about it, mapped to tags.
 *
 * The fixtures are real answers, recorded on 2026-10-04 from public links and trimmed to the fields
 * the hub reads (tests/fixtures/media-metadata): Blender's "Big Buck Bunny" (CC-BY 3.0) on YouTube,
 * Forss's "Flickermood" and the "Soulhack" set on SoundCloud, a Blender Conference playlist, and
 * Spotify's data for one track and one album (metadata only — nothing was downloaded).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromSpotdl, fromYtDlp, isCollectionUrl, mergeTags, normaliseDate, titleFromUrl, videoTitle, type ProbedPlaylist, type ProbedTrack } from '../../src/media/media-metadata.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'media-metadata', name), 'utf8'));

describe('yt-dlp answers', () => {
  it('a YouTube video: the title split from the channel, its upload date, length, thumbnail and licence', () => {
    const probe = fromYtDlp(fixture('youtube-big-buck-bunny.json'), 'https://youtu.be/aqz-KE-bpKQ') as ProbedTrack;
    expect(probe.kind).toBe('track');
    expect(probe.url).toBe('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
    expect(probe.tags).toMatchObject({
      // "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film" on Blender's channel is a
      // film called Big Buck Bunny by Blender — not a song called "Official Blender Foundation Short Film".
      title: 'Big Buck Bunny', // and the shared title rules drop "60fps 4K" as video noise
      artist: 'Blender',
      date: '2014-11-10',
      durationMs: 635_000,
      artworkUrl: 'https://i.ytimg.com/vi_webp/aqz-KE-bpKQ/maxresdefault.webp',
      license: 'Creative Commons Attribution license (reuse allowed)',
      // YouTube's categories are not genres.
      genre: null,
    });
  });

  it('a SoundCloud track: the artist, genre and release date SoundCloud publishes', () => {
    const probe = fromYtDlp(fixture('soundcloud-flickermood.json'), 'https://soundcloud.com/forss/flickermood') as ProbedTrack;
    expect(probe.tags).toMatchObject({ title: 'Flickermood', artist: 'Forss', genre: 'Electronic', date: '2003-06-02', durationMs: 213_886, artworkUrl: expect.stringMatching(/^https:\/\/i1\.sndcdn\.com\//) });
  });

  it('a SoundCloud set: every entry, the set’s title and owner, and how many it holds', () => {
    const probe = fromYtDlp(fixture('soundcloud-set-soulhack.json'), 'https://soundcloud.com/forss/sets/soulhack') as ProbedPlaylist;
    expect(probe.kind).toBe('playlist');
    expect(probe).toMatchObject({ title: 'Soulhack', owner: 'Forss', listed: 11 });
    expect(probe.entries).toHaveLength(11);
    expect(probe.entries[0]).toEqual({ url: 'https://soundcloud.com/forss/city-ports', tags: null, unavailable: null });
  });

  it('a set’s positions described in full (`--playlist-items`): each entry is its page, never the signed stream address', () => {
    // Trimmed from yt-dlp 2026.08.19's real answer for two Soulhack positions (2026-10-10): a full
    // entry's `url` is the HLS stream it would play, signed and expiring; the signature is cut here.
    const stream = 'https://playback.media-streaming.soundcloud.cloud/LU6T6NMmvb6f/aac_160k/fdc9f69c/playlist.m3u8?expires=1791621810&Policy=REDACTED&Signature=REDACTED&Key-Pair-Id=REDACTED';
    const probe = fromYtDlp(
      {
        _type: 'playlist',
        id: '5181',
        title: 'Soulhack',
        uploader: 'Forss',
        webpage_url: 'https://soundcloud.com/forss/sets/soulhack',
        entries: [
          { id: '296', title: 'Atomised', uploader: 'Forss', duration: 423.08, url: stream, webpage_url: 'https://soundcloud.com/forss/atomised', thumbnail: 'https://i1.sndcdn.com/artworks-000067273344-qyp37r-original.jpg', upload_date: '20030602', extractor_key: 'Soundcloud' },
          { id: '297', title: 'Characteristics', uploader: 'Forss', duration: 399.2, url: stream.replace('fdc9f69c', 'aa11bb22'), webpage_url: 'https://soundcloud.com/forss/characteristics', extractor_key: 'Soundcloud' },
        ],
      },
      'https://soundcloud.com/forss/sets/soulhack',
    ) as ProbedPlaylist;
    expect(probe.entries.map((e) => e.url)).toEqual(['https://soundcloud.com/forss/atomised', 'https://soundcloud.com/forss/characteristics']);
    expect(JSON.stringify(probe)).not.toMatch(/Signature|playback\.media-streaming/);
    expect(probe.entries[0]!.tags).toMatchObject({ title: 'Atomised', artist: 'Forss', durationMs: 423_080, date: '2003-06-02' });
  });

  it('a YouTube playlist, flat: each entry with the title and length the listing gives', () => {
    const probe = fromYtDlp(fixture('youtube-playlist-flat.json'), 'https://www.youtube.com/playlist?list=PLa1F2ddGya_-Ymw4YlOjqrdQxiRMJql5x') as ProbedPlaylist;
    expect(probe).toMatchObject({ kind: 'playlist', title: 'Blender Conference 2024', owner: 'Blender', listed: 87 });
    expect(probe.entries).toHaveLength(4);
    expect(probe.entries[0]!.url).toBe('https://www.youtube.com/watch?v=VZ5022VaMmA');
    expect(probe.entries[0]!.tags).toMatchObject({ durationMs: 1_792_000, artist: 'Blender' });
  });

  it('a channel’s list of playlists: entries that are lists themselves are marked, not downloaded', () => {
    const probe = fromYtDlp(fixture('youtube-channel-playlists-flat.json'), 'https://www.youtube.com/@BlenderOfficial/playlists') as ProbedPlaylist;
    expect(probe.entries.every((e) => e.unavailable === 'It is a list of its own')).toBe(true);
  });

  it('anything else is not an answer', () => {
    expect(fromYtDlp(null, 'https://youtu.be/x')).toBeNull();
    expect(fromYtDlp({ _type: 'video' }, 'https://youtu.be/x')).toBeNull();
    expect(fromYtDlp([], 'https://youtu.be/x')).toBeNull();
  });

  it('drops what does not look like what it claims: an http thumbnail, a malformed date, an overlong title', () => {
    const probe = fromYtDlp({ title: 'x'.repeat(400), thumbnail: 'http://insecure.example/a.jpg', upload_date: '2014-1-1', channel: 'C' }, 'https://youtu.be/x') as ProbedTrack;
    expect(probe.tags.title).toHaveLength(300);
    expect(probe.tags.artworkUrl).toBeNull();
    expect(probe.tags.date).toBeNull();
  });
});

describe('spotDL answers', () => {
  it('a track: name, artists, album, date, cover, track and disc number', () => {
    const probe = fromSpotdl(fixture('spotdl-track.json'), 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8') as ProbedTrack;
    expect(probe.kind).toBe('track');
    expect(probe.tags).toMatchObject({ title: 'Never Gonna Give You Up', artist: 'Rick Astley', album: 'Whenever You Need Somebody', albumArtist: 'Rick Astley', date: '1987-11-16', trackNumber: 1, discNumber: 1, durationMs: 213_000, artworkUrl: expect.stringMatching(/^https:\/\/i\.scdn\.co\//), featured: [] });
  });

  it('an album: every song, in track order, with its own tags', () => {
    const probe = fromSpotdl(fixture('spotdl-album.json'), 'https://open.spotify.com/album/6eUW0wxWtzkFdaEFsTJto6') as ProbedPlaylist;
    expect(probe).toMatchObject({ kind: 'playlist', title: 'Whenever You Need Somebody', owner: 'Rick Astley', listed: 10 });
    expect(probe.entries.map((e) => e.tags?.trackNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(probe.entries[0]!.url).toBe('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8');
  });

  it('a playlist: its songs in list order, but neither its first song’s artist as its owner nor that song’s cover as its picture', () => {
    // spotDL 4.5.2's save file for Spotify's own "Today's Top Hits" (2026-10-10, trimmed): it names the
    // list and its length on every song, but not who made the list or its picture.
    const song = (n: number, artist: string): Record<string, unknown> => ({ name: `Song ${n}`, artists: [artist], artist, album_name: `Album ${n}`, album_artist: artist, duration: 200, url: `https://open.spotify.com/track/${String(n).padStart(22, 'A')}`, cover_url: `https://i.scdn.co/image/${n}`, isrc: '', list_name: 'Today’s Top Hits', list_url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', list_position: n, list_length: 50 });
    const probe = fromSpotdl([song(2, 'ADÉLA'), song(1, 'Ashe')], 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M') as ProbedPlaylist;
    expect(probe).toMatchObject({ kind: 'playlist', title: 'Today’s Top Hits', owner: null, artworkUrl: null, listed: 50 });
    expect(probe.entries.map((e) => e.tags?.artist)).toEqual(['Ashe', 'ADÉLA']);
    // An empty ISRC (Spotify no longer gives spotDL one) is no ISRC.
    expect(probe.entries[0]!.tags?.isrc).toBeNull();
  });

  it('a second artist is a featured one', () => {
    const probe = fromSpotdl([{ name: 'Song (feat. C)', artists: ['A', 'B'], url: 'https://open.spotify.com/track/x' }], 'https://open.spotify.com/track/x') as ProbedTrack;
    expect(probe.tags).toMatchObject({ title: 'Song', artist: 'A', featured: ['B', 'C'] });
  });
});

describe('titles, dates and links', () => {
  it('reads "Artist - Song (feat. X) [Official Video]" and a Topic channel', () => {
    expect(videoTitle('Daft Punk - Get Lucky (feat. Pharrell Williams) [Official Video]', 'Daft Punk')).toEqual({ title: 'Get Lucky', artist: 'Daft Punk', featured: ['Pharrell Williams'] });
    expect(videoTitle('Get Lucky', 'Daft Punk - Topic')).toEqual({ title: 'Get Lucky', artist: 'Daft Punk', featured: [] });
    expect(videoTitle('Flickermood', 'Forss')).toEqual({ title: 'Flickermood', artist: 'Forss', featured: [] });
  });

  it('normalises the date shapes the tools write', () => {
    expect(normaliseDate('20141110')).toBe('2014-11-10');
    expect(normaliseDate('1987-11-16')).toBe('1987-11-16');
    expect(normaliseDate(2003)).toBe('2003');
    expect(normaliseDate('Nov 2014')).toBeNull();
  });

  it('knows a list link by its shape', () => {
    expect(isCollectionUrl('https://www.youtube.com/playlist?list=PL1')).toBe(true);
    expect(isCollectionUrl('https://www.youtube.com/watch?v=x&list=PL1')).toBe(false);
    expect(isCollectionUrl('https://soundcloud.com/forss/sets/soulhack')).toBe(true);
    expect(isCollectionUrl('https://soundcloud.com/forss/flickermood')).toBe(false);
    expect(isCollectionUrl('https://open.spotify.com/album/6eUW0wxWtzkFdaEFsTJto6')).toBe(true);
    expect(isCollectionUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe(true);
    expect(isCollectionUrl('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8')).toBe(false);
    expect(isCollectionUrl('not a url')).toBe(false);
  });

  it('what was known stays; what the tool reported fills the gaps', () => {
    const known = { title: 'Song', artist: null, featured: [], album: 'Album', albumArtist: null, date: null, genre: null, trackNumber: 3, discNumber: null, durationMs: null, artworkUrl: null, license: null };
    const reported = { ...known, title: 'Song (Official Video)', artist: 'Artist', album: null, date: '2020-01-02', trackNumber: null };
    expect(mergeTags(known, reported)).toMatchObject({ title: 'Song', artist: 'Artist', album: 'Album', date: '2020-01-02', trackNumber: 3 });
    expect(mergeTags(null, reported)).toBe(reported);
  });

  it('names an entry from its link before anything has run', () => {
    expect(titleFromUrl('https://soundcloud.com/forss/city-ports')).toBe('City Ports');
    expect(titleFromUrl('https://www.youtube.com/watch?v=VZ5022VaMmA')).toBe('VZ5022VaMmA');
  });
});

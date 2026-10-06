import { describe, expect, it } from 'vitest';
import type { CatalogTrack } from '@now-playing/contracts';
import { CatalogMerger, matchArtist, matchTitle, mergeTrack, normaliseIsrc, parseCatalogQuery, parseMusicLink, sameRecording, toolSearchArgs } from '@now-playing/domain/catalog';

const track = (patch: Partial<CatalogTrack> & Pick<CatalogTrack, 'id' | 'title' | 'artist'>): CatalogTrack => ({
  artists: [],
  album: null,
  albumArtist: null,
  durationMs: null,
  isrc: null,
  artworkUrl: null,
  releaseDate: null,
  year: null,
  trackNumber: null,
  discNumber: null,
  bpm: null,
  explicit: null,
  genre: null,
  label: null,
  sources: [{ platform: 'deezer', id: '1', url: 'https://www.deezer.com/track/1', previewUrl: null, matchedBy: 'search' }],
  rank: 0,
  ...patch,
});

describe('reading a query', () => {
  it('takes an ISRC in any case, with or without hyphens', () => {
    expect(parseCatalogQuery({ q: 'usqx91300108' })).toMatchObject({ kind: 'isrc', isrc: 'USQX91300108' });
    expect(normaliseIsrc('US-QX9-13-00108')).toBe('USQX91300108');
    expect(normaliseIsrc('USQX9130010')).toBeNull();
    // A word that happens to be twelve letters is not an ISRC: the last seven must be digits.
    expect(parseCatalogQuery({ q: 'electronicaz' }).kind).toBe('text');
  });

  it('reads the advanced fields, keeping free text beside them', () => {
    expect(parseCatalogQuery({ track: 'Get Lucky', artist: 'Daft Punk' })).toMatchObject({ kind: 'advanced', track: 'Get Lucky', artist: 'Daft Punk', album: null, text: 'Get Lucky Daft Punk' });
    expect(parseCatalogQuery({ q: 'live', album: 'Alive 2007' })).toMatchObject({ kind: 'advanced', text: 'live Alive 2007' });
  });

  it('treats a music link as a link, never as words', () => {
    expect(parseCatalogQuery({ q: 'https://open.spotify.com/intl-de/track/2Foc5Q5nqNiosCNqttzHof?si=x' })).toMatchObject({ kind: 'url', url: 'https://open.spotify.com/track/2Foc5Q5nqNiosCNqttzHof' });
    expect(parseCatalogQuery({ q: 'songs like open.spotify.com' }).kind).toBe('text');
  });

  it('strips control characters from what was typed', () => {
    expect(parseCatalogQuery({ q: 'get\u0000 lucky\n' }).text).toBe('get lucky');
  });
});

describe('music links', () => {
  it.each([
    ['https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa', 'spotify', 'album', '4m2880jivSbbyEGAKfITCa'],
    ['spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', 'spotify', 'playlist', '37i9dQZF1DXcBWIGoYBM5M'],
    ['https://music.apple.com/us/album/get-lucky/617154241?i=617154366', 'apple-music', 'track', '617154366'],
    ['https://music.apple.com/us/album/random-access-memories/617154241', 'apple-music', 'album', '617154241'],
    ['https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb', 'apple-music', 'playlist', 'pl.f4d106fed2bd41149aaacabb233eb5eb'],
    ['https://itunes.apple.com/us/album/random-access-memories/id617154241', 'apple-music', 'album', '617154241'],
    ['https://www.deezer.com/fr/track/67238735', 'deezer', 'track', '67238735'],
    ['https://www.deezer.com/playlist/908622995', 'deezer', 'playlist', '908622995'],
    ['https://tidal.com/browse/track/20115564', 'tidal', 'track', '20115564'],
    ['https://listen.tidal.com/album/20115557', 'tidal', 'album', '20115557'],
    ['https://www.qobuz.com/us-en/album/random-access-memories-daft-punk/0886443927087', 'qobuz', 'album', '0886443927087'],
    ['https://open.qobuz.com/track/9140031', 'qobuz', 'track', '9140031'],
    ['https://music.amazon.com/albums/B00C3B0HZC?trackAsin=B00C3B0IGM', 'amazon-music', 'track', 'B00C3B0IGM'],
    ['https://music.amazon.com/albums/B00C3B0HZC', 'amazon-music', 'album', 'B00C3B0HZC'],
    ['https://music.youtube.com/watch?v=4D7u5KF7SP8&list=RDAMVM4D7u5KF7SP8', 'youtube-music', 'track', '4D7u5KF7SP8'],
    ['https://music.youtube.com/browse/MPREb_abc123', 'youtube-music', 'album', 'MPREb_abc123'],
    ['https://youtu.be/5NV6Rdv1a3I', 'youtube', 'track', '5NV6Rdv1a3I'],
    ['https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', 'youtube', 'playlist', 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'],
    ['https://soundcloud.com/forss/city-ports?in=x', 'soundcloud', 'track', 'forss/city-ports'],
    ['https://soundcloud.com/forss/sets/soulhack', 'soundcloud', 'playlist', 'forss/sets/soulhack'],
    ['https://on.soundcloud.com/AbCdEf123', 'soundcloud', 'unknown', 'AbCdEf123'],
    ['https://someartist.bandcamp.com/album/a-record', 'bandcamp', 'album', 'someartist.bandcamp.com/album/a-record'],
  ])('%s', (url, platform, kind, id) => {
    expect(parseMusicLink(url)).toMatchObject({ platform, kind, id });
  });

  it('ignores credentials, other schemes and look-alike hosts', () => {
    expect(parseMusicLink('https://user:pw@open.spotify.com/track/abc')).toBeNull();
    expect(parseMusicLink('javascript:alert(1)')).toBeNull();
    expect(parseMusicLink('https://open.spotify.com.evil.example/track/abc')).toBeNull();
  });
});

describe('one song across services (UX-CAT-002)', () => {
  it('strips the noise before matching titles and artists', () => {
    expect(matchTitle('Get Lucky (feat. Pharrell Williams and Nile Rodgers)')).toBe('get lucky');
    expect(matchTitle('Get Lucky (Official Audio)')).toBe('get lucky');
    expect(matchTitle('Heroes - 2017 Remaster')).toBe('heroes');
    expect(matchTitle('Heroes (Remastered 2017)')).toBe('heroes');
    expect(matchArtist('Daft Punk, Pharrell Williams & Nile Rodgers')).toBe('daft punk');
    expect(matchArtist('The Beatles')).toBe('beatles');
    expect(matchArtist('Daft Punk - Topic')).toBe('daft punk');
  });

  it('is one recording by ISRC, whatever the titles say', () => {
    expect(sameRecording(track({ id: 'a', title: 'A', artist: 'X', isrc: 'USQX91300108' }), track({ id: 'b', title: 'B', artist: 'Y', isrc: 'USQX91300108' }))).toBe(true);
    expect(sameRecording(track({ id: 'a', title: 'A', artist: 'X', isrc: 'USQX91300108', durationMs: 1000 }), track({ id: 'b', title: 'A', artist: 'X', isrc: 'USQX91300809', durationMs: 1000 }))).toBe(false);
  });

  it('is one recording by names when the durations are within three seconds, and not otherwise', () => {
    const a = track({ id: 'a', title: 'Get Lucky', artist: 'Daft Punk', durationMs: 369_000 });
    expect(sameRecording(a, track({ id: 'b', title: 'Get Lucky (Official Audio)', artist: 'Daft Punk feat. Pharrell Williams', durationMs: 367_000 }))).toBe(true);
    expect(sameRecording(a, track({ id: 'c', title: 'Get Lucky', artist: 'Daft Punk', durationMs: 248_000 }))).toBe(false);
    // No duration, no merge on names alone.
    expect(sameRecording(a, track({ id: 'd', title: 'Get Lucky', artist: 'Daft Punk' }))).toBe(false);
  });

  it('keeps every source and takes each field from the best one', () => {
    const youtube = track({ id: 'youtube:x', title: 'Get Lucky', artist: 'Daft Punk', durationMs: 369_000, artworkUrl: 'https://i.ytimg.com/vi/x/hqdefault.jpg', sources: [{ platform: 'youtube', id: 'x', url: 'https://www.youtube.com/watch?v=x', previewUrl: null, matchedBy: 'search' }] });
    const deezer = track({ id: 'deezer:1', title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)', artist: 'Daft Punk', durationMs: 367_000, isrc: 'USQX91300108', bpm: 116.1, album: 'Random Access Memories', artworkUrl: 'https://cdn-images.dzcdn.net/images/cover/x/1000x1000-000000-80-0-0.jpg', releaseDate: '2013-05-20', trackNumber: 8 });
    const merged = mergeTrack(youtube, deezer);
    expect(merged.id).toBe('youtube:x');
    expect(merged.title).toBe(deezer.title);
    expect(merged).toMatchObject({ isrc: 'USQX91300108', bpm: 116.1, album: 'Random Access Memories', trackNumber: 8, artworkUrl: deezer.artworkUrl, releaseDate: '2013-05-20' });
    expect(merged.sources.map((s) => s.platform)).toEqual(['youtube', 'deezer']);
  });

  it('upserts by the first id in a merger, so a chunk can replace a row it sent before', () => {
    const merger = new CatalogMerger(parseCatalogQuery({ q: 'get lucky' }));
    const first = merger.add({ tracks: [track({ id: 'deezer:1', title: 'Get Lucky', artist: 'Daft Punk', durationMs: 367_000, isrc: 'USQX91300108' })] });
    const second = merger.add({ tracks: [track({ id: 'apple-music:2', title: 'Get Lucky', artist: 'Daft Punk', durationMs: 369_629, sources: [{ platform: 'apple-music', id: '2', url: 'https://music.apple.com/us/song/2', previewUrl: 'https://audio-ssl.itunes.apple.com/x.m4a', matchedBy: 'search' }] })] });
    expect(first.tracks[0]!.id).toBe('deezer:1');
    expect(second.tracks).toHaveLength(1);
    expect(second.tracks[0]!.id).toBe('deezer:1');
    expect(second.tracks[0]!.sources.map((s) => s.platform)).toEqual(['deezer', 'apple-music']);
    expect(merger.snapshot().tracks).toHaveLength(1);
  });
});

describe('the yt-dlp search command line', () => {
  it('puts the search last, behind --, after --ignore-config, and never as a flag', () => {
    const args = toolSearchArgs('youtube', '--exec rm -rf /\u0007', 0, 10);
    expect(args[0]).toBe('--ignore-config');
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('ytsearch10:--exec rm -rf /');
    expect(args).toContain('--flat-playlist');
  });

  it('pages with --playlist-start/--playlist-end and caps the depth', () => {
    expect(toolSearchArgs('soundcloud', 'x', 20, 10)).toEqual(expect.arrayContaining(['--playlist-start', '21', '--playlist-end', '30', 'scsearch30:x']));
    expect(toolSearchArgs('youtube', 'x', 95, 50).at(-1)).toBe('ytsearch100:x');
  });
});

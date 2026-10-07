import { describe, expect, it } from 'vitest';
import type { CatalogSearchChunk, CatalogSourceStatus, CatalogTrack } from '@now-playing/contracts';
import { appendTracks, byRank, collapseFields, sectionPages, collectionLine, coverArt, EMPTY_RESULTS, embeddedText, foldCatalogChunk, formatDuration, parseLrc, playsFromText, previewOf, queryKind, retryText, savedCollectionOf, sourceDot, sourceStateText, statusSummary } from '@now-playing/domain/catalog';

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

const status = (provider: CatalogSourceStatus['provider'], state: CatalogSourceStatus['state'], patch: Partial<CatalogSourceStatus> = {}): CatalogSourceStatus => ({ provider, state, count: 0, latencyMs: null, error: null, retryAt: null, ...patch });
const query = { kind: 'text' as const, text: 'harbour', track: null, artist: null, album: null, isrc: null, url: null };
const results = (seq: number, tracks: CatalogTrack[], st: CatalogSourceStatus[]): CatalogSearchChunk => ({ type: 'results', seq, provider: 'itunes', query, tracks, artists: [], albums: [], status: st });

describe('the live feed (UX-SEARCH-002)', () => {
  it('upserts rows by id: a later chunk replaces a row in place, a new one is added after', () => {
    let state = foldCatalogChunk(EMPTY_RESULTS, results(0, [], [status('itunes', 'pending'), status('deezer', 'pending')]));
    expect(state.status.map((s) => s.state)).toEqual(['pending', 'pending']);
    state = foldCatalogChunk(state, results(1, [track({ id: 'a', title: 'Harbour', artist: 'X', rank: 5 }), track({ id: 'b', title: 'Wall', artist: 'X', rank: 9 })], [status('itunes', 'ok', { count: 2 }), status('deezer', 'pending')]));
    state = foldCatalogChunk(state, results(2, [track({ id: 'a', title: 'Harbour (merged)', artist: 'X', rank: 5 }), track({ id: 'c', title: 'Fog', artist: 'Y', rank: 5 })], [status('itunes', 'ok', { count: 2 }), status('deezer', 'ok', { count: 2 })]));
    expect(state.tracks.map((t) => t.title)).toEqual(['Harbour (merged)', 'Wall', 'Fog']);
    // By rank, then in the order they arrived.
    expect(byRank(state.tracks).map((t) => t.id)).toEqual(['b', 'a', 'c']);
    state = foldCatalogChunk(state, { type: 'done', seq: 3, query, status: [status('itunes', 'ok'), status('deezer', 'ok')], page: { tracks: { offset: 0, limit: 25, hasMore: true }, artists: null, albums: null }, totals: { tracks: 3, artists: 0, albums: 0 }, resolve: null, linkedOnly: [] });
    expect(state.done?.page.tracks?.hasMore).toBe(true);
    expect(state.tracks).toHaveLength(3);
  });

  it('adds a further page without the songs already shown, by id and by recording', () => {
    const shown = [track({ id: 'deezer:1', title: 'Get Lucky', artist: 'Daft Punk', durationMs: 248_000 })];
    const page = [track({ id: 'youtube:x', title: 'Get Lucky (Official Audio)', artist: 'Daft Punk', durationMs: 249_000 }), track({ id: 'deezer:1', title: 'Get Lucky', artist: 'Daft Punk' }), track({ id: 'deezer:2', title: 'Instant Crush', artist: 'Daft Punk' })];
    expect(appendTracks(shown, page).map((t) => t.id)).toEqual(['deezer:1', 'deezer:2']);
  });
});

describe('pages of a section (UX-SEARCH-007)', () => {
  it('counts the pages loaded, says when there are more, and asks for the next offset only at the end', () => {
    expect(sectionPages(25, 10, 0, true)).toMatchObject({ page: 0, known: 3, canPrev: false, canNext: true, fetchForNext: false, label: 'Page 1 of 3 or more' });
    expect(sectionPages(25, 10, 2, true)).toMatchObject({ page: 2, canPrev: true, canNext: true, fetchForNext: true });
    expect(sectionPages(25, 10, 2, false)).toMatchObject({ canNext: false, fetchForNext: false, label: 'Page 3 of 3' });
    expect(sectionPages(0, 10, 4, false)).toMatchObject({ page: 0, known: 1, label: 'Page 1 of 1' });
  });
});

describe('a service in words (UX-SEARCH-002, UX-CAT-001)', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  it('says each state, with when a resting service is back', () => {
    expect(sourceStateText(status('itunes', 'pending'), now)).toBe('asking…');
    expect(sourceStateText(status('itunes', 'ok', { count: 1 }), now)).toBe('1 found');
    expect(sourceStateText(status('deezer', 'empty'), now)).toBe('nothing found');
    expect(sourceStateText(status('soundcloud', 'failed', { error: 'yt-dlp is not on this hub yet.' }), now)).toBe('failed');
    expect(sourceStateText(status('youtube', 'timeout'), now)).toBe('took too long');
    expect(sourceStateText(status('itunes', 'cooling-down', { retryAt: '2026-10-06T12:03:00Z' }), now)).toBe('resting, back in 3 min');
    expect(sourceStateText(status('musicbrainz', 'skipped'), now)).toBe('not asked');
    expect(retryText('2026-10-06T12:00:30Z', now)).toBe('back in 30 s');
    expect(sourceDot('pending')).toBe('busy');
    expect(sourceDot('failed')).toBe('bad');
    expect(sourceDot('cooling-down')).toBe('warn');
  });

  it('sums the line up for a screen reader', () => {
    expect(statusSummary([status('itunes', 'ok'), status('deezer', 'pending')], false)).toBe('Searching: 1 of 2 services have answered.');
    expect(statusSummary([status('itunes', 'ok'), status('soundcloud', 'failed')], true, { tracks: 3, artists: 1, albums: 0 })).toBe('Done: 3 songs, 1 artist, 0 albums. SoundCloud did not answer.');
  });
});

describe('what a row says (UX-SEARCH-003)', () => {
  it('a Spotify song says it plays from YouTube Music via spotDL; a song that is elsewhere too does not', () => {
    expect(playsFromText([{ platform: 'spotify', id: 's', url: 'https://open.spotify.com/track/s', previewUrl: null, matchedBy: 'link' }])).toBe('Spotify · plays from YouTube Music via spotDL');
    expect(playsFromText([{ platform: 'spotify', id: 's', url: 'https://open.spotify.com/track/s', previewUrl: null, matchedBy: 'link' }, { platform: 'youtube-music', id: 'y', url: 'https://music.youtube.com/watch?v=y', previewUrl: null, matchedBy: 'spotdl' }])).toBe('Spotify · plays from YouTube Music via spotDL');
    expect(playsFromText([{ platform: 'spotify', id: 's', url: 'https://open.spotify.com/track/s', previewUrl: null, matchedBy: 'musicbrainz' }, { platform: 'youtube', id: 'y', url: 'https://www.youtube.com/watch?v=y', previewUrl: null, matchedBy: 'search' }])).toBeNull();
    expect(playsFromText([{ platform: 'deezer', id: '1', url: 'https://www.deezer.com/track/1', previewUrl: null, matchedBy: 'search' }])).toBeNull();
  });

  it('previews Apple Music first, then Deezer; times read as clocks', () => {
    expect(previewOf([{ platform: 'deezer', id: '1', url: 'https://www.deezer.com/track/1', previewUrl: 'https://cdnt-preview.dzcdn.net/x.mp3', matchedBy: 'search' }, { platform: 'apple-music', id: '2', url: 'https://music.apple.com/x', previewUrl: 'https://audio-ssl.itunes.apple.com/x.m4a', matchedBy: 'search' }])).toEqual({ url: 'https://audio-ssl.itunes.apple.com/x.m4a', platform: 'apple-music' });
    expect(previewOf([{ platform: 'youtube', id: 'y', url: 'https://www.youtube.com/watch?v=y', previewUrl: null, matchedBy: 'search' }])).toBeNull();
    expect(formatDuration(369_629)).toBe('6:10');
    expect(formatDuration(3_729_000)).toBe('1:02:09');
    expect(formatDuration(null)).toBe('');
    expect(embeddedText({ isrc: true, genre: true, label: false, year: true, lyrics: true })).toBe('ISRC, genre, year and lyrics');
  });

  it('folds the advanced fields back into the line when they are put away, and tells a link from words', () => {
    expect(collapseFields({ q: 'daft punk', track: 'Get Lucky', artist: '', album: ' RAM ' })).toEqual({ q: 'daft punk Get Lucky RAM', track: '', artist: '', album: '' });
    expect(queryKind('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe('url');
    expect(queryKind('USQX91300108')).toBe('isrc');
    expect(queryKind('harbour lights')).toBe('text');
  });
});

describe('collections (UX-SEARCH-004, UX-SEARCH-005)', () => {
  const page = { tracks: [], offset: 0, limit: 100, total: 42, hasMore: false, capped: false };
  const ref = { platform: 'spotify' as const, kind: 'playlist' as const, id: '37i9', url: 'https://open.spotify.com/playlist/37i9', title: 'Harbour Mix', owner: 'Ana' };
  it('draws four songs’ artwork as a 2×2 mosaic, else the list’s own cover', () => {
    expect(coverArt({ artworkUrl: 'https://i.scdn.co/own', covers: ['a', 'b', 'c', 'd'] })).toEqual({ kind: 'mosaic', covers: ['a', 'b', 'c', 'd'] });
    expect(coverArt({ artworkUrl: 'https://i.scdn.co/own', covers: ['a', 'b'] })).toEqual({ kind: 'single', url: 'https://i.scdn.co/own' });
    // An album whose songs all wear its cover is drawn with that cover.
    expect(coverArt({ artworkUrl: 'https://cdn-images.dzcdn.net/album', covers: ['x', 'x', 'x', 'x'] })).toEqual({ kind: 'single', url: 'https://cdn-images.dzcdn.net/album' });
    expect(coverArt({ artworkUrl: null, covers: [] })).toEqual({ kind: 'none' });
  });

  it('names the list’s kind, platform and length, and keeps what a star saves', () => {
    expect(collectionLine({ ref, page })).toBe('Playlist · Spotify · 42 songs');
    expect(savedCollectionOf({ ref, artworkUrl: null, covers: ['a', 'b', 'c', 'd'], releaseDate: null, page }, '2026-10-06T12:00:00.000Z')).toEqual({ ref, savedAt: '2026-10-06T12:00:00.000Z', artworkUrl: null, covers: ['a', 'b', 'c', 'd'], trackCount: 42 });
  });
});

describe('lyrics (UX-SEARCH-003)', () => {
  it('reads LRC into timed lines, in order', () => {
    expect(parseLrc('[ar:Daft Punk]\n[00:12.50] Like the legend of the phoenix\n[00:08.00][01:00.00] Hey\nplain')).toEqual([
      { at: 8000, text: 'Hey' },
      { at: 12_500, text: 'Like the legend of the phoenix' },
      { at: 60_000, text: 'Hey' },
    ]);
  });
});

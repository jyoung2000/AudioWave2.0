import { describe, expect, it, vi } from 'vitest';
import { CatalogSearchChunk, CatalogResolveResult, CatalogSearchAggregate } from '@now-playing/contracts';
import { CatalogEngine, CatalogHttpError, LinkReadError, Pacer, ProviderHealth, deezerPlaylist, deezerTrack, itunesTrack, musicbrainzTrack, parseOdesli, readCatalogStream, ndjsonLine, toolSearchTracks, type CatalogEngineOptions, type LinkReader, type ToolSearchRunner } from '@now-playing/domain/catalog';
import { STANDARD_ROUTES, fixture, fixtureFetch, type Route } from './catalog-fixtures.js';

const noSleep = async (): Promise<void> => undefined;
const ytRunner: ToolSearchRunner = async ({ platform }) => fixture(platform === 'youtube' ? 'ytdlp-ytsearch' : 'ytdlp-scsearch');

function engine(routes: Route[] = STANDARD_ROUTES, extra: Partial<CatalogEngineOptions> = {}) {
  const f = fixtureFetch(routes);
  const e = new CatalogEngine({ fetch: f.fetch, userAgent: 'AirwaveTest/1.0 (test)', sleep: noSleep, toolSearch: ytRunner, crossLinkTop: 0, ...extra });
  return { engine: e, calls: f.calls };
}

async function collect(gen: AsyncGenerator<CatalogSearchChunk>): Promise<CatalogSearchChunk[]> {
  const out: CatalogSearchChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe('provider answers, as catalog rows', () => {
  it('iTunes: 600 px artwork, the preview, the store link without tracking', () => {
    const row = (fixture('itunes-search-song') as { results: Record<string, unknown>[] }).results[0]!;
    const t = itunesTrack(row)!;
    expect(t).toMatchObject({ id: 'apple-music:617154366', title: 'Get Lucky', album: 'Random Access Memories', durationMs: 369629, trackNumber: 8, releaseDate: '2013-04-19', year: 2013, explicit: false, genre: 'Pop' });
    expect(t.artworkUrl).toMatch(/600x600bb\.jpg$/);
    expect(t.sources[0]).toMatchObject({ platform: 'apple-music', previewUrl: expect.stringMatching(/^https:\/\/audio-ssl\.itunes\.apple\.com\//) });
    expect(t.sources[0]!.url).not.toContain('uo=');
  });

  it('Deezer: ISRC, tempo, contributors and a preview', () => {
    const t = deezerTrack(fixture('deezer-isrc') as Record<string, unknown>)!;
    expect(t).toMatchObject({ id: 'deezer:67238735', isrc: 'USQX91300108', bpm: 116.1, durationMs: 367000, trackNumber: 8, discNumber: 1, releaseDate: '2013-05-20' });
    expect(t.sources[0]!.previewUrl).toMatch(/^https:\/\/cdnt-preview\.dzcdn\.net\//);
  });

  it('MusicBrainz: the credit line as written, the first release', () => {
    const rec = (fixture('musicbrainz-isrc') as { recordings: Record<string, unknown>[] }).recordings[1]!;
    const t = musicbrainzTrack(rec)!;
    expect(t.artist).toBe('Daft Punk feat. Pharrell Williams & Nile Rodgers');
    expect(t.sources[0]!.url).toMatch(/^https:\/\/musicbrainz\.org\/recording\//);
  });

  it('yt-dlp: a cleaned YouTube title, a Topic channel as YouTube Music, no channels or sets', () => {
    const yt = toolSearchTracks('youtube', fixture('ytdlp-ytsearch'));
    expect(yt).toHaveLength(2);
    expect(yt[0]).toMatchObject({ title: 'Get Lucky', artist: 'Daft Punk feat. Pharrell Williams & Nile Rodgers', durationMs: 369000 });
    expect(yt[0]!.sources[0]!.platform).toBe('youtube');
    expect(yt[1]!.sources[0]).toMatchObject({ platform: 'youtube-music', url: 'https://music.youtube.com/watch?v=4D7u5KF7SP8' });
    expect(yt[1]!.artworkUrl).toBe('https://i.ytimg.com/vi/4D7u5KF7SP8/hqdefault.jpg');
    const sc = toolSearchTracks('soundcloud', fixture('ytdlp-scsearch'));
    expect(sc.map((t) => [t.title, t.artist])).toEqual([
      ['Get Lucky (cover)', 'Example Artist'],
      ['Lucky Day', 'Another Artist'],
    ]);
  });
});

describe('the live search feed', () => {
  it('opens with every service’s state, sends a chunk per service, merges, and ends with done', async () => {
    const { engine: e } = engine();
    const chunks = await collect(e.search({ q: 'daft punk get lucky', limit: 3 }));
    for (const c of chunks) expect(CatalogSearchChunk.safeParse(c).success).toBe(true);
    expect(chunks[0]).toMatchObject({ type: 'results', provider: null, tracks: [] });
    expect(chunks[0]!.status.map((s) => s.state)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    const providers = chunks.filter((c) => c.type === 'results' && c.provider).map((c) => (c.type === 'results' ? c.provider : null));
    expect(new Set(providers)).toEqual(new Set(['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud']));
    const done = chunks.at(-1)!;
    expect(done.type).toBe('done');
    if (done.type !== 'done') return;
    expect(done.status.every((s) => s.state === 'ok')).toBe(true);
    expect(done.page.tracks).toEqual({ offset: 0, limit: 3, hasMore: false });
    expect(done.seq).toBe(chunks.length - 1);
  });

  it('folds into one aggregate where Deezer, Apple and YouTube’s copies of one song are one row', async () => {
    const { engine: e } = engine();
    const all = await e.searchAll({ q: 'daft punk get lucky', limit: 3 });
    expect(CatalogSearchAggregate.safeParse(all).success).toBe(true);
    const lucky = all.tracks.filter((t) => t.sources.some((s) => s.platform === 'youtube'));
    const merged = lucky.find((t) => t.sources.length > 1)!;
    expect(merged.sources.map((s) => s.platform)).toEqual(expect.arrayContaining(['youtube']));
    expect(merged.sources.length).toBeGreaterThan(1);
    // Every row says where it came from (UX-CAT-003): no row without a source.
    expect([...all.tracks, ...all.albums, ...all.artists].every((r) => r.sources.length > 0)).toBe(true);
    expect(all.artists[0]!.name).toBe('Daft Punk');
  });

  it('reports a failing service as failed, and rests it after a second failure (UX-CAT-001)', async () => {
    const failing: Route[] = [[/api\.deezer\.com/, { status: 500 }], ...STANDARD_ROUTES];
    const now = vi.fn(() => 1_000_000);
    const { engine: e } = engine(failing, { now });
    const first = await e.searchAll({ q: 'get lucky', sections: ['tracks'] });
    expect(first.status.find((s) => s.provider === 'deezer')).toMatchObject({ state: 'failed', error: 'api.deezer.com answered 500' });
    expect(first.tracks.length).toBeGreaterThan(0);
    await e.searchAll({ q: 'get lucky again', sections: ['tracks'] });
    const third = await e.searchAll({ q: 'and again', sections: ['tracks'] });
    const deezer = third.status.find((s) => s.provider === 'deezer')!;
    expect(deezer.state).toBe('cooling-down');
    expect(deezer.retryAt).toBe(new Date(1_000_000 + 30_000).toISOString());
  });

  it('says a slow service timed out, and still answers with the rest', async () => {
    const slow: ToolSearchRunner = () => new Promise(() => undefined);
    const { engine: e } = engine(STANDARD_ROUTES, { toolSearch: slow, timeouts: { tools: 30 } });
    const all = await e.searchAll({ q: 'get lucky', sections: ['tracks'] });
    expect(all.status.find((s) => s.provider === 'youtube')).toMatchObject({ state: 'timeout' });
    expect(all.tracks.length).toBeGreaterThan(0);
  });

  it('reports a server without yt-dlp honestly, and a switched-off service as skipped', async () => {
    const { engine: e } = engine(STANDARD_ROUTES, { toolSearch: undefined, enabled: () => ({ musicbrainz: false }) });
    const all = await e.searchAll({ q: 'get lucky' });
    expect(all.status.find((s) => s.provider === 'youtube')).toMatchObject({ state: 'skipped', error: expect.stringContaining('yt-dlp') });
    expect(all.status.find((s) => s.provider === 'musicbrainz')).toMatchObject({ state: 'skipped', error: 'Switched off in the catalog settings' });
  });

  it('looks an ISRC up where it can be looked up', async () => {
    const { engine: e, calls } = engine();
    const all = await e.searchAll({ q: 'usqx91300108' });
    expect(all.query.kind).toBe('isrc');
    expect(all.status.find((s) => s.provider === 'itunes')!.state).toBe('skipped');
    expect(all.status.find((s) => s.provider === 'youtube')!.state).toBe('skipped');
    expect(calls.some((u) => u.includes('/track/isrc:USQX91300108'))).toBe(true);
    const row = all.tracks.find((t) => t.isrc === 'USQX91300108')!;
    // Both MusicBrainz recordings that carry the ISRC are kept as sources of the one row.
    expect([...new Set(row.sources.map((s) => s.platform))].sort()).toEqual(['deezer', 'musicbrainz']);
  });

  it('does not search a pasted link: done names it for resolve', async () => {
    const { engine: e, calls } = engine();
    const chunks = await collect(e.search({ q: 'https://www.deezer.com/track/67238735' }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'done', resolve: 'https://www.deezer.com/track/67238735' });
    expect(calls).toHaveLength(0);
  });

  it('asks Deezer’s field syntax first, and plain words when the syntax finds nothing', async () => {
    const routes: Route[] = [[/api\.deezer\.com\/search\/track\?q=track%3A/, 'deezer-search-empty'], ...STANDARD_ROUTES];
    const { engine: e, calls } = engine(routes);
    const all = await e.searchAll({ track: 'get lucky', artist: 'daft punk', sections: ['tracks'], providers: ['deezer'] });
    expect(calls.filter((u) => u.includes('/search/track'))).toHaveLength(2);
    expect(all.tracks.length).toBeGreaterThan(0);
  });

  it('pages: offset and limit reach the services, and a full page says there may be more', async () => {
    const { engine: e, calls } = engine();
    const all = await e.searchAll({ q: 'get lucky', offset: 25, limit: 2, sections: ['tracks'], providers: ['deezer', 'itunes'] });
    expect(calls.some((u) => u.includes('index=25') && u.includes('limit=2'))).toBe(true);
    expect(calls.some((u) => u.includes('offset=25') && u.includes('limit=2'))).toBe(true);
    expect(all.page.tracks).toEqual({ offset: 25, limit: 2, hasMore: true });
    expect(all.page.artists).toBeNull();
  });

  it('lists public playlists from Deezer as a section of their own, keylessly (UX-CAT-005)', async () => {
    const { engine: e, calls } = engine();
    const chunks = await collect(e.search({ q: 'harbour', sections: ['playlists'], limit: 3 }));
    for (const c of chunks) expect(CatalogSearchChunk.safeParse(c).success).toBe(true);
    expect(calls.filter((u) => u.includes('api.deezer.com/search/playlist?q=harbour&index=0&limit=3'))).toHaveLength(1);
    // Only Deezer lists playlists: the others say they have nothing in the section asked for.
    const done = chunks.at(-1)!;
    if (done.type !== 'done') throw new Error('no done');
    expect(done.status.find((s) => s.provider === 'deezer')).toMatchObject({ state: 'ok', count: 3 });
    for (const id of ['itunes', 'musicbrainz', 'youtube', 'soundcloud'] as const) expect(done.status.find((s) => s.provider === id)).toMatchObject({ state: 'skipped', error: 'It has nothing in the sections asked for' });
    expect(done.page).toEqual({ tracks: null, artists: null, albums: null, playlists: { offset: 0, limit: 3, hasMore: true } });
    expect(done.totals.playlists).toBe(3);
    const rows = chunks.find((c) => c.type === 'results' && c.provider === 'deezer');
    if (rows?.type !== 'results') throw new Error('no deezer chunk');
    expect(rows.playlists[0]).toMatchObject({
      id: 'deezer:14632517341',
      title: 'Relaxing Classical Music',
      owner: 'Playlist Editor',
      trackCount: 101,
      pictureUrl: 'https://cdn-images.dzcdn.net/images/playlist/ca698c69567ce9f8d4fc19dab12867d3/1000x1000-000000-80-0-0.jpg',
      covers: [],
    });
    // Its link is what the apps resolve to open it like an album (NP-FIND-007).
    expect(rows.playlists[0]!.sources).toEqual([{ platform: 'deezer', id: '14632517341', url: 'https://www.deezer.com/playlist/14632517341', previewUrl: null, matchedBy: 'search' }]);
    expect(rows.playlists.map((p) => p.title)).toContain('Coin/Harbour/Bear Hands');
    // The aggregate carries them too, ranked; a private playlist is never a row.
    const all = await e.searchAll({ q: 'harbour', sections: ['playlists'], limit: 3 });
    expect(all.playlists.map((p) => p.id)).toHaveLength(3);
    expect(deezerPlaylist({ id: 7, title: 'Mine', public: false, nb_tracks: 2 })).toBeNull();
    expect(deezerPlaylist({ id: 8, title: 'Theirs', nb_tracks: 2, md5_image: 'ca698c69567ce9f8d4fc19dab12867d3' })).toMatchObject({ pictureUrl: expect.stringContaining('/images/playlist/ca698c69567ce9f8d4fc19dab12867d3/') });
  });

  it('a search of every section asks Deezer for playlists beside the rest, and the overview’s done counts them', async () => {
    const { engine: e } = engine();
    const all = await e.searchAll({ q: 'daft punk get lucky', limit: 3 });
    expect(all.playlists.length).toBe(3);
    expect(all.page.playlists).toEqual({ offset: 0, limit: 3, hasMore: true });
    expect([...all.tracks, ...all.albums, ...all.artists, ...all.playlists].every((r) => r.sources.length > 0)).toBe(true);
  });

  it('adds the best rows’ other homes (Spotify, Tidal…) from MusicBrainz before done', async () => {
    const { engine: e } = engine(STANDARD_ROUTES, { crossLinkTop: 1 });
    const chunks = await collect(e.search({ q: 'usqx91300108' }));
    const linkChunk = chunks.find((c) => c.type === 'results' && c.provider === null && c.tracks.length);
    expect(linkChunk).toBeDefined();
    if (linkChunk?.type !== 'results') return;
    const platforms = linkChunk.tracks[0]!.sources.map((s) => s.platform);
    expect(platforms).toEqual(expect.arrayContaining(['spotify', 'youtube-music', 'tidal', 'qobuz']));
    expect(linkChunk.tracks[0]!.sources.find((s) => s.platform === 'spotify')!.matchedBy).toBe('musicbrainz');
  });
});

describe('details', () => {
  it('a Deezer album: label, genre, UPC and its tracks in order, with a collection ref', async () => {
    const { engine: e } = engine([[/\/album\/6575789\/tracks/, 'deezer-album-tracks'], [/\/album\/6575789$/, 'deezer-album']]);
    const detail = await e.album('deezer:6575789', 0, 3);
    expect(detail.album).toMatchObject({ title: 'Random Access Memories', label: 'Columbia', genre: 'Dance', upc: '886443927087', releaseDate: '2013-05-17', trackCount: 13 });
    expect(detail.page.tracks.map((t) => t.trackNumber)).toEqual([1, 2, 3]);
    expect(detail.page.tracks[0]).toMatchObject({ album: 'Random Access Memories', label: 'Columbia', isrc: 'USQX91300101' });
    expect(detail.page).toMatchObject({ total: 13, hasMore: true, capped: false });
    expect(detail.collection).toEqual({ platform: 'deezer', kind: 'album', id: '6575789', url: 'https://www.deezer.com/album/6575789', title: 'Random Access Memories', owner: 'Daft Punk' });
  });

  it('a Deezer artist: picture, top tracks, albums', async () => {
    const { engine: e } = engine([[/\/artist\/27\/top/, 'deezer-artist-top'], [/\/artist\/27\/albums/, 'deezer-artist-albums'], [/\/artist\/27$/, 'deezer-artist']]);
    const detail = await e.artist('deezer:27', { albumsLimit: 2 });
    expect(detail.artist).toMatchObject({ name: 'Daft Punk', albumCount: 38 });
    expect(detail.artist.pictureUrl).toMatch(/1000x1000/);
    expect(detail.topTracks[0]!.title).toBe('One More Time');
    expect(detail.albums).toHaveLength(2);
    expect(detail.albumsPage.hasMore).toBe(true);
  });

  it('an Apple Music album, from the lookup API', async () => {
    const { engine: e } = engine([[/itunes\.apple\.com\/lookup\?.*id=617154241/, 'itunes-lookup-album']]);
    const detail = await e.album('apple-music:617154241');
    expect(detail.album.title).toBe('Random Access Memories');
    expect(detail.page.tracks.length).toBe(3);
    expect(detail.page.tracks.every((t) => t.sources[0]!.previewUrl)).toBe(true);
  });

  it('refuses an id with no platform, or a platform without details, in words', async () => {
    const { engine: e } = engine([]);
    await expect(e.album('6575789')).rejects.toMatchObject({ code: 'validation' });
    await expect(e.album('youtube:abc')).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('resolving a pasted link', () => {
  const spotifyReader: LinkReader = async (url, { match }) => {
    if (url.includes('/track/')) return { kind: 'track', url, track: { url, title: 'Never Gonna Give You Up', artist: 'Rick Astley', album: 'Whenever You Need Somebody', durationSec: 213, date: '1987-11-16', artworkUrl: 'https://i.scdn.co/image/ab67616d0000b27315ebbedaacef61af244262a8', trackNumber: 1, isrc: 'GBARL9300135', matchUrl: match ? 'https://music.youtube.com/watch?v=lYBUbBu4W08' : null } };
    throw new LinkReadError('HTTP Error for GET to https://api.spotify.com/v1/playlists/37i9dQZF1DXcBWIGoYBM5M with Params: {} returned 404 due to Resource not found.', 'failed');
  };

  it('a Spotify song through spotDL, with spotDL’s YouTube Music match as a second source', async () => {
    const reader = vi.fn(spotifyReader);
    const { engine: e } = engine([], { linkReader: reader });
    const r = await e.resolve('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8?si=abc');
    expect(CatalogResolveResult.safeParse(r).success).toBe(true);
    expect(reader).toHaveBeenCalledWith('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8', expect.objectContaining({ match: true }));
    expect(r).toMatchObject({ kind: 'track', platform: 'spotify' });
    expect(r.track!.isrc).toBe('GBARL9300135');
    expect(r.track!.sources).toEqual([
      { platform: 'spotify', id: '4PTG3Z6ehGkBFwjybzWkR8', url: 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8', previewUrl: null, matchedBy: 'link' },
      { platform: 'youtube-music', id: 'lYBUbBu4W08', url: 'https://music.youtube.com/watch?v=lYBUbBu4W08', previewUrl: null, matchedBy: 'spotdl' },
    ]);
  });

  it('a Spotify playlist Spotify will not list says so, with the reason', async () => {
    const { engine: e } = engine([], { linkReader: spotifyReader });
    const r = await e.resolve('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    expect(r.kind).toBe('unavailable');
    expect(r.reason).toMatch(/^Spotify would not list this playlist\. It is private, or one Spotify made itself/);
    expect(r.reason).toContain('Resource not found');
  });

  it('a Deezer playlist: header, own cover, four covers in order, a stable ref and a page of songs', async () => {
    const { engine: e } = engine([[/\/playlist\/908622995\/tracks/, 'deezer-playlist-tracks'], [/\/playlist\/908622995$/, 'deezer-playlist']]);
    const r = await e.resolve('https://www.deezer.com/en/playlist/908622995', 0, 3);
    expect(r.kind).toBe('playlist');
    const c = r.collection!;
    expect(c.ref).toEqual({ platform: 'deezer', kind: 'playlist', id: '908622995', url: 'https://www.deezer.com/playlist/908622995', title: 'En mode 60', owner: 'Pop Editor' });
    expect(c.artworkUrl).toMatch(/images\/playlist\//);
    expect(c.covers.length).toBeGreaterThan(0);
    expect(c.covers[0]).toBe(c.page.tracks[0]!.artworkUrl);
    expect(c.page).toMatchObject({ offset: 0, limit: 3, total: 50, hasMore: true, capped: false });
  });

  it('a SoundCloud set listed by address alone gets its first covers looked up, two at a time', async () => {
    const entries = ['a', 'b', 'c', 'd', 'e'].map((s) => ({ url: `https://soundcloud.com/forss/${s}`, title: null, artist: null, album: null, durationSec: null, date: null, artworkUrl: null, trackNumber: null }));
    let running = 0;
    let peak = 0;
    const reader: LinkReader = async (url) => {
      if (url.includes('/sets/')) return { kind: 'collection', url, title: 'Soulhack', owner: 'Forss', artworkUrl: null, date: '2003', entries, total: 5, capped: false };
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      const slug = url.split('/').pop()!;
      return { kind: 'track', url, track: { url, title: `Song ${slug}`, artist: 'Forss', album: null, durationSec: 200, date: null, artworkUrl: `https://i1.sndcdn.com/artworks-${slug}-t500x500.jpg`, trackNumber: null } };
    };
    const { engine: e } = engine([], { linkReader: reader });
    const r = await e.resolve('https://soundcloud.com/forss/sets/soulhack');
    expect(r.kind).toBe('playlist');
    expect(r.collection!.covers).toEqual(['a', 'b', 'c', 'd'].map((s) => `https://i1.sndcdn.com/artworks-${s}-t500x500.jpg`));
    expect(r.collection!.page.tracks[0]).toMatchObject({ title: 'Song a', artist: 'Forss' });
    expect(r.collection!.page.tracks[4]!.title).toBe('E');
    expect(peak).toBeLessThanOrEqual(2);
    expect(r.collection!.ref).toMatchObject({ platform: 'soundcloud', kind: 'playlist', id: 'forss/sets/soulhack', owner: 'Forss' });
  });

  it('an Apple Music playlist whose page changed and a Tidal link without a SongLink key say why they cannot be read', async () => {
    const { engine: e } = engine([[/music\.apple\.com\/us\/playlist/, { status: 200, body: '<html><script id="serialized-server-data" type="application/json">{"data":[]}</script></html>' }]]);
    expect(await e.resolve('https://music.apple.com/us/playlist/x/pl.abc')).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('no longer looks the way Airwave reads it') });
    expect(await e.resolve('https://tidal.com/browse/track/20115564')).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('SongLink') });
    expect(await e.resolve('https://example.com/song')).toMatchObject({ kind: 'unsupported', platform: null });
  });

  it('a Tidal link with a SongLink key resolves to the song and its other homes', async () => {
    const { engine: e, calls } = engine([[/api\.song\.link/, 'odesli-links']], { odesliKey: () => 'k' });
    const r = await e.resolve('https://tidal.com/browse/track/20115564');
    expect(r.kind).toBe('track');
    expect(r.track!.sources.map((s) => s.platform)).toEqual(expect.arrayContaining(['tidal', 'deezer', 'spotify', 'apple-music', 'youtube-music']));
    expect(calls[0]).toContain('key=k');
  });
});

describe('lyrics and enrichment', () => {
  it('LRCLIB: the exact match first, synced and plain, line breaks kept', async () => {
    const { engine: e } = engine([[/lrclib\.net\/api\/get/, 'lrclib-get']]);
    const l = await e.lyrics({ title: 'Get Lucky', artist: 'Daft Punk', album: 'Random Access Memories', durationSec: 367 });
    expect(l).toMatchObject({ found: true, id: 3606695, instrumental: false });
    expect(l.synced!.split('\n')).toHaveLength(3);
    expect(l.plain!.split('\n')[0]).toBe('First line of the song');
  });

  it('LRCLIB: falls back to search, nearest duration with synced text preferred', async () => {
    const { engine: e } = engine([
      [/lrclib\.net\/api\/get/, { status: 404, body: { code: 404 } }],
      [/lrclib\.net\/api\/search/, 'lrclib-search'],
    ]);
    const l = await e.lyrics({ title: 'Get Lucky', artist: 'Daft Punk', album: 'X', durationSec: 370 });
    expect(l.found).toBe(true);
    expect(l.durationSec).toBe(370);
  });

  it('MusicBrainz: genre, label, year and the recording’s links, by ISRC', async () => {
    const { engine: e } = engine();
    const en = await e.enrich({ isrc: 'USQX91300108' });
    expect(en).toMatchObject({ isrc: 'USQX91300108', genre: 'disco', label: 'Columbia', year: 2013 });
    expect(en.genres).toContain('dance');
    expect(en.sources.some((s) => s.platform === 'spotify' && s.matchedBy === 'musicbrainz')).toBe(true);
  });

  it('SongLink’s answer is read into sources; platforms the catalog does not know are left out', () => {
    const answer = parseOdesli(fixture('odesli-links'))!;
    expect(answer.title).toBe('Get Lucky (feat. Pharrell Williams and Nile Rodgers)');
    expect(answer.sources.map((s) => s.platform)).toEqual(['deezer', 'spotify', 'apple-music', 'tidal', 'youtube-music']);
  });
});

describe('the plumbing', () => {
  it('paces MusicBrainz to one call per interval', async () => {
    let t = 0;
    const waits: number[] = [];
    const pacer = new Pacer(1000, () => t, async (ms) => {
      waits.push(ms);
      t += ms;
    });
    await Promise.all([1, 2, 3].map(() => pacer.run(async () => t)));
    expect(waits).toEqual([1000, 1000]);
  });

  it('honours Retry-After at once, and backs off by doubling after repeated failures', () => {
    const t = 0;
    const h = new ProviderHealth(() => t);
    h.failure('deezer', new CatalogHttpError('slow down', 'rate-limited', 429, 7000));
    expect(h.coolingUntil('deezer')).toBe(7000);
    h.success('deezer');
    h.failure('deezer', new Error('x'));
    expect(h.coolingUntil('deezer')).toBeNull();
    h.failure('deezer', new Error('x'));
    expect(h.coolingUntil('deezer')).toBe(30_000);
    h.failure('deezer', new Error('x'));
    expect(h.coolingUntil('deezer')).toBe(60_000);
  });

  it('rests iTunes within Apple’s budget instead of being refused', async () => {
    const { engine: e } = engine();
    for (let i = 0; i < 7; i += 1) await e.searchAll({ q: `q${i}`, providers: ['itunes'] });
    const last = await e.searchAll({ q: 'one too many', providers: ['itunes'] });
    expect(last.status[0]).toMatchObject({ provider: 'itunes', state: 'cooling-down' });
    expect(last.status[0]!.retryAt).not.toBeNull();
  });

  it('writes and reads NDJSON a chunk at a time, across arbitrary byte boundaries', async () => {
    const { engine: e } = engine();
    const chunks = await collect(e.search({ q: 'get lucky', limit: 2 }));
    const bytes = new TextEncoder().encode(chunks.map(ndjsonLine).join('') + 'not json\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const back: unknown[] = [];
    for await (const c of readCatalogStream(stream)) back.push(c);
    expect(back).toHaveLength(chunks.length);
    expect((back.at(-1) as { type: string }).type).toBe('done');
  });
});

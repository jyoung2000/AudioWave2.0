/**
 * Every result carries its facts (UX-CAT-006): a search page's rows are filled in — bpm,
 * contributors, ISRC, explicit, the full date, the store's cover — from Deezer's `/track/{id}`,
 * `/track/isrc:` or one exact search, and a MusicBrainz-only row's cover from the Cover Art
 * Archive, in one last merge-only chunk before `done`, within a budget.
 *
 * Fixtures: `deezer-isrc.json` and `deezer-track.json` are Deezer's `/track/{id}` answers, recorded
 * 2026-10-06/07 and trimmed (no country list, no token, the preview's signature cut); the Cover Art
 * Archive answers `/release/{id}/front-500` with a 307 to archive.org when a front cover exists and
 * a 404 when none does (measured 2026-10-07), so those are answered inline.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogSearchChunk, CatalogTrack } from '@now-playing/contracts';
import { APPLE_GENRE_MAX_ASKS, CatalogEngine, HYDRATE_CONCURRENCY, creditLine, emptyResult, fillTrack, needsFacts, runPool, type CatalogEngineOptions, type CatalogProvider } from '@now-playing/domain/catalog';
import { STANDARD_ROUTES, fixtureFetch, type Route } from './catalog-fixtures.js';

const noSleep = async (): Promise<void> => undefined;
const CAA = 'https://coverartarchive.org/release/';
const RELEASE_WITH_COVER = '504091b5-0180-412a-9e75-af971f85822f';
const RELEASE_WITHOUT = '7d36d17d-1a1f-499a-b095-8df9ab6e1669';

/** Deezer's details and the archive's answers, beside the usual search routes. */
const DETAIL_ROUTES: Route[] = [
  // The one exact search the filling asks (five rows, no page) answers; Deezer's own search of the
  // page finds nothing, so a row is filled by name rather than merged with Deezer's copy.
  [/api\.deezer\.com\/search\/track\?q=[^&]*&limit=5$/, 'deezer-search-track'],
  [/api\.deezer\.com\/search\/track\?q=[^&]*&index=/, 'deezer-search-empty'],
  [/api\.deezer\.com\/track\/67238735$/, 'deezer-isrc'],
  [/api\.deezer\.com\/track\/66609426$/, 'deezer-track'],
  [new RegExp(`coverartarchive\\.org/release/${RELEASE_WITH_COVER}/front-500`), { status: 307, headers: { location: `https://archive.org/download/mbid-${RELEASE_WITH_COVER}/mbid-${RELEASE_WITH_COVER}-1_thumb500.jpg` } }],
  [new RegExp(`coverartarchive\\.org/release/${RELEASE_WITHOUT}/front-500`), { status: 404 }],
];

function engine(routes: Route[] = [...DETAIL_ROUTES, ...STANDARD_ROUTES], extra: Partial<CatalogEngineOptions> = {}) {
  const f = fixtureFetch(routes);
  const e = new CatalogEngine({ fetch: f.fetch, userAgent: 'AirwaveTest/1.0 (test)', sleep: noSleep, crossLinkTop: 0, ...extra });
  return { engine: e, calls: f.calls };
}

async function collect(gen: AsyncGenerator<CatalogSearchChunk>): Promise<CatalogSearchChunk[]> {
  const out: CatalogSearchChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

/** The merge-only chunk the hydration sends: after every service's, before done. */
function hydrationChunk(chunks: CatalogSearchChunk[]): Extract<CatalogSearchChunk, { type: 'results' }> | null {
  const done = chunks.at(-1);
  const before = chunks.at(-2);
  if (done?.type !== 'done' || before?.type !== 'results' || before.provider !== null || !before.tracks.length) return null;
  return before;
}

const row = (patch: Partial<CatalogTrack> & Pick<CatalogTrack, 'id' | 'title' | 'artist' | 'sources'>): CatalogTrack => ({
  artists: [patch.artist],
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
  artistId: null,
  albumId: null,
  tags: [],
  label: null,
  rank: 0,
  ...patch,
});

const yt = (id: string) => ({ platform: 'youtube' as const, id, url: `https://www.youtube.com/watch?v=${id}`, previewUrl: null, matchedBy: 'search' as const });
const dz = (id: string) => ({ platform: 'deezer' as const, id, url: `https://www.deezer.com/track/${id}`, previewUrl: null, matchedBy: 'search' as const });
const mb = (id: string) => ({ platform: 'musicbrainz' as const, id, url: `https://musicbrainz.org/recording/${id}`, previewUrl: null, matchedBy: 'search' as const });

/** A service of the test's own, standing in for yt-dlp, that answers with the rows given. */
const rowsProvider = (tracks: CatalogTrack[]): CatalogProvider => ({ id: 'youtube', sections: ['tracks'], timeoutMs: 2000, supports: () => true, search: async () => ({ ...emptyResult(), tracks }) });

describe('every result carries its facts (UX-CAT-006)', () => {
  it('fills a search page’s rows from Deezer’s detail in one last merge-only chunk before done', async () => {
    const { engine: e } = engine([...DETAIL_ROUTES.slice(2), ...STANDARD_ROUTES]);
    const chunks = await collect(e.search({ q: 'daft punk get lucky', limit: 3 }));
    const filled = hydrationChunk(chunks);
    expect(filled).not.toBeNull();
    expect(filled!.provider).toBeNull();
    // The Deezer/iTunes row of "Get Lucky": search gave no bpm and no contributors; the detail does.
    const lucky = filled!.tracks.find((t) => t.sources.some((s) => s.platform === 'deezer' && s.id === '67238735'))!;
    expect(lucky).toMatchObject({ bpm: 116.1, isrc: 'USQX91300108', explicit: false, trackNumber: 8, discNumber: 1, album: 'Random Access Memories' });
    // iTunes' own full date was there first and stays: nothing known is overwritten.
    expect(lucky.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(lucky.artists).toEqual(['Daft Punk', 'Pharrell Williams', 'Nile Rodgers']);
    expect(lucky.artworkUrl).toMatch(/1000x1000/);
    // The same id the row arrived with: the three UIs upsert it in place.
    const first = chunks.find((c) => c.type === 'results' && c.tracks.some((t) => t.id === lucky.id));
    expect(first).toBeDefined();
    // The folded answer (?stream=0) carries the facts too.
    const all = await e.searchAll({ q: 'daft punk get lucky', limit: 3 });
    expect(all.tracks.find((t) => t.id === lucky.id)).toMatchObject({ bpm: 116.1, artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'] });
  });

  it('a MusicBrainz-only row takes the Cover Art Archive’s front cover for its first release, never following the hop', async () => {
    const { engine: e, calls } = engine();
    const all = await e.searchAll({ q: 'daft punk get lucky', sections: ['tracks'], providers: ['musicbrainz'] });
    const withCover = all.tracks.find((t) => t.sources[0]!.id === '0347d102-b653-4c6c-a0b2-cc9a58c5c585')!;
    const without = all.tracks.find((t) => t.sources[0]!.id === '97c21330-5552-41db-ba0d-249f4c833267')!;
    expect(withCover.artworkUrl).toBe(`${CAA}${RELEASE_WITH_COVER}/front-500`);
    expect(without.artworkUrl).toBeNull();
    expect(calls.some((u) => /\/\/archive\.org\//.test(u))).toBe(false);
    // Deezer was not asked for: a service left out of the search is not asked for its facts either.
    expect(calls.some((u) => u.includes('api.deezer.com'))).toBe(false);
  });

  it('fills an ISRC-only row from /track/isrc:, and a store-less row by one exact search taken only for the same recording', async () => {
    const byIsrc = row({ id: 'musicbrainz:aaa', title: 'Get Lucky', artist: 'Daft Punk', isrc: 'USQX91300108', durationMs: 367_000, sources: [mb('aaa')] });
    const upload = row({ id: 'youtube:radio', title: 'Get Lucky (Radio Edit)', artist: 'Daft Punk', durationMs: 248_000, artworkUrl: 'https://i.ytimg.com/vi/radio/hqdefault.jpg', sources: [yt('radio')] });
    const stranger = row({ id: 'youtube:other', title: 'Get Lucky', artist: 'Daft Punk', durationMs: 300_000, sources: [yt('other')] });
    const { engine: e, calls } = engine();
    e.register(rowsProvider([byIsrc, upload, stranger]));
    const all = await e.searchAll({ q: 'daft punk get lucky', sections: ['tracks'], providers: ['youtube', 'deezer'] });
    const a = all.tracks.find((t) => t.id === 'musicbrainz:aaa')!;
    expect(a).toMatchObject({ bpm: 116.1, explicit: false, album: 'Random Access Memories' });
    // Deezer fills the facts but states no genre, so Apple is asked for one and joins as a
    // matched source: the row is the same recording on three services now.
    expect(a.sources.map((s) => [s.platform, s.matchedBy])).toEqual([
      ['musicbrainz', 'search'],
      ['deezer', 'isrc'],
      ['apple-music', 'metadata'],
    ]);
    expect(a.genre, 'the genre Apple stated, which Deezer never carries').toBeTruthy();
    const b = all.tracks.find((t) => t.id === 'youtube:radio')!;
    expect(b).toMatchObject({ bpm: 116.13, isrc: 'USQX91300809', artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'] });
    // A video thumbnail gives way to the store's square cover, as the merger's rule has it.
    expect(b.artworkUrl).toMatch(/cdn-images\.dzcdn\.net.*1000x1000/);
    expect(b.sources.at(-1)).toMatchObject({ platform: 'deezer', id: '66609426', matchedBy: 'metadata' });
    // Fifty-two seconds apart: not the same recording, so nothing is taken from the search's hits.
    const c = all.tracks.find((t) => t.id === 'youtube:other')!;
    expect(c.bpm).toBeNull();
    expect(c.sources).toHaveLength(1);
    expect(calls.filter((u) => /api\.deezer\.com\/track\/\d+$/.test(u))).toEqual(['https://api.deezer.com/track/66609426']);
  });

  it('never downgrades: an iTunes row keeps its 600 px artwork and its own credit line, and gains what it lacked', async () => {
    const { engine: e } = engine();
    const all = await e.searchAll({ q: 'daft punk get lucky', sections: ['tracks'], providers: ['itunes', 'deezer'] });
    const lucky = all.tracks.find((t) => t.sources.some((s) => s.platform === 'apple-music' && s.id === '617154366'))!;
    expect(lucky.artworkUrl).toMatch(/mzstatic\.com.*600x600/);
    expect(lucky.sources.at(-1)).toMatchObject({ platform: 'deezer', id: '67238735', matchedBy: 'metadata' });
    expect(lucky.artist).toBe('Daft Punk, Pharrell Williams & Nile Rodgers');
    expect(lucky).toMatchObject({ bpm: 116.1, isrc: 'USQX91300108', explicit: false });
  });

  it('asks at most eight at a time, starts nothing past the budget, and never holds done for a slow answer', async () => {
    let inFlight = 0;
    let most = 0;
    const slow: Route = [
      /api\.deezer\.com\/track\/\d+$/,
      () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        return new Promise(() => undefined) as never; // never answers
      },
    ];
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: `deezer:${100 + i}`, title: `Song ${i}`, artist: 'Band', durationMs: 200_000, sources: [dz(String(100 + i))] }));
    const { engine: e, calls } = engine([slow, [/api\.deezer\.com\/search\/track/, 'deezer-search-empty'], ...STANDARD_ROUTES], { hydrateBudgetMs: 80 });
    e.register(rowsProvider(rows));
    const started = Date.now();
    const chunks = await collect(e.search({ q: 'band song', sections: ['tracks'], providers: ['youtube', 'deezer'] }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(chunks.at(-1)!.type).toBe('done');
    expect(hydrationChunk(chunks)).toBeNull();
    expect(most).toBeLessThanOrEqual(HYDRATE_CONCURRENCY);
    expect(calls.filter((u) => /\/track\/\d+$/.test(u)).length).toBeLessThanOrEqual(HYDRATE_CONCURRENCY);
  });

  it('keeps a detail for a day, under its id and its ISRC: the next page or search asks nothing', async () => {
    const { engine: e, calls } = engine([...DETAIL_ROUTES.slice(2), ...STANDARD_ROUTES]);
    await e.searchAll({ q: 'daft punk get lucky', sections: ['tracks'], providers: ['deezer'] });
    const asked = () => calls.filter((u) => u.endsWith('/track/67238735')).length;
    expect(asked()).toBe(1);
    await e.searchAll({ q: 'daft punk get lucky', sections: ['tracks'], providers: ['deezer'] });
    expect(asked()).toBe(1);
    // A row that knows only the ISRC is filled from the cache, with no call at all.
    e.register(rowsProvider([row({ id: 'musicbrainz:bbb', title: 'Get Lucky', artist: 'Daft Punk', isrc: 'USQX91300108', durationMs: 367_000, sources: [mb('bbb')] })]));
    const before = calls.length;
    const all = await e.searchAll({ q: 'get lucky again', sections: ['tracks'], providers: ['youtube', 'deezer'] });
    expect(all.tracks.find((t) => t.id === 'musicbrainz:bbb')).toMatchObject({ bpm: 116.1 });
    expect(calls.slice(before).some((u) => u.includes('/track/isrc:'))).toBe(false);
  });

  it('respects Deezer’s quota: the first code-4 answer ends the page’s lookups and rests the service', async () => {
    const quota: Route = [/api\.deezer\.com\/track\/\d+$/, { status: 200, body: { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } } }];
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: `deezer:${200 + i}`, title: `Tune ${i}`, artist: 'Band', durationMs: 200_000, sources: [dz(String(200 + i))] }));
    const now = () => 1_000_000;
    const { engine: e, calls } = engine([quota, [/api\.deezer\.com\/search\/track/, 'deezer-search-empty'], ...STANDARD_ROUTES], { now });
    e.register(rowsProvider(rows));
    const all = await e.searchAll({ q: 'band tune', sections: ['tracks'], providers: ['youtube', 'deezer'] });
    expect(all.tracks).toHaveLength(20);
    expect(calls.filter((u) => /\/track\/\d+$/.test(u)).length).toBeLessThanOrEqual(HYDRATE_CONCURRENCY);
    expect(e.standing().find((s) => s.provider === 'deezer')).toMatchObject({ state: 'cooling-down', retryAt: new Date(1_000_000 + 5000).toISOString() });
  });

  it('an album’s songs and an artist’s top songs are filled in too', async () => {
    // The listings carry no bpm or contributors; each song's own detail does (answered here for two of them).
    const { engine: e, calls } = engine([[/api\.deezer\.com\/track\/67238729$/, 'deezer-isrc'], [/api\.deezer\.com\/track\/67238732$/, 'deezer-track'], [/api\.deezer\.com\/album\/6575789\/tracks/, 'deezer-album-tracks'], [/api\.deezer\.com\/album\/6575789/, 'deezer-album'], [/api\.deezer\.com\/artist\/27\/top/, 'deezer-artist-top'], [/api\.deezer\.com\/artist\/27\/albums/, 'deezer-artist-albums'], [/api\.deezer\.com\/artist\/27$/, 'deezer-artist'], ...STANDARD_ROUTES]);
    const album = await e.album('deezer:6575789');
    // (The fixture's one page of three stands for every page, so the list repeats; the ids are what matter.)
    expect(album.page.tracks.slice(0, 3).map((t) => t.id)).toEqual(['deezer:67238728', 'deezer:67238729', 'deezer:67238730']);
    expect(album.page.tracks[1]).toMatchObject({ bpm: 116.1, artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'] });
    // Fifteen rows, one song's detail asked once: the answer is shared through the cache.
    expect(calls.filter((u) => u.endsWith('/track/67238729'))).toHaveLength(1);
    const artist = await e.artist('deezer:27');
    expect(artist.topTracks.find((t) => t.id === 'deezer:67238732')).toMatchObject({ bpm: 116.13 });
  });
});

describe('the filling itself', () => {
  const detail = row({ id: 'deezer:1', title: 'Song', artist: 'Band', artists: ['Band', 'Guest'], album: 'Album', durationMs: 200_000, isrc: 'GBAAA0000001', genre: 'Hip-hop & Rap', artistId: 'deezer:27', albumId: 'deezer:6516139', artworkUrl: 'https://cdn-images.dzcdn.net/images/cover/x/1000x1000-000000-80-0-0.jpg', releaseDate: '2020-03-04', year: 2020, trackNumber: 3, discNumber: 1, bpm: 120, explicit: true, sources: [dz('1')] });

  it('fills only what is null, keeps the fuller date, grows the credits, and keeps a store’s cover', () => {
    const into = row({ id: 'apple-music:9', title: 'Song', artist: 'Band & Guest', album: 'My Album', durationMs: 201_000, artworkUrl: 'https://is1-ssl.mzstatic.com/x/600x600bb.jpg', releaseDate: '2020', sources: [{ platform: 'apple-music', id: '9', url: 'https://music.apple.com/x', previewUrl: null, matchedBy: 'search' }] });
    const out = fillTrack(into, detail, 'metadata');
    expect(out).toMatchObject({ id: 'apple-music:9', artist: 'Band & Guest', artists: ['Band', 'Guest'], album: 'My Album', durationMs: 201_000, isrc: 'GBAAA0000001', releaseDate: '2020-03-04', year: 2020, trackNumber: 3, bpm: 120, explicit: true });
    expect(out.artworkUrl).toBe('https://is1-ssl.mzstatic.com/x/600x600bb.jpg');
    expect(out.sources.map((s) => [s.platform, s.matchedBy])).toEqual([
      ['apple-music', 'search'],
      ['deezer', 'metadata'],
    ]);
    expect(needsFacts(out)).toBe(false);
    expect(needsFacts(into)).toBe(true);
  });

  /**
   * A YouTube row states no genre -- YouTube publishes none, and its keywords are chosen to be
   * found by rather than to describe, so they are not read as one. That left YouTube-only rows with
   * no genre at all (measured: 0 of 260 live rows), and the recommender's genre factor blind to
   * every song a listener found there.
   *
   * The filling step already asks a store for the same recording and copies across what the row is
   * missing, and it already copies a genre. But `needsFacts` did not count a missing genre as a
   * reason to ask, so a row that had everything else was never filled and stayed untagged. The
   * genre still comes only from a platform that stated one -- it is copied, never invented.
   */
  it('counts a missing genre as a reason to ask a store', () => {
    const untagged = row({ id: 'youtube:v', title: 'Song', artist: 'Band', artists: ['Band', 'Guest'], album: 'Album', durationMs: 200_000, isrc: 'GBAAA0000001', artworkUrl: 'https://cdn-images.dzcdn.net/images/cover/x/1000x1000-000000-80-0-0.jpg', releaseDate: '2020-03-04', year: 2020, trackNumber: 3, discNumber: 1, bpm: 120, explicit: true, sources: [yt('v')] });
    expect(untagged.genre, 'a YouTube row states no genre').toBeNull();
    expect(needsFacts(untagged), 'so there is still something worth asking for').toBe(true);

    const filled = fillTrack(untagged, row({ id: 'deezer:1', title: 'Song', artist: 'Band', genre: 'Hip-hop & Rap', artistId: 'deezer:27', sources: [dz('1')] }), 'metadata');
    expect(filled.genre).toBe('Hip-hop & Rap');
    expect(needsFacts(filled), 'now nothing is missing').toBe(false);
  });

  /**
   * The ids and tags a store states have to survive the filling too: they are what lets the
   * recommender tell two artists with the same name apart, and they were added to the row contract
   * after this function was written, so it copied neither.
   */
  it('fills the artist and album ids and unions the tags a store stated', () => {
    const anonymous = row({ id: 'youtube:v', title: 'Song', artist: 'Band', tags: ['live'], sources: [yt('v')] });
    expect(anonymous.artistId).toBeNull();

    const detailed = row({ id: 'deezer:1', title: 'Song', artist: 'Band', artistId: 'deezer:27', albumId: 'deezer:302127', tags: ['nu-disco', 'live'], sources: [dz('1')] });
    const out = fillTrack(anonymous, detailed, 'metadata');

    expect(out.artistId).toBe('deezer:27');
    expect(out.albumId).toBe('deezer:302127');
    // Additive and deduped: 'live' was already known, 'nu-disco' is new.
    expect(out.tags).toEqual(['live', 'nu-disco']);
  });

  /** An id the row already states is its own; a store's copy does not replace it. */
  it('keeps an id the row already stated', () => {
    const known = row({ id: 'apple-music:9', title: 'Song', artist: 'Band', artistId: 'apple-music:271256', sources: [{ platform: 'apple-music', id: '9', url: 'https://music.apple.com/x', previewUrl: null, matchedBy: 'search' }] });
    const out = fillTrack(known, row({ id: 'deezer:1', title: 'Song', artist: 'Band', artistId: 'deezer:27', sources: [dz('1')] }), 'metadata');
    expect(out.artistId).toBe('apple-music:271256');
  });

  it('a thumbnail gives way to the store’s cover; a row with everything needs nothing', () => {
    const upload = row({ id: 'youtube:v', title: 'Song', artist: 'Band', artworkUrl: 'https://i.ytimg.com/vi/v/hqdefault.jpg', sources: [yt('v')] });
    expect(fillTrack(upload, detail, 'metadata').artworkUrl).toMatch(/dzcdn/);
    expect(needsFacts(detail)).toBe(false);
  });

  it('the pool runs at most `concurrency` at once and starts nothing past the deadline', async () => {
    let clock = 0;
    let active = 0;
    let most = 0;
    const out = await runPool(
      [1, 2, 3, 4, 5, 6],
      async (n) => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 5));
        clock += n >= 3 ? 100 : 0;
        active -= 1;
        return n * 2;
      },
      { concurrency: 2, deadline: 150, now: () => clock },
    );
    expect(most).toBe(2);
    expect(out.get(0)).toBe(2);
    // The clock passed the deadline once the third and fourth were done: the sixth never started.
    expect(out.has(4)).toBe(true);
    expect(out.has(5)).toBe(false);
  });
});

describe('the credit line (UX-CAT-006)', () => {
  const credits = (artist: string, artists: string[]) => creditLine({ artist, artists });

  it('names the main artist, then the featured ones a store lists as contributors', () => {
    expect(credits('Daft Punk', ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'])).toBe('Daft Punk feat. Pharrell Williams & Nile Rodgers');
    expect(credits('Band', ['Band', 'Guest'])).toBe('Band feat. Guest');
  });

  it('adds nothing when the line already names them, or already says feat.', () => {
    expect(credits('Daft Punk, Pharrell Williams & Nile Rodgers', ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'])).toBe('Daft Punk, Pharrell Williams & Nile Rodgers');
    expect(credits('Band feat. Guest', ['Band', 'Guest'])).toBe('Band feat. Guest');
    expect(credits('Band (feat. Someone)', ['Band', 'Other'])).toBe('Band (feat. Someone)');
  });

  it('keeps order, drops repeats, and says "& others" after four', () => {
    expect(credits('A', ['A', 'B', 'b', 'C'])).toBe('A feat. B & C');
    expect(credits('A', ['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toBe('A feat. B, C, D, E & others');
    expect(credits('A', [])).toBe('A');
    expect(credits('', ['Solo'])).toBe('Solo');
  });
});

/**
 * Deezer's `/track/{id}` carries no genre -- measured against the live API, the payload has no
 * genre field at all, and its album sub-object has no `genre_id` either. So filling a row from
 * Deezer can never give it a genre, and a YouTube-only row stayed untagged however often it was
 * asked (measured: 0 of 202 live rows over six queries, unchanged by asking more often).
 *
 * Apple states one: `primaryGenreName` on every song row. A row with no genre is matched to Apple's
 * record of the same recording -- the merger's own identity test, nothing looser -- and copies the
 * genre it stated. Never invented: a row nobody can match keeps no genre.
 */
describe('a genre for a row whose own platform states none', () => {
  const APPLE_HIT: Route = [
    /itunes\.apple\.com\/search/,
    { status: 200, body: { resultCount: 1, results: [{ wrapperType: 'track', kind: 'song', trackId: 1, trackName: 'Headlines', artistName: 'Drake', artistId: 271_256, collectionId: 9, collectionName: 'Take Care', trackTimeMillis: 244_000, primaryGenreName: 'Hip-Hop/Rap', releaseDate: '2011-11-15T08:00:00Z', trackNumber: 4, discNumber: 1, isStreamable: true, trackViewUrl: 'https://music.apple.com/x', artworkUrl100: 'https://is1-ssl.mzstatic.com/x/100x100bb.jpg' }] } },
  ];
  const APPLE_MISS: Route = [/itunes\.apple\.com\/search/, { status: 200, body: { resultCount: 0, results: [] } }];
  const DEEZER_MISS: Route = [/api\.deezer\.com\/search\/track/, { status: 200, body: { data: [] } }];

  it('asks Apple for a genre when the row has none and Deezer cannot give one', async () => {
    const { engine: e, calls } = engine([DEEZER_MISS, APPLE_HIT, ...STANDARD_ROUTES]);
    const untagged = row({ id: 'youtube:v', title: 'Headlines', artist: 'Drake', durationMs: 244_000, sources: [yt('v')] });

    const [filled] = await e.hydrateTracks([untagged]);

    expect(calls.some((u) => u.includes('itunes.apple.com/search')), 'Apple should have been asked').toBe(true);
    expect(filled?.genre).toBe('Hip-Hop/Rap');
    expect(filled?.sources.map((s) => s.platform)).toContain('youtube');
    expect(filled?.sources.map((s) => s.platform)).toContain('apple-music');
  });

  it('leaves a row untagged when Apple does not have it either', async () => {
    const { engine: e } = engine([DEEZER_MISS, APPLE_MISS, ...STANDARD_ROUTES]);
    const untagged = row({ id: 'youtube:v', title: 'A Live Set Nobody Sells', artist: 'Unsigned', durationMs: 3_600_000, sources: [yt('v')] });

    const out = await e.hydrateTracks([untagged]);
    expect(out[0]?.genre ?? null, 'no platform stated a genre, so the row has none').toBeNull();
  });

  /**
   * Apple allows about 20 searches a minute and the catalog's own search spends from the same
   * budget, while a page can bring 25 rows to be filled. Asking Apple for every untagged row would
   * spend the whole minute on genres and leave searching itself resting -- a worse page than the
   * one with some genres missing. So the genre lookups are capped per pass, well under the budget.
   */
  it('asks Apple for only a few genres per page, leaving the budget for searching', async () => {
    const { engine: e, calls } = engine([DEEZER_MISS, APPLE_MISS, ...STANDARD_ROUTES]);
    const many = Array.from({ length: 20 }, (_, i) =>
      row({ id: `youtube:v${i}`, title: `Song ${i}`, artist: `Band ${i}`, durationMs: 200_000 + i * 1000, sources: [yt(`v${i}`)] }),
    );

    await e.hydrateTracks(many);

    const appleCalls = calls.filter((u) => u.includes('itunes.apple.com/search')).length;
    expect(appleCalls, 'well under Apple’s 20-a-minute budget').toBeLessThanOrEqual(APPLE_GENRE_MAX_ASKS);
    expect(appleCalls, 'but it did ask for some').toBeGreaterThan(0);
  });

  /** A song Apple has, but a different recording: not this row, so no genre is taken from it. */
  it('does not take a genre from a different recording', async () => {
    const { engine: e } = engine([DEEZER_MISS, APPLE_HIT, ...STANDARD_ROUTES]);
    // Same words, nowhere near the same length: the identity test must reject it.
    const other = row({ id: 'youtube:v', title: 'Headlines', artist: 'Drake', durationMs: 32_000, sources: [yt('v')] });

    const out = await e.hydrateTracks([other]);
    expect(out[0]?.genre ?? null).toBeNull();
  });
});

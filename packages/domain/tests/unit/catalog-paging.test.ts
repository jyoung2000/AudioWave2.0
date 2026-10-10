/**
 * A loaded list loads every song (owner requirement, 2026-10-06): no 200-song cap. `resolve` serves
 * any page of a list by offset and limit, `total` is the platform's count, `hasMore` holds until the
 * end, and `resolveAll` / `collectAllPages` read a whole list in order up to CATALOG_COLLECTION_CAP
 * (10,000), saying so when the bound stops it.
 *
 * Long listings are generated here in each platform's own shape — Deezer's paged `index`/`limit`,
 * a tool's description of a Spotify playlist, a SoundCloud set of bare ids, an Apple Music playlist
 * page as its public HTML carries it (the shape seen on music.apple.com on 2026-10-06) — because
 * no recorded answer worth keeping in the repository is thousands of songs long.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG_COLLECTION_CAP, CATALOG_PAGE_MAX } from '@now-playing/contracts';
import { CatalogEngine, collectAllPages, readApplePlaylistPage, type CatalogFetch, type LinkRead, type LinkReader, type LinkTrack } from '@now-playing/domain/catalog';

const noSleep = async (): Promise<void> => undefined;

/** Deezer, paging a playlist of `n` songs exactly as its API does. */
function deezerFetch(n: number): { fetch: CatalogFetch; calls: string[] } {
  const calls: string[] = [];
  const json = (body: unknown) => ({ status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  const fetch: CatalogFetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (/^\/playlist\/77$/.test(u.pathname)) return json({ id: 77, title: 'Long Haul', nb_tracks: n, creator: { name: 'Airwave' }, picture_xl: 'https://cdn-images.dzcdn.net/images/playlist/x/1000x1000.jpg' });
    if (/^\/playlist\/77\/tracks$/.test(u.pathname)) {
      const index = Number(u.searchParams.get('index'));
      const limit = Number(u.searchParams.get('limit'));
      expect(limit).toBeLessThanOrEqual(100);
      const data = Array.from({ length: Math.max(0, Math.min(limit, n - index)) }, (_, i) => {
        const k = index + i + 1;
        return { id: 5000 + k, title: `Song ${k}`, duration: 180, artist: { id: 1, name: 'Band' }, album: { id: 9, title: 'Album', cover_xl: `https://cdn-images.dzcdn.net/images/cover/${k}/1000x1000.jpg` }, link: `https://www.deezer.com/track/${5000 + k}` };
      });
      return json({ data, total: n });
    }
    throw new Error(`No answer for ${url}`);
  };
  return { fetch, calls };
}

function songs(n: number, bare = false): LinkTrack[] {
  return Array.from({ length: n }, (_, i) => ({
    url: bare ? `https://api.soundcloud.com/tracks/${100_000 + i}` : `https://open.spotify.com/track/${String(i).padStart(22, 'A')}`,
    title: bare ? null : `Song ${i + 1}`,
    artist: bare ? null : 'Band',
    album: null,
    durationSec: bare ? null : 200,
    date: null,
    artworkUrl: bare ? null : `https://i.scdn.co/image/${i}`,
    trackNumber: null,
  }));
}

function toolEngine(reader: LinkReader): CatalogEngine {
  return new CatalogEngine({ fetch: async (url) => Promise.reject(new Error(`No answer for ${url}`)), userAgent: 'AirwaveTest/1.0 (test)', sleep: noSleep, linkReader: reader, crossLinkTop: 0 });
}

/** An Apple Music playlist page: the server data the page embeds, and its schema.org count. */
function applePage(shown: number, count: number): string {
  const items = Array.from({ length: shown }, (_, i) => ({
    id: `track-lockup - pl.mock - ${700 + i}`,
    title: `Song ${i + 1}`,
    tertiaryLinks: [{ title: 'Album' }],
    duration: 201_000,
    contentDescriptor: { kind: 'song', identifiers: { storeAdamID: String(700 + i) }, url: `https://music.apple.com/us/album/album/600?i=${700 + i}` },
    artwork: { dictionary: { url: `https://is1-ssl.mzstatic.com/image/thumb/Music/v4/${i}/{w}x{h}bb.{f}` } },
    subtitleLinks: [{ title: 'Band' }, { title: 'Guest' }],
  }));
  const data = { data: [{ intent: {}, data: { sections: [{ itemKind: 'containerDetailHeaderLockup', id: 'header', items: [{ title: 'Long Haul', subtitleLinks: [{ title: 'Apple Music Curator' }], artwork: { dictionary: { url: 'https://is1-ssl.mzstatic.com/image/thumb/Features/v4/x/{w}x{h}bb.{f}' } } }] }, { itemKind: 'trackLockup', id: 'track-list', items }] } }] };
  const ld = { '@type': 'MusicPlaylist', name: 'Long Haul', numTracks: count, author: { '@type': 'Person', name: 'Apple Music Curator' } };
  return `<!doctype html><html><head><script id=schema:music-playlist type="application/ld+json">${JSON.stringify(ld)}</script></head><body><script type="application/json" id="serialized-server-data">${JSON.stringify(data)}</script></body></html>`;
}

describe('a long list, page by page (no 200-song cap)', () => {
  it('Deezer: any page of a 450-song playlist, the exact total, hasMore until the end, asked 100 at a time', async () => {
    const { fetch, calls } = deezerFetch(450);
    const e = new CatalogEngine({ fetch, userAgent: 'AirwaveTest/1.0 (test)', sleep: noSleep, crossLinkTop: 0 });
    const page = await e.resolve('https://www.deezer.com/playlist/77', 300, 150);
    expect(page.collection!.page).toMatchObject({ offset: 300, limit: 150, total: 450, hasMore: false, capped: false });
    expect(page.collection!.page.tracks.map((t) => t.title)).toEqual(Array.from({ length: 150 }, (_, i) => `Song ${301 + i}`));
    expect(calls.filter((c) => c.includes('/tracks?')).map((c) => new URL(c).searchParams.get('index'))).toContain('400');
    const middle = await e.resolve('https://www.deezer.com/playlist/77', 200, 50);
    expect(middle.collection!.page.hasMore).toBe(true);
    const all = await e.resolveAll('https://www.deezer.com/playlist/77');
    expect(all.tracks.map((t) => t.title)).toEqual(Array.from({ length: 450 }, (_, i) => `Song ${i + 1}`));
    expect(all).toMatchObject({ total: 450, capped: false });
  });

  it('Spotify through spotDL: all 1,200 songs of a playlist, read once and served page by page', async () => {
    let reads = 0;
    const reader: LinkReader = async () => {
      reads += 1;
      return { kind: 'collection', url: 'https://open.spotify.com/playlist/x', title: 'Long Haul', owner: 'Airwave', artworkUrl: null, date: null, entries: songs(1200), total: 1200, capped: false } satisfies LinkRead;
    };
    const e = toolEngine(reader);
    const last = await e.resolve('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 1100, 200);
    expect(last.collection!.page).toMatchObject({ offset: 1100, total: 1200, hasMore: false, capped: false });
    expect(last.collection!.page.tracks).toHaveLength(100);
    expect(last.collection!.page.tracks[0]!.title).toBe('Song 1101');
    const pages: number[] = [];
    const all = await e.resolveAll('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', { onPage: (r) => pages.push(r.collection!.page.offset) });
    expect(all.tracks).toHaveLength(1200);
    expect(new Set(all.tracks.map((t) => t.id)).size).toBe(1200);
    expect(pages).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(reads, 'the tool runs once; pages come from what it read').toBe(1);
  });

  it('stops at CATALOG_COLLECTION_CAP and says so, never silently', async () => {
    const reader: LinkReader = async () => ({ kind: 'collection', url: 'https://www.youtube.com/playlist?list=PLx', title: 'Endless', owner: null, artworkUrl: null, date: null, entries: songs(CATALOG_COLLECTION_CAP + 50), total: CATALOG_COLLECTION_CAP + 50, capped: false });
    const e = toolEngine(reader);
    const all = await e.resolveAll('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    expect(all.tracks).toHaveLength(CATALOG_COLLECTION_CAP);
    expect(all.capped).toBe(true);
    expect(all.total).toBe(CATALOG_COLLECTION_CAP + 50);
    const end = await e.resolve('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', CATALOG_COLLECTION_CAP - 10, 100);
    expect(end.collection!.page).toMatchObject({ hasMore: false, capped: true });
  });

  it('SoundCloud: a set’s bare ids are described a page at a time, in one run for that page', async () => {
    const asked: Array<readonly number[] | undefined> = [];
    const reader: LinkReader = async (_url, { items }) => {
      asked.push(items);
      if (!items) return { kind: 'collection', url: 'https://soundcloud.com/band/sets/long', title: 'Long', owner: 'band', artworkUrl: null, date: null, entries: songs(300, true), total: 300, capped: false };
      return { kind: 'collection', url: 'https://soundcloud.com/band/sets/long', title: 'Long', owner: 'band', artworkUrl: null, date: null, entries: items.map((n) => ({ url: `https://soundcloud.com/band/song-${n}`, title: `Song ${n}`, artist: 'Band', album: null, durationSec: 190, date: null, artworkUrl: `https://i1.sndcdn.com/artworks-${n}-t500x500.jpg`, trackNumber: null })), total: items.length, capped: false };
    };
    const e = toolEngine(reader);
    const page = await e.resolve('https://soundcloud.com/band/sets/long', 250, 50);
    expect(page.collection!.page).toMatchObject({ total: 300, hasMore: false });
    expect(page.collection!.page.tracks.map((t) => t.title)).toEqual(Array.from({ length: 50 }, (_, i) => `Song ${251 + i}`));
    expect(asked.find((a) => a && a[0] === 251)).toEqual(Array.from({ length: 50 }, (_, i) => 251 + i));
    // The page the tool named replaces the bare API address the listing gave: one SoundCloud source,
    // one anyone can open and the hub's tool may reach (measured on a real set, 2026-10-10).
    expect(page.collection!.page.tracks[0]!.sources).toEqual([{ platform: 'soundcloud', id: 'band/song-251', url: 'https://soundcloud.com/band/song-251', previewUrl: null, matchedBy: 'link' }]);
    expect(page.collection!.page.tracks[0]!.id).toBe('soundcloud:tracks/100250');
  });

  it('Apple Music: a playlist read from its public page, every song it carries, paged like any other', async () => {
    const html = applePage(250, 250);
    const fetch: CatalogFetch = async (url) => {
      expect(url).toBe('https://music.apple.com/us/playlist/long-haul/pl.mock');
      return { status: 200, headers: { get: () => null }, json: async () => JSON.parse(html), text: async () => html };
    };
    const e = new CatalogEngine({ fetch, userAgent: 'AirwaveTest/1.0 (test)', sleep: noSleep, crossLinkTop: 0 });
    const r = await e.resolve('https://music.apple.com/us/playlist/long-haul/pl.mock?l=en', 200, 100);
    expect(r).toMatchObject({ kind: 'playlist', platform: 'apple-music', reason: null });
    expect(r.collection!.ref).toMatchObject({ platform: 'apple-music', kind: 'playlist', id: 'pl.mock', title: 'Long Haul', owner: 'Apple Music Curator' });
    expect(r.collection!.page).toMatchObject({ offset: 200, total: 250, hasMore: false });
    expect(r.collection!.page.tracks[0]).toMatchObject({ title: 'Song 201', artist: 'Band feat. Guest', album: 'Album', durationMs: 201_000, artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/200/600x600bb.jpg' });
    expect(r.collection!.covers).toHaveLength(4);
    expect((await e.resolveAll('https://music.apple.com/us/playlist/long-haul/pl.mock')).tracks).toHaveLength(250);
  });

  it('Apple Music: a page that carries fewer songs than the playlist holds says how many it could read', () => {
    const page = readApplePlaylistPage(applePage(100, 340), 'pl.mock');
    expect(page).toMatchObject({ title: 'Long Haul', total: 340 });
    expect(page.tracks).toHaveLength(100);
  });

  it('collectAllPages pages any resolve-shaped call in order, page size bounded', async () => {
    const seen: Array<[number, number]> = [];
    const n = 730;
    const result = await collectAllPages(
      async (offset, limit) => {
        seen.push([offset, limit]);
        const tracks = songs(n)
          .slice(offset, offset + limit)
          .map((s, i) => ({ id: `x:${offset + i}`, title: s.title!, artist: 'Band', artists: [], album: null, albumArtist: null, durationMs: null, isrc: null, artworkUrl: null, releaseDate: null, year: null, trackNumber: null, discNumber: null, bpm: null, explicit: null, genre: null, label: null, sources: [{ platform: 'spotify' as const, id: null, url: s.url!, previewUrl: null, matchedBy: 'link' as const }], rank: 0 }));
        return { url: 'u', platform: 'spotify', kind: 'playlist', track: null, artist: null, reason: null, resolvedAt: '2026-10-06T00:00:00.000Z', collection: { ref: { platform: 'spotify', kind: 'playlist', id: 'p', url: 'u', title: 't', owner: null }, artworkUrl: null, covers: [], releaseDate: null, page: { tracks, offset, limit, total: n, hasMore: offset + tracks.length < n, capped: false } } };
      },
      { max: CATALOG_COLLECTION_CAP, pageSize: CATALOG_PAGE_MAX },
    );
    expect(result.tracks.map((t) => t.id)).toEqual(Array.from({ length: n }, (_, i) => `x:${i}`));
    expect(seen).toEqual([
      [0, 200],
      [200, 200],
      [400, 200],
      [600, 200],
    ]);
    expect(result.capped).toBe(false);
  });
});

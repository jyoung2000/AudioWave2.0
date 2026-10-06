/**
 * One song is one row (owner requirement 2026-10-06; UX-CAT-002): the same recording from iTunes,
 * Deezer, a YouTube official video, a YouTube Topic upload and SoundCloud becomes one listing with
 * five platform badges; a live version, a remix and an acoustic take stay rows of their own; a
 * stranger's re-upload with no duration does not join; and a later page never repeats a song an
 * earlier page sent — it comes back with that row's id.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogSearchChunk, CatalogSource, CatalogTrack } from '@now-playing/contracts';
import { CatalogEngine, CatalogMerger, parseCatalogQuery, recordingKey, sameRecording, toolSearchTrack, versionOf, type CatalogProvider } from '@now-playing/domain/catalog';

const store = (id: string, platform: CatalogSource['platform'], patch: Partial<CatalogTrack> = {}): CatalogTrack => ({
  id: `${platform}:${id}`,
  title: 'Harbour Lights',
  artist: 'Cassette Bloom',
  artists: ['Cassette Bloom'],
  album: 'Harbour Lights',
  albumArtist: 'Cassette Bloom',
  durationMs: 214_000,
  isrc: null,
  artworkUrl: null,
  releaseDate: '2026-03-14',
  year: 2026,
  trackNumber: 1,
  discNumber: 1,
  bpm: null,
  explicit: false,
  genre: null,
  label: null,
  sources: [{ platform, id, url: `https://example.invalid/${platform}/${id}`, previewUrl: null, matchedBy: 'search' }],
  rank: 0,
  ...patch,
});

const youtube = (id: string, title: string, channel: string, duration: number | null) => toolSearchTrack('youtube', { id, title, channel, duration, webpage_url: `https://www.youtube.com/watch?v=${id}` })!;
const soundcloud = (slug: string, title: string, uploader: string, duration: number | null) => toolSearchTrack('soundcloud', { id: slug, title, uploader, duration, webpage_url: `https://soundcloud.com/cassettebloom/${slug}` })!;

describe('one song, one row', () => {
  it('iTunes, Deezer, a YouTube official video, a Topic upload and SoundCloud: one row, five badges', () => {
    const merger = new CatalogMerger(parseCatalogQuery({ q: 'harbour lights' }));
    // The Topic upload first, with no duration: it still joins the store rows that follow.
    merger.add({ tracks: [youtube('topic0001', 'Harbour Lights', 'Cassette Bloom - Topic', null)] });
    merger.add({ tracks: [store('8101', 'apple-music')] });
    merger.add({ tracks: [store('9101', 'deezer', { isrc: 'QZAAA2600101', durationMs: 214_500 })] });
    merger.add({ tracks: [youtube('video0001', 'Cassette Bloom - Harbour Lights (Official Music Video) [HD]', 'Cassette Bloom', 216)] });
    merger.add({ tracks: [soundcloud('harbour-lights', 'Cassette Bloom - Harbour Lights', 'Cassette Bloom', 215.4)] });
    const rows = merger.snapshot().tracks;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sources.map((s) => s.platform).sort()).toEqual(['apple-music', 'deezer', 'soundcloud', 'youtube', 'youtube-music']);
    // The store's words win: the title is the song's, not the upload's.
    expect(rows[0]).toMatchObject({ title: 'Harbour Lights', artist: 'Cassette Bloom', isrc: 'QZAAA2600101' });
  });

  it('keeps versions apart: live, remix, acoustic, sped up and a cover are rows of their own', () => {
    const merger = new CatalogMerger(parseCatalogQuery({ q: 'harbour lights' }));
    merger.add({ tracks: [store('9101', 'deezer')] });
    merger.add({ tracks: [store('9102', 'deezer', { title: 'Harbour Lights (Live at the Granary)', durationMs: 214_000 })] });
    merger.add({ tracks: [youtube('remix0001', 'Cassette Bloom - Harbour Lights (Night Shift Remix)', 'Cassette Bloom', 214)] });
    merger.add({ tracks: [store('8102', 'apple-music', { title: 'Harbour Lights - Acoustic', durationMs: 213_000 })] });
    merger.add({ tracks: [youtube('sped00001', 'Harbour Lights (sped up)', 'Cassette Bloom - Topic', null)] });
    merger.add({ tracks: [soundcloud('cover', 'Harbour Lights (Cover)', 'Cassette Bloom', 214)] });
    expect(merger.snapshot().tracks).toHaveLength(6);
    expect(versionOf('Harbour Lights (Live at the Granary)')).toBe('live');
    expect(versionOf('Harbour Lights - Acoustic')).toBe('acoustic');
    expect(recordingKey({ title: 'Harbour Lights - Live', artist: 'Cassette Bloom' })).toEqual(recordingKey({ title: 'Harbour Lights (Live)', artist: 'Cassette Bloom' }));
    // Remastered is the same recording.
    expect(sameRecording(store('1', 'deezer'), store('2', 'apple-music', { title: 'Harbour Lights (2026 Remaster)', durationMs: 215_000 }))).toBe(true);
  });

  it('a stranger’s re-upload with no duration does not join on names alone', () => {
    const merger = new CatalogMerger(parseCatalogQuery({ q: 'harbour lights' }));
    merger.add({ tracks: [store('9101', 'deezer')] });
    merger.add({ tracks: [youtube('reup00001', 'Harbour Lights', 'Lofi Uploads 24/7', null)] });
    expect(merger.snapshot().tracks).toHaveLength(2);
  });
});

describe('no repeats across pages', () => {
  it('page 2’s copy of a page-1 song comes back with page 1’s id; only new songs are new rows', async () => {
    const pageOne = [store('9101', 'deezer'), store('9102', 'deezer', { title: 'Harbour Wall', durationMs: 187_000 })];
    const pageTwo = [store('8101', 'apple-music', { durationMs: 213_500 }), store('8105', 'apple-music', { title: 'Ember Season', durationMs: 203_000 })];
    const provider: CatalogProvider = {
      id: 'deezer',
      sections: ['tracks'],
      timeoutMs: 1000,
      supports: () => true,
      search: async (_q, { offset }) => ({ tracks: offset === 0 ? pageOne : pageTwo, artists: [], albums: [], full: { tracks: offset === 0 } }),
    };
    const engine = new CatalogEngine({ fetch: async () => Promise.reject(new Error('no network')), userAgent: 'AirwaveTest/1.0 (test)', crossLinkTop: 0 });
    engine.register(provider);
    const run = async (offset: number): Promise<CatalogSearchChunk[]> => {
      const out: CatalogSearchChunk[] = [];
      for await (const chunk of engine.search({ q: 'harbour', providers: ['deezer'], sections: ['tracks'], offset, limit: 2 })) out.push(chunk);
      return out;
    };
    const ids = (chunks: CatalogSearchChunk[]) => [...new Set(chunks.flatMap((c) => (c.type === 'results' ? c.tracks.map((t) => t.id) : [])))];
    const first = ids(await run(0));
    const second = await run(2);
    expect(first).toEqual(['deezer:9101', 'deezer:9102']);
    expect(ids(second)).toEqual(['deezer:9101', 'apple-music:8105']);
    const merged = second.flatMap((c) => (c.type === 'results' ? c.tracks : [])).find((t) => t.id === 'deezer:9101')!;
    expect(merged.sources.map((s) => s.platform).sort()).toEqual(['apple-music', 'deezer']);
    // The rows new on page 2, as a client appends them: nothing from page 1 again.
    expect(ids(second).filter((id) => !first.includes(id))).toEqual(['apple-music:8105']);
  });

  it('says which platforms only contributed links', async () => {
    const provider: CatalogProvider = {
      id: 'deezer',
      sections: ['tracks'],
      timeoutMs: 1000,
      supports: () => true,
      search: async () => ({ tracks: [store('9101', 'deezer', { sources: [{ platform: 'deezer', id: '9101', url: 'https://www.deezer.com/track/9101', previewUrl: null, matchedBy: 'search' }, { platform: 'spotify', id: 's', url: 'https://open.spotify.com/track/s', previewUrl: null, matchedBy: 'musicbrainz' }] })], artists: [], albums: [], full: {} }),
    };
    const engine = new CatalogEngine({ fetch: async () => Promise.reject(new Error('no network')), userAgent: 'AirwaveTest/1.0 (test)', crossLinkTop: 0 });
    engine.register(provider);
    let done: CatalogSearchChunk | null = null;
    for await (const chunk of engine.search({ q: 'harbour', providers: ['deezer'], sections: ['tracks'] })) done = chunk;
    expect(done).toMatchObject({ type: 'done', linkedOnly: ['spotify'] });
  });
});

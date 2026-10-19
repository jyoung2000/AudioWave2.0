/**
 * A visitor's fetch (NP-FIND-011/012): the pure parts. What a file the hub sends as
 * application/octet-stream is, from its first bytes (the library indexes by extension), and how a
 * row that came from a bare link becomes the catalog song the hub's catalog/download reads.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { boundedAudio, sniffExtension, trackOf } from '../../src/shell/search/visit.js';
import { HELPER_CATALOG_ROUTES } from '@now-playing/contracts';
import { httpClient } from '../../src/shell/search/client.js';

const bytes = (...parts: Array<string | number[]>): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p));
  while (out.length < 40) out.push(0);
  return new Uint8Array(out);
};

describe('a fetched file', () => {
  it('reads what a fetched file is from its first bytes', () => {
    expect(sniffExtension(bytes('ID3', [4, 0]))).toBe('.mp3');
    expect(sniffExtension(bytes([0xff, 0xfb, 0x90]))).toBe('.mp3');
    expect(sniffExtension(bytes([0, 0, 0, 0x20], 'ftypM4A '))).toBe('.m4a');
    expect(sniffExtension(bytes('fLaC'))).toBe('.flac');
    expect(sniffExtension(bytes('OggS', new Array(24).fill(0), 'OpusHead'))).toBe('.opus');
    expect(sniffExtension(bytes('OggS', new Array(24).fill(0), '\u0001vorbis'))).toBe('.ogg');
    expect(sniffExtension(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBe('.wav');
    expect(sniffExtension(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBe('.webm');
    expect(sniffExtension(bytes([0xff, 0xf1]))).toBe('.aac');
    expect(sniffExtension(bytes('<!doctype html>'))).toBeNull();
  });
});

describe('a link row for the hub', () => {
  it('names a link row’s platform for the hub, and refuses a link it does not know', () => {
    const t = trackOf({ id: 'song-add-1', title: 'Far Signal', artist: 'Cedar Trio', duration: 214, url: 'https://soundcloud.com/cedar/far-signal' });
    expect(t).not.toBeNull();
    expect(t!.sources).toEqual([{ platform: 'soundcloud', id: null, url: 'https://soundcloud.com/cedar/far-signal', previewUrl: null, matchedBy: 'link' }]);
    expect(t!.durationMs).toBe(214_000);
    expect(t!.artists).toEqual(['Cedar Trio']);
    expect(trackOf({ id: 'x', title: 'A', artist: '', url: 'https://music.youtube.com/watch?v=abc' })!.sources[0]!.platform).toBe('youtube-music');
    expect(trackOf({ id: 'x', title: 'A', artist: '', url: 'https://youtu.be/abc' })!.sources[0]!.platform).toBe('youtube');
    expect(trackOf({ id: 'x', title: 'A', artist: '', url: 'https://example.com/song.mp3' })).toBeNull();
    expect(trackOf({ id: 'x', title: 'A', artist: '', url: 'javascript:alert(1)' })).toBeNull();
  });
});


describe('bounded Hub audio transfers', () => {
  it('rejects oversized advertised files before reading', async () => {
    const response = new Response('audio', { headers: { 'content-length': '100' } });
    await expect(boundedAudio(response, 8)).rejects.toThrow('too large');
  });
  it('counts streaming bytes when Content-Length is absent', async () => {
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); c.enqueue(new Uint8Array(5)); c.close(); } }));
    await expect(boundedAudio(response, 8)).rejects.toThrow('too large');
  });
  it('rejects an empty stream', async () => {
    await expect(boundedAudio(new Response(''), 8)).rejects.toThrow('no audio bytes');
  });
  it('retains bounded bytes for verification before import', async () => {
    const blob = await boundedAudio(new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }), 8);
    expect(blob.size).toBe(5);
    expect(blob.type).toBe('audio/mpeg');
  });
});

/**
 * A discography longer than one page was unreachable from the player.
 *
 * The hub has always taken an `albumsOffset` and answered with an `albumsPage` saying whether more
 * exists -- the catalog contract and the engine both support it. But the player's client never sent
 * an offset, so `artist()` could only ever return the first page of albums. For Drake, whose
 * measured discography is 24 albums plus 2 EPs, the player stopped at the first page with no sign
 * there was more, which is part of why the three apps disagreed about how much an artist released.
 */
describe('an artist with more albums than fit on one page', () => {
  const detail = (offset: number, hasMore: boolean) => ({
    artist: { id: 'deezer:246791', name: 'Drake', sources: [{ platform: 'deezer', id: '246791', url: 'https://www.deezer.com/artist/246791', previewUrl: null, matchedBy: 'search' }] },
    topTracks: [],
    albums: [],
    albumsPage: { offset, limit: 25, hasMore },
  });

  const stubFetch = (asked: string[], body: unknown) => {
    globalThis.fetch = (async (url: unknown) => {
      asked.push(String(url));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  };

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('asks for the page it was given, and says whether more exists', async () => {
    const asked: string[] = [];
    stubFetch(asked, detail(25, true));
    const client = httpClient('hub', 'Hub', 'http://hub.test', HELPER_CATALOG_ROUTES, {});

    const out = await client.artist('deezer:246791', 25);

    expect(asked[0], 'the offset must reach the hub').toContain('albumsOffset=25');
    expect(out.albumsPage.hasMore, 'and the answer must say more exists').toBe(true);
  });

  it('asks for the first page when none is named', async () => {
    const asked: string[] = [];
    stubFetch(asked, detail(0, false));
    const client = httpClient('hub', 'Hub', 'http://hub.test', HELPER_CATALOG_ROUTES, {});

    await client.artist('deezer:27');

    expect(asked[0]).toContain('albumsOffset=0');
  });
});

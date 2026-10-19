/**
 * The catalog over a paired PC (DEC-039, NP-FIND-001/003/007).
 *
 * A paired player could search a companion and then had nowhere to go: `catalog.search` was the
 * only catalog operation the AWSP sidecar would route, so an album row opened no track list, an
 * artist no discography and a pasted link read as nothing. The player had no AWSP catalog client at
 * all — `clients()` offered the hub, the helper on this PC and the browser engine, and a paired PC
 * (the one machine that has yt-dlp when there is no hub and no local companion) was never asked.
 *
 * These tests own the player's side of that path: the paired client's fixed operation allowlist,
 * its bounded pages, that it never carries a caller's route, host or credential, and where it sits
 * in the order `clients()` returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWSP_CATALOG_OPERATIONS,
  AWSP_CATALOG_PAGE_MAX,
  awspClient,
  clients,
  Unreachable,
} from '../../src/shell/search/client.js';
import type { SearchParams } from '../../src/shell/search/client.js';

const params = (over: Partial<SearchParams> = {}): SearchParams => ({
  q: 'drake',
  sections: ['tracks', 'artists', 'albums'],
  providers: [],
  offset: 0,
  limit: 25,
  ...over,
});

const source = (platform = 'deezer', id = '1') => ({
  platform,
  id,
  url: `https://www.deezer.com/track/${id}`,
  previewUrl: null,
  matchedBy: 'search',
});

const track = (id = 'deezer:1') => ({
  id,
  title: 'Hold On',
  artist: 'Drake',
  artists: ['Drake'],
  sources: [source()],
});

const aggregate = () => ({
  query: { kind: 'text', text: 'drake' },
  tracks: [track()],
  artists: [{ id: 'deezer:246791', name: 'Drake', sources: [source('deezer', '246791')] }],
  albums: [
    {
      id: 'deezer:6575789',
      title: 'Take Care',
      artist: 'Drake',
      sources: [source('deezer', '6575789')],
    },
  ],
  playlists: [],
  status: [{ provider: 'deezer', state: 'ok', count: 1 }],
  page: {
    tracks: { offset: 0, limit: 25, hasMore: true },
    artists: { offset: 0, limit: 25, hasMore: false },
    albums: { offset: 0, limit: 25, hasMore: false },
    playlists: null,
  },
  resolve: null,
});

const albumDetail = () => ({
  album: {
    id: 'deezer:6575789',
    title: 'Take Care',
    artist: 'Drake',
    sources: [source('deezer', '6575789')],
  },
  page: { tracks: [track()], offset: 0, limit: 50, total: 19, hasMore: true, capped: false },
  collection: {
    platform: 'deezer',
    kind: 'album',
    id: '6575789',
    url: 'https://www.deezer.com/album/6575789',
    title: 'Take Care',
    owner: 'Drake',
  },
});

const artistDetail = () => ({
  artist: { id: 'deezer:246791', name: 'Drake', sources: [source('deezer', '246791')] },
  topTracks: [track()],
  albums: [],
  albumsPage: { offset: 25, limit: 25, hasMore: true },
});

const resolved = () => ({
  url: 'https://www.deezer.com/album/6575789',
  platform: 'deezer',
  kind: 'album',
  collection: {
    ref: albumDetail().collection,
    artworkUrl: null,
    covers: [],
    page: { tracks: [track()], offset: 0, limit: 50, total: 19, hasMore: true, capped: false },
  },
  resolvedAt: '2026-10-19T12:00:00Z',
});

/** The paired PC, as the player sees it: one `companion(operation, args)` and a status. */
const paired = (answer: (operation: string, args: Record<string, unknown>) => unknown) => {
  const asked: Array<{ operation: string; args: Record<string, unknown> }> = [];
  return {
    asked,
    awsp: {
      status: vi.fn(async () => ({ paired: true, serverName: 'TOWER' })),
      companion: vi.fn(async (operation: string, args: Record<string, unknown> = {}) => {
        asked.push({ operation, args });
        return answer(operation, args);
      }),
    },
  };
};

const collect = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
};

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  delete (window as unknown as { COMPANION?: unknown }).COMPANION;
  delete (window as unknown as { NP_AWSP?: unknown }).NP_AWSP;
  (window as unknown as { kv: unknown }).kv = { get: vi.fn(async () => null) };
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the catalog over a paired PC', () => {
  it('searches through the paired companion and streams the aggregate as chunks', async () => {
    const pc = paired(() => aggregate());
    const client = awspClient(pc.awsp, 'TOWER');

    const chunks = await collect(client.search(params({ offset: 25 }), new AbortController().signal));

    expect(pc.asked[0]?.operation).toBe(AWSP_CATALOG_OPERATIONS.search);
    expect(pc.asked[0]?.args).toMatchObject({ q: 'drake', sections: 'tracks,artists,albums', offset: 25, limit: 25 });
    expect(chunks.map((c) => c.type)).toEqual(['results', 'done']);
    const results = chunks[0]!;
    expect(results.type === 'results' && results.tracks[0]?.id).toBe('deezer:1');
    expect(results.type === 'results' && results.albums[0]?.id).toBe('deezer:6575789');
    const done = chunks[1]!;
    expect(done.type === 'done' && done.page.tracks?.hasMore).toBe(true);
    expect(done.type === 'done' && done.totals.tracks).toBe(1);
  });

  it('never names a provider, and never asks for a page the transport cannot carry', async () => {
    const pc = paired(() => aggregate());
    const client = awspClient(pc.awsp, 'TOWER');

    await collect(
      client.search(
        params({ providers: ['itunes', 'deezer'], limit: 500, offset: 9_000 }),
        new AbortController().signal,
      ),
    );

    const args = pc.asked[0]!.args;
    expect(args['providers'], 'the helper picks its own services').toBeUndefined();
    expect(args['limit']).toBe(AWSP_CATALOG_PAGE_MAX);
    expect(Number(args['offset'])).toBeLessThanOrEqual(1000);
  });

  it('carries the advanced fields, and asks for nothing when there is nothing to look for', async () => {
    const pc = paired(() => aggregate());
    const client = awspClient(pc.awsp, 'TOWER');

    await collect(
      client.search(
        params({ q: '', track: 'Hold On', artist: 'Drake', album: 'Take Care' }),
        new AbortController().signal,
      ),
    );
    expect(pc.asked[0]?.args).toMatchObject({ track: 'Hold On', artist: 'Drake', album: 'Take Care' });
    expect(pc.asked[0]?.args['q']).toBeUndefined();

    await expect(
      collect(client.search(params({ q: '   ' }), new AbortController().signal)),
    ).rejects.toThrow(Unreachable);
    expect(pc.asked, 'an empty query is never sent').toHaveLength(1);
  });

  it('opens an album, an artist’s next page of albums and a pasted link', async () => {
    const pc = paired((operation) =>
      operation === AWSP_CATALOG_OPERATIONS.album
        ? albumDetail()
        : operation === AWSP_CATALOG_OPERATIONS.artist
          ? artistDetail()
          : resolved(),
    );
    const client = awspClient(pc.awsp, 'TOWER');

    const album = await client.album('deezer:6575789', 0, 200);
    expect(pc.asked[0]).toMatchObject({
      operation: AWSP_CATALOG_OPERATIONS.album,
      args: { id: 'deezer:6575789', offset: 0, limit: AWSP_CATALOG_PAGE_MAX },
    });
    expect(album.page.hasMore).toBe(true);
    expect(album.page.tracks[0]?.title).toBe('Hold On');

    const artist = await client.artist('deezer:246791', 25);
    expect(pc.asked[1]).toMatchObject({
      operation: AWSP_CATALOG_OPERATIONS.artist,
      args: { id: 'deezer:246791', albumsOffset: 25 },
    });
    expect(artist.albumsPage.hasMore).toBe(true);

    const link = await client.resolve('https://www.deezer.com/album/6575789', 0, 100);
    expect(pc.asked[2]).toMatchObject({
      operation: AWSP_CATALOG_OPERATIONS.resolve,
      args: { url: 'https://www.deezer.com/album/6575789' },
    });
    expect(link.collection?.page.tracks).toHaveLength(1);
  });

  it('refuses an id or a link that is not the catalog’s, before it reaches the PC', async () => {
    const pc = paired(() => albumDetail());
    const client = awspClient(pc.awsp, 'TOWER');

    for (const id of ['../../helper/v1/settings', 'http://127.0.0.1:9/x', 'shell:1', 'deezer:']) {
      await expect(client.album(id, 0, 50)).rejects.toThrow(Unreachable);
      await expect(client.artist(id)).rejects.toThrow(Unreachable);
    }
    for (const url of [
      'http://www.deezer.com/album/1',
      'https://127.0.0.1/helper/v1/settings',
      'https://deezer.com.attacker.example/album/1',
      'javascript:alert(1)',
      // spotDL needs 20-50 s: longer than the paired transport waits, so another client reads it.
      'https://open.spotify.com/album/1',
    ]) {
      await expect(client.resolve(url, 0, 50)).rejects.toThrow(Unreachable);
    }
    expect(pc.awsp.companion, 'nothing left the player').not.toHaveBeenCalled();
  });

  it('keeps lyrics and enrichment off the paired path so another client answers them', async () => {
    const pc = paired(() => aggregate());
    const client = awspClient(pc.awsp, 'TOWER');
    const t = { ...track(), album: null, artists: ['Drake'], durationMs: null, isrc: null } as never;

    await expect(client.lyrics(t)).rejects.toThrow(Unreachable);
    await expect(client.enrich(t)).rejects.toThrow(Unreachable);
    expect(pc.awsp.companion).not.toHaveBeenCalled();
  });

  it('passes a PC that cannot answer, and never repeats what it said about itself', async () => {
    const pc = paired(() => {
      throw new Error('companion-unavailable: Companion service is unavailable');
    });
    const client = awspClient(pc.awsp, 'TOWER');

    await expect(client.album('deezer:6575789', 0, 50)).rejects.toThrow(Unreachable);
    await expect(
      collect(client.search(params(), new AbortController().signal)),
    ).rejects.toThrow(Unreachable);
  });

  it('refuses an answer too large for the paired transport', async () => {
    const big = { ...albumDetail() };
    big.page = { ...big.page, tracks: Array.from({ length: 4000 }, (_, i) => track(`deezer:${i}`)) };
    const client = awspClient(paired(() => big).awsp, 'TOWER');

    await expect(client.album('deezer:6575789', 0, 50)).rejects.toThrow(/too large/i);
  });

  it('gives up before the paired transport’s own deadline', async () => {
    vi.useFakeTimers();
    try {
      const client = awspClient(
        { status: async () => ({ paired: true, serverName: 'TOWER' }), companion: () => new Promise(() => {}) },
        'TOWER',
      );
      const pending = client.album('deezer:6575789', 0, 50);
      const settled = vi.fn();
      void pending.then(settled, settled);
      await vi.advanceTimersByTimeAsync(14_000);
      await expect(pending).rejects.toThrow(Unreachable);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('where the paired PC sits among the clients', () => {
  it('is asked after the hub and this PC’s companion, and before the browser', async () => {
    (window as unknown as { COMPANION: string }).COMPANION = 'http://127.0.0.1:7777';
    (window as unknown as { kv: unknown }).kv = {
      get: vi.fn(async () => ({ base: 'https://hub.example', credentialId: 'dev', secret: 'fixture-secret' })),
    };
    (window as unknown as { NP_AWSP: unknown }).NP_AWSP = paired(() => aggregate()).awsp;

    const order = (await clients()).map((c) => c.kind);

    expect(order).toEqual(['hub', 'helper', 'awsp', 'browser']);
  });

  it('is not offered when no PC is paired', async () => {
    (window as unknown as { NP_AWSP: unknown }).NP_AWSP = {
      status: vi.fn(async () => ({ paired: false, serverName: null })),
      companion: vi.fn(),
    };

    const list = await clients();

    expect(list.map((c) => c.kind)).toEqual(['browser']);
    expect((window as unknown as { NP_AWSP: { companion: ReturnType<typeof vi.fn> } }).NP_AWSP.companion).not.toHaveBeenCalled();
  });

  it('names the PC without repeating its ticket or any credential', async () => {
    (window as unknown as { NP_AWSP: unknown }).NP_AWSP = paired(() => aggregate()).awsp;

    const found = (await clients()).find((c) => c.kind === 'awsp');

    expect(found?.label).toContain('TOWER');
    expect(found?.label).not.toMatch(/endpoint|secret|token/i);
  });
});

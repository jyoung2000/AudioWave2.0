/**
 * The Search tool's IPC (DEC-039): every catalog channel is in the preload's allowlist and the main
 * process's registry, and what `CompanionCatalog` answers — from a stand-in helper serving the stock
 * catalog (packages/aqua-ui/styleguide/fixtures/catalog-stock.json) — parses by each channel's
 * response contract. A search's chunks reach the window as `event:catalog-chunk`, tagged with its
 * id; a download takes the helper's own path with the song's best source; stars and the filter stay
 * in the companion's store. No network.
 */
import { describe, expect, it } from 'vitest';
import stock from '../../../packages/aqua-ui/styleguide/fixtures/catalog-stock.json';
import { IPC, IPC_CHANNELS, IPC_EVENTS, IPC_EVENT_NAMES } from '../../src/shared/ipc.js';
import { CompanionCatalog } from '../../src/main/catalog.js';

const CATALOG = ['catalog:search', 'catalog:cancel', 'catalog:album', 'catalog:artist', 'catalog:resolve', 'catalog:lyrics', 'catalog:enrich', 'catalog:download', 'catalog:saved', 'catalog:save', 'catalog:unsave', 'catalog:filter', 'catalog:filter:set'] as const;

function standIn() {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    expect((init?.headers as Record<string, string>)['x-helper-token']).toBe('tok');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    switch (url.pathname) {
      case '/helper/v1/catalog/search':
        return new Response(`${stock.search.map((c) => JSON.stringify(c)).join('\n')}\n`, { headers: { 'content-type': 'application/x-ndjson' } });
      case '/helper/v1/catalog/album':
        return json(stock.album);
      case '/helper/v1/catalog/artist':
        return json(stock.artist);
      case '/helper/v1/catalog/resolve':
        return json(stock.resolvePlaylist);
      case '/helper/v1/catalog/lyrics':
        return json(stock.lyrics);
      case '/helper/v1/catalog/enrich':
        return json(stock.enrich);
      case '/helper/v1/fetch':
        return json({ id: 'job1', state: 'queued', url: JSON.parse(String(init?.body)).url, tool: 'yt-dlp', format: 'original', stage: 'preflight', startedAt: '2026-10-06T12:00:00.000Z' }, 202);
      default:
        return json({ error: 'not-found', message: 'No such route.' }, 404);
    }
  }) as typeof fetch;
  const kept = new Map<string, unknown>();
  const sent: Array<{ searchId: string; chunk: unknown }> = [];
  const catalog = new CompanionCatalog({
    helper: () => ({ origin: 'http://127.0.0.1:17342', token: 'tok', reason: null }),
    store: { get: <T,>(key: string, fallback: T) => (kept.has(key) ? (kept.get(key) as T) : fallback), set: (key, value) => void kept.set(key, value) },
    send: (payload) => sent.push(payload),
    fetchImpl,
  });
  return { catalog, calls, sent };
}

describe('the Search tool’s channels', () => {
  it('are allowlisted, with request and response contracts, and the chunk event is declared', () => {
    for (const channel of CATALOG) {
      expect(IPC_CHANNELS).toContain(channel);
      expect(IPC[channel].request).toBeDefined();
    }
    expect(IPC_EVENT_NAMES).toContain('event:catalog-chunk');
    // A search id is a word, never a path or a script.
    expect(IPC['catalog:search'].request.safeParse({ searchId: '../x', sections: ['tracks'], providers: ['itunes'] }).success).toBe(false);
    expect(IPC['catalog:resolve'].request.safeParse({ url: 'https://x', limit: 500 }).success).toBe(false);
  });

  it('a search streams its chunks to the window, tagged, and answers when it is done', async () => {
    const { catalog, calls, sent } = standIn();
    const request = IPC['catalog:search'].request.parse({ searchId: 's1', q: 'harbour', sections: ['tracks', 'artists'], providers: ['itunes', 'deezer'] });
    const answer = await catalog.search(request);
    expect(IPC['catalog:search'].response.parse(answer)).toEqual({ reason: null });
    expect(sent).toHaveLength(stock.search.length);
    for (const payload of sent) expect(IPC_EVENTS['event:catalog-chunk'].safeParse(payload).success).toBe(true);
    expect(calls[0]!.url.searchParams.get('sections')).toBe('tracks,artists');
    expect(calls[0]!.url.searchParams.get('providers')).toBe('itunes,deezer');
  });

  it('every read parses by its contract', async () => {
    const { catalog } = standIn();
    expect(IPC['catalog:album'].response.parse(await catalog.album('deezer:9201', 0, 50)).result?.album.title).toBe('Harbour Lights');
    expect(IPC['catalog:artist'].response.parse(await catalog.artist('deezer:9301', 0)).result?.artist.name).toBe('Cassette Bloom');
    expect(IPC['catalog:resolve'].response.parse(await catalog.resolve(stock.playlistUrl, 0, 50)).result?.collection?.page.total).toBe(6);
    expect(IPC['catalog:lyrics'].response.parse(await catalog.lyrics({ title: 'Harbour Lights', artist: 'Cassette Bloom' })).result?.found).toBe(true);
    expect(IPC['catalog:enrich'].response.parse(await catalog.enrich({ isrc: 'QZAAA2600101' })).result?.label).toBe('Pier Records');
  });

  it('a download takes the helper’s own path from the song’s best source, with the rights basis', async () => {
    const { catalog, calls } = standIn();
    const track = stock.album.page.tracks[0]!;
    const answer = IPC['catalog:download'].response.parse(await catalog.download({ track: track as never, basis: 'user-owned' }));
    expect(answer.source).toMatchObject({ platform: 'youtube-music' });
    const post = calls.find((c) => c.url.pathname === '/helper/v1/fetch')!;
    expect(JSON.parse(String(post.init?.body))).toMatchObject({ url: 'https://music.youtube.com/watch?v=mockHL0001', tool: 'auto', authorization: { basis: 'user-owned', acknowledged: true } });
  });

  it('says why when the helper is not running, instead of failing', async () => {
    const catalog = new CompanionCatalog({ helper: () => ({ origin: null, token: null, reason: 'Port 17342 is already in use on this PC.' }), store: { get: (_k, f) => f, set: () => undefined }, send: () => undefined });
    expect(await catalog.search(IPC['catalog:search'].request.parse({ searchId: 's', q: 'x', sections: ['tracks'], providers: ['itunes'] }))).toEqual({ reason: 'Port 17342 is already in use on this PC.' });
    expect((await catalog.album('deezer:1', 0, 50)).reason).toBe('Port 17342 is already in use on this PC.');
  });

  it('keeps starred albums and playlists and the filter in the companion’s store', () => {
    const { catalog } = standIn();
    const saved = stock.saved.items[0]!;
    expect(IPC['catalog:save'].response.parse(catalog.save(saved as never)).items).toHaveLength(1);
    expect(catalog.save({ ...saved, trackCount: 7 } as never).items.map((i) => i.trackCount)).toEqual([7]);
    expect(IPC['catalog:unsave'].response.parse(catalog.unsave(saved.ref as never)).items).toEqual([]);
    expect(catalog.filter()).toEqual({ sections: ['tracks', 'artists', 'albums'], providers: ['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud'] });
    expect(catalog.setFilter({ sections: ['tracks'], providers: ['deezer'] })).toEqual({ sections: ['tracks'], providers: ['deezer'] });
  });
});

import { describe, expect, it } from 'vitest';
import { CatalogTrack } from '@now-playing/contracts';
import stock from '../../../packages/aqua-ui/styleguide/fixtures/catalog-stock.json';
import { CompanionCatalog } from '../../src/main/catalog.js';

function makeCatalog(responseFor: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const posts: Array<{ url: URL; body: unknown }> = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/helper/v1/fetch') posts.push({ url, body: JSON.parse(String(init?.body)) });
    return responseFor(url, init);
  }) as typeof fetch;
  return {
    posts,
    catalog: new CompanionCatalog({
      helper: () => ({ origin: 'http://127.0.0.1:17342', token: 'local-token', reason: null }),
      store: { get: (_key, fallback) => fallback, set: () => undefined },
      send: () => undefined,
      fetchImpl,
    }),
  };
}

const tracks = stock.album.page.tracks.slice(0, 2).map((track) => CatalogTrack.parse(track));
const job = (url: string, id: string) => ({ id, state: 'queued', url, tool: 'yt-dlp', format: 'original', stage: 'preflight', startedAt: '2026-10-14T10:00:00.000Z' });

describe('authorized batch downloads after starring a catalog collection', () => {
  it('preflights every song before queueing any job', async () => {
    const unavailable = CatalogTrack.parse({ ...tracks[1], title: 'Unavailable', sources: tracks[1]!.sources.filter((source) => source.platform === 'deezer') });
    const h = makeCatalog((url) => {
      if (url.pathname === '/helper/v1/catalog/enrich') return Response.json({ ...stock.enrich, sources: [] });
      return Response.json({ error: 'not-found' }, { status: 404 });
    });

    const result = await (h.catalog as unknown as { downloadBatch: (input: unknown) => Promise<{ jobs: unknown[]; queued: number; reason: string | null }> }).downloadBatch({ tracks: [tracks[0], unavailable], basis: 'user-owned' });

    expect(result.queued).toBe(0);
    expect(result.jobs).toEqual([]);
    expect(result.reason).toMatch(/“Unavailable” has no downloadable source/i);
    expect(h.posts).toEqual([]);
  });

  it('queues each track with the single explicit rights basis after all sources are ready', async () => {
    const h = makeCatalog((url, init) => {
      if (url.pathname === '/helper/v1/fetch') {
        const body = JSON.parse(String(init?.body)) as { url: string; authorization: { basis: string; acknowledged: boolean } };
        return Response.json(job(body.url, `job-${h.posts.length}`), { status: 202 });
      }
      if (url.pathname === '/helper/v1/catalog/enrich') return Response.json(stock.enrich);
      return Response.json({ error: 'not-found' }, { status: 404 });
    });

    const result = await (h.catalog as unknown as { downloadBatch: (input: unknown) => Promise<{ jobs: unknown[]; queued: number; reason: string | null }> }).downloadBatch({ tracks, basis: 'user-owned' });

    expect(result.reason).toBeNull();
    expect(result.queued).toBe(2);
    expect(result.jobs).toHaveLength(2);
    expect(h.posts).toHaveLength(2);
    expect(h.posts.every((post) => (post.body as { authorization: { basis: string; acknowledged: boolean } }).authorization.basis === 'user-owned')).toBe(true);
    expect(h.posts.every((post) => (post.body as { authorization: { acknowledged: boolean } }).authorization.acknowledged)).toBe(true);
  });
});

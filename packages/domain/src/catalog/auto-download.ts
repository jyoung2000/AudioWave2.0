import { CATALOG_COLLECTION_CAP } from '@now-playing/contracts';

export interface CatalogBatchPage<TTrack> {
  tracks: TTrack[];
  hasMore: boolean;
  capped: boolean;
}

/** Queueing failed after some entries were accepted; the caller can report the exact partial count. */
export class CatalogBatchQueueError extends Error {
  constructor(message: string, readonly queued: number) {
    super(message);
    this.name = 'CatalogBatchQueueError';
  }
}

/** Resolve every page of a collection before a caller authorizes or queues any entry. */
export async function resolveCatalogBatchTracks<TTrack extends { id: string; title: string }>(
  readPage: (offset: number) => Promise<CatalogBatchPage<TTrack>>,
): Promise<TTrack[]> {
  const tracks: TTrack[] = [];
  let offset = 0;
  while (true) {
    let page: CatalogBatchPage<TTrack>;
    try {
      page = await readPage(offset);
    } catch (error) {
      throw new CatalogBatchQueueError(error instanceof Error ? error.message : String(error), 0);
    }
    if (page.capped) throw new CatalogBatchQueueError('This list is too large to download as a complete batch.', 0);
    tracks.push(...page.tracks);
    if (tracks.length > CATALOG_COLLECTION_CAP) throw new CatalogBatchQueueError('This list is too large to download as a complete batch.', 0);
    if (!page.hasMore) break;
    if (!page.tracks.length) throw new CatalogBatchQueueError('The catalog returned an incomplete list; no downloads were queued.', 0);
    const next = offset + page.tracks.length;
    if (next <= offset || next > CATALOG_COLLECTION_CAP) throw new CatalogBatchQueueError('This list is too large to download as a complete batch.', 0);
    offset = next;
  }
  if (!tracks.length) throw new CatalogBatchQueueError('This list has no songs to download.', 0);
  return tracks;
}

/**
 * Read every entry, check that every entry has a downloadable source, then queue them in order.
 * No item is queued when paging fails, the collection is capped, or any source is unavailable.
 */
export async function queueResolvedCatalogBatch<TTrack extends { id: string; title: string }, TSource>(
  readPage: (offset: number) => Promise<CatalogBatchPage<TTrack>>,
  resolveSource: (track: TTrack) => Promise<TSource | null>,
  enqueue: (track: TTrack, source: TSource) => Promise<unknown>,
  preflight?: (items: readonly { track: TTrack; source: TSource }[]) => Promise<void>,
): Promise<{ queued: number; total: number }> {
  const tracks: TTrack[] = [];
  let offset = 0;
  while (true) {
    let page: CatalogBatchPage<TTrack>;
    try {
      page = await readPage(offset);
    } catch (error) {
      throw new CatalogBatchQueueError(error instanceof Error ? error.message : String(error), 0);
    }
    if (page.capped) throw new CatalogBatchQueueError('This list is too large to download as a complete batch.', 0);
    tracks.push(...page.tracks);
    if (tracks.length > CATALOG_COLLECTION_CAP) throw new CatalogBatchQueueError('This list is too large to download as a complete batch.', 0);
    if (!page.hasMore) break;
    if (!page.tracks.length) throw new CatalogBatchQueueError('The catalog returned an incomplete list; no downloads were queued.', 0);
    const next = offset + page.tracks.length;
    if (next <= offset || next > CATALOG_COLLECTION_CAP) throw new CatalogBatchQueueError('This list is too large to download as a complete batch.', 0);
    offset = next;
  }
  if (!tracks.length) throw new CatalogBatchQueueError('This list has no songs to download.', 0);

  const sources = await mapLimit(tracks, 4, resolveSource).catch((error: unknown) => {
    throw new CatalogBatchQueueError(error instanceof Error ? error.message : String(error), 0);
  });
  const unavailable = sources.findIndex((source) => source === null);
  if (unavailable >= 0) throw new CatalogBatchQueueError(`“${tracks[unavailable]!.title}” has no downloadable source. No downloads were queued.`, 0);

  if (preflight) {
    try {
      await preflight(tracks.map((track, index) => ({ track, source: sources[index]! })));
    } catch (error) {
      throw new CatalogBatchQueueError(error instanceof Error ? error.message : String(error), 0);
    }
  }

  let queued = 0;
  for (let index = 0; index < tracks.length; index += 1) {
    try {
      await enqueue(tracks[index]!, sources[index]!);
      queued += 1;
    } catch (error) {
      throw new CatalogBatchQueueError(error instanceof Error ? error.message : String(error), queued);
    }
  }
  return { queued, total: tracks.length };
}

async function mapLimit<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      output[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return output;
}

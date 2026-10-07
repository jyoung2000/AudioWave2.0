/**
 * The music catalog (DEC-039) answered from stock, for the hub's and the companion's mockups: one
 * search ("harbour") streamed as the hub streams it, its next page, a pasted Spotify playlist and an
 * Apple Music playlist link, an album, an artist, lyrics, details, the saved list and the settings.
 *
 * The answers are packages/aqua-ui/styleguide/fixtures/catalog-stock.json, written (and checked
 * against the contracts) by make-catalog-stock.mts beside it — the same answers the style guide,
 * the hub's end-to-end test and both apps' DOM tests use. Invented music, drawn covers, no network.
 */
import stock from '../../../packages/aqua-ui/styleguide/fixtures/catalog-stock.json' with { type: 'json' };

export const CATALOG_STOCK = stock;

/** The chunks a search for `q` streams: the stock search, its next page, or a pasted link named for resolve. */
export function searchChunks(q, offset = 0) {
  if (/^https?:\/\//i.test(q)) return [{ ...stock.searchLink[0], query: { ...stock.searchLink[0].query, text: q, url: q }, resolve: q }];
  return offset > 0 ? stock.searchPage2 : stock.search;
}

export function resolveAnswer(url) {
  return url === stock.playlistUrl ? stock.resolvePlaylist : { ...stock.resolveUnsupported, url };
}

/** `/api/v1/catalog/*` on the hub, or null for anything else. */
export function hubCatalogAnswer(method, pathname, params) {
  if (!pathname.startsWith('/api/v1/catalog/')) return null;
  const route = pathname.slice('/api/v1/catalog/'.length);
  const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (method !== 'GET') return null;
  switch (route) {
    case 'search':
      return { status: 200, contentType: 'application/x-ndjson; charset=utf-8', body: `${searchChunks(params.get('q') ?? '', Number(params.get('offset') ?? 0)).map((chunk) => JSON.stringify(chunk)).join('\n')}\n` };
    case 'album':
      return json(stock.album);
    case 'artist':
      return json(stock.artist);
    case 'resolve':
      return json(resolveAnswer(params.get('url') ?? ''));
    case 'lyrics':
      return json(stock.lyrics);
    case 'enrich':
      return json(stock.enrich);
    case 'saved':
      return json(stock.saved);
    case 'settings':
      return json(stock.settings);
    default:
      return null;
  }
}

/**
 * The playlist folder (DEC-041) answered from stock, for the hub's and the companion's mockups: three
 * lists made from the catalog stock's songs (one made outside Airwave), the first one's songs, and
 * each app's folder. The answers are packages/aqua-ui/styleguide/fixtures/playlists-stock.json — the
 * same the style guide shows. A song asked about (`catalogId`) is ticked in the first list only.
 */
import stock from '../../../packages/aqua-ui/styleguide/fixtures/playlists-stock.json' with { type: 'json' };

export const PLAYLISTS_STOCK = stock;

/** The folder's lists, with `hasTrack` when a song was asked about. */
export function playlistList(app, catalogId) {
  return { folder: stock[app].folder, items: stock.items.map((p) => ({ ...p, ...(app === 'companion' && p.createdBy ? { createdBy: 'companion' } : {}), hasTrack: catalogId ? p.id === stock.hasTrack : null })) };
}

/** `/api/v1/playlists/*` on the hub (reads only), or null for anything else. */
export function hubPlaylistsAnswer(method, pathname, params) {
  if (method !== 'GET' || !pathname.startsWith('/api/v1/playlists')) return null;
  const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (pathname === '/api/v1/playlists') return json(playlistList('hub', params.get('catalogId')));
  if (pathname === '/api/v1/playlists/folder') return json(stock.hub.folder);
  const id = decodeURIComponent(pathname.slice('/api/v1/playlists/'.length));
  if (id === stock.page.playlist.id) return json(stock.page);
  return { status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not found', status: 404, detail: 'That playlist isn’t in the playlist folder any more.' }) };
}

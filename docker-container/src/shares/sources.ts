/**
 * What the admin window can make a shared link to: the playlists devices have synced to the hub,
 * and the albums in the hub's own library.
 *
 * A device shares from its own library and uploads the item list itself. The admin has no library
 * of its own, so for a playlist the hub builds that list from the synced copy — the same metadata a
 * device would have sent. Nothing about what a link grants changes: items stream only where the hub
 * holds the same file, and everything else opens at its source.
 */
import type { PlaylistItem, ShareSources } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import type { CreateShareInput } from './service.js';
import type { HubContext } from '../context.js';

type Ctx = Pick<HubContext, 'repos' | 'library'>;

function livePlaylists(ctx: Ctx): Array<{ id: string; name: string }> {
  return ctx.repos.sync
    .all('playlists')
    .filter((p) => !p.deletedAt && typeof (p as { name?: unknown }).name === 'string')
    .map((p) => ({ id: p.id, name: (p as unknown as { name: string }).name }));
}

function itemsOf(ctx: Ctx, playlistId: string): PlaylistItem[] {
  return (ctx.repos.sync.all('playlistItems') as unknown as Array<PlaylistItem & { deletedAt: string | null }>)
    .filter((i) => !i.deletedAt && i.playlistId === playlistId && i.track && typeof i.track.title === 'string')
    .sort((a, b) => a.position - b.position);
}

export function shareSources(ctx: Ctx): ShareSources {
  const counts = new Map<string, number>();
  for (const item of ctx.repos.sync.all('playlistItems') as unknown as Array<{ playlistId?: string; deletedAt: string | null }>) {
    if (!item.deletedAt && item.playlistId) counts.set(item.playlistId, (counts.get(item.playlistId) ?? 0) + 1);
  }
  const playlists = livePlaylists(ctx)
    .map((p) => ({ ...p, trackCount: counts.get(p.id) ?? 0 }))
    .filter((p) => p.trackCount > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const albums = new Map<string, { id: string; title: string; artistName: string | null; trackCount: number }>();
  for (const rec of ctx.library.allTracks()) {
    const title = rec.track.albumName;
    if (!title) continue;
    // The share service finds an album by its id or, failing that, by its name.
    const id = (rec.track.albumId ?? title).slice(0, 200);
    const album = albums.get(id) ?? { id, title, artistName: rec.track.artistName ?? null, trackCount: 0 };
    if (album.artistName !== rec.track.artistName) album.artistName = album.trackCount ? null : rec.track.artistName;
    album.trackCount += 1;
    albums.set(id, album);
  }
  return { playlists, albums: [...albums.values()].sort((a, b) => a.title.localeCompare(b.title)) };
}

/** The item list for a synced playlist, as a device would have uploaded it. */
export function playlistShare(ctx: Ctx, playlistId: string): { title: string; items: NonNullable<CreateShareInput['items']> } {
  const playlist = livePlaylists(ctx).find((p) => p.id === playlistId);
  if (!playlist) throw new DomainError('not-found', 'That playlist isn’t on the hub any more.');
  const items = itemsOf(ctx, playlistId).map((item) => {
    const hubTrack = ctx.library.findTrack(item.track.trackId);
    return {
      trackId: item.track.trackId,
      title: item.track.title,
      artistName: item.track.artistName,
      albumName: item.track.albumName ?? null,
      durationMs: item.track.durationMs ?? null,
      contentHash: item.track.identity?.contentHash ?? hubTrack?.contentHash ?? null,
      openAtSourceUrl: null,
    };
  });
  if (!items.length) throw new DomainError('validation', 'That playlist is empty, so there is nothing to share.');
  return { title: playlist.name, items };
}

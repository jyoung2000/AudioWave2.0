/**
 * The hub's playlist folder (DEC-041): `/api/v1/playlists/*`. The admin may do everything; a device
 * needs `playlists:use` and is held to the rules in `playlists/service.ts` (it files songs into any
 * list, and changes or deletes only what it made or added).
 */
import type { FastifyInstance } from 'fastify';
import { routes } from '@now-playing/contracts';
import type { HubContext } from '../../context.js';
import { actorDisplayName, type Principal } from '../../auth/principal.js';
import { playlistActor } from '../../playlists/service.js';
import { RAW, registerRoute, type RawResponse } from '../register.js';

export function registerPlaylistRoutes(app: FastifyInstance, ctx: HubContext): void {
  const audit = (principal: Principal, action: string, target: string | null, meta: { ip: string | null; correlationId: string }, details?: Record<string, string | number | boolean | null>): void => {
    ctx.audit.record({
      actor: principal.kind === 'device' ? { kind: 'device', id: principal.deviceId, displayName: actorDisplayName(principal) } : { kind: 'admin', id: principal.kind === 'admin' ? principal.userId : 'admin', displayName: actorDisplayName(principal) },
      action,
      outcome: 'success',
      target: target ? { kind: 'playlist', id: target } : null,
      ip: meta.ip,
      correlationId: meta.correlationId,
      ...(details ? { details } : {}),
    });
  };

  registerRoute(app, ctx, routes.playlistsList, ({ query }) => ctx.playlists.list({ catalogId: query.catalogId, isrc: query.isrc }));

  registerRoute(app, ctx, routes.playlistsCreate, async ({ body, principal, ip, correlationId, reply }) => {
    const made = await ctx.playlists.store.create({ name: body.name, description: body.description ?? null, tracks: body.tracks }, playlistActor(principal));
    audit(principal, 'playlists.create', made.id, { ip, correlationId }, { entries: made.entryCount });
    reply.status(201);
    return made;
  });

  registerRoute(app, ctx, routes.playlistsFolderGet, () => ctx.playlists.info());

  registerRoute(app, ctx, routes.playlistsFolderPut, async ({ body, principal, ip, correlationId }) => {
    const result = await ctx.playlists.changeFolder(body.relativePath, body.move);
    audit(principal, 'playlists.folder', null, { ip, correlationId }, { folder: result.folder.relativePath, moved: result.moved, failed: result.failed.length });
    return result;
  });

  registerRoute(app, ctx, routes.playlistsGet, ({ params, query }) => ctx.playlists.store.page(params.playlistId, query.offset, query.limit));

  registerRoute(app, ctx, routes.playlistsUpdate, async ({ params, body, principal, ip, correlationId }) => {
    ctx.playlists.assertOwner(principal, await ctx.playlists.store.get(params.playlistId));
    const updated = await ctx.playlists.store.update(params.playlistId, body);
    audit(principal, 'playlists.update', updated.id, { ip, correlationId }, { renamed: body.name !== undefined });
    return updated;
  });

  registerRoute(app, ctx, routes.playlistsDelete, async ({ params, principal, ip, correlationId }) => {
    ctx.playlists.assertOwner(principal, await ctx.playlists.store.get(params.playlistId));
    await ctx.playlists.store.delete(params.playlistId);
    audit(principal, 'playlists.delete', params.playlistId, { ip, correlationId });
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.playlistsAdd, async ({ params, body, principal, ip, correlationId }) => {
    const result = await ctx.playlists.store.add(params.playlistId, body.tracks, { position: body.position, allowDuplicates: body.allowDuplicates }, playlistActor(principal));
    audit(principal, 'playlists.add', result.playlist.id, { ip, correlationId }, { added: result.added, skipped: result.skipped });
    return result;
  });

  registerRoute(app, ctx, routes.playlistsRemove, async ({ params, body, principal, ip, correlationId }) => {
    const rule = ctx.playlists.removalRule(principal, await ctx.playlists.store.get(params.playlistId));
    const updated = await ctx.playlists.store.removeEntries(params.playlistId, body.entryIds, rule);
    audit(principal, 'playlists.remove', updated.id, { ip, correlationId }, { removed: body.entryIds.length });
    return updated;
  });

  registerRoute(app, ctx, routes.playlistsMove, async ({ params, body, principal }) => {
    ctx.playlists.assertOwner(principal, await ctx.playlists.store.get(params.playlistId));
    return ctx.playlists.store.move(params.playlistId, body.entryId, body.to);
  });

  registerRoute(app, ctx, routes.playlistsExport, async ({ params, reply }): Promise<RawResponse> => {
    const { fileName, text } = await ctx.playlists.store.exportText(params.playlistId);
    // The name is the file's own (already sanitised); the ASCII fallback drops anything else.
    const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
    reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .type('audio/x-mpegurl; charset=utf-8')
      .send(text);
    return RAW;
  });
}

/**
 * Profiles: what a paired person keeps on the hub — a username, a picture, shared playlists — and
 * what other paired people can see of it.
 *
 * Nothing here is anonymous. Every route needs a device credential carrying `profile:read` or
 * `profile:write`, and the first-run gate applies like everywhere else. A profile belongs to the
 * HubUser behind the credential, so two devices paired for the same person share one.
 */
import type { FastifyInstance } from 'fastify';
import { routes } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import type { HubContext } from '../../context.js';
import type { Principal } from '../../auth/principal.js';
import { AVATAR_MAX_BYTES, PLAYLIST_MAX_BYTES, type ProfileActor } from '../../profiles/service.js';
import { RAW, registerRoute } from '../register.js';

/** The HubUser a device credential stands for. A device paired before hub users existed has none. */
export function profileIdOf(principal: Principal): string {
  if (principal.kind !== 'device') throw new DomainError('unauthenticated', 'Device credential required');
  if (!principal.hubUserId) throw new DomainError('conflict', 'This device has no profile on the hub; pair it again');
  return principal.hubUserId;
}

function actorOf(principal: Principal): ProfileActor {
  if (principal.kind === 'admin') return { kind: 'admin', id: principal.userId, displayName: principal.username };
  if (principal.kind === 'device') return { kind: 'device', id: principal.deviceId, displayName: principal.displayName };
  throw new DomainError('unauthenticated', 'Authentication required');
}

export function registerProfileRoutes(app: FastifyInstance, ctx: HubContext): void {
  const ok = { ok: true as const };

  registerRoute(app, ctx, routes.profilesMe, ({ principal }) => ctx.profiles.view(profileIdOf(principal)));

  registerRoute(app, ctx, routes.profilesMeUpdate, ({ body, principal, ip, correlationId }) => ctx.profiles.rename(profileIdOf(principal), body.displayName, actorOf(principal), { ip, correlationId }));

  registerRoute(app, ctx, routes.profilesAvailable, ({ query, principal }) => ({ available: ctx.profiles.available(query.name, profileIdOf(principal)) }));

  registerRoute(
    app,
    ctx,
    routes.profilesAvatarPut,
    async ({ req, principal, ip, correlationId }) => {
      if (!Buffer.isBuffer(req.body)) throw new DomainError('validation', 'Send the picture as image/png, image/jpeg or image/webp');
      await ctx.profiles.putAvatar(profileIdOf(principal), req.body, actorOf(principal), { ip, correlationId });
      return ok;
    },
    { bodyLimit: AVATAR_MAX_BYTES + 1024 },
  );

  registerRoute(app, ctx, routes.profilesAvatarDelete, ({ principal, ip, correlationId }) => {
    ctx.profiles.removeAvatar(profileIdOf(principal), actorOf(principal), { ip, correlationId });
    return ok;
  });

  registerRoute(
    app,
    ctx,
    routes.profilesPlaylistPut,
    ({ params, query, req, principal }) => {
      if (typeof req.body !== 'string') throw new DomainError('validation', 'Send the playlist as text/csv');
      ctx.profiles.putPlaylist(profileIdOf(principal), params.playlistId, query.name, req.body);
      return ok;
    },
    { bodyLimit: PLAYLIST_MAX_BYTES + 1024 },
  );

  registerRoute(app, ctx, routes.profilesPlaylistDelete, ({ params, principal }) => {
    ctx.profiles.removePlaylist(profileIdOf(principal), params.playlistId);
    return ok;
  });

  registerRoute(app, ctx, routes.profilesSearch, ({ query, principal }) => ({ items: ctx.profiles.search(query.q, query.limit, profileIdOf(principal)) }));

  registerRoute(app, ctx, routes.profilesGet, ({ params }) => ctx.profiles.view(params.id));

  registerRoute(app, ctx, routes.profilesAvatarGet, ({ params, reply }) => {
    const bytes = ctx.profiles.avatarBytes(params.id);
    reply.header('Cache-Control', 'private, max-age=300').header('X-Content-Type-Options', 'nosniff').type('image/webp').send(bytes);
    return RAW;
  });

  registerRoute(app, ctx, routes.profilesPlaylistCsv, ({ params, reply }) => {
    const playlistId = params.playlistFile.slice(0, -'.csv'.length);
    const csv = ctx.profiles.playlistCsv(params.id, playlistId);
    reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', 'attachment; filename="playlist.csv"').type('text/csv; charset=utf-8').send(csv);
    return RAW;
  });

  /* ------------------------------------------------------------ moderation */

  registerRoute(app, ctx, routes.profilesAdminList, () => ({ items: ctx.profiles.listAll() }));

  registerRoute(app, ctx, routes.profilesAdminRename, ({ params, body, principal, ip, correlationId }) => {
    ctx.profiles.rename(params.id, body.displayName, actorOf(principal), { ip, correlationId });
    return ctx.profiles.adminView(params.id);
  });

  registerRoute(app, ctx, routes.profilesAdminAvatarDelete, ({ params, principal, ip, correlationId }) => {
    ctx.profiles.removeAvatar(params.id, actorOf(principal), { ip, correlationId });
    return ok;
  });
}

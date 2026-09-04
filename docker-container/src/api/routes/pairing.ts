/**
 * Pairing and device management.
 *
 * The pairing flow is deliberately four calls rather than one: create (admin) → claim (device) →
 * confirm (admin, after comparing a fingerprint shown on both screens) → complete (device, single
 * use). A code alone never grants a credential, which is what stops a shoulder-surfed or guessed
 * code from being enough (docs/PAIRING_AND_SYNC.md).
 *
 * Note what these handlers never do: log a code, return a code in a list, or return a claim secret
 * to anyone but the claiming device.
 */
import type { FastifyInstance } from 'fastify';
import { routes } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import { hubIdentity, type HubContext } from '../../context.js';
import { actorDisplayName, actorId } from '../../auth/principal.js';
import { registerRoute } from '../register.js';

export function registerPairingRoutes(app: FastifyInstance, ctx: HubContext): void {
  registerRoute(app, ctx, routes.pairingCreate, async ({ body, principal, ip, userAgent, correlationId, reply }) => {
    const result = await ctx.pairing.create({ deviceKind: body.deviceKind, scopes: body.scopes, ttlSeconds: body.ttlSeconds }, { ip, userAgent, correlationId }, { id: actorId(principal), displayName: actorDisplayName(principal) });
    reply.status(201);
    return result;
  });

  registerRoute(app, ctx, routes.pairingList, () => ({ items: ctx.pairing.list() }));

  registerRoute(app, ctx, routes.pairingRevoke, ({ params, principal, ip, userAgent, correlationId }) => {
    ctx.pairing.revoke(params.sessionId, { ip, userAgent, correlationId }, { id: actorId(principal), displayName: actorDisplayName(principal) });
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.pairingClaim, ({ body, ip, userAgent, correlationId }) =>
    ctx.pairing.claim({ code: body.code, deviceName: body.deviceName, deviceKind: body.deviceKind, publicKey: body.publicKey, appVersion: body.appVersion, protocolVersion: body.protocolVersion, platform: body.platform ?? null }, { ip, userAgent, correlationId }),
  );

  registerRoute(app, ctx, routes.pairingConfirm, ({ params, body, principal, ip, userAgent, correlationId }) => {
    ctx.pairing.confirm(params.sessionId, body.verificationFingerprint, { ip, userAgent, correlationId }, { id: actorId(principal), displayName: actorDisplayName(principal) });
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.pairingStatus, ({ body }) => ({ state: ctx.pairing.status(body.sessionId, body.claimSecret) }));

  registerRoute(app, ctx, routes.pairingComplete, ({ body, ip, userAgent, correlationId }) => ctx.pairing.complete(body.sessionId, body.claimSecret, { ip, userAgent, correlationId }));

  /* --------------------------------------------------------------- devices */

  registerRoute(app, ctx, routes.devicesList, () => ({ items: ctx.devices.listViews() }));

  registerRoute(app, ctx, routes.devicesRevoke, ({ params, principal, ip, userAgent, correlationId }) => {
    ctx.devices.revoke(params.deviceId, { ip, userAgent, correlationId }, { id: actorId(principal), displayName: actorDisplayName(principal) });
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.devicesUpdate, ({ params, body, principal, ip, userAgent, correlationId }) =>
    ctx.devices.update(params.deviceId, { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.scopes !== undefined ? { scopes: body.scopes } : {}) }, { ip, userAgent, correlationId }, { id: actorId(principal), displayName: actorDisplayName(principal) }),
  );

  registerRoute(app, ctx, routes.devicesMe, ({ principal }) => {
    if (principal.kind !== 'device') throw new DomainError('unauthenticated', 'Device credential required');
    const user = ctx.devices.userFor(principal.deviceId);
    if (!user) throw new DomainError('not-found', 'This credential is not associated with a hub user; re-pair the device');
    return {
      device: principal.device,
      scopes: principal.scopes,
      hub: hubIdentity(ctx),
      user: { id: user.id, displayName: user.displayName },
    };
  });
}

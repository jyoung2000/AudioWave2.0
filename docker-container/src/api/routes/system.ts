/**
 * Health, version, hub identity and admin authentication.
 *
 * These are the only routes that answer before setup is complete (`setupRequired: false` in the
 * contract), because an operator has to be able to see the hub, log in and change the password
 * before anything else works.
 */
import type { FastifyInstance } from 'fastify';
import { CONTRACTS_VERSION, routes, WS_MIN_SUPPORTED_PROTOCOL_VERSION, WS_PROTOCOL_VERSION } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import { hubIdentity, type HubContext } from '../../context.js';
import { registerRoute } from '../register.js';

export function registerSystemRoutes(app: FastifyInstance, ctx: HubContext): void {
  registerRoute(app, ctx, routes.healthz, () => ({ status: 'ok' as const, version: ctx.version }));

  registerRoute(app, ctx, routes.readyz, ({ reply }) => {
    const checks: Record<string, 'ok' | 'fail' | 'skipped'> = {};
    try {
      ctx.db.prepare('SELECT 1').get();
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'fail';
    }
    checks['migrations'] = ctx.lifecycle.migrationVersion > 0 ? 'ok' : 'fail';
    checks['identity'] = ctx.identity.publicKey ? 'ok' : 'fail';
    checks['setup'] = ctx.auth.setupComplete() ? 'ok' : 'skipped';
    const failed = Object.values(checks).includes('fail');
    const status = ctx.lifecycle.state === 'stopping' ? 'stopping' : ctx.lifecycle.state === 'starting' ? 'starting' : failed ? 'degraded' : 'ok';
    // A degraded hub is still answering, so this stays a 200 with a body the operator can read;
    // only "starting" and "stopping" tell an orchestrator to hold traffic back.
    if (status === 'starting' || status === 'stopping') reply.status(503);
    return { status, checks };
  });

  registerRoute(app, ctx, routes.version, async () => {
    const ffmpeg = await ctx.ffmpeg();
    return {
      version: ctx.version,
      contractsVersion: CONTRACTS_VERSION,
      protocolVersion: WS_PROTOCOL_VERSION,
      minSupportedProtocolVersion: WS_MIN_SUPPORTED_PROTOCOL_VERSION,
      node: process.version,
      ffmpeg: { available: ffmpeg.available, version: ffmpeg.version },
    };
  });

  registerRoute(app, ctx, routes.hubIdentity, () => hubIdentity(ctx));

  /* ------------------------------------------------------------------ auth */

  registerRoute(app, ctx, routes.authSession, ({ principal }) => ctx.auth.infoFor(principal));

  registerRoute(app, ctx, routes.authLogin, async ({ body, ip, userAgent, correlationId, setSessionCookie }) => {
    const result = await ctx.auth.login(body.username, body.password, { ip, userAgent, correlationId });
    setSessionCookie(result.sessionId, result.expiresAt);
    return result.info;
  });

  registerRoute(app, ctx, routes.authChangePassword, async ({ body, principal, ip, userAgent, correlationId, setSessionCookie }) => {
    if (principal.kind !== 'admin') throw new DomainError('unauthenticated', 'Admin session required');
    // Changing the password rotates the session, so the cookie has to be replaced in the same
    // response — otherwise the browser holds a session the hub has just revoked.
    const result = await ctx.auth.changePassword(principal, body.currentPassword, body.newPassword, { ip, userAgent, correlationId });
    setSessionCookie(result.sessionId, result.expiresAt);
    return result.info;
  });

  registerRoute(app, ctx, routes.authLogout, ({ principal, ip, userAgent, correlationId, setSessionCookie }) => {
    if (principal.kind !== 'admin') throw new DomainError('unauthenticated', 'Admin session required');
    ctx.auth.logout(principal, { ip, userAgent, correlationId });
    setSessionCookie(null);
    return { ok: true as const };
  });

  /* -------------------------------------------------------------- security */

  registerRoute(app, ctx, routes.securitySessions, ({ principal }) => {
    if (principal.kind !== 'admin') throw new DomainError('unauthenticated', 'Admin session required');
    return { items: ctx.auth.listSessions(principal) };
  });

  registerRoute(app, ctx, routes.securityRevokeSession, ({ params, principal, ip, userAgent, correlationId }) => {
    if (principal.kind !== 'admin') throw new DomainError('unauthenticated', 'Admin session required');
    if (!ctx.auth.revokeSession(principal, params.sessionId, { ip, userAgent, correlationId })) throw new DomainError('not-found', 'No such session');
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.securityAudit, ({ query }) => {
    const items = ctx.audit.list({ limit: query.limit, before: query.cursor ?? null, action: query.action });
    const last = items[items.length - 1];
    return { items, nextCursor: items.length === query.limit && last ? last.occurredAt : null };
  });
}

/**
 * Search, provider configuration and per-user provider accounts.
 *
 * Two honesty rules are enforced at this layer. Search never hides a provider that failed: the
 * response lists every provider consulted with its state, so "SoundCloud did not answer" is visible
 * rather than showing as fewer results. And provider secrets are write-only: `PUT config` accepts
 * them, `GET config` returns a masked hint and nothing more.
 */
import type { FastifyInstance } from 'fastify';
import { routes } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import type { HubContext } from '../../context.js';
import { actorDisplayName, actorId } from '../../auth/principal.js';
import { escapeHtml } from '../../util.js';
import { RAW, registerRoute, type RawResponse } from '../register.js';

export function registerProviderRoutes(app: FastifyInstance, ctx: HubContext): void {
  registerRoute(app, ctx, routes.search, async ({ query, principal }) =>
    ctx.search.search({
      query: query.q,
      scope: query.scope,
      ...(query.providers ? { providers: query.providers.split(',').map((p) => p.trim()).filter(Boolean) } : {}),
      limit: query.limit,
      cursor: query.cursor ?? null,
      actorId: actorId(principal),
    }),
  );

  registerRoute(app, ctx, routes.providersList, async () => ({ items: ctx.providers.descriptors(), health: await ctx.providers.healthAll() }));

  registerRoute(app, ctx, routes.providersConfigGet, ({ params }) => ctx.providers.configView(params.provider));

  registerRoute(app, ctx, routes.providersConfigPut, ({ params, body, principal, ip, userAgent, correlationId }) =>
    ctx.providers.putConfig(params.provider, body, { ip, userAgent, correlationId }, { id: actorId(principal), displayName: actorDisplayName(principal) }),
  );

  registerRoute(app, ctx, routes.providersTest, ({ params }) => ctx.providers.test(params.provider));

  registerRoute(app, ctx, routes.providersResolve, async ({ query }) => {
    const result = await ctx.search.resolveUrl(query.url);
    if (!result) throw new DomainError('not-found', 'No provider on this hub recognises that link');
    return result;
  });

  registerRoute(app, ctx, routes.providersUsage, async () => {
    const items = await Promise.all(
      ctx.providers.ids().map(async (provider) => {
        const usage = ctx.rateLimiter.usage(provider);
        return { provider, health: await ctx.providers.health(provider), budget: usage.budget, queueDepth: usage.queueDepth, concurrency: usage.concurrency };
      }),
    );
    return { items };
  });

  registerRoute(app, ctx, routes.artistReleases, ({ query }) => ctx.search.latestReleases({ mbid: query.mbid, name: query.name, refresh: query.refresh }));

  /* -------------------------------------------------------------- accounts */

  registerRoute(app, ctx, routes.accountsList, ({ principal }) => {
    const userId = requireUser(ctx, principal);
    return { items: ctx.accounts.list(userId), available: ctx.accounts.available() };
  });

  registerRoute(app, ctx, routes.accountsConnectStart, ({ params, body, principal, baseUrl }) => {
    const userId = requireUser(ctx, principal);
    const deviceId = principal.kind === 'device' ? principal.deviceId : null;
    return ctx.accounts.startConnect(params.provider, userId, deviceId, baseUrl, body.returnTo ?? null);
  });

  /**
   * The provider redirects the person's *browser* here, not the app, so this route answers with a
   * small HTML page rather than JSON. It never renders anything from the query string except
   * through `escapeHtml`, and it carries a CSP nonce like every other hub-served page.
   */
  registerRoute(app, ctx, routes.accountsCallback, async ({ params, query, reply, baseUrl, ip, userAgent, correlationId }): Promise<RawResponse> => {
    let heading: string;
    let detail: string;
    let returnTo: string | null = null;
    if (query.error) {
      heading = 'Connection cancelled';
      detail = `${params.provider} reported: ${query.error}`;
    } else {
      try {
        const result = await ctx.accounts.completeConnect(params.provider, query.code, query.state, baseUrl, { ip, userAgent, correlationId });
        heading = `${params.provider} connected`;
        detail = result.displayName ? `Signed in as ${result.displayName}. You can close this tab and go back to the app.` : 'You can close this tab and go back to the app.';
        returnTo = result.returnTo;
      } catch (err) {
        heading = 'Could not finish connecting';
        detail = err instanceof Error ? err.message : String(err);
      }
    }
    const nonce = ctx.random.bytes(16).reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
      .send(callbackPage({ heading, detail, returnTo, nonce }));
    return RAW;
  });

  registerRoute(app, ctx, routes.accountsDisconnect, ({ params, principal, ip, userAgent, correlationId }) => {
    const userId = requireUser(ctx, principal);
    ctx.accounts.disconnect(params.provider, userId, { ip, userAgent, correlationId }, actorDisplayName(principal));
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.accountsSync, ({ params, principal }) => {
    const userId = requireUser(ctx, principal);
    // Importing a library is background work: the route queues a job and returns its id rather
    // than holding the request open for however long the provider takes.
    const job = ctx.jobs.enqueue({ userId, kind: 'sync-library', priority: 'P2', payload: { provider: params.provider } });
    return { jobId: job.id, status: job.state };
  });

  registerRoute(app, ctx, routes.accountsSyncStatus, ({ params, principal }) => {
    const userId = requireUser(ctx, principal);
    return ctx.accounts.syncStatus(userId, params.provider);
  });
}

/** Provider accounts belong to a hub *user*, not a device, so several devices share one connection. */
function requireUser(ctx: HubContext, principal: { kind: string; deviceId?: string; hubUserId?: string | null }): string {
  if (principal.kind !== 'device' || !principal.deviceId) throw new DomainError('unauthenticated', 'Device credential required');
  const user = ctx.devices.userFor(principal.deviceId);
  if (!user) throw new DomainError('not-found', 'This device has no hub user; re-pair it');
  return user.id;
}

function callbackPage(input: { heading: string; detail: string; returnTo: string | null; nonce: string }): string {
  const back = input.returnTo && /^https?:\/\//i.test(input.returnTo) ? `<p><a href="${escapeHtml(input.returnTo)}">Back to the app</a></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.heading)}</title><style nonce="${input.nonce}">body{font:14px -apple-system,BlinkMacSystemFont,"Lucida Grande",sans-serif;background:#e8e8e8;color:#1a1a1a;margin:0;display:grid;place-items:center;min-height:100vh}main{background:#fff;border:1px solid #b6b6b6;border-radius:8px;padding:28px 32px;max-width:34rem;box-shadow:0 1px 3px rgba(0,0,0,.2)}h1{font-size:16px;margin:0 0 8px}p{margin:0 0 8px;line-height:1.5}a{color:#1a5fb4}</style></head><body><main><h1>${escapeHtml(input.heading)}</h1><p>${escapeHtml(input.detail)}</p>${back}</main></body></html>`;
}

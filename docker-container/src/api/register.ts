import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { API_PREFIX, type RouteContract } from '@now-playing/contracts';
import { DomainError, takeToken, type TokenBucketState } from '@now-playing/domain';
import type { HubContext } from '../context.js';
import { hasScope, missingScopes, type Principal } from '../auth/principal.js';
import { SESSION_COOKIE } from '../auth/service.js';
import type { RateLimitClassName } from '../deps.js';
import { PROBLEM_CONTENT_TYPE, problem, problemFromDomainError } from './problem.js';

/** Per-request context handed to every route handler. */
export interface RequestContext<TParams, TQuery, TBody> {
  params: TParams;
  query: TQuery;
  body: TBody;
  principal: Principal;
  correlationId: string;
  ip: string | null;
  userAgent: string | null;
  /** Origin the request arrived on (scheme + host), derived from trusted proxy headers when present. */
  baseUrl: string;
  secure: boolean;
  req: FastifyRequest;
  reply: FastifyReply;
  /** Set (or clear) the admin session cookie. */
  setSessionCookie(sessionId: string | null, expiresAt?: string): void;
}

/** Handlers that write the response themselves (streams, HTML, CSV) return this sentinel. */
export const RAW = Symbol('raw-response');
export type RawResponse = typeof RAW;

type Infer<T> = T extends z.ZodTypeAny ? z.infer<T> : undefined;

export type RouteHandler<R extends RouteContract> =
  R extends RouteContract<infer P, infer Q, infer B, infer S> ? (ctx: RequestContext<Infer<P>, Infer<Q>, Infer<B>>) => Promise<z.infer<S> | RawResponse> | z.infer<S> | RawResponse : never;

export const DEFAULT_RATE_LIMITS: Record<RateLimitClassName, number> = { default: 600, auth: 10, pairing: 30, search: 120, write: 240 };

export interface RateLimiter {
  take(className: RateLimitClassName, key: string): { allowed: boolean; retryAfterSeconds: number };
}

export function createRateLimiter(ctx: Pick<HubContext, 'clock' | 'deps'>): RateLimiter {
  const buckets = new Map<string, TokenBucketState>();
  const limits = { ...DEFAULT_RATE_LIMITS, ...(ctx.deps.rateLimits ?? {}) };
  let sweep = 0;
  return {
    take(className, key) {
      const perMinute = limits[className];
      const now = ctx.clock.now();
      const id = `${className}:${key}`;
      const result = takeToken(buckets.get(id), { capacity: perMinute, refillPerSecond: perMinute / 60, now });
      buckets.set(id, result.state);
      if (++sweep % 1000 === 0) {
        for (const [k, v] of buckets) if (now - v.updatedAt > 10 * 60_000) buckets.delete(k);
      }
      return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
    },
  };
}

export function clientIp(req: FastifyRequest): string | null {
  const ip = req.ip;
  return typeof ip === 'string' && ip.length ? ip.replace(/^::ffff:/, '') : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function requestIsSecure(ctx: Pick<HubContext, 'network'>, req: FastifyRequest): boolean {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && ctx.network.isTrustedProxy(req.socket.remoteAddress ?? '')) return proto.split(',')[0]!.trim() === 'https';
  return req.protocol === 'https';
}

export function requestBaseUrl(ctx: Pick<HubContext, 'network' | 'config'>, req: FastifyRequest): string {
  const configured = ctx.network.publicEndpoint();
  if (configured) return configured;
  const secure = requestIsSecure(ctx, req);
  const host = req.headers.host ?? `localhost:${ctx.config.port}`;
  return `${secure ? 'https' : 'http'}://${host}`;
}

/** Resolve the caller: bearer device credential first, then the admin cookie, else anonymous. */
export async function resolvePrincipal(ctx: Pick<HubContext, 'auth' | 'deviceAuth'>, req: FastifyRequest): Promise<Principal> {
  const auth = req.headers.authorization;
  if (auth) {
    const device = await ctx.deviceAuth.authenticateHeader(auth);
    if (device) return device;
    throw new DomainError('unauthenticated', 'Invalid or revoked device credential');
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = ctx.auth.resolveSession(cookies[SESSION_COOKIE]);
  return session ?? { kind: 'anonymous' };
}

function sameOrigin(req: FastifyRequest, baseUrl: string, allowed: readonly string[]): boolean {
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && (fetchSite === 'same-origin' || fetchSite === 'none')) return true;
  if (typeof origin !== 'string') return true; // non-browser client; CSRF token still required for cookie sessions
  try {
    const o = new URL(origin).origin;
    if (o === new URL(baseUrl).origin) return true;
    const host = req.headers.host;
    if (host && (o === `http://${host}` || o === `https://${host}`)) return true;
    return allowed.includes(o);
  } catch {
    return false;
  }
}

export interface RegisterOptions {
  /** Override the body limit for this route (bytes). */
  bodyLimit?: number;
}

/**
 * Bind a contract route to Fastify: validate params/query/body with the canonical schemas, resolve the principal,
 * enforce setup gating, scopes, CSRF (cookie sessions) and rate-limit classes, and map DomainErrors to problem+json.
 */
export function registerRoute<R extends RouteContract>(app: FastifyInstance, ctx: HubContext, route: R, handler: RouteHandler<R>, options: RegisterOptions = {}): void {
  const url = route.absolute ? route.path : `${API_PREFIX}${route.path}`;
  const rateClass: RateLimitClassName | 'none' = route.rateLimit ?? 'default';
  const validateResponse = ctx.config.nodeEnv === 'test' && !route.responseContentType;
  app.route({
    method: route.method,
    url,
    ...(options.bodyLimit !== undefined ? { bodyLimit: options.bodyLimit } : {}),
    config: { operationId: route.operationId },
    handler: async (req, reply) => {
      const correlationId = req.id;
      const ip = clientIp(req);
      const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
      const secure = requestIsSecure(ctx, req);
      const baseUrl = requestBaseUrl(ctx, req);
      reply.header('X-Correlation-Id', correlationId);
      try {
        if (rateClass !== 'none') {
          const limit = ctx.httpRateLimiter.take(rateClass, ip ?? 'unknown');
          if (!limit.allowed) {
            ctx.metrics.increment('http.rate_limited');
            throw new DomainError('rate-limited', 'Too many requests', { retryAfterSeconds: limit.retryAfterSeconds });
          }
        }
        const principal = await resolvePrincipal(ctx, req);
        if (route.auth === 'admin' && principal.kind !== 'admin') throw new DomainError('unauthenticated', 'Admin session required');
        if (route.auth === 'device' && principal.kind !== 'device') throw new DomainError('unauthenticated', 'Device credential required');
        if (route.auth === 'admin-or-device' && principal.kind === 'anonymous') throw new DomainError('unauthenticated', 'Authentication required');
        if (route.auth !== 'none' && route.setupRequired !== false && !ctx.auth.setupComplete()) {
          throw new DomainError('setup-required', 'Replace the bootstrap password before using this feature');
        }
        if (principal.kind === 'admin' && !['GET', 'HEAD'].includes(route.method)) {
          const token = req.headers['x-csrf-token'];
          if (typeof token !== 'string' || token !== principal.csrfToken || !sameOrigin(req, baseUrl, ctx.network.allowedOrigins())) {
            ctx.audit.record({ actor: { kind: 'admin', id: principal.userId, displayName: principal.username }, action: 'security.csrf', outcome: 'denied', ip, correlationId, details: { operation: route.operationId } });
            throw new DomainError('forbidden', 'Missing or invalid CSRF token');
          }
        }
        if (route.scopes?.length && principal.kind === 'device') {
          const missing = missingScopes(principal, route.scopes);
          if (missing.length) throw new DomainError('forbidden', `Missing scopes: ${missing.join(', ')}`, { details: { missingScopes: missing } });
        }
        const params = route.params ? parseOrThrow(route.params, req.params, 'params') : undefined;
        const query = route.query ? parseOrThrow(route.query, req.query, 'query') : undefined;
        const body = route.body ? parseOrThrow(route.body, req.body, 'body') : undefined;
        const requestContext: RequestContext<unknown, unknown, unknown> = {
          params,
          query,
          body,
          principal,
          correlationId,
          ip,
          userAgent,
          baseUrl,
          secure,
          req,
          reply,
          setSessionCookie(sessionId, expiresAt) {
            const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
            if (secure) attrs.push('Secure');
            if (sessionId === null) attrs.push('Max-Age=0');
            else if (expiresAt) attrs.push(`Expires=${new Date(expiresAt).toUTCString()}`);
            reply.header('Set-Cookie', `${SESSION_COOKIE}=${sessionId ?? ''}; ${attrs.join('; ')}`);
          },
        };
        const result = await (handler as (c: RequestContext<unknown, unknown, unknown>) => Promise<unknown>)(requestContext);
        if (result === RAW) return reply;
        if (validateResponse) {
          const check = route.response.safeParse(result);
          if (!check.success) throw new Error(`Response contract violation in ${route.operationId}: ${check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        }
        reply.code(route.responseStatus ?? 200);
        return result;
      } catch (err) {
        return sendError(ctx, req, reply, err, correlationId);
      }
    },
  });
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown, where: 'params' | 'query' | 'body'): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw new DomainError('validation', `Invalid ${where}: ${issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`, { details: { where, issues } });
}

export function sendError(ctx: Pick<HubContext, 'log' | 'metrics'>, req: FastifyRequest, reply: FastifyReply, err: unknown, correlationId: string): FastifyReply {
  if (err instanceof DomainError) {
    const body = problemFromDomainError(err, correlationId);
    if (err.retryAfterSeconds !== undefined) reply.header('Retry-After', String(err.retryAfterSeconds));
    ctx.metrics.increment(`http.error.${err.status}`);
    if (err.status >= 500) ctx.log.error({ module: 'http', correlationId, err: err.message, url: req.url }, 'request failed');
    return reply.code(err.status).type(PROBLEM_CONTENT_TYPE).send(body);
  }
  const fastifyErr = err as { statusCode?: number; validation?: unknown; code?: string; message?: string };
  if (typeof fastifyErr?.statusCode === 'number' && fastifyErr.statusCode < 500) {
    ctx.metrics.increment(`http.error.${fastifyErr.statusCode}`);
    return reply.code(fastifyErr.statusCode).type(PROBLEM_CONTENT_TYPE).send(problem(fastifyErr.statusCode, { detail: fastifyErr.message ?? 'Bad request', correlationId, code: fastifyErr.code ?? 'bad-request' }));
  }
  ctx.metrics.increment('http.error.500');
  ctx.log.error({ module: 'http', correlationId, err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err), url: req.url }, 'unhandled error');
  return reply.code(500).type(PROBLEM_CONTENT_TYPE).send(problem(500, { detail: 'Internal error', correlationId, code: 'internal' }));
}

export function requireDeviceScope(principal: Principal, scope: Parameters<typeof hasScope>[1]): void {
  if (!hasScope(principal, scope)) throw new DomainError('forbidden', `Scope ${scope} required`);
}

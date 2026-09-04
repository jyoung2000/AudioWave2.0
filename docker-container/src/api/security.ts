import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { HubContext } from '../context.js';
import { requestBaseUrl } from './register.js';

/** Content-Security-Policy for API responses and the admin GUI (same origin, no CDN, no inline script). */
export function apiCsp(): string {
  return ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:", "media-src 'self' blob: https:", "connect-src 'self'", "font-src 'self'", "frame-src 'self' https://www.youtube-nocookie.com https://w.soundcloud.com", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
}

/** CSP for server-rendered pages (share page, OAuth landing) that carry one nonce-bound inline script. */
export function pageCsp(nonce: string): string {
  return ["default-src 'self'", `script-src 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:", "media-src 'self' blob: https:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
}

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** Security headers, CORS for bearer clients (never credentials), and per-request correlation ids. */
export function installSecurity(app: FastifyInstance, ctx: HubContext): void {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('Cache-Control', 'no-store');
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', apiCsp());
    if (ctx.network.publicEndpoint()?.startsWith('https://')) reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');

    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      const base = requestBaseUrl(ctx, req);
      const allowed = origin === safeOrigin(base) || ctx.network.allowedOrigins().includes(origin) || isLoopbackOrigin(origin);
      if (allowed) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-CSRF-Token,X-Requested-With,Range,Idempotency-Key');
        reply.header('Access-Control-Expose-Headers', 'X-Correlation-Id,Retry-After,Content-Range,Accept-Ranges,Content-Length');
        reply.header('Access-Control-Max-Age', '600');
        // Credentials (cookies) are deliberately never allowed cross-origin: devices use bearer credentials.
      }
      if (req.method === 'OPTIONS') {
        reply.code(allowed ? 204 : 403);
        return reply.send();
      }
    }
    return undefined;
  });

  app.addHook('onResponse', async (req, reply) => {
    ctx.metrics.increment('http.requests');
    ctx.metrics.observe('http.latency_ms', reply.elapsedTime);
    const op = (req.routeOptions.config as { operationId?: string } | undefined)?.operationId;
    if (op) ctx.metrics.increment(`http.op.${op}`);
    if (reply.statusCode >= 500) ctx.metrics.increment('http.5xx');
    ctx.log.debug({ module: 'http', correlationId: req.id, method: req.method, url: req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
  });
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Loopback dev origins (Vite dev servers for the player/admin GUI) may call the API with bearer credentials. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

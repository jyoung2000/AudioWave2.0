import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { HubContext } from '../context.js';
import { PROBLEM_CONTENT_TYPE, problem } from './problem.js';
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

function extraAllowedHosts(): string[] {
  return (process.env['NP_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameOf(value: string): string | null {
  try {
    const u = new URL(value.includes('://') ? value : `http://${value}`);
    return u.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * DNS-rebinding defence: a browser tricked into talking to the hub under an attacker's domain
 * sends that domain as Host. Only names the hub is known by are accepted: loopback names, IP
 * literals (a rebinding page can never produce one), single-label LAN names, this machine's
 * hostname, the configured public endpoint, the configured allowed origins and `NP_ALLOWED_HOSTS`
 * (comma-separated; a leading dot allows subdomains).
 */
const PRIVATE_NAME_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal'] as const;

export function isAllowedHost(ctx: Pick<HubContext, 'network'>, hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader === '') return true; // HTTP/1.0 or non-browser client
  const host = hostnameOf(hostHeader);
  if (!host) return false;
  if (isIP(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (!host.includes('.')) return true;
  const machine = hostname().toLowerCase();
  if (host === machine || host === `${machine}.local`) return true;
  // Names under these suffixes never resolve through public DNS, so a rebinding page cannot use them.
  if (PRIVATE_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  const known = new Set<string>();
  const endpoint = ctx.network.publicEndpoint();
  if (endpoint) {
    const h = hostnameOf(endpoint);
    if (h) known.add(h);
  }
  for (const origin of ctx.network.allowedOrigins()) {
    const h = hostnameOf(origin);
    if (h) known.add(h);
  }
  if (known.has(host)) return true;
  for (const entry of extraAllowedHosts()) {
    if (entry === host) return true;
    if (entry.startsWith('.') && (host.endsWith(entry) || host === entry.slice(1))) return true;
  }
  return false;
}

/** Security headers, CORS for bearer clients (never credentials), and per-request correlation ids. */
export function installSecurity(app: FastifyInstance, ctx: HubContext): void {
  app.addHook('onRequest', async (req, reply) => {
    // A rebinding page cannot know a device secret, so a request carrying a *valid* bearer credential
    // may use any host name (devices configured with a LAN DNS name keep working). Everything else
    // (browser sessions, login, static pages) is held to the Host allowlist.
    if (!isAllowedHost(ctx, req.headers.host) && !(await ctx.deviceAuth.authenticateHeader(req.headers.authorization).catch(() => null))) {
      ctx.metrics.increment('http.host_rejected');
      reply.code(421).type(PROBLEM_CONTENT_TYPE).header('Cache-Control', 'no-store');
      return reply.send(problem(421, { title: 'Misdirected Request', detail: 'This hub does not answer to that host name. Add it as the public endpoint or to NP_ALLOWED_HOSTS.', correlationId: req.id, code: 'misdirected-request' }));
    }
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

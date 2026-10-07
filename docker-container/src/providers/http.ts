import type { LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { isResolvedAddressAllowed, validateOutboundUrl } from '@now-playing/domain';

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryAfterSeconds: number | null = null,
    readonly body: string | null = null,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | URLSearchParams | Uint8Array;
  /**
   * How long to wait for response headers (per hop). Streaming callers that read `body` themselves
   * are not cut off by it once headers have arrived; `text()`/`json()` get the same budget again
   * for reading the (size-capped) body.
   */
  timeoutMs?: number;
  /** Maximum response size in bytes for buffered reads. */
  maxBytes?: number;
  /** Hosts the request (and every redirect hop) may reach. Empty means none. */
  allowedHosts: readonly string[];
  allowedSchemes?: readonly string[];
  maxRedirects?: number;
  /** Aborts the request, including a body that is still streaming. */
  signal?: AbortSignal;
  /**
   * False: a redirect is returned as the answer it is (its status and headers, no body read)
   * instead of being followed. For a service that says "found" with a 307 (the Cover Art Archive).
   */
  followRedirects?: boolean;
}

/** A fetch that connects only to the given, already validated, addresses (no second DNS lookup). */
export type PinnedFetch = (url: string, init: RequestInit, addresses: readonly string[]) => Promise<Response>;

export interface SafeHttpDeps {
  fetch: typeof globalThis.fetch;
  dnsLookup: (hostname: string) => Promise<string[]>;
  userAgent: string;
  /**
   * Used instead of `fetch` when given. When omitted and `fetch` is the runtime's own fetch, the
   * built-in node:http(s) implementation is used so the connection is pinned to the checked
   * address (DNS rebinding). An injected test fetch is used as is.
   */
  pinnedFetch?: PinnedFetch;
}

export interface SafeResponse {
  status: number;
  headers: Headers;
  url: string;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  body: ReadableStream<Uint8Array> | null;
}

/** Headers that carry the caller's credentials and must not follow a redirect to another origin. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** The runtime's fetch as it was when this module loaded (tests that inject their own are not pinned). */
const NATIVE_FETCH: typeof globalThis.fetch | undefined = globalThis.fetch;

/**
 * Outbound HTTP with SSRF protection: URL allowlist by host, scheme check, post-DNS private-range rejection with the
 * connection pinned to the checked address, manual redirect following (each hop re-validated; credentials and bodies
 * never cross origins), timeouts, size caps and a descriptive User-Agent. Never sends cookies.
 */
export class SafeHttpClient {
  constructor(private readonly deps: SafeHttpDeps) {}

  private fetcher(): PinnedFetch {
    if (this.deps.pinnedFetch) return this.deps.pinnedFetch;
    if (NATIVE_FETCH && this.deps.fetch === NATIVE_FETCH) return nodePinnedFetch;
    return (url, init) => this.deps.fetch(url, init);
  }

  async request(input: string, options: SafeFetchOptions): Promise<SafeResponse> {
    const maxRedirects = options.maxRedirects ?? 3;
    const timeoutMs = options.timeoutMs ?? 10_000;
    let url = input;
    let method: NonNullable<SafeFetchOptions['method']> = options.method ?? 'GET';
    let body = options.body;
    let headers: Record<string, string> = { ...(options.headers ?? {}) };
    let origin: string | null = null;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const check = validateOutboundUrl(url, { allowedHosts: options.allowedHosts, ...(options.allowedSchemes ? { allowedSchemes: options.allowedSchemes } : {}) });
      if (!check.ok || !check.url) throw new ProviderHttpError(`Blocked outbound URL: ${check.reason ?? 'not allowed'}`, null);
      const hostname = check.url.hostname;
      const literal = hostname.replace(/^\[|\]$/g, '');
      if (origin !== null && check.url.origin !== origin) {
        // Cross-origin hop: never forward credentials.
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase())));
      }
      origin = check.url.origin;
      let addresses: string[];
      if (isIP(literal)) {
        addresses = [literal];
      } else {
        try {
          addresses = await this.deps.dnsLookup(hostname);
        } catch {
          throw new ProviderHttpError(`DNS lookup failed for ${hostname}`, null);
        }
        const resolved = isResolvedAddressAllowed(addresses);
        if (!resolved.ok) throw new ProviderHttpError(`Blocked outbound URL: ${resolved.reason ?? 'resolves to a private address'}`, null);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const onAbort = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) onAbort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      let res: Response;
      try {
        const init: RequestInit = {
          method,
          headers: { 'User-Agent': this.deps.userAgent, Accept: 'application/json, */*;q=0.5', ...headers },
          redirect: 'manual',
          signal: controller.signal,
          // Cookies are never sent outbound: an adapter authenticates with a header or not at all.
          credentials: 'omit',
        };
        // `body` is optional on RequestInit, so assign it only when there is one to send.
        if (body !== undefined) init.body = body as NonNullable<RequestInit['body']>;
        res = await this.fetcher()(check.url.toString(), init, addresses);
      } catch (err) {
        options.signal?.removeEventListener('abort', onAbort);
        const timedOut = controller.signal.aborted && controller.signal.reason instanceof Error && controller.signal.reason.message === 'timeout';
        throw new ProviderHttpError(timedOut || (err instanceof Error && err.message === 'timeout') ? `Request to ${hostname} timed out` : `Request to ${hostname} failed: ${err instanceof Error ? err.message : String(err)}`, null);
      } finally {
        // The timeout bounds the wait for headers only; a streaming body is governed by the caller.
        clearTimeout(timeout);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location') && options.followRedirects !== false) {
        options.signal?.removeEventListener('abort', onAbort);
        let next: URL;
        try {
          next = new URL(res.headers.get('location')!, check.url);
        } catch {
          await res.body?.cancel().catch(() => undefined);
          throw new ProviderHttpError(`Invalid redirect from ${hostname}`, res.status);
        }
        await res.body?.cancel().catch(() => undefined);
        const sameOrigin = next.origin === check.url.origin;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          // Per the fetch spec these become a body-less GET.
          if (method !== 'HEAD') method = 'GET';
          body = undefined;
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-type'));
        } else if (body !== undefined && !sameOrigin) {
          throw new ProviderHttpError(`Refusing to resend a request body to another origin (${next.host})`, res.status);
        }
        url = next.toString();
        continue;
      }
      const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
      const wrapped: SafeResponse = {
        status: res.status,
        headers: res.headers,
        url: res.url || check.url.toString(),
        body: res.body,
        text: async () => {
          const readTimer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
          try {
            return await readLimited(res, maxBytes, controller.signal);
          } finally {
            clearTimeout(readTimer);
            options.signal?.removeEventListener('abort', onAbort);
          }
        },
        json: async <T,>() => {
          const text = await wrapped.text();
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new ProviderHttpError(`Invalid JSON from ${hostname}`, res.status, null, text.slice(0, 200));
          }
        },
      };
      if (res.status === 429 || res.status >= 500) {
        const retry = res.headers.get('retry-after');
        const retryAfterSeconds = retry ? (Number.isFinite(Number(retry)) ? Number(retry) : Math.max(1, Math.round((Date.parse(retry) - Date.now()) / 1000))) : null;
        const errorBody = await wrapped.text().catch(() => null);
        throw new ProviderHttpError(`${hostname} responded ${res.status}`, res.status, retryAfterSeconds, errorBody);
      }
      return wrapped;
    }
    throw new ProviderHttpError('Too many redirects', null);
  }

  async getJson<T>(url: string, options: SafeFetchOptions): Promise<T> {
    const res = await this.request(url, options);
    if (res.status >= 400) {
      const body = await res.text().catch(() => '');
      throw new ProviderHttpError(`${new URL(url).hostname} responded ${res.status}`, res.status, null, body.slice(0, 300));
    }
    return res.json<T>();
  }
}

async function readLimited(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const onAbort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new ProviderHttpError('Reading the response timed out', res.status);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProviderHttpError(`Response larger than ${maxBytes} bytes`, res.status);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) throw new ProviderHttpError('Reading the response timed out', res.status);
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** Node's dns.lookup wrapped for the SafeHttpClient. */
export async function nodeDnsLookup(hostname: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Minimal fetch over node:http(s) whose socket can only connect to `addresses` — the ones the
 * SSRF check approved — so a second, attacker-controlled DNS answer can never be used. TLS still
 * verifies the certificate against the URL's host name. Responses are not decompressed, so no
 * Accept-Encoding is sent.
 */
export const nodePinnedFetch: PinnedFetch = (input, init, addresses) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(input);
    const pinned = addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
    if (!pinned.length) {
      reject(new Error('No validated address to connect to'));
      return;
    }
    const lookup = (_host: string, options: { all?: boolean } | number, callback: (...args: unknown[]) => void): void => {
      if (typeof options === 'object' && options?.all) callback(null, pinned as LookupAddress[]);
      else callback(null, pinned[0]!.address, pinned[0]!.family);
    };
    const headers = new Headers(init.headers);
    let payload: Buffer | null = null;
    const body = init.body;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') payload = Buffer.from(body, 'utf8');
      else if (body instanceof URLSearchParams) {
        payload = Buffer.from(body.toString(), 'utf8');
        if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
      } else if (body instanceof Uint8Array) payload = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      else {
        reject(new Error('Unsupported request body type'));
        return;
      }
      headers.set('content-length', String(payload.byteLength));
    }
    const outgoing: Record<string, string> = {};
    headers.forEach((value, key) => {
      outgoing[key] = value;
    });
    const method = (init.method ?? 'GET').toUpperCase();
    const send = url.protocol === 'https:' ? httpsRequest : url.protocol === 'http:' ? httpRequest : null;
    if (!send) {
      reject(new Error(`Unsupported scheme ${url.protocol}`));
      return;
    }
    const req = send(
      url,
      {
        method,
        headers: outgoing,
        lookup: lookup as never,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res: IncomingMessage) => {
        const responseHeaders = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          try {
            responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          } catch {
            /* a malformed header is dropped rather than failing the request */
          }
        }
        const status = res.statusCode ?? 502;
        if (status < 200 || status > 599) {
          res.resume();
          reject(new Error(`Unexpected status ${status}`));
          return;
        }
        const nullBody = method === 'HEAD' || NULL_BODY_STATUSES.has(status);
        if (nullBody) res.resume();
        const stream = nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
        resolve(new Response(stream, { status, statusText: res.statusMessage ?? '', headers: responseHeaders }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

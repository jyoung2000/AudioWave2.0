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
  timeoutMs?: number;
  /** Maximum response size in bytes for buffered reads. */
  maxBytes?: number;
  allowedHosts: readonly string[];
  allowedSchemes?: readonly string[];
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeHttpDeps {
  fetch: typeof globalThis.fetch;
  dnsLookup: (hostname: string) => Promise<string[]>;
  userAgent: string;
}

export interface SafeResponse {
  status: number;
  headers: Headers;
  url: string;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Outbound HTTP with SSRF protection: URL allowlist by host, scheme check, post-DNS private-range rejection, manual
 * redirect following (each hop re-validated), timeouts, size caps and a descriptive User-Agent. Never sends cookies.
 */
export class SafeHttpClient {
  constructor(private readonly deps: SafeHttpDeps) {}

  async request(input: string, options: SafeFetchOptions): Promise<SafeResponse> {
    const maxRedirects = options.maxRedirects ?? 3;
    let url = input;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const check = validateOutboundUrl(url, { allowedHosts: options.allowedHosts, ...(options.allowedSchemes ? { allowedSchemes: options.allowedSchemes } : {}) });
      if (!check.ok || !check.url) throw new ProviderHttpError(`Blocked outbound URL: ${check.reason ?? 'not allowed'}`, null);
      const hostname = check.url.hostname;
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && !hostname.includes(':')) {
        let addresses: string[] = [];
        try {
          addresses = await this.deps.dnsLookup(hostname);
        } catch {
          throw new ProviderHttpError(`DNS lookup failed for ${hostname}`, null);
        }
        const resolved = isResolvedAddressAllowed(addresses);
        if (!resolved.ok) throw new ProviderHttpError(`Blocked outbound URL: ${resolved.reason ?? 'resolves to a private address'}`, null);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs ?? 10_000);
      const onAbort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      let res: Response;
      try {
        const init: RequestInit = {
          method: options.method ?? 'GET',
          headers: { 'User-Agent': this.deps.userAgent, Accept: 'application/json, */*;q=0.5', ...(options.headers ?? {}) },
          redirect: 'manual',
          signal: controller.signal,
          // Cookies are never sent outbound: an adapter authenticates with a header or not at all.
          credentials: 'omit',
        };
        // `body` is optional on RequestInit, so assign it only when there is one to send.
        if (options.body !== undefined) init.body = options.body as NonNullable<RequestInit['body']>;
        res = await this.deps.fetch(check.url.toString(), init);
      } catch (err) {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        throw new ProviderHttpError(err instanceof Error && err.message === 'timeout' ? `Request to ${hostname} timed out` : `Request to ${hostname} failed: ${err instanceof Error ? err.message : String(err)}`, null);
      }
      options.signal?.removeEventListener('abort', onAbort);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        clearTimeout(timeout);
        url = new URL(res.headers.get('location')!, check.url).toString();
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
      const wrapped: SafeResponse = {
        status: res.status,
        headers: res.headers,
        url: res.url || check.url.toString(),
        body: res.body,
        text: async () => {
          try {
            return await readLimited(res, maxBytes);
          } finally {
            clearTimeout(timeout);
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
        const body = await wrapped.text().catch(() => null);
        throw new ProviderHttpError(`${hostname} responded ${res.status}`, res.status, retryAfterSeconds, body);
      }
      if (options.method === 'HEAD' || res.status === 204) clearTimeout(timeout);
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

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ProviderHttpError(`Response larger than ${maxBytes} bytes`, res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** Node's dns.lookup wrapped for the SafeHttpClient. */
export async function nodeDnsLookup(hostname: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

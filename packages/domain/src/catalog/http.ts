/**
 * The little the catalog engine needs from the network, injected.
 *
 * The engine never imports `node:http` and never calls the global `fetch` itself: the hub passes its
 * host-allowlisted, DNS-checked client, the helper its own guarded fetch, the player the browser's,
 * and tests a fixture table. So the same code is safe on a server inside someone's network and
 * runnable in a page.
 */

/** The part of a `Response` the engine reads. */
export interface CatalogResponse {
  status: number;
  headers?: { get(name: string): string | null } | undefined;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface CatalogRequestInit {
  signal: AbortSignal;
  headers: Record<string, string>;
  /**
   * `manual`: answer with the redirect itself (its status) instead of following it. The Cover Art
   * Archive says "this release has a front cover" with a 307 to the archive, and the catalog needs
   * only that answer, never the hop.
   */
  redirect?: 'manual' | undefined;
}

export type CatalogFetch = (url: string, init: CatalogRequestInit) => Promise<CatalogResponse>;

export type CatalogErrorKind = 'http' | 'timeout' | 'network' | 'parse' | 'rate-limited' | 'aborted';

/** Why a call to a service failed, in a form the status line can say in words. */
export class CatalogHttpError extends Error {
  constructor(
    message: string,
    readonly kind: CatalogErrorKind,
    readonly status: number | null = null,
    /** How long the service asked to be left alone, when it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'CatalogHttpError';
  }
}

export interface GetJsonOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  headers?: Record<string, string> | undefined;
  /** Statuses that are an answer rather than a failure (404 for "no such ISRC"). */
  accept?: readonly number[];
  /** Passed to the fetch: `manual` answers with a redirect's own status. */
  redirect?: 'manual' | undefined;
}

/**
 * Does the archive have it? A GET with redirects left unfollowed: a 2xx or a redirect (the Cover Art
 * Archive's 307 to the archive) says yes; a 404 says no. Anything else is the failure it is.
 */
export async function headLike(fetchImpl: CatalogFetch, url: string, options: GetJsonOptions): Promise<{ status: number; found: boolean }> {
  const answer = await getBody(fetchImpl, url, { ...options, accept: [...(options.accept ?? []), 301, 302, 307, 308, 404], redirect: 'manual' }, 'text');
  return { status: answer.status, found: answer.status < 400 };
}

function retryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 3_600_000)) : null;
}

/**
 * GET a JSON document with a deadline. Resolves to `{ status, body }`; a status outside 2xx and
 * `accept` is a `CatalogHttpError`, as is a timeout, a dropped connection or a body that is not JSON.
 */
export function getJson(fetchImpl: CatalogFetch, url: string, options: GetJsonOptions): Promise<{ status: number; body: unknown }> {
  return getBody(fetchImpl, url, options, 'json');
}

/** GET a page (HTML) with the same deadline and refusals; the body is its text. */
export async function getText(fetchImpl: CatalogFetch, url: string, options: GetJsonOptions): Promise<{ status: number; body: string }> {
  const answer = await getBody(fetchImpl, url, options, 'text');
  return { status: answer.status, body: answer.body as string };
}

async function getBody(fetchImpl: CatalogFetch, url: string, options: GetJsonOptions, as: 'json' | 'text'): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const outer = options.signal;
  const onAbort = (): void => controller.abort();
  if (outer?.aborted) controller.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return 'the service';
    }
  })();
  try {
    let response: CatalogResponse;
    try {
      response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: as === 'json' ? 'application/json' : 'text/html', ...(options.headers ?? {}) }, ...(options.redirect ? { redirect: options.redirect } : {}) });
    } catch {
      if (timedOut) throw new CatalogHttpError(`${host} did not answer in time`, 'timeout');
      if (outer?.aborted) throw new CatalogHttpError('The search was cancelled', 'aborted');
      throw new CatalogHttpError(`${host} could not be reached`, 'network');
    }
    const ok = (response.status >= 200 && response.status < 300) || (options.accept ?? []).includes(response.status);
    if (response.status === 429 || response.status === 503) {
      throw new CatalogHttpError(`${host} asked to slow down`, 'rate-limited', response.status, retryAfterMs(response.headers?.get('retry-after')));
    }
    if (!ok) throw new CatalogHttpError(`${host} answered ${response.status}`, 'http', response.status);
    let body: unknown;
    try {
      body = as === 'json' ? await response.json() : await response.text();
    } catch {
      if (timedOut) throw new CatalogHttpError(`${host} did not answer in time`, 'timeout');
      throw new CatalogHttpError(as === 'json' ? `${host} sent something that was not JSON` : `${host}’s page could not be read`, 'parse', response.status);
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

/* ---------- small JSON readers: every service's answer is untrusted ---------- */

export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export function arr(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

export function str(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function posInt(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/** An http(s) URL, or null. Nothing else ever reaches a page as a link or an image. */
export function webUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` from the front of whatever a service sent. */
export function calendarDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(value.trim());
  if (!m || m[1] === '0000') return null;
  if (m[3] && m[3] !== '00') return `${m[1]}-${m[2]}-${m[3]}`;
  if (m[2] && m[2] !== '00') return `${m[1]}-${m[2]}`;
  return m[1]!;
}

export function yearOf(date: string | null): number | null {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return year >= 1000 && year <= 3000 ? year : null;
}

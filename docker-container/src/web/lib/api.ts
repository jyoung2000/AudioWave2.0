/**
 * Typed client for the hub's own API.
 *
 * Three things it always does: send the CSRF token on every mutating request (the session cookie is
 * SameSite=Strict and HttpOnly, so the token is the second half of the double-submit pair), parse
 * problem+json into an error a human can read, and surface the correlation id so a message in the
 * GUI can be matched to a line in the log.
 */
import type { RouteName, Routes } from '@now-playing/contracts';
import { routePath, routes } from '@now-playing/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null,
    readonly correlationId: string | null,
    readonly details: Record<string, unknown> | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the hub is telling us setup is not finished, which the shell handles globally. */
  get isSetupRequired(): boolean {
    return this.code === 'setup-required';
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

type Params = Record<string, string | number>;
type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  params?: Params;
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function currentCsrfToken(): string | null {
  return csrfToken;
}

function buildUrl(name: RouteName, options: RequestOptions): string {
  const route = routes[name] as { path: string; absolute?: boolean };
  const path = routePath(route as never, (options.params ?? {}) as never);
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search;
}

/** Call a contract route by name. The response type comes from the contract, not from a cast here. */
export async function api<N extends RouteName>(name: N, options: RequestOptions = {}): Promise<ReturnType<Routes[N]['response']['parse']>> {
  const route = routes[name];
  const method = route.method;
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (options.signal) init.signal = options.signal;

  if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers['x-csrf-token'] = csrfToken;

  const response = await fetch(buildUrl(name, options), init);
  const correlationId = response.headers.get('x-correlation-id');

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code: string | null = null;
    let details: Record<string, unknown> | null = null;
    let retryAfterSeconds: number | null = null;
    try {
      const problem = (await response.json()) as { detail?: string; title?: string; code?: string; details?: Record<string, unknown>; retryAfterSeconds?: number };
      message = problem.detail ?? problem.title ?? message;
      code = problem.code ?? null;
      details = problem.details ?? null;
      retryAfterSeconds = problem.retryAfterSeconds ?? null;
    } catch {
      // A non-JSON error body (a proxy's HTML page, say) leaves the status line as the message.
    }
    throw new ApiError(response.status, message, code, correlationId, details, retryAfterSeconds);
  }

  if (response.status === 204) return undefined as never;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return (await response.text()) as never;
  return (await response.json()) as never;
}

/** Absolute URL for a route, for links and media the browser fetches itself. */
export function apiUrl<N extends RouteName>(name: N, params?: Params, query?: Query): string {
  return buildUrl(name, { ...(params ? { params } : {}), ...(query ? { query } : {}) });
}

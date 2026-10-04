/**
 * The hub admin window's API client, as the style guide gives it to the hub's real views.
 *
 * The styleguide build puts this module where `docker-container/src/web/lib/api.ts` would be (see
 * `specimenTransports` in `../vite.config.ts`), so `GroupsView`, `BackupView` and the rest render
 * exactly as they do in the hub — their own markup, hooks and words — with the answers a real hub
 * gave (`hub-api.json`, written by `record-hub-api.mts`). Reads are answered from the recording;
 * anything that would change the hub is refused with a sentence, which the views show the way they
 * show any refused action. Timestamps move with the clock, so "3 min ago" stays "3 min ago".
 */
import { routePath, routes, type RouteName, type Routes } from '@now-playing/contracts';
import recording from './hub-api.json';

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

interface Recorded {
  name: string;
  params?: Params;
  query?: Query;
  body: unknown;
}

const RECORDED = recording as { recordedAt: string; routes: Recorded[] };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const DAY = 86_400_000;

/**
 * The recording, brought up to now: what had happened moves by exactly however long ago it was
 * recorded, so "4 min ago" stays "4 min ago"; what was still to come moves by whole days, so a
 * backup due at 03:00 is still due at 03:00 and a link that had a week left still has one.
 */
function revive(value: unknown, recordedAt: number): unknown {
  if (typeof value === 'string') {
    if (!ISO.test(value)) return value;
    const at = Date.parse(value);
    const now = Date.now();
    const elapsed = now - recordedAt;
    if (at <= recordedAt) return new Date(at + elapsed).toISOString();
    // Whole days, as many as have passed, and never so few that it is already over.
    const days = Math.max(Math.round(elapsed / DAY), Math.ceil((now - at) / DAY), 0);
    return new Date(at + days * DAY).toISOString();
  }
  if (Array.isArray(value)) return value.map((item) => revive(item, recordedAt));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item, recordedAt)]));
  return value;
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function currentCsrfToken(): string | null {
  return csrfToken;
}

const same = (a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/** Answer a read from the recording; refuse a change. Same signature as the hub's `api`. */
export async function api<N extends RouteName>(name: N, options: RequestOptions = {}): Promise<ReturnType<Routes[N]['response']['parse']>> {
  const route = routes[name] as { method: string };
  if (route.method !== 'GET' && route.method !== 'HEAD') {
    throw new ApiError(503, 'This window is a specimen in the style guide, so there is no hub behind it to change.', 'specimen', null, null, null);
  }
  const answers = RECORDED.routes.filter((item) => item.name === name);
  const answer = answers.find((item) => same(item.query, options.query as Record<string, unknown>)) ?? answers[0];
  if (!answer) throw new ApiError(404, 'The style guide has no recorded answer for this.', 'specimen', null, null, null);
  return revive(answer.body, Date.parse(RECORDED.recordedAt)) as never;
}

/** A link a real hub would serve; on the guide's page it goes nowhere. */
export function apiUrl<N extends RouteName>(name: N, params?: Params, query?: Query): string {
  try {
    const search = new URLSearchParams(Object.entries(query ?? {}).flatMap(([key, value]) => (value === undefined || value === null || value === '' ? [] : [[key, String(value)]]))).toString();
    return `#${routePath(routes[name] as never, (params ?? {}) as never)}${search ? `?${search}` : ''}`;
  } catch {
    return '#';
  }
}

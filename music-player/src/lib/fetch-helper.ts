/**
 * The tools when they are a program on loopback.
 *
 * Two ways a helper is found, and they are deliberately not symmetrical:
 *
 *   **The helper served this page.** Then its token is in the document and its origin is this
 *   origin, so detection is one request and there is nothing to configure. This is the path meant
 *   for everyone.
 *
 *   **The player is hosted somewhere and a helper is on loopback.** Then the player has no way to
 *   know a helper exists, and probing localhost on every load — for every user, most of whom have
 *   no helper — would be rude and noisy. So this only happens once someone has pasted a token into
 *   Settings, which is also what the helper needs before it will answer them.
 *
 * Everything past detection is the same protocol the Android bridge speaks; see `tools-core.ts`.
 */
import { HELPER_ROUTES, HELPER_TOKEN_META, HelperHealth, HelperJob, type HelperFetchRequest, type HelperInstallResult, type HelperJobFile, type HelperToolId } from '@now-playing/contracts';
import { ToolError, protocolMatches, type ToolBackend } from './tools-core.js';

/** What the listener saved, when they are running a helper beside a hosted player. */
export interface SavedHelper {
  origin: string;
  token: string;
}

const PROBE_TIMEOUT_MS = 2500;
const TOKEN_PROBE_JOB_ID = '00000000-0000-4000-8000-000000000001';

/** The helper puts it there on the way out; see `local-helper/src/app.ts`. */
export function tokenInDocument(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${HELPER_TOKEN_META}"]`)?.content?.trim() || null;
}

/** Normalize a helper URL without allowing credentials or a path to receive the saved token. */
function originOnly(value: string): string | null {
  try {
    const raw = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** A standalone player may pair directly only with the Companion on this PC. */
export function loopbackHelperOrigin(value: string): string | null {
  const origin = originOnly(value);
  if (!origin) return null;
  const hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1'].includes(hostname) ? origin : null;
}

export interface ConnectedHelper {
  origin: string;
  token: string;
  health: HelperHealth;
}

/** Validate the protected route before persisting a token from the player’s Settings. */
export async function connectHelper(value: string, valueToken: string): Promise<ConnectedHelper | null> {
  const origin = loopbackHelperOrigin(value);
  const token = valueToken.trim();
  if (!origin || !token) return null;
  const health = await ask(origin, token);
  return health ? { origin, token, health } : null;
}

export async function helperBackend(saved: SavedHelper | null, doc: Document = document): Promise<ToolBackend | null> {
  const local = tokenInDocument(doc);
  if (local) {
    const origin = originOnly(window.location.origin);
    const here = origin ? await ask(origin, local) : null;
    if (here && origin) return backend(origin, local, here, true);
  }
  if (saved) {
    const origin = originOnly(saved.origin);
    const token = saved.token.trim();
    const there = origin && token ? await ask(origin, token) : null;
    if (there && origin) return backend(origin, token, there, false);
  }
  return null;
}

/** Public health describes the helper; a protected, nonexistent job proves this token is accepted. */
async function ask(origin: string, token: string): Promise<HelperHealth | null> {
  try {
    const response = await fetch(`${origin}${HELPER_ROUTES.health}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store', credentials: 'omit' });
    if (!response.ok) return null;
    const parsed = HelperHealth.safeParse(await response.json());
    if (!parsed.success || !protocolMatches(parsed.data)) return null;
    const probe = await fetch(`${origin}${HELPER_ROUTES.job(TOKEN_PROBE_JOB_ID)}`, {
      headers: { 'x-helper-token': token },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: 'no-store',
      credentials: 'omit',
    });
    // The job does not exist. A 404 is the expected authenticated answer; 401/403 must never unlock tools.
    return probe.status === 404 || probe.ok ? parsed.data : null;
  } catch {
    // Nothing listening, a refused origin, a timeout. All the same answer.
    return null;
  }
}

function backend(origin: string, token: string, health: HelperHealth, sameOrigin: boolean): ToolBackend {
  const send = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetch(`${origin}${path}`, { ...init, headers: { 'x-helper-token': token, ...(init.headers ?? {}) }, cache: 'no-store' });
    const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const problem = body as { error?: string; message?: string; reason?: string } | null;
      throw new ToolError(problem?.message ?? problem?.reason ?? `The helper answered ${response.status}.`, problem?.error ?? 'http');
    }
    return body;
  };
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  return {
    kind: 'helper',
    label: sameOrigin ? 'A helper, serving this page' : `A helper at ${origin}`,
    health,
    origin,
    startFetch: async (request: HelperFetchRequest) => HelperJob.parse(await send(HELPER_ROUTES.fetch, json(request))),
    jobState: async (id: string) => HelperJob.parse(await send(HELPER_ROUTES.job(id))),
    forget: async (id: string) => {
      await send(HELPER_ROUTES.job(id), { method: 'DELETE' });
    },
    install: async (tool: HelperToolId) => (await send(HELPER_ROUTES.install(tool), json({}))) as HelperInstallResult,
    fileOf: async (job: HelperJob, entry: HelperJobFile) => {
      const response = await fetch(`${origin}${HELPER_ROUTES.file(job.id, entry.id)}`, { headers: { 'x-helper-token': token }, cache: 'no-store' });
      if (!response.ok) throw new ToolError(`${entry.name} could not be read back from the helper.`, 'file');
      return new File([await response.blob()], entry.name, { type: entry.contentType });
    },
  };
}

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

/** The helper puts it there on the way out; see `local-helper/src/app.ts`. */
export function tokenInDocument(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${HELPER_TOKEN_META}"]`)?.content?.trim() || null;
}

export async function helperBackend(saved: SavedHelper | null, doc: Document = document): Promise<ToolBackend | null> {
  const local = tokenInDocument(doc);
  if (local) {
    const here = await ask(window.location.origin, local);
    if (here) return backend(window.location.origin, local, here, true);
  }
  if (saved) {
    const there = await ask(saved.origin, saved.token);
    if (there) return backend(saved.origin, saved.token, there, false);
  }
  return null;
}

async function ask(origin: string, token: string): Promise<HelperHealth | null> {
  try {
    const response = await fetch(`${origin}${HELPER_ROUTES.health}`, { headers: { 'x-helper-token': token }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' });
    if (!response.ok) return null;
    const parsed = HelperHealth.safeParse(await response.json());
    if (!parsed.success || !protocolMatches(parsed.data)) return null;
    return parsed.data;
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

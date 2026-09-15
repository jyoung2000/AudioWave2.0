/**
 * Talking to the local helper, if there is one.
 *
 * The rule this file exists to enforce: **the player never claims a capability it has not just
 * observed.** It does not assume a helper is running because one was running last time, and it does
 * not offer a tool because a tool exists somewhere in the world. It asks, and what comes back is
 * what the interface is built from. A helper that stops answering takes its buttons with it.
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
 */
import { HELPER_PROTOCOL, HELPER_ROUTES, HELPER_TOKEN_META, HelperHealth, HelperJob, type HelperFetchRequest, type HelperInstallResult, type HelperToolId } from '@now-playing/contracts';

export interface HelperConnection {
  origin: string;
  token: string;
  health: HelperHealth;
  /** True when this helper is also the thing that served the page. */
  sameOrigin: boolean;
}

/** What the listener saved, when they are running a helper beside a hosted player. */
export interface SavedHelper {
  origin: string;
  token: string;
}

const PROBE_TIMEOUT_MS = 2500;
const POLL_MS = 900;

/** The helper puts it there on the way out; see `local-helper/src/app.ts`. */
export function tokenInDocument(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${HELPER_TOKEN_META}"]`)?.content?.trim() || null;
}

/**
 * Find a helper, or report honestly that there is none.
 *
 * Never throws: "no helper" is the normal state for almost everyone, not an error to handle.
 */
export async function detectHelper(saved: SavedHelper | null, doc: Document = document): Promise<HelperConnection | null> {
  const local = tokenInDocument(doc);
  if (local) {
    const here = await ask(window.location.origin, local);
    if (here) return { origin: window.location.origin, token: local, health: here, sameOrigin: true };
  }
  if (saved) {
    const there = await ask(saved.origin, saved.token);
    if (there) return { origin: saved.origin, token: saved.token, health: there, sameOrigin: false };
  }
  return null;
}

async function ask(origin: string, token: string): Promise<HelperHealth | null> {
  try {
    const response = await fetch(`${origin}${HELPER_ROUTES.health}`, { headers: { 'x-helper-token': token }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' });
    if (!response.ok) return null;
    const parsed = HelperHealth.safeParse(await response.json());
    // A helper speaking a protocol this player does not know is worse than no helper: better to
    // say nothing is there than to build buttons from a shape that has moved.
    if (!parsed.success || parsed.data.protocol !== HELPER_PROTOCOL) return null;
    return parsed.data;
  } catch {
    // Nothing listening, a refused origin, a timeout. All the same answer.
    return null;
  }
}

export function toolIn(health: HelperHealth, id: HelperToolId): HelperHealth['tools'][number] | undefined {
  return health.tools.find((tool) => tool.id === id);
}

/** True when this helper could fetch from this host at all — before asking whether it should. */
export function helperCovers(health: HelperHealth, hosts: readonly string[]): boolean {
  return hosts.some((host) => health.allowedHosts.includes(host));
}

export class HelperError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HelperError';
  }
}

async function send(connection: HelperConnection, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${connection.origin}${path}`, { ...init, headers: { 'x-helper-token': connection.token, ...(init.headers ?? {}) }, cache: 'no-store' });
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const problem = body as { error?: string; message?: string; reason?: string } | null;
    throw new HelperError(problem?.message ?? problem?.reason ?? `The helper answered ${response.status}.`, problem?.error ?? 'http');
  }
  return body;
}

export async function startFetch(connection: HelperConnection, request: HelperFetchRequest): Promise<HelperJob> {
  const body = await send(connection, HELPER_ROUTES.fetch, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  return HelperJob.parse(body);
}

export async function jobState(connection: HelperConnection, id: string): Promise<HelperJob> {
  return HelperJob.parse(await send(connection, HELPER_ROUTES.job(id)));
}

export async function forgetJob(connection: HelperConnection, id: string): Promise<void> {
  // A job the player has already taken the files from is litter on someone's disk. Best effort:
  // failing to tidy up is not worth failing an import that otherwise worked.
  await send(connection, HELPER_ROUTES.job(id), { method: 'DELETE' }).catch(() => undefined);
}

export async function installTool(connection: HelperConnection, tool: HelperToolId): Promise<HelperInstallResult> {
  return (await send(connection, HELPER_ROUTES.install(tool), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })) as HelperInstallResult;
}

/** Bring the finished files across as ordinary `File`s, which is all the library import wants. */
export async function collectFiles(connection: HelperConnection, job: HelperJob): Promise<File[]> {
  const files: File[] = [];
  for (const entry of job.files) {
    const response = await fetch(`${connection.origin}${HELPER_ROUTES.file(job.id, entry.id)}`, { headers: { 'x-helper-token': connection.token }, cache: 'no-store' });
    if (!response.ok) throw new HelperError(`${entry.name} could not be read back from the helper.`, 'file');
    files.push(new File([await response.blob()], entry.name, { type: entry.contentType }));
  }
  return files;
}

/**
 * Run a fetch to its end, reporting as it goes.
 *
 * Polling rather than a socket: a job is a handful of state changes over a minute or two, and a
 * second connection to keep alive would be more machinery than the problem has.
 */
export async function runFetch(connection: HelperConnection, request: HelperFetchRequest, onProgress: (job: HelperJob) => void, signal?: AbortSignal): Promise<{ job: HelperJob; files: File[] }> {
  const started = await startFetch(connection, request);
  onProgress(started);
  let job = started;
  while (job.state === 'queued' || job.state === 'running') {
    if (signal?.aborted) {
      await forgetJob(connection, job.id);
      throw new HelperError('Cancelled.', 'cancelled');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    job = await jobState(connection, job.id);
    onProgress(job);
  }
  if (job.state !== 'done') throw new HelperError(job.error ?? 'The helper stopped without saying why.', job.state);
  const files = await collectFiles(connection, job);
  await forgetJob(connection, job.id);
  return { job, files };
}

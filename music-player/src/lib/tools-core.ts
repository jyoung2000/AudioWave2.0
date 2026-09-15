/**
 * What a source of tools looks like, whichever side of the glass it is on.
 *
 * There are two ways yt-dlp can be reachable from this player, and they have nothing in common
 * mechanically: a helper on loopback, reached over HTTP, or a native shell carrying the tool in its
 * own process, reached through a JavaScript bridge. What they *do* have in common is the protocol —
 * the one in `@now-playing/contracts` — so this file makes that the only thing the rest of the app
 * knows about. The Platforms panel, the fetch sheet and the store were written against a helper and
 * did not change to gain an Android build; they were already written against this shape.
 *
 * That is the whole point of doing it this way. An Android app that forked the web app would be two
 * products drifting apart from the day it shipped. An Android app that is a transport is a shell.
 *
 * Nothing here imports a transport — the transports import this — so the two cannot become a circle.
 *
 * The rule the old file carried still holds and matters more now: **the player never claims a
 * capability it has not just observed.** It asks, and the interface is built from the answer. A
 * backend that stops answering takes its buttons with it.
 */
import { HELPER_PROTOCOL, type HelperFetchRequest, type HelperHealth, type HelperInstallResult, type HelperJob, type HelperJobFile, type HelperToolId } from '@now-playing/contracts';

export interface ToolBackend {
  /** `built-in` is a native shell carrying the tools; `helper` is a program on loopback. */
  kind: 'built-in' | 'helper';
  /** How the interface names it, in a sentence. */
  label: string;
  health: HelperHealth;
  /** The address to show, or null when there is no address — the bridge is the same process. */
  origin: string | null;
  startFetch(request: HelperFetchRequest): Promise<HelperJob>;
  jobState(id: string): Promise<HelperJob>;
  forget(id: string): Promise<void>;
  install(tool: HelperToolId): Promise<HelperInstallResult>;
  fileOf(job: HelperJob, entry: HelperJobFile): Promise<File>;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** A protocol this player does not speak is worse than none: better to report nothing than to build
 * an interface from a shape that has moved. */
export function protocolMatches(health: HelperHealth): boolean {
  return health.protocol === HELPER_PROTOCOL;
}

const POLL_MS = 900;

/**
 * Run a fetch to its end, reporting as it goes.
 *
 * Polling rather than a subscription, on both transports: a job is a handful of state changes over a
 * minute or two, and neither a second socket nor a callback registry across a bridge is worth that.
 */
export async function runFetch(backend: ToolBackend, request: HelperFetchRequest, onProgress: (job: HelperJob) => void, signal?: AbortSignal): Promise<{ job: HelperJob; files: File[] }> {
  const started = await backend.startFetch(request);
  onProgress(started);
  let job = started;
  while (job.state === 'queued' || job.state === 'running') {
    if (signal?.aborted) {
      await backend.forget(job.id);
      throw new ToolError('Cancelled.', 'cancelled');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    job = await backend.jobState(job.id);
    onProgress(job);
  }
  if (job.state !== 'done') throw new ToolError(job.error ?? 'It stopped without saying why.', job.state);

  const files: File[] = [];
  for (const entry of job.files) files.push(await backend.fileOf(job, entry));
  // Tidying up is best effort: failing to delete a temporary file is not worth failing an import
  // that otherwise worked.
  await backend.forget(job.id).catch(() => undefined);
  return { job, files };
}

export function toolIn(health: HelperHealth, id: HelperToolId): HelperHealth['tools'][number] | undefined {
  return health.tools.find((tool) => tool.id === id);
}

/** True when this backend could reach this host at all — before asking whether it should. */
export function backendCovers(health: HelperHealth, hosts: readonly string[]): boolean {
  return hosts.some((host) => health.allowedHosts.includes(host));
}

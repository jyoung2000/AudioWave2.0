/**
 * The tools when they are in the same process as the page.
 *
 * An Android build puts an object on `window` and the player talks to that instead of to a socket.
 * The shape is dictated by what an Android `@JavascriptInterface` can actually carry: **strings in,
 * strings out, synchronously.** No promises, no objects, no callbacks. So every method here takes
 * and returns JSON text, and the protocol on either side of it is the same one the helper speaks.
 *
 * Two consequences worth stating, because they explain the shape rather than excusing it:
 *
 *   **Every call must return at once.** A bridge method runs on a background thread but blocks the
 *   JavaScript that called it, so nothing here may wait on work. `startFetch` starts a job and
 *   returns its id; progress arrives by polling, exactly as it does over HTTP. `health` returns a
 *   snapshot the native side keeps fresh on its own time.
 *
 *   **Bytes do not cross the bridge.** A forty-megabyte file base64'd through a synchronous string
 *   return would freeze the interface, so `fileUrl` hands back a URL the WebView fetches from the
 *   app's own asset loader instead. The bytes travel the way bytes normally travel.
 *
 * There is no token here. The bridge is injected into one WebView by the app that owns it, so there
 * is no other page that could reach it and nothing for a token to protect against.
 */
import { HelperHealth, HelperInstallResult, HelperJob, type HelperFetchRequest, type HelperJobFile, type HelperToolId } from '@now-playing/contracts';
import { ToolError, protocolMatches, type ToolBackend } from './tools-core.js';

/** What the Android shell injects. Every method is synchronous and speaks JSON. */
export interface AndroidToolsBridge {
  protocol(): number;
  health(): string;
  startFetch(request: string): string;
  jobState(id: string): string;
  forget(id: string): string;
  install(tool: string): string;
  fileUrl(jobId: string, fileId: string): string;
}

declare global {
  interface Window {
    NowPlayingTools?: AndroidToolsBridge;
  }
}

export function bridge(): AndroidToolsBridge | null {
  if (typeof window === 'undefined') return null;
  const found = window.NowPlayingTools;
  // Duck-typed rather than trusted: something else could own this name, and a partial object would
  // fail later at a worse moment than this one.
  return found && typeof found.health === 'function' && typeof found.startFetch === 'function' ? found : null;
}

/**
 * Parse what came back, or throw what it said.
 *
 * A synchronous bridge method cannot reject, so a failure comes back as the same `{error, message}`
 * body the helper returns over HTTP. Keeping the two identical is what lets the interface above
 * show one sentence without caring which side it came from.
 */
function unwrap(text: string, what: string): unknown {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new ToolError(`This app’s tools answered ${what} with something that is not JSON.`, 'bridge');
  }
  const problem = body as { error?: string; message?: string } | null;
  if (problem && typeof problem === 'object' && typeof problem.error === 'string') {
    throw new ToolError(problem.message ?? `The tools refused: ${problem.error}.`, problem.error);
  }
  return body;
}

/**
 * The backend, when this page is inside an Android build.
 *
 * Returns null everywhere else, which is almost everywhere — this is a few hundred bytes in the
 * bundle that does nothing at all in a browser, and that is the correct trade for not forking the
 * app into two.
 */
export async function androidBackend(): Promise<ToolBackend | null> {
  const tools = bridge();
  if (!tools) return null;

  let health: HelperHealth;
  try {
    const parsed = HelperHealth.safeParse(unwrap(tools.health(), 'health'));
    if (!parsed.success || !protocolMatches(parsed.data)) return null;
    health = parsed.data;
  } catch {
    // A bridge that is there but will not answer is, for every purpose here, a bridge that is not.
    return null;
  }

  return {
    kind: 'built-in',
    label: 'Built into this app',
    health,
    origin: null,
    startFetch: async (request: HelperFetchRequest) => HelperJob.parse(unwrap(tools.startFetch(JSON.stringify(request)), 'a fetch')),
    jobState: async (id: string) => HelperJob.parse(unwrap(tools.jobState(id), 'a job')),
    forget: async (id: string) => {
      unwrap(tools.forget(id), 'a job');
    },
    install: async (tool: HelperToolId) => HelperInstallResult.parse(unwrap(tools.install(tool), 'an install')),
    fileOf: async (job: HelperJob, entry: HelperJobFile) => {
      const url = tools.fileUrl(job.id, entry.id);
      if (!url) throw new ToolError(`${entry.name} is not where the app left it.`, 'file');
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new ToolError(`${entry.name} could not be read back (${response.status}).`, 'file');
      return new File([await response.blob()], entry.name, { type: entry.contentType });
    },
  };
}

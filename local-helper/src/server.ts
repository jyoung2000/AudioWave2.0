/**
 * The socket.
 *
 * Small on purpose: Node's own `http`, no framework, one routing table you can read in a minute.
 * The hub has Fastify because it is a server with accounts, rate limits and a hundred routes; this
 * has five routes and runs on the machine it serves, so every dependency it does not have is a
 * dependency nobody has to trust.
 *
 * The parts that are not obvious:
 *
 *   **JSON is required on a POST.** Not for tidiness — a POST with a plain content type is a
 *   "simple request" and skips the preflight, so a page on any site could fire one at loopback and
 *   cause a side effect even though it could never read the reply. Requiring `application/json`
 *   forces the preflight, and the preflight is where the origin check happens.
 *
 *   **The private-network preflight is answered.** Chrome asks before letting a public page reach
 *   a local address; saying yes here is what lets a player hosted on the web talk to a helper on
 *   your own machine, and saying it only for allowed origins is what keeps that narrow.
 *
 *   **Health needs no token.** It reveals that a helper is running and which tools it found, which
 *   is exactly what the app must know before it can ask for a token to be pasted. Everything that
 *   *does* anything, or returns bytes, needs one.
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HELPER_DEFAULT_HOSTS, HELPER_PROTOCOL, HELPER_ROUTES, HelperFetchRequest, HelperToolId, type HelperHealth, type HelperInstallResult, type HelperToolId as ToolId, type OutputFormat } from '@now-playing/contracts';
import { Jobs } from './jobs.js';
import { serveApp, type AppSource } from './app.js';
import { checkFetchUrl, originAllowed, tokenMatches, type OriginPolicy } from './security.js';
import { installYtDlp, publicTool, resolveAll, type ResolvedTool } from './tools.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_JOBS = 50;

export interface HelperOptions {
  port: number;
  version: string;
  token: string;
  workDir: string;
  toolsDir: string;
  timeoutMs: number;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  app: AppSource | null;
  configured: { 'yt-dlp'?: string | undefined; spotdl?: string | undefined; ffmpeg?: string | undefined };
  log: (line: string) => void;
}

export interface Helper {
  server: Server;
  jobs: Jobs;
  origin: string;
  close: () => Promise<void>;
}

export async function startHelper(options: HelperOptions): Promise<Helper> {
  const startedAt = new Date().toISOString();
  const resolve_ = (): Promise<Record<ToolId, ResolvedTool>> => resolveAll({ configured: options.configured, toolsDir: options.toolsDir });
  const jobs = new Jobs({ workDir: options.workDir, timeoutMs: options.timeoutMs, tools: resolve_ });
  const origin = `http://127.0.0.1:${options.port}`;
  const policy: OriginPolicy = { allowed: options.allowedOrigins, self: options.app ? origin : null };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      options.log(`unhandled: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) fail(response, 500, 'internal', 'The helper hit an error it did not expect.');
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin_ = header(request, 'origin');
    const url = new URL(request.url ?? '/', origin);
    const path = url.pathname;

    if (!originAllowed(policy, origin_)) {
      // Deliberately the same answer whether the origin is unknown or the path does not exist.
      return fail(response, 403, 'origin', 'This origin may not talk to the helper.');
    }
    applyCors(response, origin_);

    if (request.method === 'OPTIONS') {
      if (header(request, 'access-control-request-private-network') === 'true') response.setHeader('access-control-allow-private-network', 'true');
      response.writeHead(204, { 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, x-helper-token', 'access-control-max-age': '600' });
      return void response.end();
    }

    if (!path.startsWith('/helper/')) {
      if (!options.app) return fail(response, 404, 'not-found', 'This helper serves the API only; open the player from wherever you installed it.');
      if (request.method !== 'GET' && request.method !== 'HEAD') return fail(response, 405, 'method', 'Only GET is served here.');
      if (!serveApp(options.app, path, options.token, response).served) return fail(response, 404, 'not-found', 'No such file.');
      return;
    }

    // Everything past here is the API, and everything but health needs the token.
    if (path !== HELPER_ROUTES.health && !tokenMatches(options.token, header(request, 'x-helper-token'))) {
      return fail(response, 401, 'token', 'This request needs the helper’s token. It is printed when the helper starts.');
    }

    if (path === HELPER_ROUTES.health && request.method === 'GET') {
      const tools = await resolve_();
      const health: HelperHealth = {
        helper: 'now-playing-local-helper',
        protocol: HELPER_PROTOCOL,
        version: options.version,
        servesApp: options.app !== null,
        tools: [publicTool(tools['yt-dlp']), publicTool(tools.spotdl), publicTool(tools.ffmpeg)],
        allowedHosts: [...options.allowedHosts],
        formats: tools.ffmpeg.present ? ['original', 'mp3', 'aac', 'opus', 'flac'] : ['original'],
        startedAt,
      };
      return send(response, 200, health);
    }

    if (path === HELPER_ROUTES.fetch && request.method === 'POST') {
      const body = await readJson(request, response);
      if (body === undefined) return;
      const parsed = HelperFetchRequest.safeParse(body);
      if (!parsed.success) return fail(response, 400, 'validation', `That request is not one this helper understands: ${parsed.error.issues[0]?.message ?? 'invalid'}.`);
      if (jobs.list().length >= MAX_JOBS) return fail(response, 429, 'busy', 'There are already too many jobs here. Clear some before starting another.');

      const checked = checkFetchUrl(parsed.data.url, options.allowedHosts);
      if (!checked.ok || !checked.url) return fail(response, 400, 'url', checked.reason ?? 'That address is not one this helper will fetch from.');

      const tools = await resolve_();
      const tool = pickTool(parsed.data.tool, checked.url);
      if (!tools[tool].present) return fail(response, 409, 'tool-missing', tools[tool].installHint ?? `${tool} is not installed.`);

      const job = jobs.create({ url: checked.url.toString(), tool, format: parsed.data.format as OutputFormat });
      options.log(`job ${job.id}: ${tool} ${checked.url.hostname} (${parsed.data.authorization.basis})`);
      return send(response, 202, job);
    }

    const install = /^\/helper\/v1\/tools\/([a-z-]+)\/install$/.exec(path);
    if (install && request.method === 'POST') {
      const tool = HelperToolId.safeParse(install[1]);
      if (!tool.success) return fail(response, 404, 'not-found', 'No such tool.');
      if (tool.data !== 'yt-dlp') {
        const result: HelperInstallResult = { tool: tool.data, installed: false, version: null, reason: `The helper does not fetch ${tool.data}; install it yourself so you know where it came from.` };
        return send(response, 409, result);
      }
      options.log(`installing yt-dlp into ${options.toolsDir}`);
      const outcome = await installYtDlp(options.toolsDir);
      const result: HelperInstallResult = { tool: 'yt-dlp', installed: outcome.installed, version: outcome.version, reason: outcome.reason };
      options.log(outcome.installed ? `installed ${outcome.version}` : `install refused: ${outcome.reason ?? 'unknown'}`);
      return send(response, outcome.installed ? 200 : 409, result);
    }

    const file = /^\/helper\/v1\/jobs\/([^/]+)\/files\/([^/]+)$/.exec(path);
    if (file && request.method === 'GET') {
      const found = jobs.filePath(decodeURIComponent(file[1]!), decodeURIComponent(file[2]!));
      if (!found) return fail(response, 404, 'not-found', 'That file is not here any more.');
      response.writeHead(200, {
        'content-type': found.file.contentType,
        'content-length': statSync(found.path).size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.file.name)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      return void createReadStream(found.path).pipe(response);
    }

    const single = /^\/helper\/v1\/jobs\/([^/]+)$/.exec(path);
    if (single) {
      const id = decodeURIComponent(single[1]!);
      if (request.method === 'GET') {
        const job = jobs.get(id);
        return job ? send(response, 200, job) : fail(response, 404, 'not-found', 'No such job.');
      }
      if (request.method === 'DELETE') {
        return jobs.forget(id) ? send(response, 200, { ok: true }) : fail(response, 404, 'not-found', 'No such job.');
      }
    }

    return fail(response, 404, 'not-found', 'No such route.');
  }

  function applyCors(response: ServerResponse, origin_: string | undefined): void {
    if (!origin_) return;
    response.setHeader('access-control-allow-origin', origin_);
    response.setHeader('vary', 'Origin');
  }

  async function readJson(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
    const type = header(request, 'content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/json')) {
      fail(response, 415, 'content-type', 'Send application/json. A simpler content type would skip the browser’s preflight, and the preflight is the check.');
      return undefined;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        fail(response, 413, 'too-large', 'That request body is far larger than anything this helper accepts.');
        request.destroy();
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      fail(response, 400, 'validation', 'That body is not JSON.');
      return undefined;
    }
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    // Loopback only. Not a setting: a program that runs subprocesses should not be reachable from
    // anywhere its operator is not already sitting.
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });

  return {
    server,
    jobs,
    origin,
    close: async () => {
      jobs.shutdown();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

/** spotDL is for Spotify links and yt-dlp is for the rest; asking for one by name overrides that. */
export function pickTool(requested: 'auto' | 'yt-dlp' | 'spotdl', url: URL): ToolId {
  if (requested !== 'auto') return requested;
  return /(^|\.)spotify\.com$/.test(url.hostname) ? 'spotdl' : 'yt-dlp';
}

export function defaultHosts(): string[] {
  return [...HELPER_DEFAULT_HOSTS];
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  response.end(text);
}

function fail(response: ServerResponse, status: number, error: string, message: string): void {
  send(response, status, { error, message });
}

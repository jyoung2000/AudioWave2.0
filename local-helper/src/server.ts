/**
 * The socket.
 *
 * Small on purpose: Node's own `http`, no framework, one routing table you can read in a minute.
 * The hub has Fastify because it is a server with accounts, rate limits and a hundred routes; this
 * has a handful of routes and runs on the machine it serves, so every dependency it does not have is a
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
import { BACKUP_PARTS, createEstimator, type BackupPart } from './measure.js';
import { HELPER_DEFAULT_HOSTS, HELPER_PROTOCOL, HELPER_ROUTES, HelperFetchRequest, HelperToolId, type HelperHealth, type HelperInstallResult, type HelperToolId as ToolId, type HelperTvChannel, type HelperTvChannels, type HelperTvGuide, type HelperTvGuideEntry, type OutputFormat } from '@now-playing/contracts';
import { Jobs } from './jobs.js';
import { readStationTitle } from '@now-playing/domain/radio-node';
import type { StationNowPlaying } from '@now-playing/contracts';
import { serveApp, type AppSource } from './app.js';
import { checkFetchUrl, hostAllowed, originAllowed, tokenMatches, type OriginPolicy } from './security.js';
import { cachedResolver, publicTool, type ResolvedTool } from './tools.js';
import { ToolProvisioner } from './provision.js';

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
  /** Answer pages served from this machine's loopback address on any port (the companion sets this). */
  loopbackPages?: boolean;
  /** Reads a station's ICY title; tests inject a fake station. */
  stationTitle?: (url: string) => Promise<StationNowPlaying>;
  app: AppSource | null;
  configured: { 'yt-dlp'?: string | undefined; spotdl?: string | undefined; ffmpeg?: string | undefined };
  log: (line: string) => void;
  /** How long a finished job and its files are kept. Default one hour. */
  finishedTtlMs?: number;
  /** The folders a backup can include, and where backups go. Unset folders are simply not measured. */
  backup?: { folders: Partial<Record<BackupPart, string | readonly string[] | null | undefined>>; backupDir: string | null; budgetMs?: number; now?: () => number };
  /** How tool setup reaches GitHub. Tests pass a fake; nothing else should. */
  fetchImpl?: typeof fetch;
  /** Called when setup lands a tool, after the resolver has forgotten its old answer. */
  onToolInstalled?: (id: ToolId) => void;
  /** Called whenever a tool's setup status changes. */
  onToolSetupChange?: () => void;
  /**
   * Live TV, when something keeps it. The companion passes the channels and guides from its Live TV
   * tab; the standalone helper keeps none, and its two TV routes answer with empty lists.
   */
  tv?: { channels: () => Promise<HelperTvChannel[]> | HelperTvChannel[]; guide: () => Promise<HelperTvGuideEntry[]> | HelperTvGuideEntry[] };
}

export interface Helper {
  server: Server;
  jobs: Jobs;
  origin: string;
  /** Tool setup. The CLI and the companion call `tools.ensure()` after start; the server never does by itself. */
  tools: ToolProvisioner;
  close: () => Promise<void>;
}

export async function startHelper(options: HelperOptions): Promise<Helper> {
  const startedAt = new Date().toISOString();
  const resolver = cachedResolver({ configured: options.configured, toolsDir: options.toolsDir });
  const resolve_ = (): Promise<Record<ToolId, ResolvedTool>> => resolver.get();
  const jobs = new Jobs({ workDir: options.workDir, timeoutMs: options.timeoutMs, tools: resolve_, log: options.log, ...(options.finishedTtlMs ? { finishedTtlMs: options.finishedTtlMs } : {}) });
  // Settled once the socket is bound: with port 0 the real port is only known then.
  let port = options.port;
  let origin = `http://127.0.0.1:${port}`;
  let policy: OriginPolicy = { allowed: options.allowedOrigins, self: options.app ? origin : null, loopbackPages: options.loopbackPages === true };
  const stationCache = new Map<string, { at: number; value: Promise<StationNowPlaying> }>();
  let stationReads = 0;
  const tools = new ToolProvisioner({
    toolsDir: options.toolsDir,
    configured: options.configured,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    busy: () => jobs.busy(),
    log: options.log,
    onInstalled: (id) => {
      resolver.invalidate();
      options.onToolInstalled?.(id);
    },
    ...(options.onToolSetupChange ? { onChange: options.onToolSetupChange } : {}),
  });
  const estimate = createEstimator(options.backup ?? { folders: {}, backupDir: null });

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      options.log(`unhandled: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) fail(response, 500, 'internal', 'The helper hit an error it did not expect.');
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Before anything else, including the origin check: a rebound hostile name arrives with no Origin.
    if (!hostAllowed(header(request, 'host'), port)) return fail(response, 421, 'host', 'This helper only answers to 127.0.0.1 or localhost.');
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

    // Radio titles need no token: the route only ever reads a public stream (the reader refuses
    // private and loopback addresses, on the name and after DNS), and a page opened from the hub
    // has no way to learn the token. But it must come from a page the origin check has vetted: a
    // request with no Origin is what an <img> or a no-cors fetch on any website sends, and without
    // this it would make the helper a blind GET relay for the whole web. The token still opens it.
    if (path === HELPER_ROUTES.radioNowPlaying && request.method === 'GET') {
      if (origin_ === undefined && !tokenMatches(options.token, header(request, 'x-helper-token'))) {
        return fail(response, 403, 'origin', 'This origin may not talk to the helper.');
      }
      const station = url.searchParams.get('url') ?? '';
      if (!station || station.length > 2048) return fail(response, 400, 'bad-request', 'Say which station: ?url=');
      const now = Date.now();
      const hit = stationCache.get(station);
      if (hit && now - hit.at < 15_000) return send(response, 200, await hit.value);
      // One tuned station per player; a burst of distinct stations is not a player.
      if (stationReads >= 8) return fail(response, 429, 'busy', 'Too many stations at once. Try again in a moment.');
      const read = options.stationTitle ?? ((u: string) => readStationTitle(u, { timeoutMs: 8000, userAgent: `NowPlaying-helper/${options.version}` }));
      stationReads += 1;
      const value = read(station)
        .catch((): StationNowPlaying => ({ raw: null, artist: null, title: null, station: null, reason: 'The station could not be read' }))
        .finally(() => {
          stationReads -= 1;
        });
      stationCache.delete(station);
      if (stationCache.size >= 200) stationCache.delete(stationCache.keys().next().value!);
      stationCache.set(station, { at: now, value });
      return send(response, 200, await value);
    }

    // Live TV is read by the same pages for the same reason: a player opened from the hub cannot
    // learn the token. Both routes only hand back what the companion already keeps — nothing here
    // reaches the network — and the rule is the radio route's: a vetted page, or the token.
    if ((path === HELPER_ROUTES.tvChannels || path === HELPER_ROUTES.tvGuide) && request.method === 'GET') {
      if (origin_ === undefined && !tokenMatches(options.token, header(request, 'x-helper-token'))) {
        return fail(response, 403, 'origin', 'This origin may not talk to the helper.');
      }
      if (path === HELPER_ROUTES.tvChannels) {
        const channels: HelperTvChannels = { channels: options.tv ? await options.tv.channels() : [] };
        return send(response, 200, channels);
      }
      const guide: HelperTvGuide = { generatedAt: new Date().toISOString(), guide: options.tv ? await options.tv.guide() : [] };
      return send(response, 200, guide);
    }

    // Everything past here is the API, and everything but health needs the token.
    if (path !== HELPER_ROUTES.health && !tokenMatches(options.token, header(request, 'x-helper-token'))) {
      return fail(response, 401, 'token', 'This request needs the helper’s token. It is printed when the helper starts.');
    }

    if (path === HELPER_ROUTES.health && request.method === 'GET') {
      const found = await resolve_();
      const setup = tools.status();
      const withSetup = (id: ToolId) => {
        const record = publicTool(found[id]);
        const state = setup[id];
        return state ? { ...record, setup: state } : record;
      };
      const health: HelperHealth = {
        helper: 'now-playing-local-helper',
        protocol: HELPER_PROTOCOL,
        version: options.version,
        servesApp: options.app !== null,
        tools: [withSetup('yt-dlp'), withSetup('spotdl'), withSetup('ffmpeg')],
        allowedHosts: [...options.allowedHosts],
        formats: found.ffmpeg.present ? ['original', 'mp3', 'aac', 'opus', 'flac'] : ['original'],
        startedAt,
      };
      return send(response, 200, health);
    }

    if (path === HELPER_ROUTES.backupEstimate && request.method === 'GET') {
      const asked = (new URL(request.url ?? '/', origin).searchParams.get('parts') ?? BACKUP_PARTS.join(',')).split(',').map((p) => p.trim()).filter(Boolean);
      const unknown = asked.find((p) => !(BACKUP_PARTS as readonly string[]).includes(p));
      if (unknown !== undefined || !asked.length) return fail(response, 400, 'validation', `parts may only name ${BACKUP_PARTS.join(', ')}.`);
      return send(response, 200, await estimate([...new Set(asked)] as BackupPart[]));
    }

    if (path === HELPER_ROUTES.fetch && request.method === 'POST') {
      const body = await readJson(request, response);
      if (body === undefined) return;
      const parsed = HelperFetchRequest.safeParse(body);
      if (!parsed.success) return fail(response, 400, 'validation', `That request is not one this helper understands: ${parsed.error.issues[0]?.message ?? 'invalid'}.`);
      await jobs.sweep();
      if (jobs.list().length >= MAX_JOBS && !(await jobs.evictOldestFinished())) return fail(response, 429, 'busy', 'There are already too many jobs here. Clear some before starting another.');

      const checked = checkFetchUrl(parsed.data.url, options.allowedHosts);
      if (!checked.ok || !checked.url) return fail(response, 400, 'url', checked.reason ?? 'That address is not one this helper will fetch from.');

      const tool = pickTool(parsed.data.tool, checked.url);
      // Only the tool being set up is off limits: its file is about to be replaced.
      if (tools.installing() === tool) return fail(response, 409, 'busy', `${tool} is being set up. Try again in a moment.`);
      const found = await resolve_();
      if (!found[tool].present) return fail(response, 409, 'tool-missing', tools.status()[tool]?.reason ?? found[tool].installHint ?? `${tool} is not installed.`);

      const job = jobs.create({ url: checked.url.toString(), tool, format: parsed.data.format as OutputFormat });
      options.log(`job ${job.id}: ${tool} ${checked.url.hostname} (${parsed.data.authorization.basis})`);
      return send(response, 202, job);
    }

    const install = /^\/helper\/v1\/tools\/([a-z-]+)\/install$/.exec(path);
    if (install && request.method === 'POST') {
      const tool = HelperToolId.safeParse(install[1]);
      if (!tool.success) return fail(response, 404, 'not-found', 'No such tool.');
      const id = tool.data;
      // Replacing a binary a job is running fails on Windows, so wait for the jobs instead.
      if (jobs.busy() && (await resolve_())[id].present) {
        const result: HelperInstallResult = { tool: id, installed: false, version: null, reason: 'Downloads are running. Wait for them to finish, then install again.' };
        return send(response, 409, result);
      }
      // One install at a time: this queues behind automatic setup or another request, then runs.
      const outcome = await tools.install(id);
      resolver.invalidate();
      const result: HelperInstallResult = { tool: id, installed: outcome.installed, version: outcome.version, reason: outcome.reason };
      return send(response, result.installed ? 200 : 409, result);
    }

    const file = /^\/helper\/v1\/jobs\/([^/]+)\/files\/([^/]+)$/.exec(path);
    if (file && request.method === 'GET') {
      const jobId = safeDecode(file[1]!);
      const fileId = safeDecode(file[2]!);
      if (jobId === null || fileId === null) return fail(response, 400, 'validation', 'That address is not encoded properly.');
      const found = jobs.filePath(jobId, fileId);
      if (!found) return fail(response, 404, 'not-found', 'That file is not here any more.');
      let size: number;
      try {
        size = statSync(found.path).size;
      } catch {
        return fail(response, 404, 'not-found', 'That file is not here any more.');
      }
      response.writeHead(200, {
        'content-type': found.file.contentType,
        'content-length': size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.file.name)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      // The job can be forgotten mid-download; a read error then ends this response, not the helper.
      const stream = createReadStream(found.path);
      stream.on('error', () => response.destroy());
      return void stream.pipe(response);
    }

    const single = /^\/helper\/v1\/jobs\/([^/]+)$/.exec(path);
    if (single) {
      const id = safeDecode(single[1]!);
      if (id === null) return fail(response, 400, 'validation', 'That address is not encoded properly.');
      if (request.method === 'GET') {
        const job = jobs.get(id);
        return job ? send(response, 200, job) : fail(response, 404, 'not-found', 'No such job.');
      }
      if (request.method === 'DELETE') {
        return (await jobs.forget(id)) ? send(response, 200, { ok: true }) : fail(response, 404, 'not-found', 'No such job.');
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
  const address = server.address();
  if (typeof address === 'object' && address) port = address.port;
  origin = `http://127.0.0.1:${port}`;
  policy = { allowed: options.allowedOrigins, self: options.app ? origin : null, loopbackPages: options.loopbackPages === true };

  // Finished jobs that nobody collected still hold disk; drop them on a timer too, not only on demand.
  const sweeper = setInterval(() => void jobs.sweep(), 60_000);
  sweeper.unref();

  return {
    server,
    jobs,
    origin,
    tools,
    close: async () => {
      clearInterval(sweeper);
      // Setup stops with the helper: a restarted helper starts its own, into the same folder.
      await tools.close();
      await jobs.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
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

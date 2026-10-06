import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOWNLOAD_BATCH_CAP, type ProviderCapabilities, type ProviderDescriptor, type ProviderHealth, type SearchResult } from '@now-playing/contracts';
import { DomainError, hostMatches, validateOutboundUrl } from '@now-playing/domain';
import { versionOf } from '@now-playing/domain/tool-install';
import { fromSpotdl, fromYtDlp, type MediaProbe } from '../../media/media-metadata.js';
import { lastError, resolveExecutable, runTool, ToolRunError } from '../../media/run-tool.js';
import type { AuthorizedDownload, DownloadContext, ProviderTestResult } from '../adapter.js';
import { BaseAdapter, caps, healthy, REVIEWED_AT, result } from './base.js';

export type PresetTool = 'yt-dlp' | 'spotdl';

/** Where one download writes, and what it may use. Every value is the hub's, never a requester's — except `url`. */
export interface DownloadArgsContext {
  url: string;
  /** A directory of the job's own; the tool names the file inside it. */
  outputDir: string;
  /** The FFmpeg the hub found, or null when it has none (the tool then cannot convert or embed). */
  ffmpeg: string | null;
  /** This Node, which yt-dlp uses to run YouTube's player JavaScript. */
  node: string | null;
}

export interface MetadataArgsContext {
  url: string;
  ffmpeg: string | null;
  node: string | null;
  /** spotDL writes its answer to a file; yt-dlp prints it. */
  saveFile: string;
  /** Entries to list, one more than the batch cap so the hub can tell when a list was longer. */
  listLimit: number;
  /** spotDL: also find the YouTube Music recording it would download (`--preload`), for the catalog. */
  match?: boolean;
}

export interface ToolPreset {
  tool: PresetTool;
  displayName: string;
  binary: string;
  allowedHosts: readonly string[];
  note: string;
  /** The download command line. The URL is always the last argument, behind `--`. */
  download(ctx: DownloadArgsContext): string[];
  /** The metadata command line, or null where the tool cannot run without FFmpeg and there is none. */
  metadata(ctx: MetadataArgsContext): string[] | null;
  /** The file the download leaves beside the audio describing it, read for the tags. */
  infoFile: string;
  /** spotDL keeps its settings and caches in the home directory; it gets a new, empty one every run. */
  needsHome: boolean;
}

/**
 * The command lines, written here rather than typed into an admin form.
 *
 * `--ignore-config` comes first for yt-dlp and is not decoration: a configuration file left in the
 * container's home directory would otherwise be read and obeyed, and one of the flags it could add
 * is `--exec`. spotDL has no such flag; instead it is run with a fresh, empty home directory every
 * time, so there is no configuration file for it to find. Both take the URL last, behind `--`, so
 * nothing in a link can be read as a flag.
 *
 * Each download gets a directory of its own and the hub takes the one audio file that appears in
 * it. That is what lets yt-dlp extract the audio (`--extract-audio` renames the file it downloaded:
 * a WebM becomes `.opus`) and embed the metadata and the thumbnail it read, and what lets spotDL —
 * which names its files itself — be used at all. Until 2026-10-04 there was no spotDL preset,
 * because a hub job was one track at one path and spotDL turns a Spotify link into a set; the owner
 * decided the hub should take Spotify links too (design/decisions.md DEC-036), so a playlist or
 * album link now becomes one job per track (`POST /downloads/batch`) and each job runs spotDL for
 * its one track in its own directory.
 *
 * spotDL never touches Spotify's audio. It reads Spotify for the track data and fetches a matching
 * recording from YouTube Music: the file is another recording of the same song.
 */
export const TOOL_PRESETS: Record<PresetTool, ToolPreset> = {
  'yt-dlp': {
    tool: 'yt-dlp',
    displayName: 'yt-dlp',
    binary: '/usr/local/bin/yt-dlp',
    allowedHosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'soundcloud.com', 'on.soundcloud.com', 'bandcamp.com', '*.bandcamp.com', 'archive.org'],
    note: 'Shipped in the image, and set up by the hub itself anywhere else. Keeping it current matters: yt-dlp works by tracking sites that change, so an old copy fails confusingly rather than safely.',
    download: ({ url, outputDir, ffmpeg, node }) => [
      '--ignore-config',
      '--no-colors',
      '--newline',
      '--no-mtime',
      '--no-cache-dir',
      '--no-playlist',
      '--format',
      'bestaudio/best',
      ...(node ? ['--js-runtimes', `node:${node}`] : []),
      // Extracting, tagging and embedding all need FFmpeg; without it the file is saved as it came.
      ...(ffmpeg ? ['--ffmpeg-location', ffmpeg, '--extract-audio', '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg'] : []),
      '--write-info-json',
      '--output',
      join(outputDir, 'media.%(ext)s'),
      '--',
      url,
    ],
    metadata: ({ url, node, listLimit }) => ['--ignore-config', '--no-colors', '--no-cache-dir', '--no-warnings', '--dump-single-json', '--no-download', '--no-playlist', '--flat-playlist', '--playlist-end', String(listLimit), ...(node ? ['--js-runtimes', `node:${node}`] : []), '--', url],
    infoFile: 'media.info.json',
    needsHome: false,
  },
  spotdl: {
    tool: 'spotdl',
    displayName: 'spotDL',
    binary: '/usr/local/bin/spotdl',
    allowedHosts: ['open.spotify.com'],
    note: 'Shipped in the image for open.spotify.com links. It reads Spotify for the track list and fetches a matching recording from YouTube Music; it never touches Spotify’s own audio.',
    download: ({ url, outputDir, ffmpeg }) => [
      '--no-cache',
      '--log-level',
      'ERROR',
      ...(ffmpeg ? ['--ffmpeg', ffmpeg] : []),
      '--threads',
      '1',
      // Opus as YouTube Music serves it, not re-encoded; the hub's FFmpeg converts if asked to.
      '--format',
      'opus',
      '--bitrate',
      'disable',
      '--output',
      join(outputDir, '{track-id}.{output-ext}'),
      '--save-file',
      join(outputDir, 'song.spotdl'),
      'download',
      '--',
      url,
    ],
    // spotDL refuses to start at all without FFmpeg, even to read metadata.
    metadata: ({ url, ffmpeg, saveFile, match }) => (ffmpeg ? ['--no-cache', '--log-level', 'ERROR', '--ffmpeg', ffmpeg, ...(match ? ['--preload'] : []), '--save-file', saveFile, 'save', '--', url] : null),
    infoFile: 'song.spotdl',
    needsHome: true,
  },
};

/** How a download job runs the tool. */
export interface DownloadPlan {
  binary: string;
  args: string[];
  /** `directory`: the tool names its file inside `outputDir`. `file`: an operator's template writes `{output}` exactly. */
  mode: 'directory' | 'file';
  preset: ToolPreset | null;
}

/** How long an answer from the tool stands before it is asked again. */
const PROBE_TTL_MS = 10 * 60_000;
const METADATA_CACHE_TTL_MS = 10 * 60_000;
const METADATA_CACHE_MAX = 100;
const METADATA_CONCURRENCY = 2;
/** yt-dlp answers in seconds; spotDL unpacks a large runtime first and Spotify's lookups are slow. */
const METADATA_TIMEOUT_MS: Record<PresetTool, number> = { 'yt-dlp': 60_000, spotdl: 150_000 };

/**
 * Bridge to a command-line media tool. Ready without setup (owner decision 2026-10-03): with nothing configured it is
 * yt-dlp — and, since 2026-10-04, spotDL for open.spotify.com links — run from the copies the image ships or the ones
 * the hub set up for itself (`media/tools.ts`). What made it safe was never the switch: it never passes cookies or
 * credentials to the tool, restricts it to allowlisted hosts, and only runs it for downloads the requesting user has
 * explicitly attributed to a rights basis (own content / licensed / public domain). An administrator can still turn
 * it off, or change it (Admin → Providers → External tool):
 *
 *   **A preset.** `extra.preset` names one of the tools above and fills in both the command and the hosts; leaving it
 *   empty means both. The command lines are written here — reviewed, in the repository — rather than typed into a web
 *   form where a stray `--exec` would be nobody's fault but everybody's problem.
 *
 *   **A template.** `extra.command`, such as `/usr/local/bin/mytool --no-playlist -o {output} {url}`, plus
 *   `extra.allowedHosts`. For a tool this file has never heard of.
 *
 * It also reads links without a key: `resolve()` asks the tool itself what a link is (`yt-dlp --dump-single-json`,
 * `spotdl save`), so a pasted YouTube link shows its real title on a hub with no YouTube key. A configured provider
 * with a key is asked first (`SearchService.resolveUrl` tries adapters in the order they were registered).
 */
export class ExternalToolAdapter extends BaseAdapter {
  readonly id = 'external-tool';
  /** Reading a Spotify link through spotDL can take well over the usual resolve budget. */
  readonly resolveTimeoutMs = METADATA_TIMEOUT_MS.spotdl + 10_000;

  private probes = new Map<string, { at: number; version: Promise<string | null> }>();
  private readonly metadataCache = new Map<string, { at: number; value: Promise<MediaProbe> }>();
  private metadataRunning = 0;
  private readonly metadataWaiting: Array<() => void> = [];

  /**
   * `locate` answers with the copy of a preset's tool on this machine, when the hub knows of one.
   * `environment` is the one the download service runs the tool in (`media/tool-env.ts`), so the
   * hub asks the tool whether it works in the same place it will later ask it to work. `ffmpeg`
   * is the hub's own FFmpeg, and `scratch` the folder on the data volume tools may write into.
   */
  constructor(
    private readonly locate: (tool: PresetTool) => string | null = () => null,
    private readonly environment: () => NodeJS.ProcessEnv | undefined = () => undefined,
    private readonly ffmpeg: () => Promise<string | null> = async () => null,
    private readonly scratch: () => string | null = () => null,
  ) {
    super();
  }

  /**
   * The tool's own answer to `--version`, run for real. A file that exists and will not start is not
   * a working tool — Hermes found the container's yt-dlp reported "ok" while every job it was given
   * exited 255 — so neither `test()` nor `health()` takes the file's existence as the answer.
   */
  private version(binary: string, timeoutMs = 20_000): Promise<string | null> {
    const now = Date.now();
    const cached = this.probes.get(binary);
    if (cached && now - cached.at < PROBE_TTL_MS) return cached.version;
    const version = versionOf(binary, undefined, timeoutMs, this.environment());
    this.probes.set(binary, { at: now, version });
    return version;
  }

  override async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const [binary] = this.commandTemplate();
    if (!binary || !existsSync(binary)) return { provider: this.id, status: 'unconfigured', circuit: 'closed', checkedAt, lastError: binary ? `${binary} is not on this hub yet` : 'No command configured' };
    const started = Date.now();
    const version = await this.version(binary);
    if (!version) return { provider: this.id, status: 'down', circuit: 'closed', checkedAt, lastError: `${binary} is on this hub but would not start, so downloads through it cannot run` };
    return healthy(this.id, checkedAt, Date.now() - started);
  }

  /** The tools in force that are on this hub, for the name an administrator sees in the Providers row. */
  private present(): string[] {
    const presets = this.presets();
    return presets.filter((p) => p === presets[0] || existsSync(this.binaryFor(p))).map((p) => p.displayName);
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    const tools = this.present();
    const suite = this.presets();
    const spotdl = suite.find((p) => p.tool === 'spotdl');
    const limitations = [
      `Ready without setup: ${suite.length ? suite.map((p) => p.displayName).join(' and ') : 'the configured tool'}, limited to the hosts on its list; an administrator can turn it off`,
      'Only for content you own or are licensed to download; the request records the rights basis',
      'No cookies, credentials or DRM circumvention; the tool runs without a shell and with a timeout',
      `A playlist, set or album link becomes one download per entry (at most ${DOWNLOAD_BATCH_CAP}), each tagged with its title, artist, date and cover`,
    ];
    if (spotdl) {
      limitations.push(
        existsSync(this.binaryFor(spotdl))
          ? 'spotDL, for open.spotify.com links, reads Spotify for the track data and fetches a matching recording from YouTube Music: another recording of the same song, never Spotify’s own audio'
          : 'spotDL is not on this hub yet, so open.spotify.com links cannot be read or saved',
      );
    }
    return { provider: this.id, displayName: tools.length ? `External media tool (${tools.join(', ')})` : 'External media tool', role: 'tool', authType: 'local', authScopes: [], groupCompatible: false, discordCompatible: false, reviewedAt: REVIEWED_AT, limitations };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: 'restricted', creatorDownload: 'restricted', userOwnedDownload: 'restricted', groupSync: 'unsupported', reason: 'Only for allowlisted hosts and content you have rights to' });
  }

  override requiredConfig(): readonly string[] {
    // A preset supplies both, so demanding them as well would report a working setup as incomplete.
    return this.preset() ? [] : ['command', 'allowedHosts'];
  }

  /**
   * The presets in force. The one that was named, when this build knows it; yt-dlp and spotDL when
   * nothing was configured at all. A hand-written command, or a name this build has never heard of,
   * means none — the operator started something of their own and is asked to finish it.
   */
  presets(): ToolPreset[] {
    const name = (this.config.extra['preset'] ?? '').trim();
    if (name) {
      const named = (TOOL_PRESETS as Record<string, ToolPreset | undefined>)[name];
      return named ? [named] : [];
    }
    return (this.config.extra['command'] ?? '').trim() ? [] : [TOOL_PRESETS['yt-dlp'], TOOL_PRESETS.spotdl];
  }

  /** The first preset in force — the one `binary`, health and the Test button are about. */
  preset(): ToolPreset | null {
    return this.presets()[0] ?? null;
  }

  override allowedHosts(): readonly string[] {
    const configured = (this.config.extra['allowedHosts'] ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    // A preset's hosts are the floor, not the ceiling: an operator may add, never silently lose them.
    const presets = this.presets();
    return presets.length ? [...new Set([...presets.flatMap((p) => p.allowedHosts), ...configured])] : configured;
  }

  /** Which preset handles a link: the one whose hosts it is on, else the first (an operator's extra host). */
  presetFor(url: URL): ToolPreset | null {
    const presets = this.presets();
    return presets.find((p) => p.allowedHosts.some((h) => hostMatches(url.hostname, h))) ?? presets[0] ?? null;
  }

  /** The copy of a preset's tool to run: an operator's named binary (first preset only), the hub's copy, or the preset's path. */
  binaryFor(preset: ToolPreset): string {
    const named = (this.config.extra['binary'] ?? '').trim();
    if (named && preset === this.preset()) return named;
    return this.locate(preset.tool) ?? preset.binary;
  }

  /** The operator's template, or the first preset's binary — what health and the Test button run. */
  commandTemplate(): string[] {
    const configured = (this.config.extra['command'] ?? '').split(/\s+/).filter(Boolean);
    if (configured.length) return configured;
    const preset = this.preset();
    return preset ? [this.binaryFor(preset)] : [];
  }

  timeoutMs(): number {
    const n = Number(this.config.extra['timeoutSeconds'] ?? 600);
    return (Number.isFinite(n) && n > 0 ? n : 600) * 1000;
  }

  /**
   * The command a download job runs for `url`. Built from data the hub owns plus the one URL, which
   * goes last behind `--` for a preset, and replaces `{url}` only as a whole argument in a template.
   */
  downloadPlan(url: string, where: { outputDir: string; output: string; ffmpeg: string | null }): DownloadPlan {
    const configured = (this.config.extra['command'] ?? '').split(/\s+/).filter(Boolean);
    if (configured.length) {
      const [binary, ...rest] = configured;
      const args = rest.map((a) => (a === '{url}' ? url : a.replaceAll('{output}', () => where.output)));
      if (!args.some((a) => a.includes(where.output))) args.push(where.output);
      return { binary: binary!, args, mode: 'file', preset: null };
    }
    const parsed = new URL(url);
    const preset = this.presetFor(parsed);
    const ffmpeg = resolveExecutable(where.ffmpeg);
    if (!preset) throw new DomainError('setup-required', 'No external tool command is configured');
    const binary = this.binaryFor(preset);
    if (preset.tool === 'spotdl') {
      if (!existsSync(binary)) throw new DomainError('setup-required', 'spotDL is not on this hub yet, so Spotify links cannot be saved. The hub sets it up by itself when it can reach github.com.');
      if (!ffmpeg) throw new DomainError('unsupported', 'spotDL needs FFmpeg, and this hub has none');
    }
    return { binary, args: preset.download({ url, outputDir: where.outputDir, ffmpeg, node: process.execPath }), mode: 'directory', preset };
  }

  /** The environment a run of `preset` gets: the hub's tool environment, and for spotDL a new home of its own. */
  toolEnvironment(home: string | null): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.environment() ?? { PATH: process.env['PATH'] ?? '' }) };
    if (home) {
      env['HOME'] = home;
      env['USERPROFILE'] = home;
    }
    return env;
  }

  /** A folder for one run to write into (spotDL's home, its answer), on the data volume when there is one. */
  makeRunDir(prefix: string): string {
    return mkdtempSync(join(this.scratch() ?? tmpdir(), `${prefix}-`));
  }

  /**
   * Report what is actually installed, not merely that a path exists.
   *
   * A file called `yt-dlp` that will not answer `--version` is not yt-dlp, and for this tool in
   * particular the *version* is the interesting part: a copy that is a year old does not fail
   * safely, it fails confusingly, on site after site. So the answer carries it — and spotDL's,
   * when it is one of the tools in force.
   */
  override async test(): Promise<ProviderTestResult> {
    const [binary] = this.commandTemplate();
    if (!binary) return { ok: false, latencyMs: null, message: 'No command configured, and the preset named is not one this hub knows' };
    if (!existsSync(binary)) {
      const own = this.preset() !== null && !(this.config.extra['binary'] ?? '').trim();
      return { ok: false, latencyMs: null, message: own ? `${this.preset()!.displayName} was not found on this hub yet. The hub sets it up by itself when it can reach github.com; restart the hub to try again.` : `Binary not found: ${binary}` };
    }
    if (!this.allowedHosts().length) return { ok: false, latencyMs: null, message: 'No allowed hosts configured' };
    const started = Date.now();
    this.probes.clear();
    const companion = this.presets().slice(1);
    const [version, ...others] = await Promise.all([this.version(binary), ...companion.map((p) => (existsSync(this.binaryFor(p)) ? this.version(this.binaryFor(p), 90_000) : Promise.resolve(undefined)))]);
    const latencyMs = Date.now() - started;
    if (!version) return { ok: false, latencyMs, message: `${binary} did not answer --version, so it is not being used` };
    const extras = companion.map((p, i) => {
      const answer = others[i];
      if (answer === undefined) return `${p.displayName} is not on this hub yet`;
      if (answer === null) return `${p.displayName} is on this hub but would not start`;
      return `${p.displayName} ${answer}`;
    });
    return { ok: true, latencyMs, message: `${[version, ...extras].join(' · ')} — ${this.allowedHosts().length} host(s) allowlisted` };
  }

  allowed(url: string): URL | null {
    const check = validateOutboundUrl(url, { allowedHosts: this.allowedHosts(), allowedSchemes: ['https:'] });
    if (!check.ok || !check.url) return null;
    return this.allowedHosts().some((h) => hostMatches(check.url!.hostname, h)) ? check.url : null;
  }

  /**
   * What a link is, from the tool that would download it. Cached for a few minutes (a pasted link is
   * usually resolved and then downloaded), at most two at a time (each run unpacks a runtime), and a
   * failure is not cached, so the next attempt asks again.
   */
  probe(input: string, signal?: AbortSignal, options: { match?: boolean } = {}): Promise<MediaProbe> {
    const url = this.allowed(input);
    if (!url) return Promise.reject(new DomainError('forbidden', 'That link is not on a host the external tool may reach'));
    const preset = this.presetFor(url);
    if (!preset || (this.config.extra['command'] ?? '').trim()) return Promise.reject(new DomainError('unsupported', 'Reading a link needs the yt-dlp or spotDL preset; a hand-written command cannot be asked'));
    const match = options.match === true && preset.tool === 'spotdl';
    const key = `${url.toString()}${match ? '#match' : ''}`;
    const now = Date.now();
    for (const [k, entry] of this.metadataCache) if (now - entry.at > METADATA_CACHE_TTL_MS) this.metadataCache.delete(k);
    const hit = this.metadataCache.get(key);
    if (hit) return hit.value;
    const value = this.withSlot(() => this.readMetadata(preset, url.toString(), signal, match));
    this.metadataCache.set(key, { at: now, value });
    while (this.metadataCache.size > METADATA_CACHE_MAX) this.metadataCache.delete(this.metadataCache.keys().next().value!);
    value.catch(() => {
      if (this.metadataCache.get(key)?.value === value) this.metadataCache.delete(key);
    });
    return value;
  }

  /**
   * One page of a catalog search through yt-dlp (`ytsearchN:` / `scsearchN:`, DEC-039). The arguments
   * are `toolSearchArgs` from the domain and are checked for that shape again here: `--ignore-config`
   * first, the search last behind `--`. Shares the two metadata slots, so searches cannot pile up
   * processes.
   */
  async catalogSearch(args: readonly string[], signal?: AbortSignal): Promise<unknown> {
    const preset = TOOL_PRESETS['yt-dlp'];
    if (!this.presets().includes(preset)) throw new DomainError('unsupported', 'The external tool is not set to yt-dlp here, so YouTube and SoundCloud cannot be searched');
    const binary = this.binaryFor(preset);
    if (!existsSync(binary)) throw new DomainError('setup-required', 'yt-dlp is not on this hub yet. The hub sets it up by itself when it can reach github.com.');
    if (args[0] !== '--ignore-config' || args.at(-2) !== '--' || !/^(yt|sc)search\d{1,3}:./.test(args.at(-1) ?? '')) throw new DomainError('validation', 'That is not a catalog search');
    return this.withSlot(async () => {
      let stdout: string;
      try {
        ({ stdout } = await runTool(binary, args, { env: this.toolEnvironment(null), timeoutMs: 30_000, maxStdoutBytes: 8 * 1024 * 1024, ...(signal ? { signal } : {}) }));
      } catch (error) {
        if (error instanceof ToolRunError) throw new DomainError('unavailable', `yt-dlp could not search: ${lastError(error.stderr) || error.message}`);
        throw error;
      }
      try {
        return JSON.parse(stdout) as unknown;
      } catch {
        throw new DomainError('unavailable', 'yt-dlp gave an answer the hub could not read');
      }
    });
  }

  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    while (this.metadataRunning >= METADATA_CONCURRENCY) await new Promise<void>((resolve) => this.metadataWaiting.push(resolve));
    this.metadataRunning += 1;
    try {
      return await run();
    } finally {
      this.metadataRunning -= 1;
      this.metadataWaiting.shift()?.();
    }
  }

  private async readMetadata(preset: ToolPreset, url: string, signal?: AbortSignal, match = false): Promise<MediaProbe> {
    const binary = this.binaryFor(preset);
    if (!existsSync(binary)) throw new DomainError('setup-required', `${preset.displayName} is not on this hub yet`);
    const ffmpeg = resolveExecutable(await this.ffmpeg());
    const runDir = preset.needsHome ? this.makeRunDir(preset.tool) : null;
    try {
      const saveFile = join(runDir ?? '', 'save.spotdl');
      const args = preset.metadata({ url, ffmpeg, node: process.execPath, saveFile, listLimit: DOWNLOAD_BATCH_CAP + 1, match });
      if (!args) throw new DomainError('unsupported', `${preset.displayName} needs FFmpeg, and this hub has none`);
      let stdout: string;
      try {
        ({ stdout } = await runTool(binary, args, { env: this.toolEnvironment(runDir), timeoutMs: METADATA_TIMEOUT_MS[preset.tool], ...(signal ? { signal } : {}), ...(runDir ? { cwd: runDir } : {}) }));
      } catch (error) {
        if (error instanceof ToolRunError) throw new DomainError('unavailable', `${preset.displayName} could not read that link: ${lastError(error.stderr) || error.message}`);
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(preset.tool === 'spotdl' ? readFileSync(saveFile, 'utf8') : stdout);
      } catch {
        throw new DomainError('unavailable', `${preset.displayName} gave an answer the hub could not read`);
      }
      const probe = preset.tool === 'spotdl' ? fromSpotdl(parsed, url) : fromYtDlp(parsed, url);
      if (!probe) throw new DomainError('not-found', `${preset.displayName} found nothing at that link`);
      return probe;
    } finally {
      if (runDir) rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  override async resolve(urlOrId: string): Promise<SearchResult | null> {
    const u = this.allowed(urlOrId.trim());
    if (!u) return null;
    let probe: MediaProbe;
    try {
      probe = await this.probe(u.toString());
    } catch {
      // A Spotify link the hub cannot read is not a track called "4PTG3Z6ehGkBFwjybzWkR8".
      if (this.presetFor(u)?.tool === 'spotdl') return null;
      const slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? u.hostname);
      return result({ provider: this.id, kind: 'track', providerId: u.toString(), title: u.searchParams.get('v') ?? (slug || u.hostname), artistName: u.hostname, canonicalUrl: u.toString(), capabilities: this.capabilities(), attribution: `Source: ${u.hostname}`, accessState: 'restricted' });
    }
    const attribution = `Source: ${u.hostname}`;
    if (probe.kind === 'playlist') {
      const durations = probe.entries.map((e) => e.tags?.durationMs ?? null);
      const total = durations.every((d) => d !== null) && durations.length ? durations.reduce((a, b) => a! + b!, 0) : null;
      return result({ provider: this.id, kind: /\/album\//.test(u.pathname) ? 'album' : 'playlist', providerId: u.toString(), title: probe.title ?? u.hostname, artistName: probe.owner, durationMs: total, artworkUrl: probe.artworkUrl, canonicalUrl: probe.url, capabilities: this.capabilities(), attribution, accessState: 'restricted' });
    }
    const { tags } = probe;
    const year = tags.date ? Number(tags.date.slice(0, 4)) : null;
    return result({
      provider: this.id,
      kind: 'track',
      providerId: u.toString(),
      title: tags.title,
      artistName: tags.artist,
      albumName: tags.album,
      durationMs: tags.durationMs,
      artworkUrl: tags.artworkUrl,
      canonicalUrl: probe.url,
      year,
      genre: tags.genre,
      genres: tags.genre ? [tags.genre] : [],
      featuredArtists: tags.featured,
      capabilities: this.capabilities(),
      attribution,
      accessState: 'restricted',
    });
  }

  override async getAuthorizedDownload(id: string, context: DownloadContext): Promise<AuthorizedDownload | null> {
    const u = this.allowed(id);
    if (!u) return null;
    if (!['user-owned', 'licensed', 'public-domain', 'purchased-export', 'creator-download'].includes(context.basis)) return null;
    const slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? 'download');
    return { kind: 'external-tool', url: u.toString(), filename: slug || 'download', basis: context.basis };
  }
}

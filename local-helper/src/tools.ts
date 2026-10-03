/**
 * Finding the tools.
 *
 * The helper ships no binaries. It looks for what is already installed — a path it was given, a
 * copy it set up itself, or one on PATH — and reports each tool with where it came from. Setting a
 * missing tool up is `install.ts` (one verified download) and `provision.ts` (doing that for every
 * missing tool on start, without being asked).
 *
 * **Automatic, since 2026-09-27.** The owner's decision was that the downloaders should "be
 * automatic and seamless for the user", so yt-dlp, spotDL and — on Windows — FFmpeg are fetched into
 * an app-owned folder (`<data>/tools`, or `<userData>\helper\tools` inside the companion) with no
 * prompt. What did not change is the bar for doing it: every file is checked against the SHA-256
 * its project published on GitHub for that exact release, and a file with no published SHA-256 is
 * refused rather than trusted. See docs/DOWNLOADS_AND_LEGAL.md.
 *
 * **Why yt-dlp is not pinned.** Pinning a version is usually the careful choice and here it is the
 * opposite: yt-dlp works by keeping up with sites that change, so a pinned copy does not get safer
 * with age, it stops working. The helper takes the current release, verifies it, and replaces the
 * copy it set up when a newer release appears.
 *
 * **Why FFmpeg is not fetched on macOS or Linux.** The package manager's copy is the better one
 * there, and every such machine has a package manager. The helper says which command to run.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HelperTool, HelperToolId } from '@now-playing/contracts';
import { binaryName, findOnPath, toolSource, versionOf } from '@now-playing/domain/tool-install';

export { digestFor, ytDlpAsset } from '@now-playing/domain/tool-install';

export interface ToolPaths {
  'yt-dlp'?: string | undefined;
  spotdl?: string | undefined;
  ffmpeg?: string | undefined;
}

export interface ResolvedTool extends HelperTool {
  path: string | null;
}

export interface ResolveOptions {
  /** Explicit paths from the command line, which win over everything. */
  configured: ToolPaths;
  /** Where setup puts things, and the second place to look. */
  toolsDir: string;
}

/** What a missing tool's record says, written for the person reading it. */
export function installHint(id: HelperToolId, installable: boolean): string {
  if (installable) return `Not set up yet. The helper downloads ${id} from its project’s GitHub release and checks it against the published SHA-256 before using it.`;
  if (id === 'ffmpeg') return 'Not installed. Without it nothing can be converted and yt-dlp takes whatever single audio stream a site offers. Install it with your package manager: brew install ffmpeg, apt install ffmpeg or dnf install ffmpeg.';
  return `Not installed, and no ${id} build is published for this system. Install it with: pipx install ${id}.`;
}

export async function resolveTool(id: HelperToolId, options: ResolveOptions): Promise<ResolvedTool> {
  const installable = toolSource(id) !== null;
  const candidates: Array<{ path: string; origin: ResolvedTool['origin'] }> = [];
  const configured = options.configured[id];
  if (configured) candidates.push({ path: configured, origin: 'configured' });
  const installed = join(options.toolsDir, binaryName(id));
  if (existsSync(installed)) candidates.push({ path: installed, origin: 'installed' });
  const onPath = findOnPath(binaryName(id));
  if (onPath) candidates.push({ path: onPath, origin: 'path' });

  for (const candidate of candidates) {
    // spotDL's standalone build unpacks itself on every start, which can take a while the first time.
    const version = await versionOf(candidate.path, id, id === 'spotdl' ? 30_000 : 8000);
    // A path that will not answer its version flag is not a tool, whatever its name says.
    if (version === null) continue;
    return { id, present: true, version, origin: candidate.origin, installHint: null, installable, path: candidate.path };
  }
  return { id, present: false, version: null, origin: 'missing', installHint: installHint(id, installable), installable, path: null };
}

export async function resolveAll(options: ResolveOptions): Promise<Record<HelperToolId, ResolvedTool>> {
  const [ytDlp, spotdl, ffmpeg] = await Promise.all([resolveTool('yt-dlp', options), resolveTool('spotdl', options), resolveTool('ffmpeg', options)]);
  return { 'yt-dlp': ytDlp, spotdl, ffmpeg };
}

export interface ToolResolver {
  get: () => Promise<Record<HelperToolId, ResolvedTool>>;
  /** Forget the cached answer, e.g. after an install. */
  invalidate: () => void;
}

/**
 * `resolveAll`, remembered for a short while.
 *
 * Health is unauthenticated and each lookup starts three version processes, so without this any
 * page that can reach the port could make the machine spawn processes as fast as it can ask.
 * Concurrent callers share one lookup.
 */
export function cachedResolver(options: ResolveOptions, ttlMs = 30_000, now: () => number = Date.now): ToolResolver {
  let pending: Promise<Record<HelperToolId, ResolvedTool>> | null = null;
  let cached: { value: Record<HelperToolId, ResolvedTool>; at: number } | null = null;
  let generation = 0;
  return {
    get: () => {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
      if (pending) return pending;
      const mine = generation;
      pending = resolveAll(options).then(
        (value) => {
          if (mine === generation) {
            cached = { value, at: now() };
            pending = null;
          }
          return value;
        },
        (error: unknown) => {
          if (mine === generation) pending = null;
          throw error;
        },
      );
      return pending;
    },
    invalidate: () => {
      generation += 1;
      cached = null;
      pending = null;
    },
  };
}

export { toolCommand, versionFlag, versionOf, findOnPath } from '@now-playing/domain/tool-install';


export function publicTool(tool: ResolvedTool): HelperTool {
  // The path stays here. It is the one thing in this record that says something about the machine,
  // and docs/PRIVACY.md's rule is that a filesystem path never leaves the device that owns it.
  const { path: _path, ...rest } = tool;
  return rest;
}

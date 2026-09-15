/**
 * The local helper protocol.
 *
 * A browser page cannot run a program. That is not a policy this project chose — it is the sandbox
 * every page lives in, and it is the same thing that makes the player safe to open from a link. So
 * when someone wants yt-dlp or spotDL, something outside the page has to run them, and the only
 * question is what that something is and how the page talks to it.
 *
 * This is that conversation, written down once so three very different programs can hold it: the
 * standalone helper in `local-helper/`, the player in the browser, and the tests. The player never
 * guesses what is on the other end of the socket — it asks `health`, and everything it offers
 * afterwards is built from the answer. A tool that is not installed is not a greyed-out button with
 * a shrug; it is a named absence with a line about how to fix it.
 *
 * Two shapes, one protocol:
 *
 *   **Same origin.** The helper serves the player itself, so the page and the tools share an
 *   origin. Nothing to configure, no CORS, no token to copy: `servesApp` is true and the token is
 *   in the document. This is the shape to prefer, because it is the one with no setup.
 *
 *   **Cross origin.** The player is on a web address and the helper is on loopback beside it. The
 *   helper must be told which origin may call it and the token has to be carried by hand. More
 *   moving parts, so it is the advanced path rather than the default.
 *
 * What the protocol deliberately does not carry: arbitrary arguments. The page names a URL, a tool,
 * an output format and a rights basis, and nothing else reaches the command line. A page that could
 * pass flags to a subprocess is a page that can run anything.
 */
import { z } from 'zod';
import { IsoDateTime } from '../common.js';
import { DownloadAuthorizationBasis, OutputFormat } from '../entities/jobs.js';

/** Bumped when a change would make an older player misread a newer helper, or the reverse. */
export const HELPER_PROTOCOL = 1;

/**
 * Loopback only, and high enough to be unlikely to collide. The player probes this and the three
 * ports above it, so a helper that found the first one taken is still found.
 */
export const HELPER_DEFAULT_PORT = 17342;
export const HELPER_PORT_SCAN = 4;

/** Where the helper puts the per-run token when it is serving the player itself. */
export const HELPER_TOKEN_META = 'np-helper-token';

export const HelperToolId = z.enum(['yt-dlp', 'spotdl', 'ffmpeg']);
export type HelperToolId = z.infer<typeof HelperToolId>;

export const HelperTool = z.object({
  id: HelperToolId,
  present: z.boolean(),
  version: z.string().max(120).nullable().default(null),
  /** How it was found. `missing` is a first-class answer, not an error. */
  origin: z.enum(['path', 'installed', 'configured', 'missing']),
  /** What to do about it when it is missing, written for the person reading it. */
  installHint: z.string().max(400).nullable().default(null),
  /** True when the helper can fetch and verify a pinned release of this tool on request. */
  installable: z.boolean().default(false),
});
export type HelperTool = z.infer<typeof HelperTool>;

export const HelperHealth = z.object({
  helper: z.literal('now-playing-local-helper'),
  protocol: z.number().int().positive(),
  version: z.string().max(40),
  /** True when this helper also serves the player, so the two share an origin. */
  servesApp: z.boolean(),
  tools: z.array(HelperTool),
  /** The hosts a fetch may name. Anything else is refused before a process is started. */
  allowedHosts: z.array(z.string().max(253)),
  /** What it can actually produce here — which depends on whether FFmpeg is present. */
  formats: z.array(OutputFormat),
  startedAt: IsoDateTime,
});
export type HelperHealth = z.infer<typeof HelperHealth>;

export const HelperFetchRequest = z.object({
  url: z.string().url().max(2048),
  /** `auto` picks spotDL for a Spotify link and yt-dlp for everything else. */
  tool: z.enum(['auto', 'yt-dlp', 'spotdl']).default('auto'),
  format: OutputFormat.default('original'),
  /**
   * The same acknowledgement the hub requires. It is not a checkbox to get past: it is the record
   * of *why* this person is entitled to this file, and the helper refuses without it.
   */
  authorization: z.object({ basis: DownloadAuthorizationBasis, acknowledged: z.literal(true) }),
});
export type HelperFetchRequest = z.infer<typeof HelperFetchRequest>;

export const HelperJobFile = z.object({
  id: z.string().max(80),
  name: z.string().max(300),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().max(120),
});
export type HelperJobFile = z.infer<typeof HelperJobFile>;

export const HelperJobState = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type HelperJobState = z.infer<typeof HelperJobState>;

export const HelperJob = z.object({
  id: z.string().max(80),
  state: HelperJobState,
  url: z.string().max(2048),
  tool: HelperToolId,
  format: OutputFormat,
  stage: z.enum(['preflight', 'fetching', 'converting', 'finalizing', 'done']),
  percent: z.number().min(0).max(100).nullable().default(null),
  /** The tool's own last line of progress, trimmed. Shown as-is; it is the honest status. */
  message: z.string().max(400).nullable().default(null),
  files: z.array(HelperJobFile).default([]),
  error: z.string().max(600).nullable().default(null),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable().default(null),
});
export type HelperJob = z.infer<typeof HelperJob>;

export const HelperInstallResult = z.object({
  tool: HelperToolId,
  installed: z.boolean(),
  version: z.string().max(120).nullable().default(null),
  /** Why it did not install, when it did not. */
  reason: z.string().max(400).nullable().default(null),
});
export type HelperInstallResult = z.infer<typeof HelperInstallResult>;

/** An error the helper returns, in the same shape whatever went wrong. */
export const HelperError = z.object({
  error: z.string().max(80),
  message: z.string().max(600),
});
export type HelperError = z.infer<typeof HelperError>;

export const HELPER_ROUTES = {
  health: '/helper/v1/health',
  fetch: '/helper/v1/fetch',
  install: (tool: HelperToolId): string => `/helper/v1/tools/${tool}/install`,
  job: (id: string): string => `/helper/v1/jobs/${encodeURIComponent(id)}`,
  file: (jobId: string, fileId: string): string => `/helper/v1/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileId)}`,
} as const;

/**
 * The hosts a fresh helper will accept, which are the ones its tools are built for. This is not the
 * gate that matters — the rights basis on every request is — but it stops a page from pointing a
 * subprocess at an arbitrary address, and it keeps the list of what this thing touches short enough
 * to read.
 */
export const HELPER_DEFAULT_HOSTS: readonly string[] = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'soundcloud.com',
  'api.soundcloud.com',
  'on.soundcloud.com',
  'open.spotify.com',
  'bandcamp.com',
  'archive.org',
];

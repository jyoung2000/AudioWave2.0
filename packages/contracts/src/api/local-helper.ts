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
import { CalendarDate, IsoDateTime } from '../common.js';
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

/**
 * Where automatic setup has got to for one tool. `installing` carries a 0–1 progress when the size
 * is known; `failed` and `unsupported` carry the sentence to show. Absent means setup has not looked
 * at this tool yet (an older helper, or one started with `--no-auto-tools`).
 */
export const HelperToolSetup = z.object({
  state: z.enum(['ready', 'installing', 'failed', 'unsupported']),
  progress: z.number().min(0).max(1).optional(),
  reason: z.string().max(400).optional(),
});
export type HelperToolSetup = z.infer<typeof HelperToolSetup>;

export const HelperTool = z.object({
  id: HelperToolId,
  present: z.boolean(),
  version: z.string().max(120).nullable().default(null),
  /** How it was found. `missing` is a first-class answer, not an error. */
  origin: z.enum(['path', 'installed', 'configured', 'missing']),
  /** What to do about it when it is missing, written for the person reading it. */
  installHint: z.string().max(400).nullable().default(null),
  /** True when the helper can fetch this tool's current release here and verify its published SHA-256. */
  installable: z.boolean().default(false),
  /** Automatic setup's progress for this tool (since protocol 1, optional). */
  setup: HelperToolSetup.optional(),
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

/** The folders a backup can include, as the companion names them. */
export const HelperBackupPart = z.enum(['music', 'tv', 'movies']);
export type HelperBackupPart = z.infer<typeof HelperBackupPart>;

/**
 * How big the next backup's folders are and how much room its destination has. A part that could not
 * be measured in time is absent — never 0 — and `destination` is null when no backup folder is set.
 */
export const HelperBackupEstimate = z.object({
  parts: z.partialRecord(HelperBackupPart, z.object({ bytes: z.number().int().nonnegative(), files: z.number().int().nonnegative(), measuredAt: IsoDateTime })),
  destination: z.object({ path: z.string(), freeBytes: z.number().int().nonnegative().nullable(), totalBytes: z.number().int().nonnegative().nullable() }).nullable(),
});
export type HelperBackupEstimate = z.infer<typeof HelperBackupEstimate>;

/**
 * One Live TV channel, as the companion read it out of the M3U playlists kept in its Live TV tab.
 *
 * `id` is stable for a stream address, so a favourite survives the playlist being refreshed.
 * `number` is the playlist's own channel number (`tvg-chno`) when it has one that is free, and the
 * next free number otherwise — always present, never repeated. `tvgId` is what joins a channel to
 * its programmes in `HelperTvGuide`; null when the playlist names none.
 */
export const HelperTvChannel = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  number: z.number().int().positive(),
  group: z.string().max(200).nullable(),
  logo: z.string().max(2048).nullable(),
  url: z.string().min(1).max(2048),
  tvgId: z.string().max(200).nullable(),
});
export type HelperTvChannel = z.infer<typeof HelperTvChannel>;

/** `GET /helper/v1/tv/channels`. The standalone helper keeps no playlists and answers with none. */
export const HelperTvChannels = z.object({ channels: z.array(HelperTvChannel) });
export type HelperTvChannels = z.infer<typeof HelperTvChannels>;

export const HelperTvProgramme = z.object({
  title: z.string().max(300),
  start: IsoDateTime,
  stop: IsoDateTime,
  description: z.string().max(600).nullable(),
});
export type HelperTvProgramme = z.infer<typeof HelperTvProgramme>;

/** What is on a channel and what follows. Either may be null: a guide has gaps, and it ends. */
export const HelperTvGuideEntry = z.object({
  /** The channel's `tvgId`, spelled as `HelperTvChannel.tvgId` spells it. */
  tvgId: z.string().min(1).max(200),
  now: HelperTvProgramme.nullable(),
  next: HelperTvProgramme.nullable(),
});
export type HelperTvGuideEntry = z.infer<typeof HelperTvGuideEntry>;

/**
 * `GET /helper/v1/tv/guide`: now and next for every channel that has a `tvgId` and a programme in
 * the stored XMLTV guides. A channel with neither a current nor a following programme is absent.
 */
export const HelperTvGuide = z.object({ generatedAt: IsoDateTime, guide: z.array(HelperTvGuideEntry) });
export type HelperTvGuide = z.infer<typeof HelperTvGuide>;

/** The most entries a resolved playlist, set or album lists. The same cap a download of one has. */
export const HELPER_RESOLVE_CAP = 200;

/** Which site a resolved link is on. */
export const HelperResolveSource = z.enum(['youtube', 'soundcloud', 'bandcamp', 'spotify', 'other']);
export type HelperResolveSource = z.infer<typeof HelperResolveSource>;

/**
 * One song, as the site describes it, with the title cleaned the way a download's tags are
 * (`cleanTags` in `@now-playing/domain`). `title` is null only for an entry of a set the site lists
 * by address alone (SoundCloud does); resolve that entry's own `url` for the rest.
 */
export const HelperResolvedTrack = z.object({
  url: z.string().max(2048).nullable(),
  title: z.string().max(300).nullable(),
  artist: z.string().max(300).nullable(),
  featured: z.array(z.string().max(300)).max(8),
  album: z.string().max(300).nullable(),
  genre: z.string().max(60).nullable(),
  durationSec: z.number().nonnegative().nullable(),
  /** `YYYY-MM-DD` or `YYYY-MM`: the release date when the site has one, otherwise the upload date. */
  date: CalendarDate.nullable(),
  year: z.number().int().min(1000).max(3000).nullable(),
  artworkUrl: z.string().max(2048).nullable(),
  trackNumber: z.number().int().positive().nullable(),
});
export type HelperResolvedTrack = z.infer<typeof HelperResolvedTrack>;

/**
 * `GET /helper/v1/resolve?url=` — what a pasted link is, read keylessly by the tools on this PC:
 * yt-dlp for YouTube, SoundCloud and Bandcamp, spotDL (`save`) for Spotify. A single song is `track`;
 * a playlist, set or album is `collection`, with at most `HELPER_RESOLVE_CAP` entries — `total` is
 * how many the site says there are, when it says, and `capped` is true when some were left out.
 */
export const HelperResolved = z.object({
  source: HelperResolveSource,
  kind: z.enum(['track', 'collection']),
  url: z.string().max(2048),
  track: HelperResolvedTrack.nullable(),
  collection: z
    .object({
      title: z.string().max(300),
      artist: z.string().max(300).nullable(),
      artworkUrl: z.string().max(2048).nullable(),
      date: CalendarDate.nullable(),
      entries: z.array(HelperResolvedTrack).max(HELPER_RESOLVE_CAP),
      total: z.number().int().nonnegative().nullable(),
      cap: z.number().int().positive(),
      capped: z.boolean(),
    })
    .nullable(),
  resolvedAt: IsoDateTime,
});
export type HelperResolved = z.infer<typeof HelperResolved>;

export const HELPER_ROUTES = {
  health: '/helper/v1/health',
  /**
   * `?url=` — what a pasted link is (HelperResolved). No token from a vetted page, the radio route's
   * rule; never reachable from another device, because it starts a tool.
   */
  resolve: '/helper/v1/resolve',
  fetch: '/helper/v1/fetch',
  backupEstimate: '/helper/v1/backup/estimate',
  /** The merged Live TV channel list (HelperTvChannels). No token, same rule as the radio route: a vetted page only. */
  tvChannels: '/helper/v1/tv/channels',
  /** Now and next per channel (HelperTvGuide). No token, same rule as the radio route. */
  tvGuide: '/helper/v1/tv/guide',
  /** `?url=` — what a radio station says it is playing (StationNowPlaying). No token: it only ever reads a public stream. */
  radioNowPlaying: '/helper/v1/radio/now-playing',
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
  // Bandcamp keeps its music on each artist subdomain (artist.bandcamp.com/track/...).
  '*.bandcamp.com',
  'archive.org',
];

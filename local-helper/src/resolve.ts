/**
 * What a pasted link is, read by the tools on this PC: no account, no key (NP-FIND-002).
 *
 * The player can only ask a site's oEmbed what a link is, and oEmbed knows a title, a channel and a
 * thumbnail. yt-dlp knows the rest — duration, date, album, genre, the songs in a playlist — and so
 * does spotDL for Spotify, whose oEmbed says nothing useful. This runs them in describe-only mode:
 *
 *   - yt-dlp `--dump-single-json --flat-playlist` for YouTube, SoundCloud and Bandcamp. Flat, so a
 *     playlist is one request and not two hundred; an entry the site lists by address alone (SoundCloud
 *     sets) comes back with `title: null`, and resolving its own URL fills it in.
 *   - spotDL `save` for Spotify, into a file in a folder of its own that is deleted afterwards. spotDL
 *     gets that folder as its home too, so no config file of the user's is read.
 *
 * The same rules as a download: no shell, the URL checked against the allowlist before anything
 * starts, `--ignore-config` first and the URL behind `--` for yt-dlp, a timeout that kills the whole
 * process tree. On top: answers are kept for ten minutes, a URL already being resolved is not resolved
 * twice, and at most two run at once with a short queue behind them — a page cannot make this PC spawn
 * processes as fast as it can ask.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HELPER_RESOLVE_CAP, type HelperResolveSource, type HelperResolved, type HelperResolvedTrack } from '@now-playing/contracts';
import { cleanTags, isoDate, type MediaInfo } from '@now-playing/domain';
import { childEnv, killTree, lastMeaningfulLine, spotdlSaveArgs } from './jobs.js';
import { toolCommand, type ResolvedTool } from './tools.js';

export const RESOLVE_TTL_MS = 10 * 60 * 1000;
const RESOLVE_CACHE_SIZE = 100;
const MAX_RUNNING = 2;
const MAX_WAITING = 8;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** The site a link is on, from its host alone. */
export function sourceOf(url: URL): HelperResolveSource {
  const host = url.hostname.toLowerCase();
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return 'youtube';
  if (/(^|\.)soundcloud\.com$/.test(host)) return 'soundcloud';
  if (/(^|\.)bandcamp\.com$/.test(host)) return 'bandcamp';
  if (/(^|\.)spotify\.com$/.test(host)) return 'spotify';
  return 'other';
}

/** yt-dlp, describing only. The URL is last and behind `--`, as in every command this program builds. */
export function ytDlpResolveArgs(url: string): string[] {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) addresses can be handed to a tool.');
  return ['--ignore-config', '--no-colors', '--no-cache-dir', '--no-warnings', '--skip-download', '--flat-playlist', '--playlist-end', String(HELPER_RESOLVE_CAP), '--dump-single-json', '--', url];
}

function str(value: unknown, max = 300): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function webUrl(value: unknown): string | null {
  const s = str(value, 2048);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The thumbnail yt-dlp chose, or the largest it listed. */
function artworkOf(info: Record<string, unknown>): string | null {
  const direct = webUrl(info['thumbnail']);
  if (direct) return direct;
  const list = Array.isArray(info['thumbnails']) ? (info['thumbnails'] as Array<Record<string, unknown>>) : [];
  const best = [...list].filter((t) => t && webUrl(t['url'])).sort((a, b) => (num(b['width']) ?? 0) - (num(a['width']) ?? 0))[0];
  return best ? webUrl(best['url']) : null;
}

/** One song from a yt-dlp description, full or flat. */
export function trackFromYtDlp(info: Record<string, unknown>, flat = false): HelperResolvedTrack {
  const url = webUrl(info['webpage_url']) ?? webUrl(info['url']);
  const hasTitle = Boolean(str(info['title']) ?? str(info['track']));
  // A flat SoundCloud entry is an address and an id: nothing to clean, and no title to invent.
  if (flat && !hasTitle) {
    return { url, title: null, artist: null, featured: [], album: str(info['album']), genre: null, durationSec: num(info['duration']), date: null, year: null, artworkUrl: artworkOf(info), trackNumber: null };
  }
  const tags = cleanTags({ ...(info as MediaInfo), ...(url && !info['webpage_url'] ? { webpage_url: url } : {}), ...(info['ie_key'] && !info['extractor_key'] ? { extractor_key: info['ie_key'] } : {}) });
  return {
    url,
    title: tags.title,
    artist: tags.artist,
    featured: tags.featured,
    album: tags.album,
    genre: tags.genre,
    durationSec: num(info['duration']),
    date: tags.date,
    year: tags.year,
    artworkUrl: artworkOf(info),
    trackNumber: tags.trackNumber,
  };
}

/** A yt-dlp `--dump-single-json --flat-playlist` answer, as the contract says it. */
export function fromYtDlp(info: Record<string, unknown>, url: URL, now = new Date()): HelperResolved {
  const source = sourceOf(url);
  const canonical = webUrl(info['webpage_url']) ?? url.toString();
  const entries = Array.isArray(info['entries']) ? (info['entries'] as unknown[]) : null;
  if (info['_type'] === 'playlist' || entries) {
    const list = (entries ?? []).filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object' && !Array.isArray(e));
    const kept = list.slice(0, HELPER_RESOLVE_CAP).map((e) => trackFromYtDlp(e, true));
    const total = num(info['playlist_count']);
    return {
      source,
      kind: 'collection',
      url: canonical,
      track: null,
      collection: {
        title: str(info['title']) ?? str(info['album']) ?? 'Playlist',
        artist: str(info['album_artist']) ?? str(info['uploader']) ?? str(info['channel']),
        artworkUrl: artworkOf(info),
        date: isoDate(info['release_date']) ?? isoDate(info['upload_date']),
        entries: kept,
        total: total !== null ? Math.round(total) : null,
        cap: HELPER_RESOLVE_CAP,
        capped: (total !== null && total > kept.length) || list.length > HELPER_RESOLVE_CAP,
      },
      resolvedAt: now.toISOString(),
    };
  }
  return { source, kind: 'track', url: canonical, track: trackFromYtDlp(info), collection: null, resolvedAt: now.toISOString() };
}

/** One song from spotDL's save file. */
export function trackFromSpotdl(song: Record<string, unknown>): HelperResolvedTrack {
  const artists = Array.isArray(song['artists']) ? (song['artists'] as unknown[]).map((a) => str(a)).filter((a): a is string => Boolean(a)) : [];
  const artist = artists[0] ?? str(song['artist']);
  const genres = Array.isArray(song['genres']) ? (song['genres'] as unknown[]).map((g) => str(g, 60)).filter((g): g is string => Boolean(g)) : [];
  const date = isoDate(song['date']);
  const yearValue = num(song['year']);
  const year = date ? Number(date.slice(0, 4)) : yearValue !== null && Number.isInteger(yearValue) && yearValue >= 1000 && yearValue <= 3000 ? yearValue : null;
  const trackNumber = num(song['track_number']);
  return {
    url: webUrl(song['url']),
    title: str(song['name']),
    artist,
    featured: artists.slice(1, 9),
    album: str(song['album_name']),
    genre: genres[0] ?? null,
    durationSec: num(song['duration']),
    date,
    year,
    artworkUrl: webUrl(song['cover_url']),
    trackNumber: trackNumber !== null && Number.isInteger(trackNumber) && trackNumber > 0 ? trackNumber : null,
  };
}

/** spotDL's save file, as the contract says it. A track link is one song; anything else is a list. */
export function fromSpotdl(songs: unknown, url: URL, now = new Date()): HelperResolved {
  const list = (Array.isArray(songs) ? songs : []).filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object' && !Array.isArray(s));
  const isTrack = /^\/(?:intl-[a-z-]+\/)?track\//i.test(url.pathname);
  if (isTrack && list[0]) return { source: 'spotify', kind: 'track', url: webUrl(list[0]['url']) ?? url.toString(), track: trackFromSpotdl(list[0]), collection: null, resolvedAt: now.toISOString() };
  const isAlbum = /^\/(?:intl-[a-z-]+\/)?album\//i.test(url.pathname);
  // An album reads in its own order; spotDL saves them in whatever order they arrived.
  const ordered = isAlbum ? [...list].sort((a, b) => (num(a['disc_number']) ?? 1) - (num(b['disc_number']) ?? 1) || (num(a['track_number']) ?? 0) - (num(b['track_number']) ?? 0)) : list;
  const first = ordered[0];
  const kept = ordered.slice(0, HELPER_RESOLVE_CAP).map(trackFromSpotdl);
  return {
    source: 'spotify',
    kind: 'collection',
    url: url.toString(),
    track: null,
    collection: {
      title: (first && (str(first['list_name']) ?? (isAlbum ? str(first['album_name']) : null))) ?? (isAlbum ? 'Album' : 'Playlist'),
      artist: first ? (isAlbum ? str(first['album_artist']) : null) : null,
      artworkUrl: first && isAlbum ? webUrl(first['cover_url']) : null,
      date: first && isAlbum ? isoDate(first['date']) : null,
      entries: kept,
      total: first && num(first['list_length']) !== null ? Math.round(num(first['list_length'])!) : isAlbum && first && num(first['tracks_count']) !== null ? Math.round(num(first['tracks_count'])!) : ordered.length,
      cap: HELPER_RESOLVE_CAP,
      capped: ordered.length > HELPER_RESOLVE_CAP,
    },
    resolvedAt: now.toISOString(),
  };
}

export class ResolveError extends Error {
  constructor(
    message: string,
    readonly code: 'busy' | 'tool-missing' | 'failed',
    /** What the tool printed before it failed, when anything. */
    readonly output: string = '',
  ) {
    super(message);
  }
}

export interface ResolverOptions {
  /** A folder this run owns; each spotDL resolve gets a folder under it, deleted afterwards. */
  workDir: string;
  tools: () => Promise<Record<'yt-dlp' | 'spotdl' | 'ffmpeg', ResolvedTool>>;
  /** yt-dlp answers in a few seconds; spotDL unpacks itself and asks Spotify, which is slower. */
  timeoutMs?: { ytDlp: number; spotdl: number };
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * Runs one tool to completion, no shell, with the whole tree killed at the deadline (yt-dlp and
 * spotDL are self-unpacking programs that start a second process; killing only the first leaves it).
 */
function run(path: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, spawnImpl: typeof spawn = spawn): Promise<string> {
  const { command, prefix } = toolCommand(path);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, [...prefix, ...args], { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const out: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let timedOut = false;
    let tooBig = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        if (!tooBig) killTree(child);
        tooBig = true;
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ResolveError(`The tool could not be started: ${error.message}`.slice(0, 400), 'failed'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new ResolveError('The tool took too long to answer.', 'failed'));
      if (tooBig) return reject(new ResolveError('The tool’s answer was far larger than any link needs.', 'failed'));
      if (code !== 0) return reject(new ResolveError(lastMeaningfulLine(stderr) ?? `The tool exited with code ${code ?? 'unknown'}.`, 'failed', Buffer.concat(out).toString('utf8')));
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

export interface Resolver {
  resolve(url: URL): Promise<HelperResolved>;
}

export function createResolver(options: ResolverOptions): Resolver {
  const cache = new Map<string, { at: number; value: Promise<HelperResolved> }>();
  const now = options.now ?? Date.now;
  const timeouts = options.timeoutMs ?? { ytDlp: 45_000, spotdl: 150_000 };
  let running = 0;
  const waiting: Array<() => void> = [];

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= MAX_RUNNING) {
      if (waiting.length >= MAX_WAITING) throw new ResolveError('Too many links are being looked up at once. Try again in a moment.', 'busy');
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }

  async function fresh(url: URL): Promise<HelperResolved> {
    const tools = await options.tools();
    const source = sourceOf(url);
    if (source === 'spotify') {
      const spotdl = tools.spotdl;
      if (!spotdl.present || !spotdl.path) throw new ResolveError(spotdl.installHint ?? 'spotDL is not set up on this PC yet.', 'tool-missing');
      return slot(async () => {
        const dir = join(options.workDir, 'resolve', randomUUID());
        mkdirSync(dir, { recursive: true });
        try {
          const file = join(dir, 'songs.spotdl');
          // An empty home of its own: spotDL reads a config file from the home directory otherwise.
          await run(spotdl.path!, spotdlSaveArgs(url.toString(), file), childEnv(process.env, { HOME: dir, USERPROFILE: dir }), timeouts.spotdl);
          let songs: unknown;
          try {
            songs = JSON.parse(readFileSync(file, 'utf8'));
          } catch {
            throw new ResolveError('spotDL found nothing at that address.', 'failed');
          }
          return fromSpotdl(songs, url);
        } finally {
          rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        }
      });
    }
    const ytDlp = tools['yt-dlp'];
    if (!ytDlp.present || !ytDlp.path) throw new ResolveError(ytDlp.installHint ?? 'yt-dlp is not set up on this PC yet.', 'tool-missing');
    return slot(async () => {
      const stdout = await run(ytDlp.path!, ytDlpResolveArgs(url.toString()), childEnv(), timeouts.ytDlp).catch((error: unknown) => {
        // A playlist with a song the site will not give is still described, minus that song, and
        // yt-dlp exits 1 for it. What it did describe is the answer; nothing described is the failure.
        if (error instanceof ResolveError && /"entries"\s*:\s*\[\s*\{/.test(error.output)) return error.output;
        throw error;
      });
      let info: unknown;
      try {
        info = JSON.parse(stdout);
      } catch {
        throw new ResolveError('yt-dlp did not describe that address.', 'failed');
      }
      if (!info || typeof info !== 'object' || Array.isArray(info)) throw new ResolveError('yt-dlp did not describe that address.', 'failed');
      return fromYtDlp(info as Record<string, unknown>, url);
    });
  }

  return {
    resolve(url: URL): Promise<HelperResolved> {
      const key = url.toString();
      const at = now();
      const hit = cache.get(key);
      if (hit && at - hit.at < RESOLVE_TTL_MS) return hit.value;
      const value = fresh(url);
      // A failure is not remembered: the next paste may find the tool set up, or the site back.
      value.catch(() => {
        if (cache.get(key)?.value === value) cache.delete(key);
      });
      cache.delete(key);
      if (cache.size >= RESOLVE_CACHE_SIZE) cache.delete(cache.keys().next().value!);
      cache.set(key, { at, value });
      return value;
    },
  };
}

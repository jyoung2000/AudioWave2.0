/**
 * Live TV: the channel playlists (M3U) and programme guides (XMLTV) kept in the Live TV tab.
 *
 * A link is checked before it is kept: it is fetched here, in the main process, under the rules in
 * `fetch.ts`, and it has to hold what it claims — a playlist at least one channel, a guide at least
 * one channel or programme. What was read is cached beside the database, so the player gets its
 * channel list and its now/next from this PC without anything being fetched while it waits, and a
 * link that stops answering keeps showing what it last held.
 *
 * Links are looked at again at most every six hours. A guide is read as it arrives and only the
 * programmes of the next day and a half are kept — enough for now and next until the following
 * look — so a week-long guide for thousands of channels costs a few megabytes, not a few hundred.
 *
 * The links themselves live in the companion's settings table under one key (`liveTv`); the parsed
 * lists live as files in `<data>/live-tv/`. A stored value this code does not recognise is treated
 * as no links at all rather than as an error at start-up.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { HelperTvChannel, HelperTvGuideEntry, HelperTvProgramme } from '@now-playing/contracts';
import type { TvLink, TvLinkKind, TvLinks } from '../../shared/ipc.js';
import type { CompanionStore } from '../store.js';
import { LinkError, checkLink, readLink, type LinkFailure, type ReadLink, type ReadLinkOptions } from './fetch.js';
import { channelFromStream, parseM3u, type M3uChannel } from './m3u.js';
import { XmltvScanner } from './xmltv.js';

const SETTINGS_KEY = 'liveTv';
const HOUR_MS = 60 * 60 * 1000;
/** A link that answered is looked at again no sooner than this. */
export const REFRESH_MS = 6 * HOUR_MS;
/** A link that failed is tried again sooner: the usual cause is a server having a bad half hour. */
const RETRY_MS = HOUR_MS / 2;
/** How far ahead programmes are kept: one refresh interval, and room for several missed ones. */
const GUIDE_WINDOW_MS = 36 * HOUR_MS;
const MAX_LINKS: Record<TvLinkKind, number> = { m3u: 20, epg: 10 };
const MAX_PROGRAMMES_PER_CHANNEL = 300;
const MAX_PROGRAMMES = 500_000;
const MAX_GUIDE_CHANNELS = 100_000;
const MAX_MERGED_CHANNELS = 50_000;

const MB = 1024 * 1024;
const LIMITS: Record<TvLinkKind, Pick<ReadLinkOptions, 'timeoutMs' | 'maxBytes' | 'maxDecodedBytes'>> = {
  m3u: { timeoutMs: 30_000, maxBytes: 25 * MB, maxDecodedBytes: 40 * MB },
  epg: { timeoutMs: 180_000, maxBytes: 150 * MB, maxDecodedBytes: 1536 * MB },
};

const StoredLink = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(['m3u', 'epg']),
  url: z.string().min(1).max(2048),
  addedAt: z.string(),
  checkedAt: z.string().nullable(),
  ok: z.boolean(),
  summary: z.string().max(200).nullable(),
  error: z.string().max(400).nullable(),
});
type StoredLink = z.infer<typeof StoredLink>;
const Stored = z.object({ version: z.literal(1), links: z.array(StoredLink) });

type ProgrammeRow = [startMs: number, stopMs: number, title: string, description: string | null];
interface PlaylistCache {
  channels: M3uChannel[];
}
interface GuideCache {
  /** Keyed by the guide's channel id, lower-cased: playlists and guides disagree about case. */
  programmes: Record<string, ProgrammeRow[]>;
}

/** What the person is told, by what went wrong. One sentence, and what to do about it. */
function explain(kind: TvLinkKind, failure: LinkFailure | 'empty'): { short: string; sentence: string } {
  const thing = kind === 'm3u' ? 'playlist' : 'guide';
  switch (failure) {
    case 'invalid':
      return { short: 'not a link', sentence: 'That doesn’t look like a link — it should start with https:// or http://.' };
    case 'private':
      return { short: 'not public', sentence: 'That address is on this PC or your own network. Live TV links need an address on the internet.' };
    case 'status':
      return { short: 'not found', sentence: `That link answered, but there is no ${thing} there. Check the address and try again.` };
    case 'timeout':
      return { short: 'unreachable', sentence: 'That link took too long to answer. Try again in a moment.' };
    case 'too-large':
      return { short: 'too large', sentence: kind === 'm3u' ? 'That playlist is bigger than Airwave reads (25 MB). Use a smaller one.' : 'That guide is bigger than Airwave reads (150 MB). Use a smaller one.' };
    case 'unreadable':
    case 'empty':
      return kind === 'm3u'
        ? { short: 'not a playlist', sentence: 'That doesn’t look like an M3U playlist — no channels were found in it.' }
        : { short: 'not a guide', sentence: 'That doesn’t look like a programme guide — it should be an XMLTV file (.xml or .xml.gz).' };
    default:
      return { short: 'unreachable', sentence: 'That link didn’t answer. Check the address and your connection, then try again.' };
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export interface LiveTvOptions {
  store: CompanionStore;
  /** Where parsed playlists and guides are kept, one file per link. */
  cacheDir: string;
  version: string;
  log: (line: string) => void;
  /** Told whenever a link's state changes, so the window can redraw without asking. */
  onChange?: (links: TvLinks) => void;
  /** How a link is read. Tests pass fixtures; the app reads the network through `readLink`. */
  read?: ReadLink;
  now?: () => number;
  /** Tests serve fixtures from 127.0.0.1. Never set outside a test. */
  allowPrivateNetworkForTests?: boolean;
}

export class LiveTv {
  private links: StoredLink[];
  private readonly checking = new Set<string>();
  private readonly playlists = new Map<string, PlaylistCache>();
  private readonly guides = new Map<string, GuideCache>();
  /** One link is read at a time: a guide is large, and two at once would only take turns anyway. */
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly read: ReadLink;
  private readonly now: () => number;

  constructor(private readonly options: LiveTvOptions) {
    this.read = options.read ?? readLink;
    this.now = options.now ?? Date.now;
    const saved = Stored.safeParse(options.store.get<unknown>(SETTINGS_KEY, null));
    this.links = saved.success ? saved.data.links : [];
  }

  /** Looks at whatever is due now, and again every half hour. Never awaited by start-up. */
  start(): void {
    void this.refreshStale();
    this.timer = setInterval(() => void this.refreshStale(), RETRY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort.abort();
  }

  list(): TvLinks {
    const view = (link: StoredLink): TvLink => ({
      id: link.id,
      kind: link.kind,
      url: link.url,
      state: this.checking.has(link.id) ? 'checking' : link.ok ? 'ok' : 'failed',
      summary: link.summary,
      error: link.error,
      checkedAt: link.checkedAt,
    });
    return { m3u: this.links.filter((l) => l.kind === 'm3u').map(view), epg: this.links.filter((l) => l.kind === 'epg').map(view) };
  }

  /** Checks a pasted link and keeps it only if it holds what it claims. */
  async add(kind: TvLinkKind, input: string): Promise<{ link: TvLink | null; reason: string | null }> {
    const refused = checkLink(input, this.options.allowPrivateNetworkForTests);
    if (refused) return { link: null, reason: explain(kind, refused.kind).sentence };
    const url = new URL(input.trim()).toString();
    if (this.links.some((l) => l.kind === kind && l.url === url)) return { link: null, reason: 'That link is already in the list.' };
    if (this.links.filter((l) => l.kind === kind).length >= MAX_LINKS[kind]) {
      return { link: null, reason: `That’s as many ${kind === 'm3u' ? 'playlists' : 'guides'} as Airwave keeps (${MAX_LINKS[kind]}). Remove one first.` };
    }
    const link: StoredLink = { id: randomUUID(), kind, url, addedAt: new Date(this.now()).toISOString(), checkedAt: null, ok: false, summary: null, error: null };
    const outcome = await this.enqueue(() => this.check(link));
    if (!outcome.ok) return { link: null, reason: outcome.sentence };
    // Someone may have added the same link twice while the first was being read.
    if (this.links.some((l) => l.kind === kind && l.url === url)) return { link: null, reason: 'That link is already in the list.' };
    link.ok = true;
    link.summary = outcome.summary;
    link.checkedAt = new Date(this.now()).toISOString();
    this.links = [...this.links, link];
    this.persist();
    return { link: this.view(link.id), reason: null };
  }

  remove(id: string): { ok: boolean } {
    const link = this.links.find((l) => l.id === id);
    if (!link) return { ok: false };
    this.links = this.links.filter((l) => l.id !== id);
    this.playlists.delete(id);
    this.guides.delete(id);
    this.persist();
    void rm(this.cacheFile(id), { force: true }).catch(() => undefined);
    return { ok: true };
  }

  /** Looks at one link again now. What it last held is kept if it does not answer. */
  async refresh(id: string): Promise<{ link: TvLink | null; reason: string | null }> {
    const link = this.links.find((l) => l.id === id);
    if (!link) return { link: null, reason: 'That link is no longer in the list.' };
    this.checking.add(id);
    this.changed();
    let reason: string | null = null;
    try {
      const outcome = await this.enqueue(() => this.check(link));
      const current = this.links.find((l) => l.id === id);
      if (current) {
        current.checkedAt = new Date(this.now()).toISOString();
        current.ok = outcome.ok;
        current.summary = outcome.ok ? outcome.summary : outcome.short;
        current.error = outcome.ok ? null : outcome.sentence;
        reason = current.error;
      }
    } finally {
      this.checking.delete(id);
      this.persist();
    }
    return { link: this.view(id), reason };
  }

  /** Every link that is due: six hours after it last answered, half an hour after it last failed. */
  async refreshStale(): Promise<void> {
    const now = this.now();
    for (const link of [...this.links]) {
      if (this.stopped) return;
      const last = link.checkedAt ? Date.parse(link.checkedAt) : 0;
      if (now - last < (link.ok ? REFRESH_MS : RETRY_MS)) continue;
      await this.refresh(link.id).catch((err: unknown) => this.options.log(`live tv: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /** Every channel from every playlist, in the order the playlists were added, each stream once. */
  async channels(): Promise<HelperTvChannel[]> {
    const merged: Array<Omit<HelperTvChannel, 'number'> & { chno: number | null }> = [];
    const seen = new Set<string>();
    for (const link of this.links.filter((l) => l.kind === 'm3u')) {
      const cache = await this.playlist(link.id);
      for (const channel of cache?.channels ?? []) {
        if (seen.has(channel.url) || merged.length >= MAX_MERGED_CHANNELS) continue;
        seen.add(channel.url);
        merged.push({ id: createHash('sha1').update(channel.url).digest('hex').slice(0, 16), name: channel.name, group: channel.group, logo: channel.logo, url: channel.url, tvgId: channel.tvgId, chno: channel.chno });
      }
    }
    // A playlist's own numbers are kept where they do not collide; the rest take the next free one.
    const taken = new Set<number>();
    const numbers = merged.map((channel) => {
      if (channel.chno === null || taken.has(channel.chno)) return null;
      taken.add(channel.chno);
      return channel.chno;
    });
    let next = 1;
    return merged.map(({ chno: _chno, ...channel }, index) => {
      let number = numbers[index] ?? null;
      if (number === null) {
        while (taken.has(next)) next += 1;
        number = next;
        taken.add(next);
      }
      return { ...channel, number };
    });
  }

  /** Now and next for every channel that names a `tvg-id` a stored guide knows. */
  async guide(): Promise<HelperTvGuideEntry[]> {
    const at = this.now();
    const wanted = new Map<string, string>();
    for (const channel of await this.channels()) if (channel.tvgId && !wanted.has(channel.tvgId.toLowerCase())) wanted.set(channel.tvgId.toLowerCase(), channel.tvgId);
    if (!wanted.size) return [];
    const guides: GuideCache[] = [];
    for (const link of this.links.filter((l) => l.kind === 'epg')) {
      const cache = await this.guideCache(link.id);
      if (cache) guides.push(cache);
    }
    const out: HelperTvGuideEntry[] = [];
    const programme = (row: ProgrammeRow | undefined): HelperTvProgramme | null => (row ? { title: row[2], start: new Date(row[0]).toISOString(), stop: new Date(row[1]).toISOString(), description: row[3] } : null);
    for (const [key, tvgId] of wanted) {
      // The first guide that knows the channel answers for it; guides are not blended.
      for (const cache of guides) {
        const rows = cache.programmes[key];
        if (!rows?.length) continue;
        const now = rows.find((row) => row[0] <= at && at < row[1]);
        const next = rows.find((row) => row[0] > at);
        if (now || next) out.push({ tvgId, now: programme(now), next: programme(next) });
        break;
      }
    }
    return out;
  }

  /* ----------------------------------------------------------------- internals */

  private view(id: string): TvLink | null {
    const all = this.list();
    return [...all.m3u, ...all.epg].find((l) => l.id === id) ?? null;
  }

  private persist(): void {
    if (this.options.store.isOpen) this.options.store.set(SETTINGS_KEY, { version: 1, links: this.links } satisfies z.infer<typeof Stored>, new Date(this.now()).toISOString());
    this.changed();
  }

  private changed(): void {
    this.options.onChange?.(this.list());
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private cacheFile(id: string): string {
    // Ids are made here (randomUUID), but the name is still narrowed to what a file name may hold.
    return join(this.options.cacheDir, `${id.replace(/[^A-Za-z0-9-]/g, '')}.json`);
  }

  private async writeCache(id: string, value: unknown): Promise<void> {
    await mkdir(this.options.cacheDir, { recursive: true });
    const file = this.cacheFile(id);
    // Written beside itself and renamed, so a power cut leaves the old list rather than half a new one.
    await writeFile(`${file}.partial`, JSON.stringify(value), 'utf8');
    await rename(`${file}.partial`, file);
  }

  private async readCache<T>(id: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.cacheFile(id), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private async playlist(id: string): Promise<PlaylistCache | null> {
    const held = this.playlists.get(id);
    if (held) return held;
    const read = await this.readCache<PlaylistCache>(id);
    if (!read || !Array.isArray(read.channels)) return null;
    this.playlists.set(id, read);
    return read;
  }

  private async guideCache(id: string): Promise<GuideCache | null> {
    const held = this.guides.get(id);
    if (held) return held;
    const read = await this.readCache<GuideCache>(id);
    if (!read || typeof read.programmes !== 'object' || read.programmes === null) return null;
    this.guides.set(id, read);
    return read;
  }

  /** Reads a link and, when it holds what it should, replaces what is cached for it. */
  private async check(link: StoredLink): Promise<{ ok: true; summary: string } | { ok: false; short: string; sentence: string }> {
    const options: ReadLinkOptions = {
      ...LIMITS[link.kind],
      userAgent: `Airwave-Companion/${this.options.version}`,
      signal: this.abort.signal,
      ...(this.options.allowPrivateNetworkForTests ? { allowPrivateNetworkForTests: true } : {}),
    };
    try {
      const summary = link.kind === 'm3u' ? await this.readPlaylist(link, options) : await this.readGuide(link, options);
      if (summary === null) return { ok: false, ...explain(link.kind, 'empty') };
      return { ok: true, summary };
    } catch (err) {
      const failure: LinkFailure = err instanceof LinkError ? err.kind : 'unreachable';
      this.options.log(`live tv: ${link.kind} link could not be read (${failure})`);
      return { ok: false, ...explain(link.kind, failure) };
    }
  }

  private async readPlaylist(link: StoredLink, options: ReadLinkOptions): Promise<string | null> {
    const pieces: string[] = [];
    await this.read(link.url, options, (text) => pieces.push(text));
    const parsed = parseM3u(pieces.join(''));
    const channels = parsed.kind === 'stream' ? [channelFromStream(link.url)] : parsed.channels;
    if (!channels.length) return null;
    const cache: PlaylistCache = { channels };
    await this.writeCache(link.id, cache);
    this.playlists.set(link.id, cache);
    return plural(channels.length, 'channel', 'channels');
  }

  private async readGuide(link: StoredLink, options: ReadLinkOptions): Promise<string | null> {
    const from = this.now();
    const until = from + GUIDE_WINDOW_MS;
    const programmes: Record<string, ProgrammeRow[]> = {};
    let kept = 0;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    const scanner = new XmltvScanner({
      programme: (p) => {
        if (p.startMs < first) first = p.startMs;
        if (p.stopMs > last) last = p.stopMs;
        // Only what can still be "now" or "next" before the next look is kept.
        if (p.stopMs <= from || p.startMs >= until || kept >= MAX_PROGRAMMES) return;
        const key = p.channel.toLowerCase();
        let rows = programmes[key];
        if (!rows) {
          if (Object.keys(programmes).length >= MAX_GUIDE_CHANNELS) return;
          rows = programmes[key] = [];
        }
        if (rows.length >= MAX_PROGRAMMES_PER_CHANNEL) return;
        rows.push([p.startMs, p.stopMs, p.title, p.description]);
        kept += 1;
      },
    });
    await this.read(link.url, options, (text) => scanner.write(text));
    scanner.end();
    if (!scanner.sawRoot || (scanner.channels === 0 && scanner.programmes === 0)) return null;
    for (const rows of Object.values(programmes)) rows.sort((a, b) => a[0] - b[0]);
    const cache: GuideCache = { programmes };
    await this.writeCache(link.id, cache);
    this.guides.set(link.id, cache);
    if (!scanner.programmes) return `${plural(scanner.channels, 'channel', 'channels')}, no programmes yet`;
    const days = Math.round((last - first) / (24 * HOUR_MS));
    return days >= 1 ? `${days}-day guide` : plural(scanner.programmes, 'programme', 'programmes');
  }
}

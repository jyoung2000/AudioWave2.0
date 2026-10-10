/**
 * Discover's "From the catalog" set (NP-DISC-006) and its look-ahead (NP-DISC-007), the side that
 * talks to the network. Installed by the search chunk as `window.NP_DISC_ONLINE`, because the catalog
 * search lives here; the shell's Discover (make-shell.py) asks it and draws what it answers.
 *
 * `ask()` derives the queries from the listener's own profile (`onlineQueries`), searches the
 * catalog for each — through whichever client answers: the paired hub, the companion on this PC, or,
 * keylessly, this browser — and ranks what came back with the very ranker Discover's library rows
 * use (`rankFound`). The answer says what happened in words when nothing came: offline, nothing
 * played yet, nothing answered, or nothing new.
 *
 * The look-ahead asks for the next picks' 30-second previews while the page is idle, one at a time,
 * within the budget `prefetch.ts` states, and keeps them as `blob:` URLs in memory so a chosen pick's
 * preview starts at once. Nothing is fetched while the catalog set is off, the browser asks to save
 * data, or the device is offline.
 */
import type { CatalogSourceStatus, CatalogTrack } from '@now-playing/contracts';
import { CATALOG_PLATFORM_LABELS } from '@now-playing/contracts';
// Imported here, in the lazy search chunk, so the catalog set and its look-ahead stay out of the first load.
import { explainFound, onlineQueries, rankFound, type GatheredRow } from '../recommend/online.js';
import { cachedFor, describeCache, planLookAhead, type CacheEntry, type Candidate } from '../recommend/prefetch.js';
import type { RankConfig, RankLean, RankPlay, RankSong } from '../recommend/rank.js';
import { Refused } from './client.js';
import * as V from './view.js';
import type { ListSong } from './index.js';

/** One search for the catalog set: the songs, who answered, and how each service did. */
export type Find = (
  q: string,
  signal: AbortSignal,
) => Promise<{ tracks: CatalogTrack[]; via: string; status: CatalogSourceStatus[] }>;

export interface AskInput {
  /** The library, as Discover ranks it: the taste comes from here, and none of it is offered again. */
  songs: readonly RankSong[];
  plays: readonly RankPlay[];
  cfg: RankConfig;
  mode: string;
  lean?: RankLean | null;
  /** Online picks this Discover session has already shown (their row ids). */
  exclude?: readonly string[];
  queued?: readonly string[];
  shown?: readonly { id: string; at: number }[];
  seed?: number;
  limit?: number;
}

/** A pick as the music list draws it: a visitor row, with what the menu and the transport need. */
export interface OnlineRow extends ListSong {
  online: true;
  /** Every platform it is on, named, for the badges. */
  platforms: string[];
  /** Why the algorithm put it here, from the factor that did (`explainFound`). */
  why: string;
  genre: string | null;
  explored: boolean;
}

export interface Answer {
  state: 'ok' | 'offline' | 'no-queries' | 'failed' | 'empty' | 'cancelled';
  rows: OnlineRow[];
  /** Who answered ("the hub TOWER", "the companion on this PC", "this browser"). */
  via: string | null;
  /** The plain sentence for anything but `ok`. */
  said: string;
  /** The searches asked, in order. */
  queries: string[];
}

export interface DiscoverOnline {
  ask(input: AskInput): Promise<Answer>;
  cancel(): void;
  /** Hand the look-ahead the picks on show, best first. */
  warm(rows: readonly OnlineRow[]): void;
  /** The preview held for a pick, as a `blob:` URL, or null. */
  clip(id: string): string | null;
  /** A pick's preview was played: the ring lets it go and moves on. */
  played(id: string): void;
  /** What the look-ahead holds and why it is not asking for more, in words. */
  lookahead(): { held: string; reason: string | null; bytes: number; entries: number };
  /** Off while the person has switched the catalog set off. */
  enable(on: boolean): void;
}

/** Queries at once; each a real search, so few. */
const CONCURRENCY = 2;
const QUERY_MS = 12_000;
/** How many picks a refresh shows. */
const PICKS = 12;
/** Service states that mean "not reached" rather than "nothing found". */
const UNREACHED = new Set<string>(['failed', 'timeout', 'cooling-down']);
/** A preview larger than this is not a 30-second clip; it is not kept. */
const CLIP_MAX = 3 * 1024 * 1024;

export function installDiscoverOnline(
  find: Find,
  songFor: (t: CatalogTrack) => ListSong,
): DiscoverOnline {
  let ctl: AbortController | null = null;
  let on = true;

  async function ask(input: AskInput): Promise<Answer> {
    ctl?.abort();
    const mine = (ctl = new AbortController());
    const queries = onlineQueries(input.songs, input.plays, input.cfg, {
      leanGenre: input.lean?.genre ?? null,
      mode: input.mode,
    });
    const asked = queries.map((q) => q.q);
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      return {
        state: 'offline',
        rows: [],
        via: null,
        said: 'This device is offline, so the catalog was not asked. Your library’s songs are above.',
        queries: asked,
      };
    if (!queries.length)
      return {
        state: 'no-queries',
        rows: [],
        via: null,
        said: input.plays.length
          ? 'This algorithm has nothing to ask the catalog for yet: it looks for genres, and the songs you have played carry none.'
          : 'Play a few songs first: the catalog is asked for the artists and genres you play.',
        queries: asked,
      };

    const gathered: GatheredRow<CatalogTrack>[] = [];
    let via: string | null = null;
    let failed = 0;
    let refused: string | null = null;
    const status: CatalogSourceStatus[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < queries.length && !mine.signal.aborted) {
        const q = queries[next++]!;
        try {
          const signal = AbortSignal.any([mine.signal, AbortSignal.timeout(QUERY_MS)]);
          const r = await find(q.q, signal);
          via = via ?? r.via;
          status.push(...r.status);
          for (const t of r.tracks) gathered.push({ row: foundRow(t), asked: q, extra: t });
          // Answered, but only with failures (every service failed, timed out or is cooling down): unreached.
          const tried = r.status.filter((s) => s.state !== 'skipped');
          if (!r.tracks.length && tried.length && tried.every((s) => UNREACHED.has(s.state))) failed += 1;
        } catch (err) {
          if (mine.signal.aborted) return;
          failed += 1;
          if (err instanceof Refused) refused = err.message;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queries.length) }, worker));
    if (mine.signal.aborted)
      return { state: 'cancelled', rows: [], via, said: '', queries: asked };

    if (!gathered.length) {
      const services = V.statusWords(status);
      return {
        state: failed === queries.length ? 'failed' : 'empty',
        rows: [],
        via,
        said:
          failed === queries.length
            ? refused
              ? `The catalog refused: ${refused}`
              : `Couldn’t reach the catalog: ${services || 'neither the hub, the companion nor the music services answered'}. Check the connection and refresh.`
            : `The catalog found nothing for ${list(asked)}${services ? ` (${services})` : ''}.`,
        queries: asked,
      };
    }

    const { picks, diagnostics } = rankFound<CatalogTrack>({
      gathered,
      library: input.songs,
      plays: input.plays,
      cfg: input.cfg,
      mode: input.mode,
      lean: input.lean ?? null,
      exclude: (input.exclude ?? []).map((id) => id.replace(/^disc-/, '')),
      ...(input.queued ? { queued: input.queued } : {}),
      ...(input.shown ? { shown: input.shown } : {}),
      ...(input.seed === undefined ? {} : { seed: input.seed }),
      limit: input.limit ?? PICKS,
    });
    const rows = picks.flatMap((p) => {
      const t = p.extra;
      if (!t) return [];
      const base = songFor(t);
      const row: OnlineRow = {
        ...base,
        id: rowId(p.song.id),
        online: true,
        platforms: V.platformsOf(t.sources).map((pf) => CATALOG_PLATFORM_LABELS[pf]),
        why: explainFound({ ...p, platform: base.platform }),
        genre: p.song.genre ?? null,
        explored: p.row.explored,
      };
      return [row];
    });
    if (!rows.length)
      return {
        state: 'empty',
        rows: [],
        via,
        said:
          diagnostics.fresh === 0
            ? `The catalog answered with ${diagnostics.arrived} songs, and every one is already here or was shown this session.`
            : `The catalog answered with ${diagnostics.fresh} new songs, and this algorithm’s mode leaves every one of them out.`,
        queries: asked,
      };
    return { state: 'ok', rows, via, said: '', queries: asked };
  }

  /* -------------------------------------------------------- the look-ahead */

  const ring: CacheEntry[] = [];
  const blobs = new Map<string, string>();
  /** Clips a page may not read (no CORS), and clips already played: neither is asked for again. */
  const failedClips = new Set<string>();
  const playedClips = new Set<string>();
  let candidates: Candidate[] = [];
  let inFlight: string | null = null;
  let reason: string | null = null;
  let scheduled = false;

  const saveData = (): boolean =>
    Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);
  const enabled = (): boolean => on && !saveData() && navigator.onLine !== false;

  /** The clip playing now: out of the ring, but its `blob:` URL stays alive until another is played. */
  let playing: string | null = null;

  function letGo(id: string): void {
    const at = ring.findIndex((c) => c.id === id);
    if (at >= 0) ring.splice(at, 1);
    const url = blobs.get(id);
    blobs.delete(id);
    if (url && url !== playing) URL.revokeObjectURL(url);
  }

  function pump(): void {
    const plan = planLookAhead({
      enabled: enabled(),
      candidates: candidates.filter((c) => !playedClips.has(c.id)).map((c) => (failedClips.has(c.id) ? { ...c, url: null } : c)),
      cache: ring,
      inFlight: inFlight ? [inFlight] : [],
    });
    for (const id of plan.evict) letGo(id);
    reason = plan.reason;
    const f = plan.fetch[0];
    if (!f || scheduled) return;
    // Only while the page has nothing better to do: a warm-up never competes with a click.
    scheduled = true;
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    const go = (): void => {
      scheduled = false;
      void warmOne(f);
    };
    if (idle) idle(go, { timeout: 2000 });
    else setTimeout(go, 200);
  }

  async function warmOne(f: { id: string; url: string }): Promise<void> {
    if (inFlight || !enabled() || !candidates.some((c) => c.id === f.id)) return;
    inFlight = f.id;
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(15_000), credentials: 'omit' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (!blob.size || blob.size > CLIP_MAX) throw new Error('not a clip');
      ring.push({ id: f.id, url: f.url, bytes: blob.size, at: Date.now(), played: false });
      blobs.set(f.id, URL.createObjectURL(blob));
    } catch {
      // A platform that does not let a page read its clip (no CORS) is streamed when chosen instead.
      failedClips.add(f.id);
    } finally {
      inFlight = null;
      pump();
    }
  }

  const api: DiscoverOnline = {
    ask,
    cancel: () => ctl?.abort(),
    warm(rows) {
      candidates = rows.map((r) => ({ id: r.id, url: r.preview, title: r.title, artist: r.artist, platform: r.platform }));
      pump();
    },
    clip(id) {
      return cachedFor(ring, id) ? (blobs.get(id) ?? null) : null;
    },
    played(id) {
      playedClips.add(id);
      const url = blobs.get(id) ?? null;
      if (playing && playing !== url) URL.revokeObjectURL(playing);
      playing = url;
      const c = ring.find((x) => x.id === id);
      if (c) c.played = true;
      pump();
    },
    lookahead() {
      return {
        held: describeCache(ring),
        reason,
        bytes: ring.reduce((n, c) => n + c.bytes, 0),
        entries: ring.length,
      };
    },
    enable(v) {
      on = v;
      pump();
    },
  };
  return api;
}

/** A catalog song as the ranker reads it. */
function foundRow(t: CatalogTrack): GatheredRow['row'] {
  return {
    t: t.title,
    a: t.artist,
    al: t.album ?? '',
    d: t.durationMs ? Math.round(t.durationMs / 1000) : null,
    bpm: t.bpm,
    p: t.sources[0] ? CATALOG_PLATFORM_LABELS[t.sources[0].platform] : null,
    // The catalog id, not a page address: it is what keeps one merged song one candidate.
    u: t.id,
    g: t.genre,
    c: V.previewOf(t),
  };
}

/** Row ids are the catalog id behind a prefix the music list can tell apart from a library id. */
const rowId = (id: string): string => `disc-${id}`;

function list(words: readonly string[]): string {
  const q = words.map((w) => `“${w}”`);
  return q.length <= 1 ? (q[0] ?? '') : `${q.slice(0, -1).join(', ')} or ${q.at(-1)!}`;
}

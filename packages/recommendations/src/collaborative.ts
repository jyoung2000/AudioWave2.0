import type { ListeningEvent } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import type { Candidate, Catalogue } from './candidates.js';
import { maxPositiveWeight, type TasteProfile } from './profile.js';

export interface CooccurrenceOptions {
  /** Minimum number of shared sessions before a pair counts (default 2). */
  minSupport?: number;
  /** Neighbours kept per track (default 50). */
  maxNeighbours?: number;
  /** 0 disables damping; higher values push popular tracks down the neighbour lists (default 0.25). */
  popularityDamping?: number;
  /** Sessions longer than this are truncated (default 50 distinct tracks). */
  maxSessionLength?: number;
}

export interface Neighbour {
  trackId: string;
  score: number;
}

/** Item-item co-occurrence matrix: cosine-normalised, popularity-damped, JSON serialisable. */
export interface Cooccurrence {
  version: 1;
  sessionCount: number;
  counts: Record<string, number>;
  neighbours: Record<string, Neighbour[]>;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Build the matrix from sessions (lists of track ids that were played together). Deterministic for the same input. */
export function buildCooccurrence(sessions: readonly (readonly string[])[], options: CooccurrenceOptions = {}): Cooccurrence {
  const minSupport = options.minSupport ?? 2;
  const maxNeighbours = options.maxNeighbours ?? 50;
  const damping = options.popularityDamping ?? 0.25;
  const maxSessionLength = options.maxSessionLength ?? 50;
  if (minSupport < 1 || maxNeighbours < 1 || damping < 0 || maxSessionLength < 2) throw new DomainError('validation', 'Invalid co-occurrence options');
  const counts = new Map<string, number>();
  const pairs = new Map<string, Map<string, number>>();
  let sessionCount = 0;
  for (const session of sessions) {
    const unique = [...new Set(session)].slice(0, maxSessionLength);
    if (unique.length < 2) continue;
    sessionCount += 1;
    for (const id of unique) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (let i = 0; i < unique.length; i += 1) {
      const a = unique[i]!;
      const row = pairs.get(a) ?? new Map<string, number>();
      for (let j = 0; j < unique.length; j += 1) {
        if (i === j) continue;
        const b = unique[j]!;
        row.set(b, (row.get(b) ?? 0) + 1);
      }
      pairs.set(a, row);
    }
  }
  const neighbours: Record<string, Neighbour[]> = {};
  const countsOut: Record<string, number> = {};
  for (const id of [...counts.keys()].sort()) countsOut[id] = counts.get(id)!;
  for (const a of [...pairs.keys()].sort()) {
    const ca = counts.get(a) ?? 0;
    const list: Neighbour[] = [];
    for (const [b, c] of pairs.get(a)!) {
      if (c < minSupport) continue;
      const cb = counts.get(b) ?? 0;
      const cosine = c / Math.sqrt(ca * cb);
      const damped = cosine / (1 + damping * Math.log(cb));
      list.push({ trackId: b, score: round6(damped) });
    }
    if (!list.length) continue;
    list.sort((x, y) => y.score - x.score || (x.trackId < y.trackId ? -1 : 1));
    neighbours[a] = list.slice(0, maxNeighbours);
  }
  return { version: 1, sessionCount, counts: countsOut, neighbours };
}

const POSITIVE_SESSION_EVENTS: ReadonlySet<ListeningEvent['type']> = new Set(['meaningful', 'completed', 'replayed', 'liked', 'favorited', 'saved', 'playlist-added']);

/** Group positively-interacted tracks by session id; sessions with fewer than two tracks are dropped. */
export function sessionsFromEvents(events: readonly ListeningEvent[]): string[][] {
  const bySession = new Map<string, string[]>();
  for (const e of events) {
    if (!e.trackId || !POSITIVE_SESSION_EVENTS.has(e.type)) continue;
    const list = bySession.get(e.sessionId) ?? [];
    if (!list.includes(e.trackId)) list.push(e.trackId);
    bySession.set(e.sessionId, list);
  }
  return [...bySession.values()].filter((s) => s.length >= 2);
}

/** Per-track collaborative score for a profile: neighbour scores of its strongest tracks, weighted by affinity. */
export function collaborativeScores(cooccurrence: Cooccurrence, profile: TasteProfile, limitSeeds = 20): Map<string, { score: number; via: string }> {
  const max = maxPositiveWeight(profile.dims.tracks);
  const out = new Map<string, { score: number; via: string }>();
  if (max <= 0) return out;
  const seeds = Object.entries(profile.dims.tracks)
    .filter(([, e]) => e.w > 0)
    .sort(([ka, a], [kb, b]) => b.w - a.w || (ka < kb ? -1 : 1))
    .slice(0, limitSeeds);
  const best = new Map<string, number>();
  for (const [seedId, entry] of seeds) {
    const weight = entry.w / max;
    for (const n of cooccurrence.neighbours[seedId] ?? []) {
      const contribution = n.score * weight;
      const current = out.get(n.trackId);
      const label = entry.label ?? seedId;
      if (!current) {
        out.set(n.trackId, { score: contribution, via: label });
        best.set(n.trackId, contribution);
      } else {
        current.score += contribution;
        if (contribution > (best.get(n.trackId) ?? 0)) {
          best.set(n.trackId, contribution);
          current.via = label;
        }
      }
    }
  }
  for (const value of out.values()) value.score = Math.min(1, value.score);
  return out;
}

/** 4. "People who play X also play this" — co-occurrence neighbours of the profile's strongest tracks. */
export function collaborativeCandidates(cooccurrence: Cooccurrence, profile: TasteProfile, catalogue: Catalogue, limit = 60): Candidate[] {
  const scores = collaborativeScores(cooccurrence, profile);
  const out: Candidate[] = [];
  for (const [trackId, { score, via }] of scores) {
    const track = catalogue.byId.get(trackId);
    if (!track) continue;
    const entry = profile.dims.tracks[trackId];
    if (entry && (entry.n > 0 || entry.w !== 0)) continue;
    out.push({ trackId, track, sources: [{ kind: 'collaborative', score, via }], reasons: [`People who play ${via} also play this`] });
  }
  out.sort((a, b) => b.sources[0]!.score - a.sources[0]!.score || (a.trackId < b.trackId ? -1 : 1));
  return out.slice(0, limit);
}

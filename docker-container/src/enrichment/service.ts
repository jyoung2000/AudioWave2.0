import type { CanonicalTrack, DiscoveryJob, SearchResult } from '@now-playing/contracts';
import { mergeGenreProfile, normalizeArtist, normalizeText } from '@now-playing/domain';
import { randomUUID } from 'node:crypto';
import type { CanonicalRepository } from '../db/repositories/canonical.js';
import type { Clock, FfmpegInfo } from '../deps.js';
import type { Logger } from 'pino';
import type { AcousticBrainzAdapter } from '../providers/adapters/acousticbrainz.js';
import type { DeezerAdapter } from '../providers/adapters/deezer.js';
import type { LastFmAdapter } from '../providers/adapters/lastfm.js';
import type { MusicBrainzAdapter } from '../providers/adapters/musicbrainz.js';
import type { SafeHttpClient } from '../providers/http.js';
import type { RateLimitManager } from '../providers/rate-limit-manager.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { RecordingMatcher, type Match } from './matcher.js';
import { bpmFromPreviewClip } from './preview-bpm.js';

/** System jobs have no user; the job table has no foreign key, so a fixed v4-shaped id names them. */
export const ENRICHMENT_USER_ID = '00000000-0000-4000-8000-00000000e001';
const DURATION_GATE_MS = 3000;
const MATCHED_AT_LEAST = 0.5;

/** Everything a job needs to look a track up, carried in the job's payload. */
export interface EnrichmentKey {
  provider: string;
  providerId: string;
  title: string;
  artistName: string | null;
  channelName?: string | null;
  durationMs: number | null;
  isrc: string | null;
  musicbrainzRecordingId: string | null;
  previewUrl: string | null;
  genreHint?: string | null;
}

export interface EnrichmentDeps {
  canonical: CanonicalRepository;
  providers: ProviderRegistry;
  rateLimiter: RateLimitManager;
  clock: Clock;
  log: Logger;
  http: SafeHttpClient;
  ffmpeg: () => Promise<FfmpegInfo>;
  enqueue: (input: { userId: string; kind: DiscoveryJob['kind']; priority?: DiscoveryJob['priority']; payload?: Record<string, unknown> }) => unknown;
}

type BpmAnswer = { bpm: number; source: CanonicalTrack['bpmSource'] } | null;

/**
 * What a track becomes once the hub has looked it up. Two doors: `enrichResult` answers a request
 * from the cache and never waits on the network (it queues a job instead); `runJob` is that job —
 * match, fill, store — one track at a time on the scheduler, at the providers' rates.
 */
export class EnrichmentService {
  private readonly matcher: RecordingMatcher;

  constructor(private readonly deps: EnrichmentDeps) {
    this.matcher = new RecordingMatcher(deps.providers.get('musicbrainz') as MusicBrainzAdapter, deps.rateLimiter);
  }

  private now(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }

  private adapter<T>(id: string): T | null {
    return this.deps.providers.has(id) && this.deps.providers.isEnabled(id) ? (this.deps.providers.get(id) as T) : null;
  }

  private findCanonical(r: { identity: Pick<SearchResult['identity'], 'isrc' | 'musicbrainzRecordingId'>; title: string; artistName: string | null; durationMs: number | null }): CanonicalTrack | undefined {
    const c = this.deps.canonical;
    if (r.identity.musicbrainzRecordingId) {
      const t = c.findTrackByMbid(r.identity.musicbrainzRecordingId);
      if (t) return t;
    }
    if (r.identity.isrc) {
      const t = c.findTrackByIsrc(r.identity.isrc);
      if (t) return t;
    }
    if (!r.artistName) return undefined;
    return c
      .findTracksByNormalized(normalizeArtist(r.artistName), normalizeText(r.title))
      .find((t) => r.durationMs === null || t.durationMs === null || Math.abs(t.durationMs - r.durationMs) <= DURATION_GATE_MS);
  }

  /** The canonical row's answers laid over a result — only the matched ones when the match was confident. */
  applyCanonical(result: SearchResult, t: CanonicalTrack): SearchResult {
    const matched = (t.matchConfidence ?? 0) >= MATCHED_AT_LEAST;
    return {
      ...result,
      albumName: matched ? (t.albumName ?? result.albumName) : result.albumName,
      artistName: matched ? t.artistName : result.artistName,
      featuredArtists: matched ? t.featuredArtists : result.featuredArtists,
      artworkUrl: matched && t.artworkUrl ? t.artworkUrl : result.artworkUrl,
      year: matched ? (t.releaseYear ?? result.year) : result.year,
      genres: matched ? t.genres : result.genres,
      genreProfile: matched ? t.genreProfile : result.genreProfile,
      genre: matched ? (t.genres[0] ?? result.genre) : result.genre,
      bpm: t.bpm ?? result.bpm,
      bpmSource: t.bpm !== null ? t.bpmSource : result.bpmSource,
      identity: {
        ...result.identity,
        isrc: result.identity.isrc ?? t.isrc,
        musicbrainzRecordingId: result.identity.musicbrainzRecordingId ?? t.musicbrainzRecordingId,
        matchConfidence: t.matchConfidence,
      },
    };
  }

  /** Cache-first, never the network: a miss queues one job and the result goes back as it came. */
  async enrichResult(result: SearchResult, _budgetMs: number): Promise<SearchResult> {
    if (result.kind !== 'track') return result;
    const t = this.findCanonical(result);
    if (t?.enrichedAt) return this.applyCanonical(result, t);
    this.enqueueForTrack({
      provider: result.provider,
      providerId: result.providerId,
      title: result.title,
      artistName: result.artistName,
      channelName: result.provider === 'youtube' ? result.artistName : null,
      durationMs: result.durationMs,
      isrc: result.identity.isrc,
      musicbrainzRecordingId: result.identity.musicbrainzRecordingId,
      previewUrl: result.previewUrl,
      genreHint: result.genre,
    });
    return t ? this.applyCanonical(result, t) : result;
  }

  enqueueForTrack(key: EnrichmentKey): void {
    const payloadKey = `${key.provider}:${key.providerId}`;
    if (this.deps.canonical.hasQueuedJob('enrich-track', payloadKey)) return;
    this.deps.enqueue({ userId: ENRICHMENT_USER_ID, kind: 'enrich-track', priority: 'P3', payload: { key: payloadKey, ...key } });
  }

  async runJob(job: DiscoveryJob): Promise<void> {
    const key = job.payload as unknown as EnrichmentKey;
    const match = await this.matcher.match({
      title: key.title,
      artistName: key.artistName,
      channelName: key.channelName ?? null,
      durationMs: key.durationMs,
      isrc: key.isrc,
      musicbrainzRecordingId: key.musicbrainzRecordingId,
      provider: key.provider,
    });
    const now = this.now();
    const existing = this.findCanonical({
      identity: { isrc: key.isrc ?? match?.recording.isrcs[0] ?? null, musicbrainzRecordingId: match?.recording.id ?? key.musicbrainzRecordingId },
      title: key.title,
      artistName: key.artistName,
      durationMs: key.durationMs,
    });
    const base: CanonicalTrack = existing ?? {
      id: randomUUID(),
      musicbrainzRecordingId: null,
      isrc: key.isrc,
      title: key.title,
      normalizedTitle: normalizeText(key.title),
      artistId: null,
      artistName: key.artistName ?? '',
      normalizedArtist: normalizeArtist(key.artistName ?? ''),
      albumId: null,
      albumName: null,
      releaseYear: null,
      durationMs: key.durationMs,
      genres: [],
      tags: [],
      popularity: null,
      createdAt: now,
      updatedAt: now,
      featuredArtists: [],
      genreProfile: {},
      bpm: null,
      bpmSource: null,
      artworkUrl: null,
      matchConfidence: null,
      enrichedAt: null,
    };
    const track: CanonicalTrack = match ? await this.fill(base, match, key) : { ...base, matchConfidence: 0 };
    if (track.bpm === null) {
      const answer = await this.bpmChain(track, key);
      if (answer) {
        track.bpm = answer.bpm;
        track.bpmSource = answer.source;
      }
    }
    track.updatedAt = now;
    track.enrichedAt = now;
    this.deps.canonical.upsertTrack(track);
  }

  private async fill(base: CanonicalTrack, m: Match, key: EnrichmentKey): Promise<CanonicalTrack> {
    const mb = this.deps.providers.get('musicbrainz') as MusicBrainzAdapter;
    const lastfm = this.adapter<LastFmAdapter>('lastfm');
    const r = m.recording;
    const artwork = r.releaseGroupId
      ? await this.deps.rateLimiter.run('musicbrainz', 'P3', () => mb.coverArtUrl(r.releaseGroupId!), { timeoutMs: 10_000 }).catch(() => null)
      : null;
    const lfm = lastfm ? await this.deps.rateLimiter.run('lastfm', 'P3', () => lastfm.topTags(r.artistName, r.title), { timeoutMs: 10_000 }).catch(() => []) : [];
    const maxG = Math.max(1, ...r.genres.map((g) => g.count));
    const maxT = Math.max(1, ...r.tags.map((g) => g.count));
    const maxL = Math.max(1, ...lfm.map((g) => g.count));
    const votes = [
      ...r.genres.map((g) => ({ label: g.name, weight: g.count / maxG })),
      ...r.tags.map((g) => ({ label: g.name, weight: 0.5 * (g.count / maxT) })),
      ...lfm.map((g) => ({ label: g.name, weight: 0.8 * (g.count / maxL) })),
      ...(key.genreHint ? [{ label: key.genreHint, weight: 0.3 }] : []),
    ];
    const profile = mergeGenreProfile(votes);
    const unmapped = [...r.tags, ...lfm].map((t) => t.name.toLowerCase()).filter((n) => !(n in profile)).slice(0, 10);
    return {
      ...base,
      musicbrainzRecordingId: r.id,
      isrc: base.isrc ?? r.isrcs[0] ?? null,
      title: r.title,
      normalizedTitle: normalizeText(r.title),
      artistName: r.artistName,
      normalizedArtist: normalizeArtist(r.artistName),
      albumName: r.albumName,
      releaseYear: r.releaseYear,
      durationMs: base.durationMs ?? r.lengthMs,
      featuredArtists: r.featuredArtists.length ? r.featuredArtists : m.cleaned.featured,
      genres: Object.keys(profile),
      genreProfile: profile,
      tags: [...new Set(unmapped)],
      artworkUrl: artwork,
      matchConfidence: m.confidence,
    };
  }

  /** First answer wins: a code lookup, the archive, a name lookup, and only then the clip itself. */
  private async bpmChain(t: CanonicalTrack, key: EnrichmentKey): Promise<BpmAnswer> {
    const deezer = this.adapter<DeezerAdapter>('deezer');
    const ab = this.adapter<AcousticBrainzAdapter>('acousticbrainz');
    const run = <T>(p: string, fn: () => Promise<T>): Promise<T | null> => this.deps.rateLimiter.run(p, 'P3', fn, { timeoutMs: 10_000 }).catch(() => null);
    if (deezer && t.isrc) {
      const d = await run('deezer', () => deezer.bpmByIsrc(t.isrc!));
      if (d) return { bpm: d.bpm, source: 'deezer' };
    }
    if (ab && t.musicbrainzRecordingId) {
      const b = await run('acousticbrainz', () => ab.bpmByMbid(t.musicbrainzRecordingId!));
      if (b) return { bpm: b, source: 'acousticbrainz' };
    }
    if (deezer && t.artistName) {
      const d = await run('deezer', () => deezer.bpmBySearch(t.artistName, t.title, t.durationMs));
      if (d) return { bpm: d.bpm, source: 'deezer' };
    }
    if (key.previewUrl) {
      const p = await bpmFromPreviewClip({ http: this.deps.http, ffmpeg: this.deps.ffmpeg, log: this.deps.log }, key.previewUrl).catch(() => null);
      if (p) return { bpm: p.bpm, source: 'preview-analysis' };
    }
    return null;
  }
}

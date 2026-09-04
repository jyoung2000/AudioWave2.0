/**
 * Hub-side discovery and recommendation.
 *
 * Three jobs live here. **Canonicalisation**: every track the hub sees — from the local library, a
 * provider search, or an account import — is matched into one canonical record, so "the same song
 * on three services" is one row with three `track_platforms` entries. Matching is strict first
 * (MusicBrainz recording id, then ISRC) and only then falls back to normalised artist + title with
 * a duration tolerance, because a loose metadata match silently merges two different recordings.
 *
 * **Profiles**: listening events ingested with the `history:events` scope are folded into a stored
 * `TasteProfile` (the same code the player runs offline), cached in `taste_profiles` and refreshed
 * incrementally as new events arrive.
 *
 * **Serving**: `recommend()` runs against the canonical catalogue with the caller's profile,
 * carrying provider availability so the UI can only offer what is actually playable.
 */
import type { ArtistRelation, CanonicalArtist, CanonicalTrack, ListeningEvent, Recommendation, RecommendationFeedback, RecommendationMode, SearchResult, TasteProfileView, Track, TrackPlatform } from '@now-playing/contracts';
import { DomainError, uuidv7 } from '@now-playing/domain';
import {
  DEFAULT_RECOMMENDATION_CONFIG,
  applyEvents,
  applyFeedback,
  applySeeds,
  buildCatalogue,
  buildCooccurrence,
  createProfile,
  deserializeProfile,
  isColdStart,
  mergeConfig,
  profileView,
  recommend,
  serializeProfile,
  sessionsFromEvents,
  type Catalogue,
  type RecommendationConfig,
  type TasteProfile,
} from '@now-playing/recommendations';
import type { CanonicalRepository } from '../db/repositories/canonical.js';
import type { SettingsRepository } from '../db/repositories/settings.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { LibraryService } from '../library/service.js';
import type { Logger } from 'pino';

export const RECOMMENDATION_CONFIG_KEY = 'recommendations';
/** Two recordings match on metadata only when their durations agree within this many milliseconds. */
export const DURATION_TOLERANCE_MS = 4000;
const CATALOGUE_LIMIT = 5000;
const PROFILE_EVENT_LIMIT = 20_000;

export interface RecommendationRequest {
  userId: string;
  mode: RecommendationMode;
  contextId?: string | null;
  seeds?: readonly string[];
  limit: number;
  exploration?: number | undefined;
}

export interface RecommendationResponse {
  mode: RecommendationMode;
  items: Recommendation[];
  generatedAt: string;
  fromCache: boolean;
  coverage: { candidates: number; sources: Record<string, number>; coldStart: boolean };
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\((?:feat|ft|with)[^)]*\)/g, '')
    .replace(/\s*-\s*(?:remaster(?:ed)?|radio edit|single version)\b.*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export class RecommendationService {
  private catalogueCache: { catalogue: Catalogue; builtAt: number; size: number } | null = null;
  private readonly profiles = new Map<string, TasteProfile>();

  constructor(
    private readonly repo: CanonicalRepository,
    private readonly settings: SettingsRepository,
    private readonly library: LibraryService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /* ------------------------------------------------------------- configuration */

  config(): RecommendationConfig {
    const stored = this.settings.get<Record<string, unknown>>(RECOMMENDATION_CONFIG_KEY);
    if (!stored) return DEFAULT_RECOMMENDATION_CONFIG;
    try {
      return mergeConfig(stored as never);
    } catch (err) {
      this.log.warn({ module: 'recommendations', err: err instanceof Error ? err.message : String(err) }, 'stored recommendation config is invalid; using defaults');
      return DEFAULT_RECOMMENDATION_CONFIG;
    }
  }

  setConfig(patch: Record<string, unknown>): RecommendationConfig {
    const merged = mergeConfig(patch as never); // throws DomainError('validation') on anything invalid
    this.settings.set(RECOMMENDATION_CONFIG_KEY, patch, this.nowIso());
    this.profiles.clear();
    return merged;
  }

  /* ----------------------------------------------------------- canonicalisation */

  /**
   * Find or create the canonical record for a track, and remember which provider it came from.
   * Returns the canonical id so callers can key recommendations and platform rows on it.
   */
  canonicalise(input: { title: string; artistName: string; albumName?: string | null; durationMs?: number | null; releaseYear?: number | null; genres?: readonly string[]; tags?: readonly string[]; popularity?: number | null; musicbrainzRecordingId?: string | null; isrc?: string | null; provider?: string | null; providerTrackId?: string | null; url?: string | null; availability?: TrackPlatform['availability'] }): CanonicalTrack {
    const now = this.nowIso();
    const normalizedTitle = normalize(input.title);
    const normalizedArtist = normalize(input.artistName);

    let existing: CanonicalTrack | undefined;
    if (input.musicbrainzRecordingId) existing = this.repo.findTrackByMbid(input.musicbrainzRecordingId);
    if (!existing && input.isrc) existing = this.repo.findTrackByIsrc(input.isrc);
    if (!existing && input.provider && input.providerTrackId) existing = this.repo.findTrackByPlatform(input.provider, input.providerTrackId);
    if (!existing) {
      // Metadata fallback, guarded by duration so two different recordings of one song stay apart.
      const candidates = this.repo.findTracksByNormalized(normalizedArtist, normalizedTitle);
      existing = candidates.find((c) => {
        if (input.durationMs === null || input.durationMs === undefined || c.durationMs === null) return candidates.length === 1;
        return Math.abs(c.durationMs - input.durationMs) <= DURATION_TOLERANCE_MS;
      });
    }

    const track: CanonicalTrack = {
      id: existing?.id ?? uuidv7(this.clock.now()),
      musicbrainzRecordingId: input.musicbrainzRecordingId ?? existing?.musicbrainzRecordingId ?? null,
      isrc: input.isrc ?? existing?.isrc ?? null,
      title: input.title.slice(0, 300),
      normalizedTitle,
      artistId: existing?.artistId ?? this.canonicaliseArtist(input.artistName, input.genres ?? []).id,
      artistName: input.artistName.slice(0, 300),
      normalizedArtist,
      albumId: existing?.albumId ?? null,
      albumName: input.albumName ?? existing?.albumName ?? null,
      releaseYear: input.releaseYear ?? existing?.releaseYear ?? null,
      durationMs: input.durationMs ?? existing?.durationMs ?? null,
      genres: [...new Set([...(input.genres ?? []).map((g) => g.toLowerCase()), ...(existing?.genres ?? [])])].slice(0, 12),
      tags: [...new Set([...(input.tags ?? []).map((t) => t.toLowerCase()), ...(existing?.tags ?? [])])].slice(0, 20),
      popularity: input.popularity ?? existing?.popularity ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.repo.upsertTrack(track);
    if (input.provider && input.providerTrackId) {
      this.repo.putPlatform({ trackId: track.id, provider: input.provider, providerTrackId: input.providerTrackId, url: input.url ?? null, availability: input.availability ?? 'unknown', lastVerifiedAt: now });
    }
    this.catalogueCache = null;
    return track;
  }

  canonicaliseArtist(name: string, genres: readonly string[] = [], musicbrainzArtistId: string | null = null): CanonicalArtist {
    const normalizedName = normalize(name);
    const existing = this.repo.findArtistByNormalized(normalizedName);
    const now = this.nowIso();
    const artist: CanonicalArtist = {
      id: existing?.id ?? uuidv7(this.clock.now()),
      musicbrainzArtistId: musicbrainzArtistId ?? existing?.musicbrainzArtistId ?? null,
      name: name.slice(0, 300),
      normalizedName,
      genres: [...new Set([...genres.map((g) => g.toLowerCase()), ...(existing?.genres ?? [])])].slice(0, 12),
      tags: existing?.tags ?? [],
      popularity: existing?.popularity ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.repo.upsertArtist(artist);
    return artist;
  }

  canonicaliseSearchResult(result: SearchResult): CanonicalTrack {
    return this.canonicalise({
      title: result.title,
      artistName: result.artistName ?? 'Unknown Artist',
      albumName: result.albumName,
      durationMs: result.durationMs,
      releaseYear: result.year,
      genres: result.genre ? [result.genre] : [],
      musicbrainzRecordingId: result.identity.musicbrainzRecordingId,
      isrc: result.identity.isrc,
      provider: result.provider,
      providerTrackId: result.providerId,
      url: result.canonicalUrl,
      availability: result.capabilities.playback === 'available' ? 'available' : result.capabilities.playback === 'requires_auth' ? 'requires_auth' : result.capabilities.playback === 'restricted' ? 'restricted' : 'unavailable',
    });
  }

  canonicaliseLibraryTrack(track: Track, provider: string): CanonicalTrack {
    return this.canonicalise({
      title: track.title,
      artistName: track.artistName,
      albumName: track.albumName,
      durationMs: track.durationMs,
      releaseYear: track.year,
      genres: track.genres,
      tags: track.tags,
      musicbrainzRecordingId: track.identity.musicbrainzRecordingId,
      isrc: track.identity.isrc,
      provider,
      providerTrackId: track.id,
      availability: track.unsupportedReason ? 'restricted' : 'available',
    });
  }

  /** Fold the hub's own library into the catalogue so recommendations can include what you own. */
  indexLibrary(): number {
    let n = 0;
    for (const record of this.library.allTracks()) {
      this.canonicaliseLibraryTrack(record.track, this.library.tagOf(record) === 'public-domain' ? 'public-domain' : 'hub');
      n += 1;
    }
    this.metrics.gauge('recommendations.catalogue', this.repo.countTracks());
    return n;
  }

  catalogue(): Catalogue {
    const size = this.repo.countTracks();
    if (this.catalogueCache && this.catalogueCache.size === size && this.clock.now() - this.catalogueCache.builtAt < 60_000) return this.catalogueCache.catalogue;
    const tracks = this.repo.listTracks(CATALOGUE_LIMIT);
    const artists = this.repo.listArtists();
    const relations = this.repo.allRelations();
    const catalogue = buildCatalogue(tracks, { artists, relations });
    this.catalogueCache = { catalogue, builtAt: this.clock.now(), size };
    return catalogue;
  }

  putRelation(relation: ArtistRelation): void {
    this.repo.putRelation(relation);
    this.catalogueCache = null;
  }

  /* ---------------------------------------------------------------- profiles */

  /** Ingest opt-in listening events and fold them into the stored profile. Idempotent by event id. */
  ingestEvents(userId: string, events: readonly ListeningEvent[]): { accepted: number; duplicates: number } {
    const now = this.nowIso();
    const result = this.repo.insertEvents(userId, events, now);
    if (result.accepted > 0) {
      const profile = applyEvents(this.profile(userId), events, this.config(), this.clock.now());
      this.saveProfile(userId, profile);
      for (const e of events) {
        if (e.track) this.canonicalise({ title: e.track.title, artistName: e.track.artistName, albumName: e.track.albumName, durationMs: e.track.durationMs, releaseYear: e.track.year, genres: e.track.genre ? [e.track.genre] : [], tags: e.track.tags, popularity: e.track.popularity, provider: e.track.provider, providerTrackId: e.trackId });
      }
    }
    this.metrics.increment('recommendations.events_ingested', result.accepted);
    return result;
  }

  profile(userId: string): TasteProfile {
    const cached = this.profiles.get(userId);
    if (cached) return cached;
    const stored = this.repo.getProfile(userId);
    if (stored) {
      try {
        const profile = deserializeProfile(stored.profile);
        this.profiles.set(userId, profile);
        return profile;
      } catch (err) {
        this.log.warn({ module: 'recommendations', userId, err: err instanceof Error ? err.message : String(err) }, 'stored taste profile could not be read; rebuilding');
      }
    }
    return this.rebuildProfile(userId);
  }

  /** Rebuild from the append-only event log — the log is the source of truth, the profile a cache. */
  rebuildProfile(userId: string): TasteProfile {
    const events = this.repo.eventsForUser(userId, PROFILE_EVENT_LIMIT).slice().reverse();
    const profile = applyEvents(createProfile(userId, this.clock.now()), events, this.config(), this.clock.now());
    this.saveProfile(userId, profile);
    return profile;
  }

  private saveProfile(userId: string, profile: TasteProfile): void {
    this.profiles.set(userId, profile);
    this.repo.putProfile(userId, serializeProfile(profile), this.nowIso(), profile.eventCount);
  }

  applySeeds(userId: string, seeds: { artists: string[]; genres: string[]; likedTrackIds: string[] }): TasteProfile {
    const profile = applySeeds(this.profile(userId), seeds, this.config(), this.clock.now());
    this.saveProfile(userId, profile);
    this.repo.putSeeds(userId, seeds, this.nowIso());
    return profile;
  }

  recordFeedback(userId: string, recommendationId: string, feedback: RecommendationFeedback, track: { trackId: string; artistName?: string | null; genres?: string[] } | null): void {
    this.repo.putFeedback(recommendationId, userId, feedback, this.nowIso());
    if (!track) return;
    const profile = applyFeedback(
      this.profile(userId),
      { recommendationId, trackId: track.trackId, feedback, ...(track.artistName ? { artistName: track.artistName } : {}), ...(track.genres ? { genres: track.genres } : {}) },
      this.config(),
      this.clock.now(),
    );
    this.saveProfile(userId, profile);
    this.metrics.increment(`recommendations.feedback.${feedback}`);
  }

  view(userId: string): TasteProfileView {
    const profile = this.profile(userId);
    const view = profileView(profile, this.config());
    return {
      ownerId: userId,
      computedAt: view.computedAt,
      eventCount: view.eventCount,
      dimensions: view.dimensions,
      contexts: view.contexts.map((c) => ({ kind: c.kind, id: c.id, name: c.name, eventCount: c.eventCount, topArtists: c.topArtists })),
      discoveryPreference: view.discoveryPreference,
      popularityPreference: view.popularityPreference,
      coldStart: view.coldStart,
    };
  }

  deleteEverythingFor(userId: string): { events: number; profile: boolean } {
    const events = this.repo.deleteEvents(userId);
    const profile = this.repo.deleteProfile(userId);
    this.profiles.delete(userId);
    return { events, profile };
  }

  /* ---------------------------------------------------------------- serving */

  serve(request: RecommendationRequest, options: { ownedTrackIds?: Iterable<string>; recentlyPlayedIds?: Iterable<string>; recentlyRecommended?: Record<string, number> } = {}): RecommendationResponse {
    const config = this.config();
    const profile = this.profile(request.userId);
    const catalogue = this.catalogue();
    if (catalogue.tracks.length === 0) throw new DomainError('unavailable', 'The hub has no catalogue yet: scan a library or run a search first');
    const events = this.repo.eventsForUser(request.userId, 5000);
    const cooccurrence = buildCooccurrence(sessionsFromEvents(events.slice().reverse()));
    const platforms = this.repo.allPlatforms();

    const result = recommend({
      userId: request.userId,
      profile,
      catalogue,
      platforms,
      mode: request.mode,
      limit: request.limit,
      seed: Math.floor(this.clock.now() / 3_600_000),
      config,
      cooccurrence,
      now: this.clock.now(),
      context: {
        ...(request.contextId ? { playlistId: request.contextId } : {}),
        ...(request.mode === 'similar' && request.seeds?.length ? { seedTrackId: request.seeds[0]!, seedIds: request.seeds } : {}),
        ...(request.mode === 'genre' && request.contextId ? { genre: request.contextId } : {}),
        ...(options.ownedTrackIds ? { ownedTrackIds: options.ownedTrackIds } : {}),
        ...(options.recentlyPlayedIds ? { recentlyPlayedIds: options.recentlyPlayedIds } : {}),
        ...(options.recentlyRecommended ? { recentlyRecommended: options.recentlyRecommended } : {}),
      },
    });

    this.metrics.increment(`recommendations.served.${request.mode}`);
    this.metrics.observe('recommendations.latency_ms', result.diagnostics.elapsedMs);
    return {
      mode: request.mode,
      items: result.recommendations,
      generatedAt: this.nowIso(),
      fromCache: false,
      coverage: { candidates: result.diagnostics.candidateCount, sources: result.diagnostics.sources, coldStart: result.diagnostics.coldStart },
    };
  }

  coldStart(userId: string): boolean {
    return isColdStart(this.profile(userId), this.config());
  }

  stats(): { tracks: number; artists: number; users: number } {
    return { tracks: this.repo.countTracks(), artists: this.repo.listArtists(1).length ? this.repo.listArtists(100000).length : 0, users: this.repo.usersWithEvents().length };
  }
}

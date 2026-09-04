import type { AggregateTasteProfile, ArtistRelation, CanonicalArtist, CanonicalTrack, DiscoveryJob, ListeningEvent, RecommendationFeedback, TrackPlatform } from '@now-playing/contracts';
import type { Db } from '../connection.js';

interface CanonicalTrackRow {
  id: string;
  musicbrainz_recording_id: string | null;
  isrc: string | null;
  title: string;
  normalized_title: string;
  artist_id: string | null;
  artist_name: string;
  normalized_artist: string;
  album_id: string | null;
  album_name: string | null;
  release_year: number | null;
  duration_ms: number | null;
  genres: string;
  tags: string;
  popularity: number | null;
  created_at: string;
  updated_at: string;
}

interface CanonicalArtistRow {
  id: string;
  musicbrainz_artist_id: string | null;
  name: string;
  normalized_name: string;
  genres: string;
  tags: string;
  popularity: number | null;
  created_at: string;
  updated_at: string;
}

interface TrackPlatformRow {
  track_id: string;
  provider: string;
  provider_track_id: string;
  url: string | null;
  availability: TrackPlatform['availability'];
  last_verified_at: string | null;
}

function toCanonicalTrack(r: CanonicalTrackRow): CanonicalTrack {
  return {
    id: r.id,
    musicbrainzRecordingId: r.musicbrainz_recording_id,
    isrc: r.isrc,
    title: r.title,
    normalizedTitle: r.normalized_title,
    artistId: r.artist_id,
    artistName: r.artist_name,
    normalizedArtist: r.normalized_artist,
    albumId: r.album_id,
    albumName: r.album_name,
    releaseYear: r.release_year,
    durationMs: r.duration_ms,
    genres: JSON.parse(r.genres) as string[],
    tags: JSON.parse(r.tags) as string[],
    popularity: r.popularity,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toCanonicalArtist(r: CanonicalArtistRow): CanonicalArtist {
  return { id: r.id, musicbrainzArtistId: r.musicbrainz_artist_id, name: r.name, normalizedName: r.normalized_name, genres: JSON.parse(r.genres) as string[], tags: JSON.parse(r.tags) as string[], popularity: r.popularity, createdAt: r.created_at, updatedAt: r.updated_at };
}

function toTrackPlatform(r: TrackPlatformRow): TrackPlatform {
  return { trackId: r.track_id, provider: r.provider, providerTrackId: r.provider_track_id, url: r.url, availability: r.availability, lastVerifiedAt: r.last_verified_at };
}

interface DiscoveryJobRow {
  id: string;
  state: DiscoveryJob['state'];
  user_id: string;
  kind: DiscoveryJob['kind'];
  priority: DiscoveryJob['priority'];
  payload: string;
  attempts: number;
  next_run_at: string;
  created_at: string;
  updated_at: string;
  error: string | null;
}

function toDiscoveryJob(r: DiscoveryJobRow): DiscoveryJob {
  return { id: r.id, state: r.state, userId: r.user_id, kind: r.kind, priority: r.priority, payload: JSON.parse(r.payload) as Record<string, unknown>, attempts: r.attempts, nextRunAt: r.next_run_at, createdAt: r.created_at, updatedAt: r.updated_at, error: r.error };
}

/** Canonical catalogue, discovery cache/jobs, listening events and profiles. The discovery engine itself lands later; the storage is ready now. */
export class CanonicalRepository {
  constructor(private readonly db: Db) {}

  /* ---- listening events ---- */
  insertEvents(userId: string, events: readonly ListeningEvent[], now: string): { accepted: number; duplicates: number } {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO listening_events (id, user_id, device_id, type, occurred_at, event, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    let accepted = 0;
    this.db.transaction(() => {
      for (const e of events) accepted += stmt.run(e.id, userId, e.deviceId, e.type, e.occurredAt, JSON.stringify(e), now).changes;
    })();
    return { accepted, duplicates: events.length - accepted };
  }

  eventsForUser(userId: string, limit = 20_000): ListeningEvent[] {
    return this.db.prepare<[string, number], { event: string }>('SELECT event FROM listening_events WHERE user_id = ? ORDER BY occurred_at DESC LIMIT ?').all(userId, limit).map((r) => JSON.parse(r.event) as ListeningEvent);
  }

  eventCount(userId: string): number {
    return this.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM listening_events WHERE user_id = ?').get(userId)?.n ?? 0;
  }

  deleteEvents(userId: string): number {
    return this.db.prepare('DELETE FROM listening_events WHERE user_id = ?').run(userId).changes;
  }

  purgeEvents(before: string): number {
    return this.db.prepare('DELETE FROM listening_events WHERE occurred_at < ?').run(before).changes;
  }

  /* ---- aggregate profiles ---- */
  putAggregate(ownerId: string, profile: AggregateTasteProfile, now: string): void {
    this.db.prepare('INSERT INTO aggregate_profiles (owner_id, profile, uploaded_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET profile = excluded.profile, uploaded_at = excluded.uploaded_at').run(ownerId, JSON.stringify(profile), now);
  }

  getAggregate(ownerId: string): AggregateTasteProfile | null {
    const r = this.db.prepare<[string], { profile: string }>('SELECT profile FROM aggregate_profiles WHERE owner_id = ?').get(ownerId);
    return r ? (JSON.parse(r.profile) as AggregateTasteProfile) : null;
  }

  deleteAggregate(ownerId: string): boolean {
    return this.db.prepare('DELETE FROM aggregate_profiles WHERE owner_id = ?').run(ownerId).changes > 0;
  }

  /* ---- recommendation feedback / seeds ---- */
  putFeedback(recommendationId: string, userId: string, feedback: RecommendationFeedback, now: string): void {
    this.db.prepare('INSERT INTO recommendation_feedback (recommendation_id, user_id, feedback, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(recommendation_id, user_id) DO UPDATE SET feedback = excluded.feedback, created_at = excluded.created_at').run(recommendationId, userId, feedback, now);
  }

  feedbackForUser(userId: string): Array<{ recommendationId: string; feedback: RecommendationFeedback }> {
    return this.db.prepare<[string], { recommendation_id: string; feedback: RecommendationFeedback }>('SELECT recommendation_id, feedback FROM recommendation_feedback WHERE user_id = ?').all(userId).map((r) => ({ recommendationId: r.recommendation_id, feedback: r.feedback }));
  }

  putSeeds(userId: string, seeds: { artists: string[]; genres: string[]; likedTrackIds: string[] }, now: string): void {
    this.db.prepare('INSERT INTO recommendation_seeds (user_id, artists, genres, liked_track_ids, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET artists = excluded.artists, genres = excluded.genres, liked_track_ids = excluded.liked_track_ids, updated_at = excluded.updated_at').run(userId, JSON.stringify(seeds.artists), JSON.stringify(seeds.genres), JSON.stringify(seeds.likedTrackIds), now);
  }

  getSeeds(userId: string): { artists: string[]; genres: string[]; likedTrackIds: string[] } | null {
    const r = this.db.prepare<[string], { artists: string; genres: string; liked_track_ids: string }>('SELECT artists, genres, liked_track_ids FROM recommendation_seeds WHERE user_id = ?').get(userId);
    return r ? { artists: JSON.parse(r.artists) as string[], genres: JSON.parse(r.genres) as string[], likedTrackIds: JSON.parse(r.liked_track_ids) as string[] } : null;
  }

  /* ---- discovery jobs ---- */
  enqueueJob(job: DiscoveryJob): void {
    this.db.prepare('INSERT INTO discovery_jobs (id, state, user_id, kind, priority, payload, attempts, next_run_at, created_at, updated_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(job.id, job.state, job.userId, job.kind, job.priority, JSON.stringify(job.payload), job.attempts, job.nextRunAt, job.createdAt, job.updatedAt, job.error);
  }

  claimDueJob(now: string): DiscoveryJob | undefined {
    return this.db.transaction(() => {
      const r = this.db.prepare<[string], DiscoveryJobRow>("SELECT * FROM discovery_jobs WHERE state = 'queued' AND next_run_at <= ? ORDER BY priority, next_run_at LIMIT 1").get(now);
      if (!r) return undefined;
      this.db.prepare("UPDATE discovery_jobs SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now, r.id);
      return toDiscoveryJob({ ...r, state: 'running', attempts: r.attempts + 1, updated_at: now });
    })();
  }

  finishJob(id: string, state: DiscoveryJob['state'], now: string, error: string | null, nextRunAt?: string): void {
    this.db.prepare('UPDATE discovery_jobs SET state = ?, updated_at = ?, error = ?, next_run_at = COALESCE(?, next_run_at) WHERE id = ?').run(state, now, error, nextRunAt ?? null, id);
  }

  recoverRunningJobs(now: string): number {
    return this.db.prepare("UPDATE discovery_jobs SET state = 'queued', updated_at = ? WHERE state = 'running'").run(now).changes;
  }

  jobCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare<[], { state: string; n: number }>('SELECT state, COUNT(*) AS n FROM discovery_jobs GROUP BY state').all()) out[r.state] = r.n;
    return out;
  }

  findJob(id: string): DiscoveryJob | undefined {
    const r = this.db.prepare<[string], DiscoveryJobRow>('SELECT * FROM discovery_jobs WHERE id = ?').get(id);
    return r ? toDiscoveryJob(r) : undefined;
  }

  /* ---- canonical catalogue ---- */
  upsertTrack(track: CanonicalTrack): void {
    this.db
      .prepare(
        'INSERT INTO canonical_tracks (id, musicbrainz_recording_id, isrc, title, normalized_title, artist_id, artist_name, normalized_artist, album_id, album_name, release_year, duration_ms, genres, tags, popularity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET musicbrainz_recording_id = COALESCE(excluded.musicbrainz_recording_id, canonical_tracks.musicbrainz_recording_id), isrc = COALESCE(excluded.isrc, canonical_tracks.isrc), title = excluded.title, normalized_title = excluded.normalized_title, artist_id = COALESCE(excluded.artist_id, canonical_tracks.artist_id), artist_name = excluded.artist_name, normalized_artist = excluded.normalized_artist, album_id = COALESCE(excluded.album_id, canonical_tracks.album_id), album_name = COALESCE(excluded.album_name, canonical_tracks.album_name), release_year = COALESCE(excluded.release_year, canonical_tracks.release_year), duration_ms = COALESCE(excluded.duration_ms, canonical_tracks.duration_ms), genres = excluded.genres, tags = excluded.tags, popularity = COALESCE(excluded.popularity, canonical_tracks.popularity), updated_at = excluded.updated_at',
      )
      .run(track.id, track.musicbrainzRecordingId, track.isrc, track.title, track.normalizedTitle, track.artistId, track.artistName, track.normalizedArtist, track.albumId, track.albumName, track.releaseYear, track.durationMs, JSON.stringify(track.genres), JSON.stringify(track.tags), track.popularity, track.createdAt, track.updatedAt);
  }

  findTrackById(id: string): CanonicalTrack | undefined {
    const r = this.db.prepare<[string], CanonicalTrackRow>('SELECT * FROM canonical_tracks WHERE id = ?').get(id);
    return r ? toCanonicalTrack(r) : undefined;
  }

  findTrackByMbid(mbid: string): CanonicalTrack | undefined {
    const r = this.db.prepare<[string], CanonicalTrackRow>('SELECT * FROM canonical_tracks WHERE musicbrainz_recording_id = ?').get(mbid);
    return r ? toCanonicalTrack(r) : undefined;
  }

  findTrackByIsrc(isrc: string): CanonicalTrack | undefined {
    const r = this.db.prepare<[string], CanonicalTrackRow>('SELECT * FROM canonical_tracks WHERE isrc = ?').get(isrc);
    return r ? toCanonicalTrack(r) : undefined;
  }

  /** Metadata match: same normalised artist and title. Duration is compared by the caller. */
  findTracksByNormalized(normalizedArtist: string, normalizedTitle: string): CanonicalTrack[] {
    return this.db.prepare<[string, string], CanonicalTrackRow>('SELECT * FROM canonical_tracks WHERE normalized_artist = ? AND normalized_title = ?').all(normalizedArtist, normalizedTitle).map(toCanonicalTrack);
  }

  findTrackByPlatform(provider: string, providerTrackId: string): CanonicalTrack | undefined {
    const r = this.db
      .prepare<[string, string], CanonicalTrackRow>('SELECT t.* FROM canonical_tracks t JOIN track_platforms p ON p.track_id = t.id WHERE p.provider = ? AND p.provider_track_id = ?')
      .get(provider, providerTrackId);
    return r ? toCanonicalTrack(r) : undefined;
  }

  listTracks(limit = 5000): CanonicalTrack[] {
    return this.db.prepare<[number], CanonicalTrackRow>('SELECT * FROM canonical_tracks ORDER BY updated_at DESC LIMIT ?').all(limit).map(toCanonicalTrack);
  }

  countTracks(): number {
    return this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM canonical_tracks').get()?.n ?? 0;
  }

  upsertArtist(artist: CanonicalArtist): void {
    this.db
      .prepare(
        'INSERT INTO canonical_artists (id, musicbrainz_artist_id, name, normalized_name, genres, tags, popularity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET musicbrainz_artist_id = COALESCE(excluded.musicbrainz_artist_id, canonical_artists.musicbrainz_artist_id), name = excluded.name, normalized_name = excluded.normalized_name, genres = excluded.genres, tags = excluded.tags, popularity = COALESCE(excluded.popularity, canonical_artists.popularity), updated_at = excluded.updated_at',
      )
      .run(artist.id, artist.musicbrainzArtistId, artist.name, artist.normalizedName, JSON.stringify(artist.genres), JSON.stringify(artist.tags), artist.popularity, artist.createdAt, artist.updatedAt);
  }

  findArtistByNormalized(normalizedName: string): CanonicalArtist | undefined {
    const r = this.db.prepare<[string], CanonicalArtistRow>('SELECT * FROM canonical_artists WHERE normalized_name = ?').get(normalizedName);
    return r ? toCanonicalArtist(r) : undefined;
  }

  listArtists(limit = 2000): CanonicalArtist[] {
    return this.db.prepare<[number], CanonicalArtistRow>('SELECT * FROM canonical_artists ORDER BY updated_at DESC LIMIT ?').all(limit).map(toCanonicalArtist);
  }

  putPlatform(p: TrackPlatform): void {
    this.db
      .prepare('INSERT INTO track_platforms (track_id, provider, provider_track_id, url, availability, last_verified_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(track_id, provider, provider_track_id) DO UPDATE SET url = COALESCE(excluded.url, track_platforms.url), availability = excluded.availability, last_verified_at = excluded.last_verified_at')
      .run(p.trackId, p.provider, p.providerTrackId, p.url, p.availability, p.lastVerifiedAt);
  }

  platformsFor(trackId: string): TrackPlatform[] {
    return this.db.prepare<[string], TrackPlatformRow>('SELECT * FROM track_platforms WHERE track_id = ? ORDER BY provider').all(trackId).map(toTrackPlatform);
  }

  allPlatforms(limit = 20_000): TrackPlatform[] {
    return this.db.prepare<[number], TrackPlatformRow>('SELECT * FROM track_platforms LIMIT ?').all(limit).map(toTrackPlatform);
  }

  putRelation(relation: ArtistRelation): void {
    this.db
      .prepare('INSERT INTO artist_relations (artist_id, related_artist_id, weight, source, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(artist_id, related_artist_id, source) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at')
      .run(relation.artistId, relation.relatedArtistId, relation.weight, relation.source, relation.updatedAt);
  }

  relationsFor(artistId: string): ArtistRelation[] {
    return this.db
      .prepare<[string], { artist_id: string; related_artist_id: string; weight: number; source: string; updated_at: string }>('SELECT * FROM artist_relations WHERE artist_id = ? ORDER BY weight DESC')
      .all(artistId)
      .map((r) => ({ artistId: r.artist_id, relatedArtistId: r.related_artist_id, weight: r.weight, source: r.source, updatedAt: r.updated_at }));
  }

  allRelations(limit = 20_000): ArtistRelation[] {
    return this.db
      .prepare<[number], { artist_id: string; related_artist_id: string; weight: number; source: string; updated_at: string }>('SELECT * FROM artist_relations LIMIT ?')
      .all(limit)
      .map((r) => ({ artistId: r.artist_id, relatedArtistId: r.related_artist_id, weight: r.weight, source: r.source, updatedAt: r.updated_at }));
  }

  /* ---- stored taste profiles ---- */
  putProfile(userId: string, profileJson: string, computedAt: string, eventCount: number): void {
    this.db.prepare('INSERT INTO taste_profiles (user_id, profile, computed_at, event_count) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET profile = excluded.profile, computed_at = excluded.computed_at, event_count = excluded.event_count').run(userId, profileJson, computedAt, eventCount);
  }

  getProfile(userId: string): { profile: string; computedAt: string; eventCount: number } | null {
    const r = this.db.prepare<[string], { profile: string; computed_at: string; event_count: number }>('SELECT profile, computed_at, event_count FROM taste_profiles WHERE user_id = ?').get(userId);
    return r ? { profile: r.profile, computedAt: r.computed_at, eventCount: r.event_count } : null;
  }

  deleteProfile(userId: string): boolean {
    return this.db.prepare('DELETE FROM taste_profiles WHERE user_id = ?').run(userId).changes > 0;
  }

  usersWithEvents(): string[] {
    return this.db.prepare<[], { user_id: string }>('SELECT DISTINCT user_id FROM listening_events').all().map((r) => r.user_id);
  }

  /* ---- discovery cache ---- */
  cacheGet(key: string): { results: unknown[]; createdAt: string; expiresAt: string } | undefined {
    const r = this.db.prepare<[string], { results: string; created_at: string; expires_at: string }>('SELECT results, created_at, expires_at FROM discovery_cache WHERE key = ?').get(key);
    if (!r) return undefined;
    this.db.prepare('UPDATE discovery_cache SET hits = hits + 1 WHERE key = ?').run(key);
    return { results: JSON.parse(r.results) as unknown[], createdAt: r.created_at, expiresAt: r.expires_at };
  }

  cachePut(key: string, provider: string, query: string, results: unknown[], createdAt: string, expiresAt: string): void {
    this.db.prepare('INSERT INTO discovery_cache (key, provider, query, results, created_at, expires_at, hits) VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT(key) DO UPDATE SET results = excluded.results, created_at = excluded.created_at, expires_at = excluded.expires_at').run(key, provider, query, JSON.stringify(results), createdAt, expiresAt);
  }

  cachePurge(before: string): number {
    return this.db.prepare('DELETE FROM discovery_cache WHERE expires_at < ?').run(before).changes;
  }
}

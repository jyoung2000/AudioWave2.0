import { cleanVideoTitle, normalizeArtist, normalizeText, splitFeatured } from '@now-playing/domain';
import type { MbRecordingDetail, MusicBrainzAdapter } from '../providers/adapters/musicbrainz.js';
import type { Priority, RateLimitManager } from '../providers/rate-limit-manager.js';

export interface MatchInput {
  title: string;
  artistName: string | null;
  channelName?: string | null;
  durationMs: number | null;
  isrc: string | null;
  musicbrainzRecordingId: string | null;
  provider: string;
}

export interface Match {
  recording: MbRecordingDetail;
  confidence: number;
  via: 'isrc' | 'mbid' | 'title';
  cleaned: { title: string; artist: string | null; featured: string[] };
}

const DURATION_GATE_MS = 3000;
const DURATION_TIGHT_MS = 1500;

/**
 * Which MusicBrainz recording a result is. By the id a file already carries, by ISRC when there is
 * one (a code, not a guess), and only then by name — and a name match is thrown away unless the
 * length agrees to three seconds and the artist is the same artist. Nothing here returns "probably",
 * and a provider that fails is a thrown error, not a "no match": the job retries later.
 */
export class RecordingMatcher {
  constructor(
    private readonly mb: MusicBrainzAdapter,
    private readonly limiter: RateLimitManager,
    private readonly priority: Priority = 'P2',
  ) {}

  private run<T>(fn: () => Promise<T>): Promise<T> {
    return this.limiter.run('musicbrainz', this.priority, fn, { timeoutMs: 15_000 });
  }

  async match(input: MatchInput): Promise<Match | null> {
    const cleaned = input.provider === 'youtube'
      ? cleanVideoTitle({ title: input.title, channel: input.channelName ?? input.artistName ?? null })
      : { ...splitFeatured(input.title), artist: null as string | null, fromTopicChannel: false };
    const artist = cleaned.artist ?? input.artistName;
    const cleanedOut = { title: cleaned.title, artist, featured: cleaned.featured };

    if (input.musicbrainzRecordingId) {
      const r = await this.run(() => this.mb.recordingDetail(input.musicbrainzRecordingId!));
      if (r) return { recording: r, confidence: 1, via: 'mbid', cleaned: cleanedOut };
    }
    if (input.isrc) {
      const hits = await this.run(() => this.mb.recordingsByIsrc(input.isrc!));
      if (hits[0]) return { recording: hits[0], confidence: 0.95, via: 'isrc', cleaned: cleanedOut };
    }
    if (!artist || !cleaned.title) return null;

    const hits = await this.run(() => this.mb.searchRecordings(cleaned.title, artist));
    const wantArtist = normalizeArtist(artist);
    const wantTitle = normalizeText(cleaned.title);
    for (const r of hits) {
      if (normalizeArtist(r.artistName) !== wantArtist) continue;
      if (normalizeText(r.title) !== wantTitle) continue;
      const delta = input.durationMs !== null && r.lengthMs !== null ? Math.abs(r.lengthMs - input.durationMs) : null;
      if (delta !== null && delta > DURATION_GATE_MS) continue;
      const tight = delta !== null && delta <= DURATION_TIGHT_MS;
      return { recording: r, confidence: 0.8 + (tight ? 0.2 : 0), via: 'title', cleaned: cleanedOut };
    }
    return null;
  }
}

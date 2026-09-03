import type { ListeningEvent } from '@now-playing/contracts';
import { seededRandom } from '@now-playing/domain';

export interface FixtureEventOptions {
  deviceId: string;
  days?: number;
  seed?: number;
  startAt?: string;
}

const CATALOG = [
  { title: 'Ember Line', artistName: 'Fennel Grove', albumName: 'Long Wave Sessions', genre: 'Ambient', year: 2019, durationMs: 214_000 },
  { title: 'Slow Carousel', artistName: 'Fennel Grove', albumName: 'Long Wave Sessions', genre: 'Ambient', year: 2019, durationMs: 262_000 },
  { title: 'Signal Fade', artistName: 'Cassette Bloom', albumName: 'Live from Pier 9', genre: 'Indie', year: 2021, durationMs: 233_000 },
  { title: 'Harbour Lights', artistName: 'Cassette Bloom', albumName: 'Live from Pier 9', genre: 'Indie', year: 2021, durationMs: 251_000 },
  { title: 'Copper Meridian', artistName: 'Orbital Cartographers', albumName: 'Copper Meridian', genre: 'Electronic', year: 2018, durationMs: 305_000 },
  { title: 'Glass Hour', artistName: 'Orbital Cartographers', albumName: 'Copper Meridian', genre: 'Electronic', year: 2018, durationMs: 187_000 },
  { title: 'Quiet Arithmetic', artistName: 'Marlow & the Tidewater', albumName: 'Quiet Arithmetic', genre: 'Folk', year: 2015, durationMs: 276_000 },
  { title: 'Lantern Road', artistName: 'Marlow & the Tidewater', albumName: 'Quiet Arithmetic', genre: 'Folk', year: 2015, durationMs: 198_000 },
  { title: 'Nine Below', artistName: 'Cassette Bloom', albumName: 'Tideline', genre: 'Indie', year: 2023, durationMs: 204_000 },
  { title: 'Static Bloom', artistName: 'Velvet Antenna', albumName: 'Static Bloom', genre: 'Shoegaze', year: 2012, durationMs: 289_000 },
];

function id(seedIdx: number, n: number): string {
  const hex = (seedIdx * 1_000_003 + n).toString(16).padStart(12, '0').slice(-12);
  return `0192b1f0-0000-7000-8000-${hex}`;
}

/** Deterministic listening history: sessions of 2–6 plays per day, skips concentrated on one artist, replays and likes on another. */
export function generateListeningEvents(options: FixtureEventOptions): ListeningEvent[] {
  const days = options.days ?? 21;
  const rnd = seededRandom(options.seed ?? 7);
  const start = Date.parse(options.startAt ?? '2026-08-01T00:00:00.000Z');
  const events: ListeningEvent[] = [];
  let n = 0;
  const trackIds = CATALOG.map((_, i) => id(1, i + 1));
  for (let d = 0; d < days; d += 1) {
    const sessionId = id(2, d + 1);
    const hour = 8 + Math.floor(rnd() * 14);
    let t = start + d * 86_400_000 + hour * 3_600_000;
    const plays = 2 + Math.floor(rnd() * 5);
    for (let p = 0; p < plays; p += 1) {
      const ti = Math.floor(rnd() * CATALOG.length);
      const c = CATALOG[ti]!;
      const base = (type: ListeningEvent['type'], at: number, extra: Partial<ListeningEvent> = {}): ListeningEvent => ({ id: id(3, (n += 1)), schemaVersion: 1, type, occurredAt: new Date(at).toISOString(), sessionId, deviceId: options.deviceId, mode: 'solo', groupId: null, trackId: trackIds[ti]!, track: { title: c.title, artistName: c.artistName, artistId: null, albumName: c.albumName, albumId: null, genre: c.genre, tags: [], year: c.year, durationMs: c.durationMs, provider: 'local', popularity: null }, positionMs: null, secondsPlayed: null, completionPercent: null, reason: null, playlistId: null, presetId: null, recommendationId: null, contextKind: 'manual', contextId: null, mood: null, activity: null, ...extra });
      events.push(base('started', t));
      const skipsThisArtist = c.artistName === 'Velvet Antenna' && rnd() < 0.8;
      if (skipsThisArtist) {
        events.push(base('skipped', t + 6000, { secondsPlayed: 6, positionMs: 6000, reason: 'user' }));
        t += 8000;
        continue;
      }
      events.push(base('meaningful', t + 31_000, { secondsPlayed: 31 }));
      const completes = rnd() < 0.85;
      if (completes) {
        events.push(base('completed', t + c.durationMs, { secondsPlayed: c.durationMs / 1000, completionPercent: 100 }));
        if (c.artistName === 'Orbital Cartographers' && rnd() < 0.5) events.push(base('replayed', t + c.durationMs + 500));
        if (c.artistName === 'Orbital Cartographers' && rnd() < 0.3) events.push(base('liked', t + c.durationMs + 700));
        t += c.durationMs + 2000;
      } else {
        const at = Math.floor(c.durationMs * (0.3 + rnd() * 0.5));
        events.push(base('skipped', t + at, { secondsPlayed: at / 1000, positionMs: at, completionPercent: Math.round((at / c.durationMs) * 100), reason: 'user' }));
        t += at + 2000;
      }
    }
  }
  return events;
}

export const FIXTURE_CATALOG = CATALOG;

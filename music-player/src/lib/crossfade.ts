/**
 * The crossfade preference, and the one rule that overrides it.
 *
 * iTunes offered a checkbox and a slider from one to twelve seconds; this is the same control.
 * The rule: songs from one album play back to back without a fade, because a live recording or a
 * concept album is a single piece of music that a crossfade would chop up. It is on by default and
 * can be turned off.
 */
import type { TrackRef } from '@now-playing/contracts';
import { MAX_CROSSFADE_SECONDS } from './playback.js';

export interface CrossfadeSettings {
  enabled: boolean;
  /** Overlap between one song and the next, in whole seconds, 1–12. Kept while disabled. */
  seconds: number;
  /** Do not crossfade between two songs of the same album. */
  sameAlbumGapless: boolean;
}

export const DEFAULT_CROSSFADE: CrossfadeSettings = Object.freeze({ enabled: false, seconds: 5, sameAlbumGapless: true });

/** Accept whatever was stored and return a valid setting; anything malformed falls back to the default. */
export function normalizeCrossfade(value: unknown): CrossfadeSettings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_CROSSFADE };
  const raw = value as Partial<Record<keyof CrossfadeSettings, unknown>>;
  const seconds = typeof raw.seconds === 'number' && Number.isFinite(raw.seconds) ? Math.round(Math.max(1, Math.min(MAX_CROSSFADE_SECONDS, raw.seconds))) : DEFAULT_CROSSFADE.seconds;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CROSSFADE.enabled,
    seconds,
    sameAlbumGapless: typeof raw.sameAlbumGapless === 'boolean' ? raw.sameAlbumGapless : DEFAULT_CROSSFADE.sameAlbumGapless,
  };
}

/** Whether two tracks belong to the same album: same artist and the same, non-empty, album name. */
export function sameAlbum(a: Pick<TrackRef, 'artistName' | 'albumName'>, b: Pick<TrackRef, 'artistName' | 'albumName'>): boolean {
  if (!a.albumName || !b.albumName) return false;
  return a.artistName.trim().toLowerCase() === b.artistName.trim().toLowerCase() && a.albumName.trim().toLowerCase() === b.albumName.trim().toLowerCase();
}

/**
 * How long the handover from `from` to `to` should overlap, in milliseconds. 0 means a plain cut:
 * crossfading is off, nothing is playing yet, or both songs are from the same album and the
 * gapless rule applies. A song fading into itself (repeat one) is allowed.
 */
export function crossfadeMsBetween(settings: CrossfadeSettings, from: TrackRef | null, to: TrackRef): number {
  if (!settings.enabled || settings.seconds <= 0 || !from) return 0;
  if (settings.sameAlbumGapless && from.trackId !== to.trackId && sameAlbum(from, to)) return 0;
  return Math.round(settings.seconds) * 1000;
}

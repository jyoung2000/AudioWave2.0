/**
 * Operating-system media integration: lock screen, notification, headset buttons, and the car.
 *
 * ## What this actually gets you in a car
 *
 * The Media Session API is what Android Auto, CarPlay and Bluetooth head units read. When the
 * player is running — installed as a PWA or open in a tab — and audio is playing, this makes the
 * title, artist, album and artwork appear on the car's screen, and makes its buttons work.
 *
 * What it does **not** do, and the UI says so rather than implying otherwise
 * (docs/PWA_AND_CAR.md): a PWA cannot appear as an app icon on the Android Auto or CarPlay home
 * screen. Those launchers only list native apps built against the car app libraries and shipped
 * through the Play Store or App Store. There is no web API that changes this, and no configuration
 * here can. What works is: start playback on the phone, then the car controls it — which is exactly
 * how a phone's own music app behaves over Bluetooth.
 *
 * Everything here is feature-detected. A browser without Media Session simply gets no integration
 * and nothing breaks.
 */
import type { TrackRef } from '@now-playing/contracts';

export interface MediaSessionHandlers {
  play(): void | Promise<void>;
  pause(): void;
  previous(): void | Promise<void>;
  next(): void | Promise<void>;
  seekTo(positionMs: number): void;
  seekBy(offsetSeconds: number): void;
  stop(): void;
  like?: (() => void) | undefined;
}

export function mediaSessionSupported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

/**
 * Describe what the car, lock screen and headset can do here, honestly. Used by the settings screen
 * so someone can see why their steering-wheel button does or does not work before getting in a car.
 */
export function mediaIntegrationReport(): { supported: boolean; features: Array<{ name: string; available: boolean; note: string }> } {
  const supported = mediaSessionSupported();
  const hasHandler = (action: string): boolean => {
    if (!supported) return false;
    try {
      navigator.mediaSession.setActionHandler(action as MediaSessionAction, null);
      return true;
    } catch {
      // The browser rejects actions it does not implement, which is how support is detected.
      return false;
    }
  };
  return {
    supported,
    features: [
      { name: 'Track information on the lock screen and in the car', available: supported, note: supported ? 'Title, artist, album and artwork are published while audio is playing.' : 'This browser has no Media Session support, so nothing is published.' },
      { name: 'Play, pause, next and previous from car and headset buttons', available: hasHandler('play'), note: hasHandler('play') ? 'Handled by the player.' : 'Not available in this browser.' },
      { name: 'Scrubbing from the car display', available: hasHandler('seekto'), note: hasHandler('seekto') ? 'The car can seek within the current track.' : 'This browser does not support seeking from the media controls.' },
      { name: 'An app tile on the Android Auto or CarPlay home screen', available: false, note: 'Not possible for any web app. Those launchers list only native apps built with the car app libraries. Start playback on your phone and the car will control it, the same as any other Bluetooth audio source.' },
    ],
  };
}

/**
 * Publish the current track. Artwork is passed as a blob URL the caller owns — this module never
 * fetches anything, so a car display can never cause a network request the listener did not make.
 */
export function publishMetadata(track: TrackRef | null, artworkUrl: string | null): void {
  if (!mediaSessionSupported()) return;
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artistName,
    album: track.albumName ?? '',
    artwork: artworkUrl ? [{ src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
  });
}

export function publishPlaybackState(status: 'playing' | 'paused' | 'none'): void {
  if (!mediaSessionSupported()) return;
  navigator.mediaSession.playbackState = status;
}

/**
 * Publish the position so the car's progress bar tracks the audio. Browsers throw on out-of-range
 * values, which would otherwise leave the car showing a stuck bar.
 */
export function publishPosition(positionMs: number, durationMs: number | null, playbackRate = 1): void {
  if (!mediaSessionSupported() || !navigator.mediaSession.setPositionState) return;
  if (durationMs === null || durationMs <= 0) return;
  const duration = durationMs / 1000;
  const position = Math.max(0, Math.min(positionMs / 1000, duration));
  try {
    navigator.mediaSession.setPositionState({ duration, position, playbackRate });
  } catch {
    // A rate of 0 or a position past the end: not worth surfacing, the next tick corrects it.
  }
}

/** Install the action handlers. Returns a function that removes them again. */
export function installHandlers(handlers: MediaSessionHandlers): () => void {
  if (!mediaSessionSupported()) return () => undefined;
  const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // An action this browser does not know about; the others still install.
    }
  };

  set('play', () => void handlers.play());
  set('pause', () => handlers.pause());
  set('stop', () => handlers.stop());
  set('previoustrack', () => void handlers.previous());
  set('nexttrack', () => void handlers.next());
  set('seekbackward', (details) => handlers.seekBy(-(details.seekOffset ?? 10)));
  set('seekforward', (details) => handlers.seekBy(details.seekOffset ?? 10));
  set('seekto', (details) => {
    if (typeof details.seekTime === 'number') handlers.seekTo(details.seekTime * 1000);
  });

  return () => {
    for (const action of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'] as const) set(action, null);
  };
}

/**
 * Media-element helpers: deciding whether an element may enter the graph at all, and applying
 * playback-rate / pitch-preservation flags (including vendor-prefixed variants) for retune.
 */
import type { RetunableMediaElement } from './types.js';

export const DSP_UNAVAILABLE_REASON = 'EQ unavailable for this source';

const LOCAL_PROTOCOLS = new Set(['blob:', 'data:', 'file:', 'mediastream:', 'filesystem:', 'about:']);

/** The page origin, when running in a window (undefined in workers / Node). */
export function currentPageOrigin(): string | null {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return typeof loc?.origin === 'string' ? loc.origin : null;
}

/**
 * A `MediaElementAudioSourceNode` for a cross-origin resource fetched without CORS outputs
 * silence once created, and the element's own output is rerouted into the graph — so the user
 * hears nothing. Detect that case *before* creating the node so the element keeps playing.
 *
 * Optimistic where it cannot know (no src yet, unknown page origin, or `crossOrigin` set).
 */
export function isCrossOriginWithoutCors(element: RetunableMediaElement, pageOrigin: string | null): boolean {
  if (element.srcObject) return false;
  if (element.crossOrigin !== null && element.crossOrigin !== undefined) return false;
  const src = element.currentSrc || element.src || '';
  if (!src) return false;
  let url: URL;
  try {
    url = pageOrigin ? new URL(src, pageOrigin) : new URL(src);
  } catch {
    return false;
  }
  if (LOCAL_PROTOCOLS.has(url.protocol)) {
    if (url.protocol === 'blob:' && pageOrigin) {
      // blob:https://origin/uuid — the embedded origin is the owner.
      try {
        return new URL(url.pathname).origin !== pageOrigin && new URL(url.pathname).origin !== 'null';
      } catch {
        return false;
      }
    }
    return false;
  }
  if (!pageOrigin || pageOrigin === 'null') return false;
  return url.origin !== pageOrigin;
}

function setFlag(element: RetunableMediaElement, key: 'preservesPitch' | 'webkitPreservesPitch' | 'mozPreservesPitch', value: boolean): void {
  if (key in element) element[key] = value;
}

/** Set `preservesPitch` and whichever vendor-prefixed twins the element exposes. */
export function setPreservesPitch(element: RetunableMediaElement, value: boolean): void {
  if (!('preservesPitch' in element) && !('webkitPreservesPitch' in element) && !('mozPreservesPitch' in element)) {
    element.preservesPitch = value;
    return;
  }
  setFlag(element, 'preservesPitch', value);
  setFlag(element, 'webkitPreservesPitch', value);
  setFlag(element, 'mozPreservesPitch', value);
}

export function setPlaybackRate(element: RetunableMediaElement, rate: number): void {
  if (element.playbackRate !== rate) element.playbackRate = rate;
}

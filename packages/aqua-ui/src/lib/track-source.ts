/**
 * Where a track's bytes are, in the sixteen pixels the list has room for — and whether they are
 * here.
 *
 * The reference's list has a platform column and a download key. Its rows are demo data, so both
 * are decorations there. These are real files, so both say something true: the mark names the
 * source and links to it only when a provider gave a URL to link to, and the offline key reports
 * whether the track can actually play with the network off. Neither pretends to an action the app
 * cannot take.
 */
import type { Track, TrackRef } from '@now-playing/contracts';
import { initialsFrom, markFor } from '../icons/provider-marks.js';

type Locatable = Pick<Track, 'locators' | 'title'> | Pick<TrackRef, 'locators' | 'title'>;

export interface TrackSource {
  /** Provider slug, so the row can draw that platform's mark. */
  provider: string;
  initials: string;
  name: string;
  href: string | null;
}

export function sourceOf(track: Locatable): TrackSource {
  const provider = track.locators.find((l) => l.kind === 'provider');
  if (provider && provider.kind === 'provider') {
    const known = markFor(provider.provider);
    return { provider: provider.provider, initials: known.initials || initialsFrom(provider.provider), name: known.name, href: provider.canonicalUrl ?? null };
  }
  if (track.locators.some((l) => l.kind === 'hub-blob')) return { provider: 'hub', initials: 'H', name: 'Streamed from your hub', href: null };
  return { provider: 'local', initials: 'L', name: 'A file on this device', href: null };
}

export interface TrackOfflineState {
  offline: boolean;
  reason: string;
}

/**
 * @param ephemeral True when the file came from the one-shot picker and cannot be reopened. It is
 *   not derivable from the track — a picked file carries the same locator as a scanned one — so the
 *   caller passes it from the library's own record of which files those are.
 */
export function offlineOf(track: Locatable, ephemeral = false): TrackOfflineState {
  if (ephemeral) {
    return { offline: false, reason: `${track.title} was added with the file picker, so it is gone after a reload. Add its folder to keep it.` };
  }
  if (track.locators.some((l) => l.kind === 'browser-handle' || l.kind === 'opfs' || l.kind === 'windows-file')) {
    return { offline: true, reason: `${track.title} is already on this device — there is nothing to download.` };
  }
  if (track.locators.some((l) => l.kind === 'hub-blob')) {
    return { offline: false, reason: `${track.title} streams from your hub, so it needs the hub to be reachable. This player does not keep its own copy.` };
  }
  return { offline: false, reason: `${track.title} has no file this player can reach.` };
}

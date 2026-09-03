import type { CapabilityKey, CapabilityState, ProviderCapabilities } from '@now-playing/contracts';

export type TrackAction = 'preview' | 'play' | 'add-to-solo-queue' | 'add-to-group-queue' | 'add-to-playlist' | 'open-at-source' | 'download' | 'import';

export interface ActionAvailability {
  action: TrackAction;
  enabled: boolean;
  state: CapabilityState | 'n/a';
  why: string | null;
}

const STATE_TEXT: Record<CapabilityState, string> = {
  available: 'Available',
  requires_auth: 'Sign in to this provider to use it',
  restricted: 'The provider restricts this for this item',
  unsupported: 'The provider does not permit this',
  temporarily_unavailable: 'Temporarily unavailable; try again later',
};

export function whyUnavailable(capabilities: ProviderCapabilities, key: CapabilityKey): string | null {
  const state = capabilities[key];
  if (state === 'available') return null;
  return capabilities.reason ? `${STATE_TEXT[state]} — ${capabilities.reason}` : STATE_TEXT[state];
}

/** Derive UI actions from capability state only. Never infers download permission from a stream URL. */
export function actionsFor(capabilities: ProviderCapabilities, context: { hasCanonicalUrl: boolean; hubConnected: boolean; inGroup: boolean }): ActionAvailability[] {
  const cap = (key: CapabilityKey): CapabilityState => capabilities[key];
  const item = (action: TrackAction, key: CapabilityKey | null, extra?: { enabled?: boolean; why?: string | null }): ActionAvailability => {
    const state: CapabilityState | 'n/a' = key ? cap(key) : 'n/a';
    const enabled = extra?.enabled ?? (key ? state === 'available' : true);
    const why = extra?.why !== undefined ? extra.why : key ? whyUnavailable(capabilities, key) : null;
    return { action, enabled, state, why: enabled ? null : why };
  };
  const downloadKey: CapabilityKey | null = cap('userOwnedDownload') === 'available' ? 'userOwnedDownload' : cap('creatorDownload') === 'available' ? 'creatorDownload' : 'creatorDownload';
  return [
    item('preview', 'preview'),
    item('play', 'playback'),
    item('add-to-solo-queue', 'playback'),
    item('add-to-group-queue', 'playback', { enabled: cap('playback') === 'available' && context.hubConnected && context.inGroup && capabilities.groupSync !== 'unsupported', why: !context.hubConnected ? 'Connect to a hub to use Group mode' : !context.inGroup ? 'Join a group first' : capabilities.groupSync === 'unsupported' ? 'This source cannot be synchronised in a group' : whyUnavailable(capabilities, 'playback') }),
    item('add-to-playlist', 'metadata'),
    item('open-at-source', null, { enabled: context.hasCanonicalUrl, why: context.hasCanonicalUrl ? null : 'No canonical link is available' }),
    item('download', downloadKey),
    item('import', 'importLikes'),
  ];
}

export function syncGradeText(grade: ProviderCapabilities['groupSync']): string {
  switch (grade) {
    case 'exact': return 'Exact sync — everyone plays the same seekable file';
    case 'near': return 'Near sync — same representation with small timing differences';
    case 'best_effort': return 'Best effort — start times are aligned but sources may drift';
    default: return 'Not synchronised — this source cannot be aligned across listeners';
  }
}

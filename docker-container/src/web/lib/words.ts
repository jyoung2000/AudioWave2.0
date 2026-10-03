/**
 * The hub's vocabulary: every identifier the API speaks, said as a person would.
 *
 * Statuses read as words, permissions have plain labels (the scope id stays beside them as the
 * small mono suffix the design shows), and nothing on screen is an enum value. One file, so the
 * same thing is called the same thing on every tab.
 */
import type { ProviderCapabilities, ProviderDescriptor, ProviderHealth, Scope } from '@now-playing/contracts';
import type { DotKind } from '../ui.js';

/** Permission labels, in the order the pairing form lists them. */
export const SCOPE_LABELS: ReadonlyArray<readonly [Scope, string]> = [
  ['library:read', 'Browse the library'],
  ['search:use', 'Search'],
  ['playlists:sync', 'Sync playlists'],
  ['eq:sync', 'Sync EQ presets'],
  ['history:aggregate', 'Send listening totals'],
  ['history:events', 'Send each play'],
  ['group:member', 'Join groups'],
  ['group:admin', 'Run groups'],
  ['downloads:request', 'Ask for downloads'],
  ['transfers:receive', 'Receive files'],
  ['files:serve', 'Serve its own files'],
  ['library:share', 'Share from the library'],
  ['shares:create', 'Create shared links'],
  ['profile:read', 'See people’s profiles'],
  ['profile:write', 'Have a profile of its own'],
  ['backup:read', 'Read its backups'],
];

export const DEVICE_KINDS: Record<string, string> = { player: 'Player', companion: 'Windows companion', hub: 'Hub' };

export const PROVIDER_STATUS: Record<ProviderHealth['status'], { dot: DotKind; word: string }> = {
  ok: { dot: 'ok', word: 'Working' },
  degraded: { dot: 'warn', word: 'Limited' },
  unconfigured: { dot: 'bad', word: 'Needs setting up' },
  disabled: { dot: 'off', word: 'Off' },
  down: { dot: 'bad', word: 'Down' },
};

export const PROVIDER_ROLES: Record<ProviderDescriptor['role'], string> = {
  'audio-source': 'Audio source',
  'metadata-only': 'Metadata only',
  library: 'Library',
  tool: 'Tool',
};

export type CapLevel = 'yes' | 'part' | 'no';

const CAP_LEVEL: Record<string, CapLevel> = {
  available: 'yes',
  requires_auth: 'part',
  restricted: 'part',
  temporarily_unavailable: 'part',
  unsupported: 'no',
  // group sync grades
  exact: 'yes',
  near: 'yes',
  best_effort: 'part',
};

export const CAP_WORDS: Record<string, string> = {
  available: 'yes',
  requires_auth: 'after signing in',
  restricted: 'partly',
  temporarily_unavailable: 'not right now',
  unsupported: 'no',
  exact: 'exactly in step',
  near: 'nearly in step',
  best_effort: 'best effort',
};

export function capLevel(state: string): CapLevel {
  return CAP_LEVEL[state] ?? 'no';
}

/** The four chips the providers table shows, as the design has them. */
export function headlineCaps(caps: ProviderCapabilities): Array<{ label: string; state: string }> {
  const order: CapLevel[] = ['yes', 'part', 'no'];
  const best = [caps.creatorDownload, caps.userOwnedDownload].sort((a, b) => order.indexOf(capLevel(a)) - order.indexOf(capLevel(b)))[0]!;
  return [
    { label: 'Search', state: caps.search },
    { label: 'Stream', state: caps.playback },
    { label: 'Group sync', state: caps.groupSync },
    { label: 'Download', state: best },
  ];
}

export const CAPABILITY_LABELS: ReadonlyArray<readonly [keyof ProviderCapabilities, string]> = [
  ['metadata', 'Look up details'],
  ['search', 'Search'],
  ['preview', 'Preview'],
  ['playback', 'Stream'],
  ['importLikes', 'Import likes'],
  ['importPlaylists', 'Import playlists'],
  ['creatorDownload', 'Downloads the artist allows'],
  ['userOwnedDownload', 'Downloads of what you own'],
  ['groupSync', 'Group sync'],
  ['eq', 'Equalizer'],
];

export const SYNC_GRADES: Record<string, { dot: 'ok' | 'warn'; word: string }> = {
  exact: { dot: 'ok', word: 'exact' },
  near: { dot: 'ok', word: 'near' },
  best_effort: { dot: 'warn', word: 'best effort' },
  unsupported: { dot: 'warn', word: 'not in step' },
};

export const GROUP_ROLES: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };

/** "sentence case" → "Sentence case", for values that are already words. */
export function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

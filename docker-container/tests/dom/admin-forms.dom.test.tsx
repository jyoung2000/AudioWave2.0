/**
 * The admin window's forms, rendered: Discord, Backup, Recommendations and Network each load what
 * the hub has, check what was typed before sending it, send only on Save, and say in a sentence
 * when the hub refuses. Shared links make a link from the hub's own playlists and albums; provider
 * details open under their own row and close with Escape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BackupView } from '../../src/web/views/Backup.js';
import { DiscordView } from '../../src/web/views/Discord.js';
import { NetworkView } from '../../src/web/views/Network.js';
import { ProvidersView } from '../../src/web/views/Providers.js';
import { RecommendationsView } from '../../src/web/views/Recommendations.js';
import { SharesView } from '../../src/web/views/Shares.js';

type Answer = { status?: number; body: unknown } | ((init: RequestInit | undefined) => { status?: number; body: unknown });

/** A fake hub: `"GET /backup/settings"` → answer. Longest matching path wins. */
function fakeHub(routes: Record<string, Answer>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, 'http://hub.test').pathname.replace(/^\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes)
      .filter((k) => k.split(' ')[0] === method && path === k.split(' ')[1])
      .sort((a, b) => b.length - a.length)[0];
    const answer = key ? routes[key]! : { status: 404, body: { detail: 'Not found' } };
    const { status = 200, body } = typeof answer === 'function' ? answer(init) : answer;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, sent: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

const refused = (detail: string): Answer => ({ status: 400, body: { status: 400, code: 'validation', detail } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/* ------------------------------------------------------------------ Discord */

const DISCORD_CONFIG = { enabled: true, guildAllowlist: [], prefix: '!', prefixEnabled: true, djRoleIds: [], adminRoleIds: [], defaultGroupId: null, autoPostNowPlaying: true, updateInsteadOfSpam: true, tokenLast4: 'abcd', tokenSource: 'encrypted', applicationId: '1' };
const DISCORD_STATUS = {
  enabled: true,
  configured: true,
  gateway: 'stopped',
  voice: 'idle',
  commandsRegistered: false,
  commandsRegisteredAt: null,
  messageContentIntent: 'unknown',
  latencyMs: null,
  reconnects: 0,
  errors: 0,
  uptimeSeconds: 0,
  currentGuildId: null,
  currentVoiceChannelId: null,
  currentTrackTitle: null,
  lastError: null,
  warnings: ['The bot answers in every server it is invited to. To limit it, list server IDs in Server allowlist.'],
};
const DISCORD: Record<string, Answer> = {
  'GET /discord/config': { body: DISCORD_CONFIG },
  'GET /discord/status': { body: DISCORD_STATUS },
  'GET /discord/invite-url': { body: { url: null, permissions: '0', scopes: ['bot'], reason: 'Save a bot token first. The invite link is made from it.' } },
  'GET /groups': { body: { items: [{ id: 'g1', name: 'Living Room', status: 'active' }] } },
  'PUT /discord/config': { body: DISCORD_CONFIG },
  'POST /discord/actions/start': { body: DISCORD_STATUS },
};

describe('Discord form', () => {
  it('loads what the hub has and shows its warnings as plain sentences', async () => {
    fakeHub(DISCORD);
    render(<DiscordView />);
    expect(await screen.findByText(/list server IDs in Server allowlist/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/`|guild/i);
    expect((screen.getByLabelText('Prefix:') as HTMLInputElement).value).toBe('!');
  });

  it('checks server IDs before sending anything', async () => {
    const hub = fakeHub(DISCORD);
    render(<DiscordView />);
    await userEvent.type(await screen.findByLabelText('Server allowlist:'), 'my server');
    await userEvent.click(screen.getByRole('button', { name: 'Save and Start' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Server IDs are numbers. Right-click a server in Discord and choose Copy Server ID.');
    expect(hub.sent('PUT', '/discord/config')).toHaveLength(0);
  });

  it('saves the edited settings, then starts the bot', async () => {
    const hub = fakeHub(DISCORD);
    render(<DiscordView />);
    await userEvent.type(await screen.findByLabelText('Server allowlist:'), '112233445566778899');
    await userEvent.selectOptions(screen.getByLabelText('Group it controls:'), 'g1');
    await userEvent.click(screen.getByRole('button', { name: 'Save and Start' }));
    await waitFor(() => expect(hub.sent('POST', '/discord/actions/start')).toHaveLength(1));
    expect(hub.sent('PUT', '/discord/config')[0]!.body).toMatchObject({ guildAllowlist: ['112233445566778899'], defaultGroupId: 'g1', enabled: true });
  });

  it('says what the hub said when it refuses', async () => {
    fakeHub({ ...DISCORD, 'PUT /discord/config': refused('That server isn’t on this hub’s server allowlist.') });
    render(<DiscordView />);
    await userEvent.type(await screen.findByLabelText('Server allowlist:'), '112233445566778899');
    await userEvent.click(screen.getByRole('button', { name: 'Save and Start' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That server isn’t on this hub’s server allowlist.');
  });
});

/* ------------------------------------------------------------------ Backup */

const BACKUP_SETTINGS = {
  location: 'backups',
  include: { credentials: true, activity: true, caches: true },
  schedule: { frequency: 'daily', time: '03:00', weekday: 0 },
  keep: 10,
  path: '/data/backups',
  dataDir: '/data',
  locationFixed: false,
  nextRunAt: '2026-01-02T03:00:00.000Z',
  lastRunAt: null,
};
const BACKUP: Record<string, Answer> = {
  'GET /backup/settings': { body: BACKUP_SETTINGS },
  'GET /backup/space': { body: { path: '/data/backups', freeBytes: 10_000_000, totalBytes: 20_000_000, lastArchiveBytes: 1000, keep: 10 } },
  'GET /backup': { body: { items: [{ id: 'backup-20260101T030000Z-auto', createdAt: '2026-01-01T03:00:00.000Z', sizeBytes: 1000, relativePath: 'backups/backup-20260101T030000Z-auto.sqlite' }] } },
  'PUT /backup/settings': (init) => ({ body: { ...BACKUP_SETTINGS, ...(JSON.parse(String(init?.body)) as object) } }),
};

describe('Backup form', () => {
  it('loads the folder, the parts, the schedule and a Download per archive', async () => {
    fakeHub(BACKUP);
    render(<BackupView />);
    expect(((await screen.findByLabelText('Save backups to:')) as HTMLInputElement).value).toBe('/data/backups');
    await waitFor(() => expect((screen.getByLabelText('Provider sign-ins and the Discord bot token') as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText('How often:') as HTMLSelectElement).value).toBe('daily');
    expect(screen.getByText(/Next one/)).toBeTruthy();
    const download = await screen.findByRole('link', { name: 'Download backup-20260101T030000Z-auto' });
    expect(download.getAttribute('href')).toBe('/api/v1/backup/backup-20260101T030000Z-auto/download');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses a folder outside the data volume before sending it', async () => {
    const hub = fakeHub(BACKUP);
    render(<BackupView />);
    const field = await screen.findByLabelText('Save backups to:');
    await waitFor(() => expect((field as HTMLInputElement).value).toBe('/data/backups'));
    await userEvent.clear(field);
    await userEvent.type(field, '/etc/backups');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Use a folder inside the data volume, such as /data/backups.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(hub.sent('PUT', '/backup/settings')).toHaveLength(0);
  });

  it('saves the schedule, the parts and Keep together, and Revert puts them back', async () => {
    const hub = fakeHub(BACKUP);
    render(<BackupView />);
    await waitFor(() => expect((screen.getByLabelText('How often:') as HTMLSelectElement).value).toBe('daily'));
    await userEvent.selectOptions(screen.getByLabelText('How often:'), 'weekly');
    await userEvent.selectOptions(screen.getByLabelText('On'), '5');
    await userEvent.click(screen.getByLabelText('The audit log and the hub’s statistics'));
    await userEvent.selectOptions(screen.getByLabelText('Keep:'), '4');
    await userEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect((screen.getByLabelText('How often:') as HTMLSelectElement).value).toBe('daily');
    await userEvent.selectOptions(screen.getByLabelText('Keep:'), '4');
    await userEvent.selectOptions(screen.getByLabelText('How often:'), 'weekly');
    await userEvent.selectOptions(screen.getByLabelText('On'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(hub.sent('PUT', '/backup/settings')).toHaveLength(1));
    expect(hub.sent('PUT', '/backup/settings')[0]!.body).toEqual({ location: 'backups', include: { credentials: true, activity: true, caches: true }, schedule: { frequency: 'weekly', time: '03:00', weekday: 5 }, keep: 4 });
  });

  it('says what the hub said when it refuses the folder', async () => {
    fakeHub({ ...BACKUP, 'PUT /backup/settings': refused('The hub can’t write to /data/locked. Check the folder’s permissions.') });
    render(<BackupView />);
    const field = await screen.findByLabelText('Save backups to:');
    await waitFor(() => expect((field as HTMLInputElement).value).toBe('/data/backups'));
    await userEvent.clear(field);
    await userEvent.type(field, '/data/locked');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The hub can’t write to /data/locked. Check the folder’s permissions.');
  });
});

/* ------------------------------------------------------------------ Recommendations */

const REC_CONFIG = { exploration: 0.2, halfLifeDays: 45, maxPerArtist: 2, actionWeights: { liked: 3, earlySkip: -1 } };

describe('Recommendations form', () => {
  it('loads the three numbers and the weights', async () => {
    fakeHub({ 'GET /recommendations/config': { body: REC_CONFIG } });
    render(<RecommendationsView />);
    expect(((await screen.findByLabelText('Exploration (0–1):')) as HTMLInputElement).value).toBe('0.2');
    expect((screen.getByLabelText('Weight for Liked') as HTMLInputElement).value).toBe('3');
  });

  it('refuses a number outside its range before sending it', async () => {
    const hub = fakeHub({ 'GET /recommendations/config': { body: REC_CONFIG } });
    render(<RecommendationsView />);
    const field = await screen.findByLabelText('Most tracks per artist:');
    await userEvent.clear(field);
    await userEvent.type(field, '50');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Most tracks per artist must be between 1 and 20.');
    expect(hub.sent('PUT', '/recommendations/config')).toHaveLength(0);
  });

  it('saves the edit, and Revert puts back what the hub has', async () => {
    const hub = fakeHub({ 'GET /recommendations/config': { body: REC_CONFIG }, 'PUT /recommendations/config': { body: REC_CONFIG } });
    render(<RecommendationsView />);
    const half = await screen.findByLabelText('Half-life (days):');
    await userEvent.clear(half);
    await userEvent.type(half, '30');
    await userEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect((screen.getByLabelText('Half-life (days):') as HTMLInputElement).value).toBe('45');
    await userEvent.clear(screen.getByLabelText('Half-life (days):'));
    await userEvent.type(screen.getByLabelText('Half-life (days):'), '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(hub.sent('PUT', '/recommendations/config')).toHaveLength(1));
    expect(hub.sent('PUT', '/recommendations/config')[0]!.body).toMatchObject({ halfLifeDays: 30, exploration: 0.2 });
  });

  it('says what the hub said when it refuses', async () => {
    fakeHub({ 'GET /recommendations/config': { body: REC_CONFIG }, 'PUT /recommendations/config': refused('Exploration is out of range') });
    render(<RecommendationsView />);
    const field = await screen.findByLabelText('Exploration (0–1):');
    await userEvent.clear(field);
    await userEvent.type(field, '0.5');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Exploration is out of range.');
  });
});

/* ------------------------------------------------------------------ Network */

const NETWORK = { bindMode: 'localhost', bindAddress: '127.0.0.1', port: 4546, publicEndpoint: null, trustedProxyCidrs: [], ipLogging: { mode: 'truncated', retentionDays: 30 }, tlsTerminatedByProxy: false, restartRequired: false, warnings: [] };

describe('Network form', () => {
  it('sends nothing until Save, checks the address first, and Revert puts it back', async () => {
    const hub = fakeHub({ 'GET /network': { body: NETWORK }, 'GET /hub': { body: { codeOnlyPairingAvailable: false } }, 'PUT /network': { body: { ...NETWORK, publicEndpoint: 'https://music.example.com' } } });
    render(<NetworkView />);
    const endpoint = await screen.findByLabelText('Public address:');
    await userEvent.type(endpoint, 'http://music.example.com');
    await userEvent.tab();
    expect(hub.sent('PUT', '/network')).toHaveLength(0);
    expect((await screen.findByRole('alert')).textContent).toBe('Use an https address, such as https://music.example.com.');
    expect(screen.getByText('Not saved yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect((screen.getByLabelText('Public address:') as HTMLInputElement).value).toBe('');
    await userEvent.type(screen.getByLabelText('Public address:'), 'https://music.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(hub.sent('PUT', '/network')).toHaveLength(1));
    expect(hub.sent('PUT', '/network')[0]!.body).toEqual({ publicEndpoint: 'https://music.example.com' });
  });
});

/* ------------------------------------------------------------------ Shares */

describe('Creating a shared link', () => {
  it('makes a link from a hub playlist and shows it in the table with Copy', async () => {
    const share = { id: 's1', kind: 'playlist', targetId: 'p1', title: 'Late Night', ownerId: 'admin', tokenHint: 'abc123', allowStream: true, allowDownload: false, expiresAt: '2026-01-08T00:00:00.000Z', maxAccesses: null, accessCount: 0, playCount: 0, createdAt: '2026-01-01T00:00:00.000Z', revokedAt: null, url: null, reachable: false, warning: null };
    let listed: unknown[] = [];
    const hub = fakeHub({
      'GET /shares': () => ({ body: { items: listed } }),
      'GET /shares/sources': { body: { playlists: [{ id: 'p1', name: 'Late Night', trackCount: 12 }], albums: [{ id: 'Harbour Lights', title: 'Harbour Lights', artistName: 'The Tides', trackCount: 9 }] } },
      'POST /shares': () => {
        listed = [share];
        return { status: 201, body: { share, token: 'TOKEN-0123456789abcdef' } };
      },
    });
    render(<SharesView />);
    const what = await screen.findByLabelText('What to share');
    await userEvent.click(screen.getByRole('button', { name: 'Create Link' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Choose what to share first.');
    expect(hub.sent('POST', '/shares')).toHaveLength(0);
    await waitFor(() => expect((what as HTMLSelectElement).disabled).toBe(false));
    await userEvent.selectOptions(what, 'playlist:p1');
    await userEvent.selectOptions(screen.getByLabelText('Expires'), '30');
    await userEvent.click(screen.getByRole('button', { name: 'Create Link' }));
    await waitFor(() => expect(hub.sent('POST', '/shares')).toHaveLength(1));
    expect(hub.sent('POST', '/shares')[0]!.body).toMatchObject({ kind: 'playlist', targetId: 'p1', expiresInSeconds: 30 * 86_400, allowDownload: false });
    const table = screen.getByRole('table', { name: 'Shared links' });
    expect(await within(table).findByText(`${window.location.origin}/s/TOKEN-0123456789abcdef`)).toBeTruthy();
    expect(within(table).getByRole('button', { name: 'Copy the link to Late Night' })).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ Providers */

describe('Provider details', () => {
  const CAPS = { metadata: 'available', search: 'available', preview: 'unsupported', playback: 'unsupported', importLikes: 'unsupported', importPlaylists: 'unsupported', creatorDownload: 'unsupported', userOwnedDownload: 'unsupported', groupSync: 'unsupported', eq: 'unsupported' };
  const provider = (id: string, name: string, enabled: boolean) => ({ provider: id, displayName: name, role: 'metadata-only', authType: 'none', authScopes: [], groupCompatible: false, discordCompatible: false, reviewedAt: '2026-01-01', limitations: [], capabilities: CAPS, enabled, configured: enabled });
  const usage = (id: string, used: number) => ({ provider: id, health: {}, budget: { perMinute: 60, perDay: null, usedMinute: 0, usedDay: used, shedding: [] }, queueDepth: {}, concurrency: { limit: 1, inFlight: 0 } });
  const ROUTES: Record<string, Answer> = {
    'GET /providers': { body: { items: [provider('musicbrainz', 'MusicBrainz', true), provider('deezer', 'Deezer', false), provider('itunes', 'iTunes', false)], health: [] } },
    'GET /providers/usage': { body: { items: [usage('musicbrainz', 3), usage('deezer', 0), usage('itunes', 2)] } },
    'GET /providers/musicbrainz/config': { body: { provider: 'musicbrainz', enabled: true, clientId: null, clientSecretHint: null, apiKeyHint: null, contactEmail: null, missing: [] } },
  };

  it('open under their own row, take the caret, and close with Escape back onto the button', async () => {
    fakeHub(ROUTES);
    render(<ProvidersView />);
    const button = await screen.findByRole('button', { name: 'Details of MusicBrainz' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const region = screen.getByRole('region', { name: 'MusicBrainz details' });
    // Inside the providers table, in the row after MusicBrainz's.
    expect(region.closest('tr')?.previousElementSibling?.contains(button)).toBe(true);
    await waitFor(() => expect(region.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'MusicBrainz details' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Details of MusicBrainz' }));
  });

  it('list only the providers in use under Requests and limits, with the rest behind a disclosure', async () => {
    fakeHub(ROUTES);
    render(<ProvidersView />);
    const table = await screen.findByRole('table', { name: 'Requests and limits' });
    await waitFor(() => expect(within(table).getByText('MusicBrainz')).toBeTruthy());
    expect(within(table).getByText('iTunes')).toBeTruthy();
    expect(within(table).queryByText('Deezer')).toBeNull();
    const more = screen.getByRole('button', { name: 'Show All Providers (1 more)' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(more);
    expect(within(table).getByText('Deezer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show Providers in Use' }).getAttribute('aria-expanded')).toBe('true');
  });
});

/**
 * The hub window's gating, rendered.
 *
 * The server enforces the same rules, but this asserts the *interface* does not offer a way past
 * them. It is one window in every state — "Airwave Hub", six tabs, a status strip — and what changes
 * is what the window lets through: signed out, every tab is locked; with the bootstrap password
 * still in place, Overview shows the amber gate and the other five tabs are locked with the reason;
 * once a real password is set, everything opens.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/web/App.js';

type Routes = Record<string, unknown>;

function mockFetch(routes: Routes) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, 'http://hub.test').pathname;
    // Longest match wins, so "/providers/usage" is not answered by "/providers".
    const key = Object.keys(routes)
      .filter((k) => path.endsWith(k) || path.includes(`${k}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json', 'x-correlation-id': 'test' } });
  });
}

const TABS = ['Overview', 'Devices', 'Music', 'Groups', 'Sharing', 'System'];
const HUB = { hubId: '1', name: 'Test Hub', version: '0.1.0', contractsVersion: '1.0.0', protocolVersion: 1, minSupportedProtocolVersion: 1, publicKey: 'k', fingerprint: 'ABCD-EF01', bindMode: 'localhost', publicEndpoint: null, setupComplete: true, codeOnlyPairingAvailable: false };
const OVERVIEW = {
  hub: HUB,
  uptimeSeconds: 120,
  startedAt: new Date().toISOString(),
  connections: { active: 0, players: 0, companions: 0, historical: 0, reconnects: 0, wsErrors: 0 },
  pairing: { pending: 0, attempts: 0, failures: 0 },
  groups: [],
  providers: [{ provider: 'ytdlp', status: 'ok', circuit: 'closed', checkedAt: new Date().toISOString() }],
  jobs: { queued: 0, running: 0, failed: 0, completed: 0 },
  discord: { enabled: false, configured: false, gateway: 'stopped', voice: 'idle', commandsRegistered: false, commandsRegisteredAt: null, messageContentIntent: 'unknown', latencyMs: null, reconnects: 0, errors: 0, uptimeSeconds: 0, currentGuildId: null, currentVoiceChannelId: null, currentTrackTitle: null, lastError: null, warnings: [] },
  database: { migrationVersion: 4, sizeBytes: 1024, lastBackupAt: null, walMode: true },
  storage: { dataDir: '/data', freeBytes: null, totalBytes: null },
  alerts: [{ level: 'warning', message: 'No backup has been taken yet.' }],
  memoryRssBytes: 1024,
};
const NETWORK = { bindMode: 'localhost', bindAddress: '127.0.0.1', port: 4546, publicEndpoint: null, trustedProxyCidrs: [], ipLogging: { mode: 'truncated', retentionDays: 30 }, tlsTerminatedByProxy: false, restartRequired: false, warnings: [] };
const CAPS = { metadata: 'available', search: 'unsupported', preview: 'unsupported', playback: 'unsupported', importLikes: 'unsupported', importPlaylists: 'unsupported', creatorDownload: 'restricted', userOwnedDownload: 'available', groupSync: 'unsupported', eq: 'unsupported' };
const TOOL = { provider: 'ytdlp', displayName: 'External media tool (yt-dlp)', role: 'tool', authType: 'none', authScopes: [], groupCompatible: false, discordCompatible: false, reviewedAt: '2026-01-01', limitations: [], capabilities: CAPS, enabled: true, configured: true };
const PROVIDERS = { items: [TOOL], health: OVERVIEW.providers };
const EMPTY = { items: [] };

const GATED_SESSION = { authenticated: true, username: 'admin', mustChangePassword: true, setupComplete: false, csrfToken: 'x' };
const SESSION = { authenticated: true, username: 'admin', mustChangePassword: false, setupComplete: true, csrfToken: 'csrf' };
const SIGNED_IN: Routes = {
  '/auth/session': SESSION,
  '/metrics/overview': OVERVIEW,
  '/hub': HUB,
  '/network': NETWORK,
  '/providers': PROVIDERS,
  '/providers/usage': EMPTY,
  '/devices': EMPTY,
  '/pairing/sessions': EMPTY,
  '/admin/profiles': EMPTY,
  '/library/roots': EMPTY,
  '/library/tracks': EMPTY,
  '/downloads': EMPTY,
  '/downloads/formats': { formats: [{ format: 'original', available: true, lossy: false, reason: null, qualityNote: 'Byte for byte' }], ffmpeg: { available: false, version: null, encoders: [] } },
  '/downloads/storage': { dataDir: '/data', freeBytes: null, totalBytes: null, usedByDownloadsBytes: 0, partialFiles: 0, cleanupPolicy: { keepFailedDays: 7, keepPartialHours: 24 }, directories: [] },
  '/recommendations/config': { exploration: 0.2, halfLifeDays: 45, maxPerArtist: 2, actionWeights: { liked: 3 } },
};

/** The window is on screen before the session has answered, with its tabs locked; wait for it to open. */
async function signedIn(): Promise<void> {
  await screen.findByRole('button', { name: 'Sign Out' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('sign-in', () => {
  it('is drawn inside the same window, with every tab locked and the reason said', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': { authenticated: false, setupComplete: true } }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Airwave Hub' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeTruthy();
    for (const label of TABS) expect(screen.getByRole('tab', { name: label }).getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById('tools-locked')?.textContent).toBe('Sign in first.');
    expect(document.body.textContent).not.toContain('Now Playing');
  });

  it('shows the first-run credentials only before setup is complete', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': { authenticated: false, setupComplete: false } }));
    render(<App />);
    await screen.findByRole('heading', { name: 'Airwave Hub' });
    expect(screen.getByText(/First run/)).toBeTruthy();
  });

  it('does not show the first-run hint once a real password is set', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': { authenticated: false, setupComplete: true } }));
    render(<App />);
    await screen.findByRole('heading', { name: 'Airwave Hub' });
    expect(screen.queryByText(/First run/)).toBeNull();
  });

  it('says what the hub said when a login is refused', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/login')) {
        return new Response(JSON.stringify({ status: 401, code: 'unauthenticated', detail: 'Invalid username or password' }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ authenticated: false, setupComplete: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: 'Airwave Hub' });
    await userEvent.type(screen.getByLabelText('Password:'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    // A sentence, with no status code in it.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Invalid username or password.');
  });
});

describe('setup gate', () => {
  const GATED: Routes = { '/auth/session': GATED_SESSION, '/metrics/overview': OVERVIEW, '/network': NETWORK, '/providers': PROVIDERS, '/hub': HUB };

  it('shows the gate in the window, with only Overview open and the other tabs locked with the reason', async () => {
    const fetchMock = mockFetch(GATED);
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Choose a real password' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Overview/ }).getAttribute('aria-selected')).toBe('true');
    for (const label of TABS.slice(1)) {
      const tab = screen.getByRole('tab', { name: label });
      expect(tab.getAttribute('aria-disabled'), `${label} is locked`).toBe('true');
      expect(tab.className).toContain('locked');
      await userEvent.click(tab);
      expect(tab.getAttribute('aria-selected'), `${label} cannot be opened`).toBe('false');
    }
    expect(document.getElementById('tools-locked')?.textContent).toBe('Choose a real password first.');
    // Nothing gated is offered, and nothing gated is asked of the server either.
    expect(screen.queryByRole('button', { name: /pair/i })).toBeNull();
    const asked = fetchMock.mock.calls.map((call) => String(call[0]));
    for (const gatedRoute of ['/devices', '/pairing', '/groups', '/library', '/backup', '/shares']) expect(asked.some((url) => url.includes(gatedRoute)), `${gatedRoute} is not requested`).toBe(false);
  });

  it('ignores a deep link to a locked tab', async () => {
    window.location.hash = '#devices';
    vi.stubGlobal('fetch', mockFetch(GATED));
    render(<App />);
    await screen.findByRole('heading', { name: 'Choose a real password' });
    expect(screen.getByRole('tab', { name: /^Overview/ }).getAttribute('aria-selected')).toBe('true');
    window.location.hash = '';
  });

  it('refuses to submit when the two new passwords differ, and says so', async () => {
    const fetchMock = mockFetch(GATED);
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: 'Choose a real password' });
    await userEvent.type(screen.getByLabelText('Current password'), 'admin');
    await userEvent.type(screen.getByLabelText('New password'), 'a-real-password-1234');
    await userEvent.type(screen.getByLabelText('New password again'), 'a-real-password-124');
    await userEvent.click(screen.getByRole('button', { name: 'Set Password' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The two don’t match.');
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/auth/change-password'))).toBe(false);
  });

  it('asks for twelve characters, as the server does', async () => {
    vi.stubGlobal('fetch', mockFetch(GATED));
    render(<App />);
    await screen.findByRole('heading', { name: 'Choose a real password' });
    await userEvent.type(screen.getByLabelText('Current password'), 'admin');
    await userEvent.type(screen.getByLabelText('New password'), 'elevenchars');
    await userEvent.type(screen.getByLabelText('New password again'), 'elevenchars');
    await userEvent.click(screen.getByRole('button', { name: 'Set Password' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Use at least 12 characters.');
  });

  it('explains what stays off until the password is changed', async () => {
    vi.stubGlobal('fetch', mockFetch(GATED));
    render(<App />);
    const hint = await screen.findByText(/no pairing, no providers, no group listening/i);
    expect(hint.textContent).toContain('no remote access');
    expect(hint.textContent).toContain('The server enforces this');
  });
});

describe('signed in', () => {
  it('renders the window with the six tabs, the status strip and Sign Out', async () => {
    vi.stubGlobal('fetch', mockFetch(SIGNED_IN));
    render(<App />);
    expect(await screen.findByRole('tablist', { name: 'Sections' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Airwave Hub', level: 1 })).toBeTruthy();
    for (const label of TABS) {
      const tab = screen.getByRole('tab', { name: new RegExp(`^${label}`) });
      expect(tab.getAttribute('aria-disabled'), `${label} is open`).toBeNull();
    }
    expect(await screen.findByRole('button', { name: 'Sign Out' })).toBeTruthy();
    // The Overview tab wears the count of things needing attention; the pane is the one it controls.
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Overview/ }).textContent).toContain('1'));
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(screen.getByRole('tab', { name: /^Overview/ }).id);
    // The status line reads the real bind address and port.
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Test Hub running · 127.0.0.1:4546 · reachable from this machine only'));
  });

  it('shows what needs attention as a sentence, and provider health as a word beside the provider’s name', async () => {
    vi.stubGlobal('fetch', mockFetch(SIGNED_IN));
    render(<App />);
    const attention = await screen.findByRole('list', { name: 'Needs attention' });
    await waitFor(() => expect(within(attention).getByText('No backup has been taken yet.')).toBeTruthy());
    const health = screen.getByRole('list', { name: 'Provider health' });
    await waitFor(() => expect(within(health).getByText('External media tool (yt-dlp)')).toBeTruthy());
    expect(within(health).getByText('Working')).toBeTruthy();
  });

  it('draws the badge and the Needs attention list from one reading, so they always agree', async () => {
    const fetchMock = mockFetch(SIGNED_IN);
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    const attention = await screen.findByRole('list', { name: 'Needs attention' });
    await waitFor(() => expect(within(attention).getAllByRole('listitem')).toHaveLength(1));
    // The badge is drawn from the same reading one render after the list (a slow CI runner showed the gap).
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Overview/ }).textContent).toContain('1'));
    // One request for the overview, not one for the badge and another for the list.
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/metrics/overview'))).toHaveLength(1);
  });

  it('shows the hub fingerprint on the overview, so it can be compared during pairing', async () => {
    vi.stubGlobal('fetch', mockFetch(SIGNED_IN));
    render(<App />);
    expect(await screen.findByText('ABCD-EF01')).toBeTruthy();
  });

  it('moves between tabs with the arrow keys, Home and End, keeping one tab stop', async () => {
    vi.stubGlobal('fetch', mockFetch(SIGNED_IN));
    render(<App />);
    await signedIn();
    const overview = screen.getByRole('tab', { name: /^Overview/ });
    overview.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Devices' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Devices' }));
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'System' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /^Overview/ }).getAttribute('aria-selected')).toBe('true');
    expect(TABS.filter((label) => screen.getByRole('tab', { name: new RegExp(`^${label}`) }).tabIndex === 0)).toEqual(['Overview']);
  });

  it('names every permission in plain words, with its id beside it, and a tick sticks', async () => {
    vi.stubGlobal('fetch', mockFetch(SIGNED_IN));
    render(<App />);
    await signedIn();
    await userEvent.click(await screen.findByRole('tab', { name: 'Devices' }));
    const run = await screen.findByLabelText(/^Run groups/);
    expect(run.closest('label')?.textContent).toBe('Run groups group:admin');
    expect((run as HTMLInputElement).checked).toBe(false);
    await userEvent.click(run);
    expect((screen.getByLabelText(/^Run groups/) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText('This panel could not be displayed')).toBeNull();
    // Sixteen scopes, sixteen labels: none is shown as a bare id.
    const boxes = within(screen.getByRole('group', { name: 'What this device may do' })).getAllByRole('checkbox');
    expect(boxes).toHaveLength(16);
    for (const box of boxes) expect(box.closest('label')?.textContent).toMatch(/^[A-Z][^:]+ [a-z]+:[a-z]+$/);
    // Empty lists are a quiet line in the list box.
    expect(await screen.findByText('None waiting.')).toBeTruthy();
    expect(await screen.findByText('No devices are paired yet.')).toBeTruthy();
  });

  it('shows the external tool as the hub reports it: on, working, with nothing to set up', async () => {
    vi.stubGlobal('fetch', mockFetch(SIGNED_IN));
    render(<App />);
    await signedIn();
    await userEvent.click(await screen.findByRole('tab', { name: 'Music' }));
    const table = await screen.findByRole('table', { name: 'Providers' });
    const row = (await within(table).findByText('External media tool (yt-dlp)')).closest('tr')!;
    expect(within(row).getByText('Working:', { exact: false })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Details of External media tool (yt-dlp)' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Set up/i })).toBeNull();
  });

  it('says spotDL is there in the provider’s row, and shows a playlist download as one row per entry', async () => {
    const now = new Date().toISOString();
    const job = (index: number, title: string, state: string) => ({
      id: `0190000${index}-0000-7000-8000-000000000000`,
      state,
      ownerId: 'd1',
      source: { provider: 'external-tool', providerTrackId: null, url: `https://soundcloud.com/forss/t${index}`, locator: null, title, artistName: 'Forss', batch: { id: '01900000-0000-7000-8000-00000000000b', title: 'Soulhack', index, total: 11 } },
      authorization: { basis: 'public-domain', evidence: null, acknowledgedAt: now },
      target: { destination: 'hub', directoryId: null, filenameTemplate: '{artist} - {title}', format: 'original', quality: null },
      progress: { bytesDone: 0, bytesTotal: null, speedBps: null, percent: null, stage: 'preflight' },
      attempts: 0,
      maxAttempts: 5,
      nextRetryAt: null,
      checksumSha256: null,
      resultLocator: null,
      resultSizeBytes: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    const tools = { ...TOOL, provider: 'external-tool', displayName: 'External media tool (yt-dlp, spotDL)' };
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...SIGNED_IN,
        '/providers': { items: [tools], health: [{ ...OVERVIEW.providers[0], provider: 'external-tool' }] },
        '/downloads': { items: [job(0, 'City Ports', 'completed'), job(1, 'Soulhack', 'queued')] },
        '/downloads/formats': { formats: [], ffmpeg: { available: true, version: '7.1', encoders: [] } },
        '/downloads/storage': { dataDir: '/data', freeBytes: null, totalBytes: null, usedByDownloadsBytes: 0, partialFiles: 0, cleanupPolicy: { keepFailedDays: 14, keepPartialHours: 24 }, directories: [] },
      }),
    );
    render(<App />);
    await signedIn();
    await userEvent.click(await screen.findByRole('tab', { name: 'Music' }));
    const providers = await screen.findByRole('table', { name: 'Providers' });
    expect(await within(providers).findByText('External media tool (yt-dlp, spotDL)')).toBeTruthy();
    const downloads = await screen.findByRole('table', { name: 'Downloads' });
    const first = (await within(downloads).findByText('City Ports — Forss')).closest('tr')!;
    expect(first.textContent).toContain('Soulhack, 1 of 11');
    const second = within(downloads).getByText('Soulhack — Forss').closest('tr')!;
    expect(second.textContent).toContain('Soulhack, 2 of 11');
    expect(within(second).getByText('Waiting')).toBeTruthy();
  });

  it('asks before revoking a device, and Cancel leaves it alone', async () => {
    const device = { id: 'd1', name: 'Kitchen iPad', kind: 'player', scopes: ['library:read'], online: true, lastSeenAt: null, revokedAt: null, platform: 'Safari', ipDisplay: null };
    const fetchMock = mockFetch({ ...SIGNED_IN, '/devices': { items: [device] } });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await signedIn();
    await userEvent.click(await screen.findByRole('tab', { name: 'Devices' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke Kitchen iPad' }));
    const sheet = screen.getByRole('alertdialog', { name: 'Revoke Kitchen iPad?' });
    // Cancel holds the focus, so Return never destroys anything.
    expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: 'Cancel' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetchMock.mock.calls.some((call) => (call as unknown as [unknown, RequestInit?])[1]?.method === 'DELETE')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Revoke Kitchen iPad' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/devices/d1') && (call as unknown as [unknown, RequestInit?])[1]?.method === 'DELETE')).toBe(true));
  });

  it('keeps the window alive when a section fails to render', async () => {
    // The overview is missing `alerts`, which the section reads: without a boundary this unmounts
    // the whole app and leaves an operator with a blank page and no way to reach Diagnostics.
    const broken = { ...OVERVIEW, alerts: undefined };
    vi.stubGlobal('fetch', mockFetch({ ...SIGNED_IN, '/metrics/overview': broken }));
    render(<App />);
    expect(await screen.findByText('This panel could not be displayed')).toBeTruthy();
    // The tabs and Sign Out survive, so the operator can move somewhere useful.
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign Out' })).toBeTruthy();
  });
});

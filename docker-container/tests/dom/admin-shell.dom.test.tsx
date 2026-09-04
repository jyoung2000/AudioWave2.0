/**
 * The admin shell's gating, rendered.
 *
 * The server enforces the same rules, but this asserts the *interface* does not offer a way past
 * them: before the password is changed there is no navigation, no provider form and no pairing
 * button on screen at all — not merely a disabled one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@now-playing/aqua-ui';
import { App } from '../../src/web/App.js';

/** `main.tsx` mounts the app inside ToastProvider; tests must do the same. */
function Shell() {
  return (
    <ToastProvider>
      <App />
    </ToastProvider>
  );
}

function mockFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json', 'x-correlation-id': 'test' } });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('sign-in', () => {
  it('shows the first-run credentials only before setup is complete', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': { authenticated: false, setupComplete: false } }));
    render(<Shell />);
    expect(await screen.findByRole('heading', { name: 'Now Playing Hub' })).toBeTruthy();
    expect(screen.getByText(/First run/)).toBeTruthy();
  });

  it('does not show the first-run hint once a real password is set', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': { authenticated: false, setupComplete: true } }));
    render(<Shell />);
    await screen.findByRole('heading', { name: 'Now Playing Hub' });
    expect(screen.queryByText(/First run/)).toBeNull();
  });

  it('surfaces the hub message when a login is refused', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/login')) {
        return new Response(JSON.stringify({ status: 401, code: 'unauthenticated', detail: 'Invalid username or password' }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ authenticated: false, setupComplete: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<Shell />);
    await screen.findByRole('heading', { name: 'Now Playing Hub' });
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Invalid username or password')).toBeTruthy();
  });
});

describe('setup gate', () => {
  it('replaces the whole interface with the password screen while the bootstrap password stands', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': { authenticated: true, username: 'admin', mustChangePassword: true, setupComplete: false, csrfToken: 'x' } }));
    render(<Shell />);
    expect(await screen.findByRole('heading', { name: 'Choose a password' })).toBeTruthy();
    // No navigation exists at all: there is nothing to click past.
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: /pair/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  it('refuses to submit when the two new passwords differ', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': { authenticated: true, username: 'admin', mustChangePassword: true, setupComplete: false, csrfToken: 'x' } }));
    render(<Shell />);
    await screen.findByRole('heading', { name: 'Choose a password' });
    await userEvent.type(screen.getByLabelText('Current password'), 'admin');
    await userEvent.type(screen.getByLabelText('New password'), 'a-real-password-1234');
    await userEvent.type(screen.getByLabelText('Repeat new password'), 'a-real-password-124');
    expect(screen.getByText('The two passwords do not match')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set password' }).hasAttribute('disabled')).toBe(true);
  });

  it('explains what stays disabled until the password is changed', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': { authenticated: true, username: 'admin', mustChangePassword: true, setupComplete: false, csrfToken: 'x' } }));
    render(<Shell />);
    const hint = await screen.findByText(/pairing, providers, group listening/i);
    expect(hint.textContent).toContain('remote access');
  });
});

describe('signed in', () => {
  const SESSION = { authenticated: true, username: 'admin', mustChangePassword: false, setupComplete: true, csrfToken: 'csrf' };
  const HUB = { hubId: '1', name: 'Test Hub', version: '0.1.0', contractsVersion: '1.0.0', protocolVersion: 1, minSupportedProtocolVersion: 1, publicKey: 'k', fingerprint: 'ABCD-EF01', bindMode: 'localhost', publicEndpoint: null, setupComplete: true, codeOnlyPairingAvailable: false };
  const OVERVIEW = {
    hub: HUB,
    uptimeSeconds: 120,
    startedAt: new Date().toISOString(),
    connections: { active: 0, players: 0, companions: 0, historical: 0, reconnects: 0, wsErrors: 0 },
    pairing: { pending: 0, attempts: 0, failures: 0 },
    groups: [],
    providers: [],
    jobs: { queued: 0, running: 0, failed: 0, completed: 0 },
    discord: { enabled: false, configured: false, gateway: 'stopped', voice: 'idle', commandsRegistered: false, commandsRegisteredAt: null, messageContentIntent: 'unknown', latencyMs: null, reconnects: 0, errors: 0, uptimeSeconds: 0, currentGuildId: null, currentVoiceChannelId: null, currentTrackTitle: null, lastError: null, warnings: [] },
    database: { migrationVersion: 4, sizeBytes: 1024, lastBackupAt: null, walMode: true },
    storage: { dataDir: '/data', freeBytes: null, totalBytes: null },
    alerts: [{ level: 'warning', message: 'No backup has been taken yet.' }],
    memoryRssBytes: 1024,
  };

  it('renders the full interface with the source list and status bar', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': SESSION, '/metrics/overview': OVERVIEW, '/hub': HUB }));
    render(<Shell />);
    expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    for (const label of ['Overview', 'Devices', 'Groups', 'Providers', 'Library', 'Downloads', 'Shared links', 'Discord', 'Network', 'Diagnostics']) {
      expect(screen.getByRole('option', { name: new RegExp(label) }), `${label} should be in the source list`).toBeTruthy();
    }
  });

  it('shows an alert as a sentence with the remedy, not a code', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': SESSION, '/metrics/overview': OVERVIEW, '/hub': HUB }));
    render(<Shell />);
    await waitFor(() => expect(screen.getByText('No backup has been taken yet.')).toBeTruthy());
  });

  it('shows the hub fingerprint in the status bar and the overview, so it can be compared during pairing', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': SESSION, '/metrics/overview': OVERVIEW, '/hub': HUB }));
    render(<Shell />);
    await waitFor(() => expect(screen.getAllByText('ABCD-EF01').length).toBeGreaterThanOrEqual(2));
  });

  it('keeps the shell alive when a panel fails to render', async () => {
    // The overview is missing `alerts`, which the panel reads: without a boundary this unmounts
    // the whole app and leaves an operator with a blank page and no way to reach Diagnostics.
    const broken = { ...OVERVIEW, alerts: undefined };
    vi.stubGlobal('fetch', mockFetch({ '/auth/session': SESSION, '/metrics/overview': broken, '/hub': HUB }));
    render(<Shell />);
    expect(await screen.findByText('This panel could not be displayed')).toBeTruthy();
    // Navigation and the sign-out button survive, so the operator can move somewhere useful.
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});

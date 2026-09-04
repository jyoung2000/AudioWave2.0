/**
 * The companion's interface, rendered.
 *
 * Two things are asserted here that no unit test can. First, that opening the page *outside* the
 * app — in a browser, from a copied URL — shows a plain explanation rather than a wall of broken
 * calls: the renderer has no privileges of its own, and it should say so. Second, that the pairing
 * screen shows the fingerprint and states what sharing means *before* anyone opts in, because that
 * sentence is the privacy model and it has to be on screen at the moment of the decision.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@now-playing/aqua-ui';
import { App } from '../../src/renderer/App.js';
import { HubView } from '../../src/renderer/views/Hub.js';
import type { CompanionBridge } from '../../src/shared/ipc.js';

type Responder = (request: unknown) => unknown;

/** Install a fake bridge on `window.companion`, the way the preload script would. */
function installBridge(responders: Record<string, Responder>): { invoked: Array<{ channel: string; request: unknown }> } {
  const invoked: Array<{ channel: string; request: unknown }> = [];
  const bridge: CompanionBridge = {
    invoke: (async (channel: string, request: unknown) => {
      invoked.push({ channel, request });
      const responder = responders[channel];
      if (!responder) throw new Error(`No fake for ${channel}`);
      return responder(request);
    }) as CompanionBridge['invoke'],
    on: () => () => undefined,
  };
  (window as unknown as { companion?: CompanionBridge }).companion = bridge;
  return { invoked };
}

function Shell({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { companion?: CompanionBridge }).companion;
  vi.restoreAllMocks();
});

describe('outside the app', () => {
  it('explains itself instead of failing, when there is no bridge', async () => {
    render(
      <Shell>
        <App />
      </Shell>,
    );
    expect(await screen.findByRole('heading', { name: /not running inside the companion/i })).toBeTruthy();
    // And it offers nothing that would pretend to work.
    expect(screen.queryByRole('button', { name: 'Scan' })).toBeNull();
  });
});

describe('the shell', () => {
  it('shows the library sections and the hub state once the bridge is there', async () => {
    installBridge({
      'app:info': () => ({ version: '0.1.0', electron: '44.1.1', node: '22.0.0', chrome: '132', platform: 'win32', dataDir: 'C:\\Users\\Sam\\AppData', contractsVersion: '1.0.0', protocolVersion: 1 }),
      'library:folders': () => ({ items: [{ id: '1', path: 'C:\\Music', displayName: 'Music', watch: true, trackCount: 12, sizeBytes: 100, lastScanAt: null, lastScanError: null, available: true }] }),
      'hub:status': () => ({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null }),
    });

    render(
      <Shell>
        <App />
      </Shell>,
    );

    expect(await screen.findByRole('button', { name: 'Scan' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/12 tracks in 1 folder/)).toBeTruthy());
    expect(screen.getByText('No hub paired')).toBeTruthy();
  });

  it('disables Sync while no hub is paired, rather than failing after the click', async () => {
    installBridge({
      'app:info': () => ({ version: '0.1.0', electron: '44.1.1', node: '22.0.0', chrome: '132', platform: 'win32', dataDir: 'C:\\x', contractsVersion: '1.0.0', protocolVersion: 1 }),
      'library:folders': () => ({ items: [] }),
      'hub:status': () => ({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null }),
    });

    render(
      <Shell>
        <App />
      </Shell>,
    );
    const sync = await screen.findByRole('button', { name: 'Sync' });
    expect(sync.hasAttribute('disabled')).toBe(true);
  });
});

describe('pairing', () => {
  it('shows the fingerprint to compare, and does not claim to be paired while waiting', async () => {
    let resolveAwait: ((value: unknown) => void) | null = null;
    installBridge({
      'hub:pair-start': () => ({ challenge: { sessionId: '00000000-0000-7000-8000-000000000001', verificationFingerprint: 'ABCD-EF01', hubFingerprint: 'aa:bb:cc:dd', hubName: 'Front room hub', expiresAt: new Date(Date.now() + 60_000).toISOString() }, reason: null }),
      'hub:pair-await': () => new Promise((resolve) => (resolveAwait = resolve)),
    });

    render(
      <Shell>
        <HubView status={null} onChanged={() => undefined} />
      </Shell>,
    );

    await userEvent.type(screen.getByLabelText('Pairing code'), 'ABCD1234');
    await userEvent.click(screen.getByRole('button', { name: 'Pair' }));

    expect(await screen.findByText('ABCD-EF01')).toBeTruthy();
    expect(screen.getByText(/Waiting for someone at the hub to confirm/)).toBeTruthy();
    // Nothing on screen says it is connected until the hub has actually said so.
    expect(screen.queryByText(/^Connected$/)).toBeNull();
    expect(resolveAwait).not.toBeNull();
  });

  it('states what is and is not shared, at the moment the choice is offered', async () => {
    installBridge({ 'hub:share-library': () => ({ enabled: true, reason: null }) });

    render(
      <Shell>
        <HubView
          status={{ endpoint: 'http://hub.local:4546', hubId: '00000000-0000-7000-8000-000000000002', hubName: 'Front room hub', hubFingerprint: 'aa:bb:cc:dd', connected: true, reason: null, scopes: ['library:share'], lastSyncAt: null }}
          onChanged={() => undefined}
        />
      </Shell>,
    );

    expect(screen.getByText(/What is never sent: the folders on this computer, or any path within them/)).toBeTruthy();
    expect(screen.getByText(/Audio files stay here until you explicitly send one/)).toBeTruthy();
    // The sharing switch starts off: sharing is opted into, never assumed.
    const checkbox = screen.getByRole('checkbox', { name: /what music is on this computer/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });
});

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
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  it('shows the four tabs, the folders by kind and the hub state once the bridge is there', async () => {
    installBridge({
      'app:info': () => ({ version: '0.1.0', electron: '44.1.1', node: '22.0.0', chrome: '132', platform: 'win32', dataDir: 'C:\\Users\\Sam\\AppData', contractsVersion: '1.0.0', protocolVersion: 1 }),
      'library:folders': () => ({ items: [{ id: '1', path: 'C:\\Music', displayName: 'Music', watch: true, kind: 'music', trackCount: 12, sizeBytes: 100, lastScanAt: null, lastScanError: null, available: true }, { id: '2', path: 'D:\\TV', displayName: 'TV', watch: true, kind: 'tv', trackCount: 0, sizeBytes: 0, lastScanAt: null, lastScanError: null, available: true }] }),
      'hub:status': () => ({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null }),
      'helper:status': () => ({ running: true, port: 17342, origin: 'http://127.0.0.1:17342', reason: null, tools: [{ id: 'yt-dlp', present: false, version: null, path: null, advice: 'Install yt-dlp.' }, { id: 'spotdl', present: false, version: null, path: null, advice: 'Install spotDL.' }, { id: 'ffmpeg', present: true, version: '7.1', path: 'C:\\ffmpeg\\ffmpeg.exe', advice: null }], checkedAt: null }),
    });

    render(
      <Shell>
        <App />
      </Shell>,
    );

    expect(await screen.findByRole('button', { name: 'Scan' })).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: 'Sections' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['Library', 'Live TV', 'Remote', 'Settings']);
    // Two downloaders are missing: the Settings tab says so, as the mockup's gear wore its badge.
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: /Settings/ }).textContent).toContain('2'));
    await waitFor(() => expect(screen.getByText(/12 tracks in 2 folders/)).toBeTruthy());
    expect(screen.getByText('No hub paired')).toBeTruthy();
    // The folders are grouped by kind: the TV folder sits under Saved TV, not among the music.
    await waitFor(() => expect(screen.getByRole('table', { name: 'Saved TV folders' })).toBeTruthy());
    expect(screen.getByRole('table', { name: 'Saved Music folders' })).toBeTruthy();
    expect(screen.getByText('No movie folders yet')).toBeTruthy();
  });

  it('says what Live TV is missing, and shows no sample channel', async () => {
    installBridge({
      'app:info': () => ({ version: '0.1.0', electron: '44.1.1', node: '22.0.0', chrome: '132', platform: 'win32', dataDir: 'C:\\x', contractsVersion: '1.0.0', protocolVersion: 1 }),
      'library:folders': () => ({ items: [] }),
      'hub:status': () => ({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null }),
      'helper:status': () => ({ running: true, port: 17342, origin: 'http://127.0.0.1:17342', reason: null, tools: [{ id: 'yt-dlp', present: false, version: null, path: null, advice: 'Install yt-dlp.' }, { id: 'spotdl', present: false, version: null, path: null, advice: 'Install spotDL.' }, { id: 'ffmpeg', present: true, version: '7.1', path: 'C:\\ffmpeg\\ffmpeg.exe', advice: null }], checkedAt: null }),
    });
    render(
      <Shell>
        <App />
      </Shell>,
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Live TV' }));
    expect(await screen.findByText('Not available yet')).toBeTruthy();
    expect(screen.getByText(/Channel playlists \(M3U\) and programme guides \(EPG\) are not kept anywhere yet/)).toBeTruthy();
    expect(screen.queryByText(/channels/i)).toBeNull();
  });

  it('disables Back Up Now with the reason while there is nowhere to back up to', async () => {
    installBridge({
      'app:info': () => ({ version: '0.1.0', electron: '44.1.1', node: '22.0.0', chrome: '132', platform: 'win32', dataDir: 'C:\\x', contractsVersion: '1.0.0', protocolVersion: 1, signed: false, updateFeedUrl: null }),
      'library:folders': () => ({ items: [] }),
      'hub:status': () => ({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null }),
      'helper:status': () => ({ running: true, port: 17342, origin: 'http://127.0.0.1:17342', reason: null, tools: [{ id: 'yt-dlp', present: false, version: null, path: null, advice: 'Install yt-dlp.' }, { id: 'spotdl', present: false, version: null, path: null, advice: 'Install spotDL.' }, { id: 'ffmpeg', present: true, version: '7.1', path: 'C:\\ffmpeg\\ffmpeg.exe', advice: null }], checkedAt: null }),
      'app:preferences:get': () => ({ launchAtLogin: false, minimizeToTray: true, watchFolders: true, autoSync: false, theme: 'system', helperPort: 17342 }),
      'backup:settings:get': () => ({ dir: null, include: { music: true, tv: false, movies: false, playlists: true, presets: true, settings: true }, schedule: 'manual', keep: 5, lastRunAt: null, lastRunError: null }),
      'backup:estimate': () => ({ parts: {}, dataBytes: 812, expectedBytes: 812, complete: true, destination: null, blocked: 'Choose where backups go first.' }),
      'backup:list': () => ({ items: [] }),
    });
    render(
      <Shell>
        <App />
      </Shell>,
    );
    await userEvent.click(await screen.findByRole('tab', { name: /Settings/ }));
    const now = await screen.findByRole('button', { name: 'Back Up Now' });
    await waitFor(() => expect(now.hasAttribute('disabled')).toBe(true));
    expect(screen.getAllByText('Choose where backups go first.').length).toBeGreaterThan(0);
    // The missing downloaders are amber and say what to install; ffmpeg is found, with its version.
    expect(screen.getByText('Install yt-dlp.')).toBeTruthy();
    expect(screen.getByText('7.1')).toBeTruthy();
  });

  it('disables Sync while no hub is paired, rather than failing after the click', async () => {
    installBridge({
      'app:info': () => ({ version: '0.1.0', electron: '44.1.1', node: '22.0.0', chrome: '132', platform: 'win32', dataDir: 'C:\\x', contractsVersion: '1.0.0', protocolVersion: 1 }),
      'library:folders': () => ({ items: [] }),
      'hub:status': () => ({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null }),
      'helper:status': () => ({ running: true, port: 17342, origin: 'http://127.0.0.1:17342', reason: null, tools: [{ id: 'yt-dlp', present: false, version: null, path: null, advice: 'Install yt-dlp.' }, { id: 'spotdl', present: false, version: null, path: null, advice: 'Install spotDL.' }, { id: 'ffmpeg', present: true, version: '7.1', path: 'C:\\ffmpeg\\ffmpeg.exe', advice: null }], checkedAt: null }),
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

describe("the Library names each tempo's provenance", () => {
  const NOW = new Date().toISOString();
  const song = (id: string, title: string, bpm: number | null, bpmSource: 'tag' | 'analysis' | null) => ({
    id, schemaVersion: 1, createdAt: NOW, updatedAt: NOW, deletedAt: null,
    title, artistId: null, artistName: 'A', albumId: null, albumName: 'LP', albumArtistName: null,
    discNumber: null, trackNumber: null, genre: null, genres: [], tags: [], year: null,
    durationMs: 200_000, bpm, bpmSource, featuredArtists: [], genreProfile: {},
    identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} },
    locators: [], artworkId: null, format: null, rootId: null, unsupportedReason: null, liked: false, explicit: null, popularity: null,
  });
  const bridgeWith = (ffmpegPresent: boolean) => installBridge({
    'app:info': () => ({ version: '0.1.0', electron: '44.1.1', node: '22.0.0', chrome: '132', platform: 'win32', dataDir: 'C:\\x', contractsVersion: '1.0.0', protocolVersion: 1 }),
    'library:folders': () => ({ items: [] }),
    'hub:status': () => ({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null }),
    'helper:status': () => ({ running: true, port: 17342, origin: 'http://127.0.0.1:17342', reason: null, tools: [{ id: 'ffmpeg', present: ffmpegPresent, version: ffmpegPresent ? '7.1' : null, path: ffmpegPresent ? 'C:\\t\\ffmpeg.exe' : null, advice: null }], checkedAt: NOW }),
    'library:tracks': () => ({ items: [song('t1', 'Tagged Song', 128, 'tag'), song('t2', 'Measured Song', 120, 'analysis'), song('t3', 'Silent Song', null, null)], total: 3 }),
  });

  it('a tag is plain, a measurement wears the mark', async () => {
    bridgeWith(true);
    render(
      <Shell>
        <App />
      </Shell>,
    );
    await screen.findByText('Tagged Song');
    expect(screen.getByText('128')).toBeTruthy();
    const measured = screen.getByText('≈120');
    expect(measured.getAttribute('title')).toMatch(/Measured from the audio/);
    expect(screen.queryByText('≈128')).toBeNull();
    expect(screen.queryByText(/Tempo needs ffmpeg/)).toBeNull();
  });

  it('without ffmpeg, the silent rows are explained once', async () => {
    bridgeWith(false);
    render(
      <Shell>
        <App />
      </Shell>,
    );
    await screen.findByText('Silent Song');
    expect(screen.getAllByText(/Tempo needs ffmpeg/).length).toBe(1);
  });
});

describe('downloaders set themselves up (UX-SETUP-001)', () => {
  const NOW = new Date().toISOString();
  const base = {
    'app:info': () => ({ version: '0.1.0', electron: '44.1.1', node: '22.0.0', chrome: '132', platform: 'win32', dataDir: 'C:\\x', contractsVersion: '1.0.0', protocolVersion: 1, signed: false, updateFeedUrl: null }),
    'library:folders': () => ({ items: [] }),
    'hub:status': () => ({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null }),
    'app:preferences:get': () => ({ launchAtLogin: false, minimizeToTray: true, watchFolders: true, autoSync: false, theme: 'system', helperPort: 17342 }),
    'backup:settings:get': () => ({ dir: null, include: { music: true, tv: false, movies: false, playlists: true, presets: true, settings: true }, schedule: 'manual', keep: 5, lastRunAt: null, lastRunError: null }),
    'backup:estimate': () => ({ parts: {}, dataBytes: 812, expectedBytes: 812, complete: true, destination: null, blocked: 'Choose where backups go first.' }),
    'backup:list': () => ({ items: [] }),
  };
  const status = (ffmpeg: Record<string, unknown>) => ({
    running: true,
    port: 17342,
    origin: 'http://127.0.0.1:17342',
    reason: null,
    checkedAt: NOW,
    tools: [
      { id: 'yt-dlp', present: true, version: '2026.09.20', path: 'C:\\x\\helper\\tools\\yt-dlp.exe', advice: null, origin: 'installed', setup: { state: 'ready' } },
      { id: 'spotdl', present: false, version: null, path: null, advice: 'Install spotDL.', origin: 'missing', setup: { state: 'failed', reason: 'GitHub did not answer (503).' } },
      { id: 'ffmpeg', present: false, version: null, path: null, advice: 'Install ffmpeg.', origin: 'missing', ...ffmpeg },
    ],
  });

  it('Settings shows setting up with progress, ready and set up automatically, and a failure with Try Again', async () => {
    const { invoked } = installBridge({ ...base, 'helper:status': () => status({ setup: { state: 'installing', progress: 0.42 } }), 'helper:install-tools': () => status({ setup: { state: 'installing', progress: 0 } }) });
    render(
      <Shell>
        <App />
      </Shell>,
    );
    const tabs = await screen.findByRole('tablist', { name: 'Sections' });
    // Only the failed tool needs the person; the one on its way does not wear the badge.
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: /Settings/ }).textContent).toContain('1'));
    await userEvent.click(within(tabs).getByRole('tab', { name: /Settings/ }));
    const list = await screen.findByRole('list', { name: 'Downloaders' });
    expect(within(list).getByText('Setting up… 42%')).toBeTruthy();
    expect(within(list).getByRole('progressbar', { name: 'Setting up ffmpeg' }).getAttribute('aria-valuenow')).toBe('42');
    expect(within(list).getByText('Ready')).toBeTruthy();
    expect(within(list).getByText('Set up automatically')).toBeTruthy();
    expect(within(list).getByText(/Couldn.t set up: GitHub did not answer \(503\)\./)).toBeTruthy();
    // The manual advice is only a fallback: a tool being set up, or that failed, does not show it.
    expect(within(list).queryByText('Install ffmpeg.')).toBeNull();
    expect(within(list).queryByText('Install spotDL.')).toBeNull();
    await userEvent.click(within(list).getByRole('button', { name: 'Try Again' }));
    expect(invoked.some((call) => call.channel === 'helper:install-tools')).toBe(true);
  });

  it('Settings keeps the install advice for a tool this PC cannot set up', async () => {
    installBridge({ ...base, 'helper:status': () => status({ setup: { state: 'unsupported', reason: 'Install it with your package manager.' } }) });
    render(
      <Shell>
        <App />
      </Shell>,
    );
    await userEvent.click(await screen.findByRole('tab', { name: /Settings/ }));
    const list = await screen.findByRole('list', { name: 'Downloaders' });
    expect(within(list).getByText('Install it yourself')).toBeTruthy();
    expect(within(list).getByText('Install it with your package manager.')).toBeTruthy();
  });

  const tracks = {
    'library:tracks': () => ({
      items: [{ id: 't3', schemaVersion: 1, createdAt: NOW, updatedAt: NOW, deletedAt: null, title: 'Silent Song', artistId: null, artistName: 'A', albumId: null, albumName: 'LP', albumArtistName: null, discNumber: null, trackNumber: null, genre: null, genres: [], tags: [], year: null, durationMs: 200_000, bpm: null, bpmSource: null, featuredArtists: [], genreProfile: {}, identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} }, locators: [], artworkId: null, format: null, rootId: null, unsupportedReason: null, liked: false, explicit: null, popularity: null }],
      total: 1,
    }),
  };

  it('the Library says tempos are on their way while ffmpeg is being set up', async () => {
    installBridge({ ...base, ...tracks, 'helper:status': () => status({ setup: { state: 'installing', progress: 0.1 } }) });
    render(
      <Shell>
        <App />
      </Shell>,
    );
    await screen.findByText('Silent Song');
    expect(await screen.findByText('Setting up ffmpeg — tempos appear once it finishes.')).toBeTruthy();
    expect(screen.queryByText(/install it and rescan/)).toBeNull();
  });

  it('the Library points to Settings when ffmpeg could not be set up, and says nothing once it is ready', async () => {
    installBridge({ ...base, ...tracks, 'helper:status': () => status({ setup: { state: 'failed', reason: 'No SHA-256.' } }) });
    render(
      <Shell>
        <App />
      </Shell>,
    );
    await screen.findByText('Silent Song');
    expect(await screen.findByText('Tempo needs ffmpeg, which could not be set up automatically. Try again in Settings.')).toBeTruthy();
    cleanup();

    installBridge({ ...base, ...tracks, 'helper:status': () => status({ present: true, version: '7.1', path: 'C:\\x\\helper\\tools\\ffmpeg.exe', origin: 'installed', setup: { state: 'ready' } }) });
    render(
      <Shell>
        <App />
      </Shell>,
    );
    await screen.findByText('Silent Song');
    await waitFor(() => expect(screen.queryByText(/ffmpeg/i)).toBeNull());
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

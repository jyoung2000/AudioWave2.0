/**
 * The controls the design drew that now have something behind them, rendered: per-downloader
 * Check and Update, automatic updates, the Downloads preferences, new versions, the LAN switch,
 * cache and logs, which connections streaming may use and when a device was last seen, the hub's
 * recommendation settings in a backup, every song of a large library reachable, and a sheet that
 * dims only the pane.
 *
 * Each command is asserted where it reaches the bridge: the main process does the work, and its
 * own tests say how.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/renderer/App.js';
import { ConfirmProvider } from '../../src/renderer/ui.js';
import { connection, StreamingView } from '../../src/renderer/views/Streaming.js';
import { needsAttention, toolLook } from '../../src/renderer/views/Settings.js';
import { windowFor, ROW_HEIGHT } from '../../src/renderer/views/Library.js';
import type { AwspStatus, CompanionBridge, HelperTool } from '../../src/shared/ipc.js';

type Responder = (request: unknown) => unknown;
const NOW = new Date().toISOString();

const PREFS = {
  launchAtLogin: false,
  minimizeToTray: true,
  watchFolders: true,
  autoSync: false,
  theme: 'system',
  helperPort: 17342,
  autoUpdateTools: true,
  checkForUpdates: true,
  downloadDir: null as string | null,
  downloadFormat: 'original',
  downloadConcurrency: 2,
  downloadRateKBps: null as number | null,
  downloadDone: 'nothing',
  helperLan: false,
  verboseLogs: false,
};

const tool = (id: HelperTool['id'], extra: Partial<HelperTool> = {}): HelperTool => ({ id, present: true, version: '2026.09.20', path: `C:\\x\\helper\\tools\\${id}.exe`, advice: null, origin: 'installed', setup: { state: 'ready' }, ...extra });

const helperStatus = (tools: HelperTool[], extra: Record<string, unknown> = {}) => ({ running: true, port: 17342, origin: 'http://127.0.0.1:17342', reason: null, tools, checkedAt: NOW, busy: false, lan: false, ...extra });

function awsp(overrides: Partial<AwspStatus> = {}): AwspStatus {
  return { enabled: true, running: true, reason: null, endpointId: 'abc', ticket: 't', ticketQrSvg: null, relayUrl: null, pairingCode: null, devices: [], connections: [], port: null, network: { unmetered: true, metered: true, connection: 'unmetered', blocked: null }, ...overrides };
}

const song = (n: number) => ({
  id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  schemaVersion: 1,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  title: `Song ${n}`,
  artistId: null,
  artistName: 'A',
  albumId: null,
  albumName: 'LP',
  albumArtistName: null,
  discNumber: null,
  trackNumber: null,
  genre: null,
  genres: [],
  tags: [],
  year: null,
  durationMs: 200_000,
  bpm: 120,
  bpmSource: 'tag',
  featuredArtists: [],
  genreProfile: {},
  identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} },
  locators: [],
  artworkId: null,
  format: null,
  rootId: null,
  unsupportedReason: null,
  liked: false,
  explicit: null,
  popularity: null,
});

function fresh(): Record<string, Responder> {
  return {
    'app:info': () => ({ version: '0.1.0', electron: '44.1.1', node: '22.0.0', chrome: '132', platform: 'win32/x64', dataDir: 'C:\\Users\\Sam\\AppData\\Roaming\\Airwave Companion', contractsVersion: '1.0.0', protocolVersion: 1, signed: false, updateFeedUrl: null, logsDir: 'C:\\logs' }),
    'app:preferences:get': () => PREFS,
    'app:preferences:set': (patch) => ({ ...PREFS, ...(patch as object) }),
    'app:update-status': () => ({ current: '0.1.0', latest: null, available: false, checkedAt: null, reason: null, enabled: true }),
    'app:storage': () => ({ cache: { app: 0, liveTv: 0, downloads: 0, total: 0 }, logsDir: 'C:\\logs' }),
    'library:folders': () => ({ items: [] }),
    'library:tracks': () => ({ items: [], total: 0 }),
    'hub:status': () => ({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null }),
    'helper:status': () => helperStatus([tool('yt-dlp'), tool('spotdl', { version: '4.2.11' }), tool('ffmpeg', { version: '7.1' })]),
    'tv:links': () => ({ m3u: [], epg: [] }),
    'awsp:status': () => awsp({ enabled: false, running: false }),
    'transfers:list': () => ({ items: [] }),
    'backup:settings:get': () => ({ dir: null, include: { music: true, tv: false, movies: false, playlists: true, presets: true, algorithms: true, settings: true }, schedule: 'manual', keep: 5, lastRunAt: null, lastRunError: null }),
    'backup:estimate': () => ({ parts: {}, dataBytes: 812, expectedBytes: 812, complete: true, destination: null, blocked: 'Choose where backups go first.' }),
    'backup:list': () => ({ items: [] }),
    'backup:algorithms': () => ({ available: false, hubName: null, reason: 'No hub is paired, so there are no recommendation settings to back up.' }),
  };
}

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

const called = (invoked: Array<{ channel: string; request: unknown }>, channel: string) => invoked.filter((call) => call.channel === channel);
const openSettings = async () => {
  render(<App />);
  await userEvent.click(await screen.findByRole('tab', { name: /Settings/ }));
};

afterEach(() => {
  cleanup();
  delete (window as unknown as { companion?: CompanionBridge }).companion;
  vi.restoreAllMocks();
});

describe('each downloader has Check and Update, as the design drew them', () => {
  it('Check asks about that tool; one found behind says which version is out, wears the badge, and Update installs it', async () => {
    let behind = false;
    const status = () => helperStatus([tool('yt-dlp', behind ? { latest: { version: '2026.10.01', updateAvailable: true, reason: null, checkedAt: NOW } } : {}), tool('spotdl', { version: '4.2.11', latest: { version: '4.2.11', updateAvailable: false, reason: null, checkedAt: NOW } }), tool('ffmpeg', { version: '7.1' })]);
    const { invoked } = installBridge({
      ...fresh(),
      'helper:status': status,
      'helper:check-tool': () => {
        behind = true;
        return status();
      },
      'helper:update-tool': () => ({ status: status(), reason: null }),
    });
    await openSettings();
    const list = await screen.findByRole('list', { name: 'Downloaders' });
    // spotDL was checked and is current: Update has nothing to do, and says so.
    expect(within(list).getByText('Up to date')).toBeTruthy();
    const spotUpdate = within(list).getByRole('button', { name: 'Update spotDL' }) as HTMLButtonElement;
    expect(spotUpdate.disabled).toBe(true);
    expect(spotUpdate.title).toBe('It is up to date.');

    await userEvent.click(within(list).getByRole('button', { name: 'Check yt-dlp' }));
    await waitFor(() => expect(called(invoked, 'helper:check-tool')[0]?.request).toEqual({ id: 'yt-dlp' }));
    expect(await within(list).findByText('Update available · 2026.10.01')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('tab', { name: /Settings/ }).textContent).toContain('1 downloader needs attention'));

    await userEvent.click(within(list).getByRole('button', { name: 'Update yt-dlp' }));
    await waitFor(() => expect(called(invoked, 'helper:update-tool')[0]?.request).toEqual({ id: 'yt-dlp' }));
    expect(await screen.findByText(/Updating yt-dlp\. It is checked against its published SHA-256/)).toBeTruthy();
  });

  it('a missing tool offers Install, and Check waits for it; a busy helper says why Update must wait', async () => {
    const { invoked } = installBridge({
      ...fresh(),
      'helper:status': () => helperStatus([tool('yt-dlp'), tool('spotdl', { present: false, version: null, path: null, origin: 'missing', setup: { state: 'ready' } }), tool('ffmpeg', { version: '7.1' })], { busy: true }),
      'helper:update-tool': () => ({ status: helperStatus([]), reason: null }),
    });
    await openSettings();
    const list = await screen.findByRole('list', { name: 'Downloaders' });
    const check = within(list).getByRole('button', { name: 'Check spotDL' }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    expect(check.title).toBe('Install it first.');
    // Downloads are running: a tool in use is not replaced, but a missing one can still be installed.
    expect((within(list).getByRole('button', { name: 'Update yt-dlp' }) as HTMLButtonElement).title).toBe('Downloads are running. Update when they finish.');
    await userEvent.click(within(list).getByRole('button', { name: 'Install spotDL' }));
    await waitFor(() => expect(called(invoked, 'helper:update-tool')[0]?.request).toEqual({ id: 'spotdl' }));
  });

  it('“Update downloaders automatically” is on by default and writes its preference', async () => {
    const { invoked } = installBridge(fresh());
    await openSettings();
    const box = (await screen.findByRole('checkbox', { name: /Update downloaders automatically/ })) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    await waitFor(() => expect(called(invoked, 'app:preferences:set')[0]?.request).toEqual({ autoUpdateTools: false }));
    expect(await screen.findByText(/update only when you choose Update\. Missing ones are still set up/)).toBeTruthy();
  });

  it('says in words what each state is', () => {
    expect(toolLook(tool('yt-dlp', { checking: true }))).toEqual({ kind: 'busy', label: 'Checking…' });
    expect(toolLook(tool('yt-dlp', { setup: { state: 'installing', progress: 0.5 } }))).toEqual({ kind: 'busy', label: 'Updating… 50%' });
    expect(toolLook(tool('ffmpeg', { latest: { version: null, updateAvailable: true, reason: null, checkedAt: NOW } }))).toEqual({ kind: 'warn', label: 'A newer build is available' });
    expect(needsAttention(tool('yt-dlp', { latest: { version: '1', updateAvailable: true, reason: null, checkedAt: NOW } }))).toBe(true);
    expect(needsAttention(tool('yt-dlp', { latest: { version: '1', updateAvailable: null, reason: 'GitHub didn’t answer.', checkedAt: NOW } }))).toBe(false);
  });
});

describe('General and Downloads', () => {
  it('says a new version is out, and Download opens the release page through the main process', async () => {
    const { invoked } = installBridge({ ...fresh(), 'app:update-status': () => ({ current: '0.1.0', latest: '0.2.0', available: true, checkedAt: NOW, reason: null, enabled: true }), 'app:open-release': () => ({ opened: true, reason: null }) });
    await openSettings();
    expect(await screen.findByText('A new version is available: 0.2.0.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Download…' }));
    await waitFor(() => expect(called(invoked, 'app:open-release')).toHaveLength(1));
    // No URL comes from the page: the request is empty.
    expect(called(invoked, 'app:open-release')[0]?.request).toBeUndefined();
  });

  it('the notification switch and “When one finishes” are one preference', async () => {
    const { invoked } = installBridge(fresh());
    await openSettings();
    const notify = (await screen.findByRole('checkbox', { name: 'Show a notification when a download finishes' })) as HTMLInputElement;
    await waitFor(() => expect(notify.disabled).toBe(false));
    await userEvent.click(notify);
    await waitFor(() => expect(called(invoked, 'app:preferences:set')[0]?.request).toEqual({ downloadDone: 'notify' }));
    await userEvent.selectOptions(screen.getByLabelText('When one finishes:'), 'reveal');
    await waitFor(() => expect(called(invoked, 'app:preferences:set')[1]?.request).toEqual({ downloadDone: 'reveal' }));
  });

  it('chooses the folder in the system’s picker, and writes format, how many at once and a speed limit', async () => {
    const { invoked } = installBridge({ ...fresh(), 'downloads:pick-dir': () => ({ preferences: { ...PREFS, downloadDir: 'D:\\Media\\Downloads' }, reason: null }) });
    await openSettings();
    expect(await screen.findByText('Downloads, in your Music folder')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('group', { name: 'Downloads' })).getByRole('button', { name: 'Choose…' }));
    await waitFor(() => expect(called(invoked, 'downloads:pick-dir')).toHaveLength(1));
    expect(await screen.findByText('Downloads now go to D:\\Media\\Downloads.')).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText('Format:'), 'flac');
    await waitFor(() => expect(called(invoked, 'app:preferences:set').map((c) => c.request)).toContainEqual({ downloadFormat: 'flac' }));

    const jobs = screen.getByLabelText('At the same time:') as HTMLInputElement;
    await userEvent.clear(jobs);
    await userEvent.type(jobs, '7');
    await userEvent.tab();
    expect(screen.getByText('Choose from 1 to 4 downloads.')).toBeTruthy();
    await userEvent.clear(jobs);
    await userEvent.type(jobs, '3{Enter}');
    await waitFor(() => expect(called(invoked, 'app:preferences:set').map((c) => c.request)).toContainEqual({ downloadConcurrency: 3 }));

    const speed = screen.getByLabelText('Speed limit:') as HTMLInputElement;
    await userEvent.type(speed, '500{Enter}');
    await waitFor(() => expect(called(invoked, 'app:preferences:set').map((c) => c.request)).toContainEqual({ downloadRateKBps: 500 }));
    expect(await screen.findByText('Each download is now held to 500 KB/s.')).toBeTruthy();
  });

  it('explains what the LAN switch exposes before it is turned on', async () => {
    const { invoked } = installBridge(fresh());
    await openSettings();
    const lan = (await screen.findByRole('checkbox', { name: /Let devices on this network use the helper without pairing/ })) as HTMLInputElement;
    expect(lan.checked).toBe(false);
    expect(screen.getByText(/any device on this network can see that the companion is running.*Downloads, backups and the helper’s token stay on this PC/)).toBeTruthy();
    await waitFor(() => expect(lan.disabled).toBe(false));
    await userEvent.click(lan);
    await waitFor(() => expect(called(invoked, 'app:preferences:set')[0]?.request).toEqual({ helperLan: true }));
  });
});

describe('Storage and privacy: cache and logs', () => {
  it('shows the cache, asks before clearing it, and clears it through the main process', async () => {
    let total = 1_200_000_000;
    const report = () => ({ cache: { app: total ? 200_000_000 : 0, liveTv: total ? 900_000_000 : 0, downloads: total ? 100_000_000 : 0, total }, logsDir: 'C:\\logs' });
    const { invoked } = installBridge({
      ...fresh(),
      'app:storage': report,
      'app:clear-cache': () => {
        total = 0;
        return { storage: report(), reason: null };
      },
    });
    await openSettings();
    expect(await screen.findByText('1.2 GB')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Clear Cache' }));
    expect(await screen.findByText('Clear the cache?')).toBeTruthy();
    expect(called(invoked, 'app:clear-cache')).toHaveLength(0);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear Cache' }));
    await waitFor(() => expect(called(invoked, 'app:clear-cache')).toHaveLength(1));
    expect(await screen.findByText('Cache cleared. Artwork and guide data will be fetched again as needed.')).toBeTruthy();
    expect(await screen.findByText('Empty')).toBeTruthy();
  });

  it('opens and exports the logs without the page naming a place, and switches detailed logs', async () => {
    const { invoked } = installBridge({ ...fresh(), 'app:open-logs': () => ({ ok: true, reason: null }), 'app:export-logs': () => ({ path: 'C:\\Users\\Sam\\Documents\\logs.zip', reason: null }) });
    await openSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'Open Logs Folder' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export Logs…' }));
    await waitFor(() => expect(called(invoked, 'app:export-logs')).toHaveLength(1));
    expect(called(invoked, 'app:open-logs')[0]?.request).toBeUndefined();
    expect(await screen.findByText(/Logs saved to C:\\Users\\Sam\\Documents\\logs\.zip, with tokens, keys and folder paths taken out\./)).toBeTruthy();
    const verbose = screen.getByRole('checkbox', { name: /Keep detailed logs/ }) as HTMLInputElement;
    await waitFor(() => expect(verbose.disabled).toBe(false));
    await userEvent.click(verbose);
    await waitFor(() => expect(called(invoked, 'app:preferences:set')[0]?.request).toEqual({ verboseLogs: true }));
  });

  it('dims only the pane under the toolbar while a sheet is open, and keeps it modal', async () => {
    installBridge({ ...fresh(), 'app:storage': () => ({ cache: { app: 10, liveTv: 0, downloads: 0, total: 10 }, logsDir: 'C:\\logs' }) });
    await openSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'Clear Cache' }));
    const dialog = await screen.findByRole('dialog');
    const dim = document.querySelector<HTMLElement>('.sheet-dim');
    expect(dim).toBeTruthy();
    // It starts where the chrome ends — never over the title bar and toolbar — and the sheet hangs from the same line.
    expect(dim!.style.top).toBe(dialog.style.top);
    expect(Number.parseFloat(dim!.style.top)).toBeGreaterThan(0);
    expect(dim!.getAttribute('aria-hidden')).toBe('true');
    expect(dialog.hasAttribute('open')).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.querySelector('.sheet-dim')).toBeNull());
  });
});

describe('Remote: which connections, and when each device was last seen', () => {
  const alone = (status: AwspStatus) => render(<ConfirmProvider><StreamingView status={status} onChanged={() => undefined} /></ConfirmProvider>);

  it('has the two switches, writes each, and says why streaming is paused on this connection', async () => {
    const { invoked } = installBridge({ 'awsp:set-networks': () => awsp() });
    alone(awsp({ running: false, reason: 'Paused: this PC is on a metered connection (mobile data or a hotspot), and streaming on metered connections is off.', network: { unmetered: true, metered: false, connection: 'metered', blocked: 'Paused: …' } }));
    const wifi = screen.getByRole('checkbox', { name: /On Wi-Fi and Ethernet/ }) as HTMLInputElement;
    const metered = screen.getByRole('checkbox', { name: /On metered connections \(mobile data, hotspots\)/ }) as HTMLInputElement;
    expect(wifi.checked).toBe(true);
    expect(metered.checked).toBe(false);
    expect(screen.getAllByText(/Paused: this PC is on a metered connection/).length).toBeGreaterThan(0);
    expect(screen.getByText('This PC is on a metered connection.')).toBeTruthy();
    await userEvent.click(metered);
    await waitFor(() => expect(called(invoked, 'awsp:set-networks')[0]?.request).toEqual({ metered: true }));
  });

  it('keeps the switches off while streaming itself is off', () => {
    installBridge({});
    alone(awsp({ enabled: false, running: false }));
    expect((screen.getByRole('checkbox', { name: /On Wi-Fi and Ethernet/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it('says when a device was last seen, and how it is connected while it is', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const device = { id: 'p', name: 'Phone', clientKind: 'android' as const, tierCap: 'high' as const, pairedAt: '2026-09-01T00:00:00Z', lastSeenAt: '2026-10-03T11:55:00Z' };
    expect(connection(awsp(), device, now)).toBe('Android · last seen 5 minutes ago');
    expect(connection(awsp(), { ...device, lastSeenAt: null }, now)).toBe('Android · not seen yet');
    expect(connection(awsp({ connections: [{ peer: 'p', name: 'Phone', type: 'relay', rttMs: 80 }] }), device, now)).toBe('Android · through a relay · 80 ms');
  });
});

describe('the backup takes the hub’s recommendation settings', () => {
  it('offers the checkbox, and says why when they cannot be read', async () => {
    installBridge(fresh());
    await openSettings();
    expect(await screen.findByRole('checkbox', { name: /Recommendation algorithms/ })).toBeTruthy();
    expect(await screen.findByText(/No hub is paired, so there are no recommendation settings to back up\. The rest is backed up without them\./)).toBeTruthy();
  });

  it('names the hub they come from when they can be', async () => {
    installBridge({ ...fresh(), 'backup:algorithms': () => ({ available: true, hubName: 'Den Hub', reason: null }) });
    await openSettings();
    expect(await screen.findByText(/from Den Hub, as it keeps them/)).toBeTruthy();
  });
});

describe('every song is reachable, however many there are', () => {
  const TOTAL = 50_000;
  const library = (asked: Array<{ offset: number; limit: number }>) => ({
    'library:tracks': (request: unknown) => {
      const { offset, limit } = request as { offset: number; limit: number };
      asked.push({ offset, limit });
      const items = [];
      for (let i = offset; i < Math.min(TOTAL, offset + limit); i += 1) items.push(song(i));
      return { items, total: TOTAL };
    },
    'library:track-ids': (request: unknown) => {
      const { offset, limit } = request as { offset: number; limit: number };
      const ids = [];
      for (let i = offset; i < Math.min(TOTAL, offset + limit); i += 1) ids.push(song(i).id);
      return { ids, total: TOTAL };
    },
  });

  it('draws a window of rows, not 50,000, and counts them all', async () => {
    const asked: Array<{ offset: number; limit: number }> = [];
    installBridge({ ...fresh(), ...library(asked) });
    render(<App />);
    expect(await screen.findByText('Song 0')).toBeTruthy();
    expect(document.querySelectorAll('tbody tr[data-index]').length).toBeLessThan(100);
    expect(screen.getByRole('grid', { name: 'Music' }).getAttribute('aria-rowcount')).toBe(String(TOTAL + 1));
    expect(screen.getByText('50,000 songs')).toBeTruthy();
    expect(screen.queryByText(/showing the first/)).toBeNull();
    // Only the first stretch was asked for.
    expect(asked.every((a) => a.offset === 0 && a.limit === 200)).toBe(true);
  });

  it('End reaches the last song, fetching only its stretch; Shift+Home chooses everything between by asking for the ids', async () => {
    const asked: Array<{ offset: number; limit: number }> = [];
    const { invoked } = installBridge({ ...fresh(), ...library(asked) });
    render(<App />);
    await userEvent.click((await screen.findByText('Song 0')).closest('tr')!);
    await userEvent.keyboard('{End}');
    const last = await screen.findByText('Song 49999');
    expect(last.closest('tr')!.getAttribute('aria-selected')).toBe('true');
    expect(last.closest('tr')!.getAttribute('aria-rowindex')).toBe(String(TOTAL + 1));
    expect(asked.map((a) => a.offset)).toContain(49_800);
    await waitFor(() => expect(document.activeElement).toBe(last.closest('tr')));

    await userEvent.keyboard('{Shift>}{Home}{/Shift}');
    await waitFor(() => expect(screen.getByText(/50,000 chosen/)).toBeTruthy());
    expect(called(invoked, 'library:track-ids').length).toBeGreaterThan(0);
  });

  it('Ctrl+A chooses every song, and Send to Hub sends them in batches', async () => {
    const sent: string[][] = [];
    installBridge({
      ...fresh(),
      ...library([]),
      'hub:status': () => ({ endpoint: 'http://hub.local:4546', hubId: '00000000-0000-7000-8000-0000000000aa', hubName: 'Front Room', hubFingerprint: 'aa', connected: true, reason: null, scopes: [], lastSyncAt: NOW }),
      'transfers:send': (request) => {
        const ids = (request as { trackIds: string[] }).trackIds;
        sent.push(ids);
        return { queued: ids.length, reason: null };
      },
    });
    render(<App />);
    await userEvent.click((await screen.findByText('Song 3')).closest('tr')!);
    await userEvent.keyboard('{Control>}a{/Control}');
    await waitFor(() => expect(screen.getByText(/50,000 chosen/)).toBeTruthy());
    // Not drawn, but chosen all the same.
    await userEvent.click(screen.getByRole('button', { name: 'Send to Hub' }));
    await waitFor(() => expect(sent.flat()).toHaveLength(TOTAL));
    expect(Math.max(...sent.map((s) => s.length))).toBeLessThanOrEqual(500);
    expect(await screen.findByText(/Sending 50,000 songs to the hub/)).toBeTruthy();
  });

  it('computes the drawn rows from the scroll position', () => {
    expect(windowFor(0, 0, 0)).toEqual({ first: 0, last: -1 });
    const middle = windowFor(25_000 * ROW_HEIGHT, 440, 50_000);
    expect(middle.first).toBeLessThan(25_000);
    expect(middle.last).toBeGreaterThan(25_000 + 440 / ROW_HEIGHT - 1);
    expect(middle.last - middle.first).toBeLessThan(60);
    expect(windowFor(10_000_000, 440, 50_000).last).toBe(49_999);
  });
});

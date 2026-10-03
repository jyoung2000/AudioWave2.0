/**
 * The companion's window, rendered.
 *
 * What is asserted here is what no unit test can see: that the window is the design's — one title,
 * four tools, the folders in their wells, a status line — on this PC's data rather than a sample's;
 * that every command reaches the main process through the bridge and nothing else; that removing
 * and forgetting ask first; and the two sentences that matter most at the moment they matter:
 * what pairing shares, and why a downloader is not ready.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/renderer/App.js';
import { ConfirmProvider } from '../../src/renderer/ui.js';
import { HubView, scopeWords } from '../../src/renderer/views/Hub.js';
import { shortVersion } from '../../src/renderer/views/Settings.js';
import { StreamingView } from '../../src/renderer/views/Streaming.js';
import type { CompanionBridge } from '../../src/shared/ipc.js';

type Responder = (request: unknown) => unknown;

const NOW = new Date().toISOString();

const TOOLS_MISSING = [
  { id: 'yt-dlp', present: false, version: null, path: null, advice: 'Install yt-dlp.' },
  { id: 'spotdl', present: false, version: null, path: null, advice: 'Install spotDL.' },
  { id: 'ffmpeg', present: true, version: 'ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers', path: 'C:\\ffmpeg\\ffmpeg.exe', advice: null },
];

/** What a companion with nothing set up answers. A test replaces only what it is about. */
function fresh(): Record<string, Responder> {
  return {
    'app:info': () => ({ version: '0.1.0', electron: '44.1.1', node: '22.0.0', chrome: '132', platform: 'win32/x64', dataDir: 'C:\\Users\\Sam\\AppData\\Roaming\\Airwave Companion', contractsVersion: '1.0.0', protocolVersion: 1, signed: false, updateFeedUrl: null }),
    'app:preferences:get': () => ({ launchAtLogin: false, minimizeToTray: true, watchFolders: true, autoSync: false, theme: 'system', helperPort: 17342 }),
    'library:folders': () => ({ items: [] }),
    'library:tracks': () => ({ items: [], total: 0 }),
    'hub:status': () => ({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null }),
    'hub:sharing': () => ({ enabled: false }),
    // No helper, so nothing is setting the downloaders up: they are found or they are missing.
    'helper:status': () => ({ running: false, port: null, origin: null, reason: 'Port 17342 is already in use on this PC. Choose another in Settings ▸ Network.', tools: TOOLS_MISSING, checkedAt: null }),
    'tv:links': () => ({ m3u: [], epg: [] }),
    'awsp:status': () => awsp(),
    'transfers:list': () => ({ items: [] }),
    'backup:settings:get': () => ({ dir: null, include: { music: true, tv: false, movies: false, playlists: true, presets: true, settings: true }, schedule: 'manual', keep: 5, lastRunAt: null, lastRunError: null }),
    'backup:estimate': () => ({ parts: {}, dataBytes: 812, expectedBytes: 812, complete: true, destination: null, blocked: 'Choose where backups go first.' }),
    'backup:list': () => ({ items: [] }),
  };
}

function awsp(overrides: Record<string, unknown> = {}) {
  return { enabled: false, running: false, reason: null, endpointId: null, ticket: null, ticketQrSvg: null, relayUrl: null, pairingCode: null, devices: [], connections: [], port: null, ...overrides };
}

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

const folder = (id: string, path: string, kind: 'music' | 'tv' | 'movies', extra: Record<string, unknown> = {}) => ({ id, path, displayName: path.split('\\').pop(), watch: true, kind, trackCount: 0, sizeBytes: 0, lastScanAt: null, lastScanError: null, available: true, ...extra });

const song = (id: string, title: string, bpm: number | null, bpmSource: 'tag' | 'analysis' | null) => ({
  id, schemaVersion: 1, createdAt: NOW, updatedAt: NOW, deletedAt: null,
  title, artistId: null, artistName: 'A', albumId: null, albumName: 'LP', albumArtistName: null,
  discNumber: null, trackNumber: null, genre: null, genres: [], tags: [], year: null,
  durationMs: 200_000, bpm, bpmSource, featuredArtists: [], genreProfile: {},
  identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} },
  locators: [], artworkId: null, format: null, rootId: null, unsupportedReason: null, liked: false, explicit: null, popularity: null,
});

const openApp = () => render(<App />);
const tool = (name: RegExp | string) => screen.findByRole('tab', { name });
const called = (invoked: Array<{ channel: string; request: unknown }>, channel: string) => invoked.filter((call) => call.channel === channel);

afterEach(() => {
  cleanup();
  delete (window as unknown as { companion?: CompanionBridge }).companion;
  vi.restoreAllMocks();
});

describe('outside the app', () => {
  it('explains itself instead of failing, when there is no bridge', async () => {
    openApp();
    expect(await screen.findByRole('heading', { name: /not running inside the companion/i })).toBeTruthy();
    // And it offers nothing that would pretend to work.
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Folder…' })).toBeNull();
  });
});

describe('the window is the design’s', () => {
  it('has one title, four tools and nothing else in its chrome', async () => {
    installBridge(fresh());
    openApp();
    const tabs = await screen.findByRole('tablist', { name: 'Sections' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent?.replace(/[\d,].*$/, ''))).toEqual(['Library', 'Live TV', 'Remote', 'Settings']);
    // The name is drawn once: by the page, in the strip Windows' own buttons sit over.
    expect(screen.getAllByText('Airwave Companion')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Airwave Companion' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Now Playing/);
    // Scan and Sync are commands of the Library and of the hub connection, not of the toolbar.
    expect(within(tabs).getAllByRole('tab')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Scan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull();
  });

  it('shows the folders by kind, the hub state and the counts, from this PC', async () => {
    installBridge({
      ...fresh(),
      'library:folders': () => ({ items: [folder('1', 'C:\\Music', 'music', { trackCount: 12 }), folder('2', 'D:\\TV', 'tv')] }),
      'tv:links': () => ({ m3u: [{ id: 'a', kind: 'm3u', url: 'https://tv.example.com/all.m3u8', state: 'ok', summary: '112 channels', error: null, checkedAt: NOW }], epg: [] }),
    });
    openApp();
    const music = await screen.findByRole('list', { name: 'Music folders' });
    await waitFor(() => expect(within(music).getByText('C:\\Music')).toBeTruthy());
    expect(within(music).getByText('12 songs')).toBeTruthy();
    // The TV folder sits under Saved TV, not among the music.
    const tv = screen.getByRole('list', { name: 'TV folders' });
    expect(within(tv).getByText('D:\\TV')).toBeTruthy();
    expect(within(tv).getByText('watched')).toBeTruthy();
    // An empty list is one quiet line, in the design's words — not an illustration.
    expect(within(screen.getByRole('list', { name: 'Movie folders' })).getByText('No folders yet — add the one this PC keeps these in.')).toBeTruthy();
    expect(screen.getByText('No hub paired')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('2 folders · 1 playlist · 0 guides · 0 devices')).toBeTruthy());
    // Two downloaders are missing: the Settings tool says so, as the design's gear wore its badge.
    const settings = await tool(/Settings/);
    await waitFor(() => expect(settings.textContent).toContain('2 downloaders need attention'));
  });

  it('moves along the tools with the arrow keys, choosing as it goes', async () => {
    installBridge(fresh());
    openApp();
    const library = await tool('Library');
    library.focus();
    await userEvent.keyboard('{ArrowRight}');
    const liveTv = screen.getByRole('tab', { name: 'Live TV' });
    expect(liveTv.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(liveTv);
    // Only the chosen tool is in the tab order; its pane is the one on show.
    expect(library.tabIndex).toBe(-1);
    expect(liveTv.tabIndex).toBe(0);
    expect(document.getElementById('companion-pane-live-tv')?.hidden).toBe(false);
    expect(document.getElementById('companion-pane-library')?.hidden).toBe(true);
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: /Settings/ }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowRight}');
    expect(library.getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Settings/ }));
  });

  it('keeps every section the ledger knows, each in its tab', async () => {
    installBridge(fresh());
    openApp();
    await tool('Library');
    for (const [name, ids] of [['Library', ['folders', 'library']], ['Live TV', ['live-tv']], ['Remote', ['streaming', 'hub', 'transfers']], ['Settings', ['settings', 'backup', 'about']]] as const) {
      await userEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));
      for (const id of ids) expect(document.getElementById(id), `section #${id}`).not.toBeNull();
    }
  });
});

describe('folders', () => {
  it('adds through the Windows folder picker, by kind, and says what happened', async () => {
    const { invoked } = installBridge({ ...fresh(), 'library:add-folder': () => ({ folder: folder('9', 'D:\\Shows', 'tv'), reason: null }) });
    openApp();
    await screen.findByRole('list', { name: 'TV folders' });
    await userEvent.click(screen.getAllByRole('button', { name: 'Add Folder…' })[1]!);
    expect(called(invoked, 'library:add-folder')[0]?.request).toEqual({ kind: 'tv' });
    expect(await screen.findByText('Added Shows.')).toBeTruthy();
  });

  it('asks before removing one, says the files are not touched, and does nothing on Cancel', async () => {
    const { invoked } = installBridge({ ...fresh(), 'library:folders': () => ({ items: [folder('00000000-0000-7000-8000-00000000000a', 'C:\\Music', 'music')] }), 'library:remove-folder': () => ({ ok: true }) });
    openApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove C:\\Music' }));
    expect(await screen.findByText('Stop using “Music”?')).toBeTruthy();
    expect(screen.getByText(/Your files aren’t touched/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Stop using “Music”?')).toBeNull());
    expect(called(invoked, 'library:remove-folder')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Remove C:\\Music' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Folder' }));
    await waitFor(() => expect(called(invoked, 'library:remove-folder')[0]?.request).toEqual({ folderId: '00000000-0000-7000-8000-00000000000a' }));
  });

  it('keeps a folder whose drive is unplugged in the list, and says so', async () => {
    installBridge({ ...fresh(), 'library:folders': () => ({ items: [folder('1', 'E:\\Music', 'music', { available: false, trackCount: 40 })] }) });
    openApp();
    const music = await screen.findByRole('list', { name: 'Music folders' });
    expect(await within(music).findByText('not connected')).toBeTruthy();
    expect(screen.getByText(/One folder isn’t connected right now\. What was found there stays listed/)).toBeTruthy();
    // It cannot be scanned while it is away, and the button says why rather than failing.
    expect((screen.getByRole('button', { name: 'Scan E:\\Music again' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Live TV is real', () => {
  it('shows no sample channels: two empty lists in the design’s words', async () => {
    installBridge(fresh());
    openApp();
    await userEvent.click(await tool('Live TV'));
    expect(within(await screen.findByRole('list', { name: 'M3U links' })).getByText('No playlists yet.')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'EPG links' })).getByText('No guides yet — the guide will list channels without programmes.')).toBeTruthy();
    expect(screen.queryByText(/\d+ channels/)).toBeNull();
    // Add has nothing to add yet, and says so.
    const add = screen.getAllByRole('button', { name: 'Add' })[0] as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toBe('Paste a link first.');
  });

  it('hands a pasted link to the main process, says “checking…” while it is read, then what it holds', async () => {
    let finish: ((value: unknown) => void) | null = null;
    const links = { m3u: [] as unknown[], epg: [] as unknown[] };
    const { invoked } = installBridge({
      ...fresh(),
      'tv:links': () => ({ m3u: [...links.m3u], epg: [...links.epg] }),
      'tv:add': () => new Promise((resolve) => (finish = resolve)),
    });
    openApp();
    await userEvent.click(await tool('Live TV'));
    const field = await screen.findByLabelText('M3U link');
    await userEvent.type(field, 'https://tv.example.com/all.m3u8{Enter}');
    expect(called(invoked, 'tv:add')[0]?.request).toEqual({ kind: 'm3u', url: 'https://tv.example.com/all.m3u8' });
    const list = screen.getByRole('list', { name: 'M3U links' });
    expect(await within(list).findByText('checking…')).toBeTruthy();
    expect(within(list).getByText('https://tv.example.com/all.m3u8')).toBeTruthy();

    const link = { id: 'a', kind: 'm3u', url: 'https://tv.example.com/all.m3u8', state: 'ok', summary: '112 channels', error: null, checkedAt: NOW };
    links.m3u.push(link);
    finish!({ link, reason: null });
    expect(await within(list).findByText('✓ 112 channels')).toBeTruthy();
    expect(within(list).queryByText('checking…')).toBeNull();
    expect((field as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(screen.getByText(/1 playlist · 0 guides/)).toBeTruthy());
  });

  it('says why a link was not kept, keeps what was typed, and adds nothing', async () => {
    installBridge({ ...fresh(), 'tv:add': () => ({ link: null, reason: 'That doesn’t look like a programme guide — it should be an XMLTV file (.xml or .xml.gz).' }) });
    openApp();
    await userEvent.click(await tool('Live TV'));
    const field = (await screen.findByLabelText('EPG link')) as HTMLInputElement;
    await userEvent.type(field, 'https://tv.example.com/page.html');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add' })[1]!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('That doesn’t look like a programme guide — it should be an XMLTV file (.xml or .xml.gz).');
    expect(field.value).toBe('https://tv.example.com/page.html');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(within(screen.getByRole('list', { name: 'EPG links' })).getByText(/No guides yet/)).toBeTruthy();
    // Typing again clears the complaint.
    await userEvent.type(field, 'x');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('marks a link that stopped answering, offers to check it again, and removes on the minus', async () => {
    const dead = { id: 'b', kind: 'm3u', url: 'https://tv.example.com/gone.m3u', state: 'failed', summary: 'unreachable', error: 'That link didn’t answer.', checkedAt: NOW };
    const { invoked } = installBridge({ ...fresh(), 'tv:links': () => ({ m3u: [dead], epg: [] }), 'tv:refresh': () => ({ link: dead, reason: dead.error }), 'tv:remove': () => ({ ok: true }) });
    openApp();
    await userEvent.click(await tool('Live TV'));
    const list = await screen.findByRole('list', { name: 'M3U links' });
    expect(await within(list).findByText('unreachable')).toBeTruthy();
    expect(screen.getByText('A link that doesn’t answer keeps what it last held, and is tried again by itself.')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Check Again' }));
    await waitFor(() => expect(called(invoked, 'tv:refresh')[0]?.request).toEqual({ id: 'b' }));
    await userEvent.click(within(list).getByRole('button', { name: 'Remove https://tv.example.com/gone.m3u' }));
    await waitFor(() => expect(called(invoked, 'tv:remove')[0]?.request).toEqual({ id: 'b' }));
  });
});

describe('Settings', () => {
  it('disables Back Up Now with the reason while there is nowhere to back up to', async () => {
    installBridge(fresh());
    openApp();
    await userEvent.click(await tool(/Settings/));
    const now = (await screen.findByRole('button', { name: 'Back Up Now' })) as HTMLButtonElement;
    await waitFor(() => expect(now.disabled).toBe(true));
    await waitFor(() => expect(now.title).toBe('Choose where backups go first.'));
    expect(screen.getAllByText('Choose where backups go first.').length).toBeGreaterThan(0);
    expect(within(screen.getByRole('list', { name: 'Backups' })).getByText('No backups yet.')).toBeTruthy();
    // The missing downloaders say what to install; FFmpeg is found, with its version as a number.
    expect(screen.getByText('Install yt-dlp.')).toBeTruthy();
    expect(screen.getByText('7.1')).toBeTruthy();
    expect(shortVersion('2026.09.14')).toBe('2026.09.14');
    expect(shortVersion('nightly')).toBe('nightly');
  });

  it('writes a preference back as it changes, and says so at the foot of the pane', async () => {
    const { invoked } = installBridge({ ...fresh(), 'app:preferences:set': (patch) => ({ launchAtLogin: false, minimizeToTray: true, watchFolders: true, autoSync: false, theme: 'system', helperPort: 17342, ...(patch as object) }) });
    openApp();
    await userEvent.click(await tool(/Settings/));
    expect(screen.getByText('Settings are kept on this PC.')).toBeTruthy();
    const startup = (await screen.findByRole('checkbox', { name: 'Start when Windows starts' })) as HTMLInputElement;
    await waitFor(() => expect(startup.disabled).toBe(false));
    await userEvent.click(startup);
    await waitFor(() => expect(called(invoked, 'app:preferences:set')[0]?.request).toEqual({ launchAtLogin: true }));
    expect(await screen.findByText('Saved. Settings are kept on this PC.')).toBeTruthy();
  });

  it('refuses a port that is not one, in words, without sending it', async () => {
    const { invoked } = installBridge(fresh());
    openApp();
    await userEvent.click(await tool(/Settings/));
    const port = (await screen.findByLabelText('Local helper port:')) as HTMLInputElement;
    await waitFor(() => expect(port.disabled).toBe(false));
    await userEvent.clear(port);
    await userEvent.type(port, '80');
    await userEvent.tab();
    expect(screen.getByText('Use a port from 1024 to 65535.')).toBeTruthy();
    expect(port.getAttribute('aria-invalid')).toBe('true');
    expect(called(invoked, 'app:preferences:set')).toHaveLength(0);
  });

  it('asks before restoring the defaults', async () => {
    const { invoked } = installBridge({ ...fresh(), 'app:preferences:reset': () => ({ launchAtLogin: false, minimizeToTray: true, watchFolders: true, autoSync: false, theme: 'system', helperPort: 17342 }) });
    openApp();
    await userEvent.click(await tool(/Settings/));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore Defaults' }));
    expect(await screen.findByText('Restore the default settings?')).toBeTruthy();
    expect(called(invoked, 'app:preferences:reset')).toHaveLength(0);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore Defaults' }));
    await waitFor(() => expect(called(invoked, 'app:preferences:reset')).toHaveLength(1));
    expect(await screen.findByText('Defaults restored. Downloaders and folders are unchanged.')).toBeTruthy();
  });
});

describe("the Library names each tempo's provenance", () => {
  const withSongs = (ffmpegPresent: boolean, extra: Record<string, Responder> = {}) =>
    installBridge({
      ...fresh(),
      'helper:status': () => ({ running: false, port: null, origin: null, reason: 'The helper could not start.', tools: [{ id: 'ffmpeg', present: ffmpegPresent, version: ffmpegPresent ? '7.1' : null, path: ffmpegPresent ? 'C:\\t\\ffmpeg.exe' : null, advice: null }], checkedAt: NOW }),
      'library:tracks': () => ({ items: [song('00000000-0000-7000-8000-000000000001', 'Tagged Song', 128, 'tag'), song('00000000-0000-7000-8000-000000000002', 'Measured Song', 120, 'analysis'), song('00000000-0000-7000-8000-000000000003', 'Silent Song', null, null)], total: 3 }),
      ...extra,
    });

  it('a tag is plain, a measurement wears the mark', async () => {
    withSongs(true);
    openApp();
    await screen.findByText('Tagged Song');
    expect(screen.getByText('128')).toBeTruthy();
    const measured = screen.getByText('≈120');
    expect(measured.getAttribute('title')).toMatch(/Measured from the audio/);
    expect(screen.queryByText('≈128')).toBeNull();
    expect(screen.queryByText(/Tempo needs FFmpeg/)).toBeNull();
    expect(screen.getByText('3 songs')).toBeTruthy();
  });

  it('without ffmpeg, the silent rows are explained once', async () => {
    withSongs(false);
    openApp();
    await screen.findByText('Silent Song');
    expect(screen.getAllByText(/Tempo needs FFmpeg/).length).toBe(1);
  });

  it('acts on the songs that are chosen: Enter shows the file, Send to Hub sends them', async () => {
    const { invoked } = withSongs(true, {
      'hub:status': () => ({ endpoint: 'http://hub.local:4546', hubId: '00000000-0000-7000-8000-0000000000aa', hubName: 'Front Room', hubFingerprint: 'aa:bb', connected: true, reason: null, scopes: [], lastSyncAt: NOW }),
      'app:reveal': () => ({ ok: true, reason: null }),
      'transfers:send': () => ({ queued: 2, reason: null }),
    });
    openApp();
    const send = (await screen.findByRole('button', { name: 'Send to Hub' })) as HTMLButtonElement;
    // Nothing chosen: the button is off and says what to do, rather than failing after the click.
    await waitFor(() => expect(send.title).toBe('Choose the songs to send first.'));
    expect(send.disabled).toBe(true);

    const first = (await screen.findByText('Tagged Song')).closest('tr')!;
    await userEvent.click(first);
    expect(first.getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(screen.getByText('Measured Song').closest('tr')!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/2 chosen/)).toBeTruthy();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(called(invoked, 'app:reveal')[0]?.request).toEqual({ trackId: '00000000-0000-7000-8000-000000000002' }));

    await userEvent.click(send);
    await waitFor(() => expect(called(invoked, 'transfers:send')[0]?.request).toEqual({ trackIds: ['00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002'] }));
    expect(await screen.findByText(/Sending 2 songs to the hub/)).toBeTruthy();
  });

  it('with no hub paired, Send to Hub says where to pair one', async () => {
    withSongs(true);
    openApp();
    const send = (await screen.findByRole('button', { name: 'Send to Hub' })) as HTMLButtonElement;
    await userEvent.click((await screen.findByText('Tagged Song')).closest('tr')!);
    expect(send.disabled).toBe(true);
    expect(send.title).toBe('Pair an Airwave Hub under Remote to send songs to it.');
  });
});

describe('downloaders set themselves up (UX-SETUP-001)', () => {
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
    const { invoked } = installBridge({ ...fresh(), 'helper:status': () => status({ setup: { state: 'installing', progress: 0.42 } }), 'helper:install-tools': () => status({ setup: { state: 'installing', progress: 0 } }) });
    openApp();
    const settings = await tool(/Settings/);
    // Only the failed tool needs the person; the one on its way does not wear the badge.
    await waitFor(() => expect(settings.textContent).toContain('1 downloader needs attention'));
    await userEvent.click(settings);
    const list = await screen.findByRole('list', { name: 'Downloaders' });
    expect(within(list).getByText('Setting up… 42%')).toBeTruthy();
    expect(within(list).getByRole('progressbar', { name: 'Setting up FFmpeg' }).getAttribute('aria-valuenow')).toBe('42');
    expect(within(list).getByText('Ready')).toBeTruthy();
    expect(within(list).getByText('Set up automatically')).toBeTruthy();
    expect(within(list).getByText(/Couldn.t set up: GitHub did not answer \(503\)\./)).toBeTruthy();
    // The manual advice is only a fallback: a tool being set up, or that failed, does not show it.
    expect(within(list).queryByText('Install ffmpeg.')).toBeNull();
    expect(within(list).queryByText('Install spotDL.')).toBeNull();
    await userEvent.click(within(list).getByRole('button', { name: 'Try Again' }));
    expect(invoked.some((call) => call.channel === 'helper:install-tools')).toBe(true);
  });

  it('a tool setup has not reached yet is on its way, not missing: no badge, no install advice', async () => {
    // Setup takes the tools one at a time; for a few seconds after start the later ones have no state.
    const starting = {
      running: true,
      port: 17342,
      origin: 'http://127.0.0.1:17342',
      reason: null,
      checkedAt: NOW,
      tools: [
        { id: 'yt-dlp', present: false, version: null, path: null, advice: null, origin: 'missing', setup: { state: 'installing', progress: 0.07 } },
        { id: 'spotdl', present: false, version: null, path: null, advice: 'Install spotDL.', origin: 'missing' },
        { id: 'ffmpeg', present: false, version: null, path: null, advice: 'Install FFmpeg.', origin: 'missing' },
      ],
    };
    installBridge({ ...fresh(), ...tracks, 'helper:status': () => starting });
    openApp();
    const settings = await tool(/Settings/);
    await screen.findByText('Silent Song');
    expect(settings.textContent).toBe('Settings');
    expect(await screen.findByText('Setting up FFmpeg — tempos appear once it finishes.')).toBeTruthy();
    await userEvent.click(settings);
    const list = await screen.findByRole('list', { name: 'Downloaders' });
    expect(within(list).getByText('Setting up… 7%')).toBeTruthy();
    expect(within(list).getAllByText('Setting up…')).toHaveLength(2);
    expect(within(list).queryByText('Missing')).toBeNull();
    expect(within(list).queryByText('Install spotDL.')).toBeNull();
    expect(within(list).queryByText('Install FFmpeg.')).toBeNull();
  });

  it('Settings keeps the install advice for a tool this PC cannot set up', async () => {
    installBridge({ ...fresh(), 'helper:status': () => status({ setup: { state: 'unsupported', reason: 'Install it with your package manager.' } }) });
    openApp();
    await userEvent.click(await tool(/Settings/));
    const list = await screen.findByRole('list', { name: 'Downloaders' });
    expect(within(list).getByText('Install it yourself')).toBeTruthy();
    expect(within(list).getByText('Install it with your package manager.')).toBeTruthy();
  });

  const tracks = { 'library:tracks': () => ({ items: [song('00000000-0000-7000-8000-000000000003', 'Silent Song', null, null)], total: 1 }) };

  it('the Library says tempos are on their way while ffmpeg is being set up', async () => {
    installBridge({ ...fresh(), ...tracks, 'helper:status': () => status({ setup: { state: 'installing', progress: 0.1 } }) });
    openApp();
    await screen.findByText('Silent Song');
    expect(await screen.findByText('Setting up FFmpeg — tempos appear once it finishes.')).toBeTruthy();
    expect(screen.queryByText(/install it and scan again/)).toBeNull();
  });

  it('the Library points to Settings when ffmpeg could not be set up, and says nothing once it is ready', async () => {
    installBridge({ ...fresh(), ...tracks, 'helper:status': () => status({ setup: { state: 'failed', reason: 'No SHA-256.' } }) });
    openApp();
    await screen.findByText('Silent Song');
    expect(await screen.findByText('Tempo needs FFmpeg, which could not be set up automatically. Try again in Settings.')).toBeTruthy();
    cleanup();

    installBridge({ ...fresh(), ...tracks, 'helper:status': () => status({ present: true, version: '7.1', path: 'C:\\x\\helper\\tools\\ffmpeg.exe', origin: 'installed', setup: { state: 'ready' } }) });
    openApp();
    await screen.findByText('Silent Song');
    await waitFor(() => expect(screen.queryByText(/ffmpeg/i)).toBeNull());
  });
});

describe('pairing', () => {
  const alone = (ui: React.ReactNode) => render(<ConfirmProvider>{ui}</ConfirmProvider>);

  it('shows the fingerprint to compare, and does not claim to be paired while waiting', async () => {
    let resolveAwait: ((value: unknown) => void) | null = null;
    const { invoked } = installBridge({
      'hub:pair-start': () => ({ challenge: { sessionId: '00000000-0000-7000-8000-000000000001', verificationFingerprint: 'ABCD-EF01', hubFingerprint: 'aa:bb:cc:dd', hubName: 'Front room hub', expiresAt: new Date(Date.now() + 60_000).toISOString() }, reason: null }),
      'hub:pair-await': () => new Promise((resolve) => (resolveAwait = resolve)),
    });
    alone(<HubView status={null} onChanged={() => undefined} />);

    // Pair is off until there is an address and a code, and says which is missing.
    const pair = screen.getByRole('button', { name: 'Pair' }) as HTMLButtonElement;
    expect(pair.disabled).toBe(true);
    expect(pair.title).toBe('Enter the hub’s address first.');
    await userEvent.type(screen.getByLabelText('Hub address'), 'http://hub.local:4546');
    await userEvent.type(screen.getByLabelText('Pairing code'), 'abcd1234');
    await userEvent.click(pair);
    expect(called(invoked, 'hub:pair-start')[0]?.request).toEqual({ endpoint: 'http://hub.local:4546', code: 'ABCD1234' });

    expect(await screen.findByText('ABCD-EF01')).toBeTruthy();
    expect(screen.getByText(/Waiting for someone at the hub to confirm/)).toBeTruthy();
    // Nothing on screen says it is connected until the hub has actually said so.
    expect(screen.queryByText(/^Connected$/)).toBeNull();
    expect(resolveAwait).not.toBeNull();
  });

  it('says why pairing did not start, in the hub’s own sentence', async () => {
    installBridge({ 'hub:pair-start': () => ({ challenge: null, reason: 'That code has expired. Make a new one in the hub.' }) });
    alone(<HubView status={null} onChanged={() => undefined} />);
    await userEvent.type(screen.getByLabelText('Hub address'), 'http://hub.local:4546');
    await userEvent.type(screen.getByLabelText('Pairing code'), 'OLD1{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('That code has expired. Make a new one in the hub.');
  });

  const connected = { endpoint: 'http://hub.local:4546', hubId: '00000000-0000-7000-8000-000000000002', hubName: 'Front room hub', hubFingerprint: 'aa:bb:cc:dd', connected: true, reason: null, scopes: ['library:share', 'playlists:sync', 'made:up'], lastSyncAt: null };

  it('states what is and is not shared, at the moment the choice is offered', async () => {
    installBridge({ 'hub:sharing': () => ({ enabled: false }), 'hub:share-library': () => ({ enabled: true, reason: null }) });
    alone(<HubView status={connected} onChanged={() => undefined} />);

    expect(screen.getByText(/What is never sent: the folders on this PC, or any path within them/)).toBeTruthy();
    expect(screen.getByText(/Audio files stay here until you send one yourself/)).toBeTruthy();
    // The sharing switch starts off: sharing is opted into, never assumed.
    const checkbox = screen.getByRole('checkbox', { name: /what music is on this PC/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    // What the hub allows is said in words, and a permission this build does not know is left out.
    expect(screen.getByText('Share this PC’s library and keep playlists in step.')).toBeTruthy();
    expect(scopeWords([])).toBe('Nothing yet.');
    // Until it is on there is nothing to sync, and Sync Now says so instead of sending anything.
    const sync = screen.getByRole('button', { name: 'Sync Now' }) as HTMLButtonElement;
    expect(sync.disabled).toBe(true);
    expect(sync.title).toBe('Turn on sharing below first: until then there is nothing to sync.');
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(sync.disabled).toBe(false);
  });

  it('shows sharing as it was left, not “off” every time the window opens', async () => {
    installBridge({ 'hub:sharing': () => ({ enabled: true }) });
    alone(<HubView status={connected} onChanged={() => undefined} />);
    const checkbox = screen.getByRole('checkbox', { name: /what music is on this PC/i }) as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));
  });

  it('asks before forgetting the hub, and says the music stays', async () => {
    const { invoked } = installBridge({ 'hub:sharing': () => ({ enabled: false }), 'hub:forget': () => ({ ...connected, endpoint: null, connected: false }) });
    const onChanged = vi.fn();
    alone(<HubView status={connected} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Forget This Hub…' }));
    expect(await screen.findByText('Forget Front room hub?')).toBeTruthy();
    expect(screen.getByText(/Your music and folders on this PC stay exactly as they are/)).toBeTruthy();
    expect(called(invoked, 'hub:forget')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Forget This Hub' }));
    await waitFor(() => expect(called(invoked, 'hub:forget')).toHaveLength(1));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});

describe('streaming to devices', () => {
  const alone = (ui: React.ReactNode) => render(<ConfirmProvider>{ui}</ConfirmProvider>);

  it('is off until it is turned on, and the pairing controls say so', async () => {
    const { invoked } = installBridge({ 'awsp:set-enabled': () => awsp({ enabled: true }) });
    const onChanged = vi.fn();
    alone(<StreamingView status={awsp()} onChanged={onChanged} />);
    expect(screen.getByText('Turn on streaming to pair a device')).toBeTruthy();
    expect(screen.getByText('Streaming is off')).toBeTruthy();
    const code = screen.getByRole('button', { name: 'New Code' }) as HTMLButtonElement;
    expect(code.disabled).toBe(true);
    expect(code.title).toBe('Turn on streaming first.');
    expect(screen.getByText('Nothing paired yet — enter the code on a device to pair it.')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /Let paired devices stream from this PC/ }));
    await waitFor(() => expect(called(invoked, 'awsp:set-enabled')[0]?.request).toEqual({ enabled: true }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ enabled: true })));
  });

  it('shows the code on the LCD with the time it has left, and asks before revoking a device', async () => {
    const running = awsp({
      enabled: true,
      running: true,
      endpointId: 'abc123',
      ticket: 'ticket-text',
      ticketQrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      pairingCode: { code: '417302', expiresAt: new Date(Date.now() + 9 * 60_000 + 30_000).toISOString() },
      devices: [{ id: 'dev-1', name: 'Sam’s Phone', clientKind: 'android', tierCap: 'high', pairedAt: NOW }],
      connections: [{ peer: 'dev-1', name: 'Sam’s Phone', type: 'direct', rttMs: 23 }],
    });
    const { invoked } = installBridge({ 'awsp:revoke': () => awsp({ enabled: true, running: true }) });
    alone(<StreamingView status={running} onChanged={() => undefined} />);
    expect(screen.getByText('417 302')).toBeTruthy();
    expect(screen.getByText(/^Code expires in 9:\d\d$/)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'QR code of this PC’s ticket' })).toBeTruthy();
    const devices = screen.getByRole('list', { name: 'Paired devices' });
    expect(within(devices).getByText('Sam’s Phone')).toBeTruthy();
    expect(within(devices).getByText('Android · direct · 23 ms')).toBeTruthy();
    await userEvent.click(within(devices).getByRole('button', { name: 'Revoke Sam’s Phone' }));
    expect(await screen.findByText('Stop “Sam’s Phone” streaming from this PC?')).toBeTruthy();
    expect(called(invoked, 'awsp:revoke')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(called(invoked, 'awsp:revoke')[0]?.request).toEqual({ id: 'dev-1' }));
  });
});

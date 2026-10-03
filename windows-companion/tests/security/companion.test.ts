/**
 * The companion's security boundaries, tested as behaviour rather than as configuration.
 *
 * Three things are checked here, because each of them is a way a desktop app that can read your
 * files goes wrong:
 *
 * 1. **Nothing path-shaped leaves the machine.** Filesystem paths are what makes this app useful
 *    and what makes it dangerous; `sanitize` is the one place that decides, and it is checked
 *    against fields it has never seen rather than only the ones on the denylist.
 * 2. **The renderer's capability list is exactly the channel list.** A capability that is not a
 *    named channel does not exist, so the preload allowlist and the schema registry must agree.
 * 3. **A link cannot start a program.** `shell.openExternal` on a `file:` URL is a way to run
 *    something; the companion opens web links and refuses everything else.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const openExternal = vi.fn(async (_url: string) => undefined);
vi.mock('electron', () => ({
  app: { requestSingleInstanceLock: () => true, on: () => undefined },
  shell: { openExternal: (url: string) => openExternal(url) },
}));

const { isPlainHttpOverInternet, sanitize } = await import('../../src/main/hub.js');
const { appUrlGuard, contentSecurityPolicy, isAllowedAppUrl, isTrustedSender, openExternally, permissionAllowed } = await import('../../src/main/security.js');
const { IPC_CHANNELS, IPC_EVENT_NAMES } = await import('../../src/shared/channels.js');
const { IPC, IPC_EVENTS } = await import('../../src/shared/ipc.js');

describe('nothing path-shaped leaves this computer', () => {
  it('drops the fields that name a location on disk', () => {
    const clean = sanitize({ id: 'abc', title: 'A Song', absolutePath: 'C:\\Users\\Sam\\Music\\a.flac', folderPath: 'D:\\Music', relativePath: 'Album/a.flac' });
    expect(clean).toEqual({ id: 'abc', title: 'A Song', relativePath: 'Album/a.flac' });
  });

  it('drops a Windows-shaped value even under a field name it has never seen', () => {
    // The denylist cannot be complete — this is the check that catches the field added next year.
    const clean = sanitize({ id: 'abc', someNewField: 'C:\\Users\\Sam\\Music\\a.flac', share: '\\\\nas\\music\\a.flac', note: 'Recorded in C major' });
    expect(clean).toEqual({ id: 'abc', note: 'Recorded in C major' });
  });

  it('keeps the relative path, which is what identifies a file inside a folder', () => {
    expect(sanitize({ relativePath: 'Miles Davis/Kind of Blue/01 So What.flac' })).toEqual({ relativePath: 'Miles Davis/Kind of Blue/01 So What.flac' });
  });

  it('leaves ordinary metadata alone', () => {
    const record = { id: 'x', title: 'So What', artistName: 'Miles Davis', durationMs: 545_000, year: 1959 };
    expect(sanitize(record)).toEqual(record);
  });
});

describe('the renderer can only do what is on the list', () => {
  it('has a schema for every channel the preload will forward, and no extras', () => {
    expect(Object.keys(IPC).sort()).toEqual([...IPC_CHANNELS].sort());
    expect(Object.keys(IPC_EVENTS).sort()).toEqual([...IPC_EVENT_NAMES].sort());
  });

  it('changes only the preferences a request names, and never the download folder', () => {
    const schema = IPC['app:preferences:set'].request;
    // Zod 4 fills `.default()`s inside optional fields; a partial of Preferences would reset the rest.
    expect(schema.parse({ autoSync: true })).toEqual({ autoSync: true });
    expect(schema.parse({})).toEqual({});
    expect(schema.safeParse({ downloadDirectory: 'C:\\Windows' }).success).toBe(false);
  });

  it('names no channel that could read an arbitrary file or run a command', () => {
    for (const channel of IPC_CHANNELS) {
      expect(channel).not.toMatch(/exec|spawn|shell|eval|read-?file|write-?file/i);
    }
  });
});

describe('the content security policy', () => {
  it('forbids remote and inline script in a packaged build', () => {
    const csp = contentSecurityPolicy(null);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it('relaxes only what the dev server needs, and only when there is one', () => {
    const dev = contentSecurityPolicy('http://localhost:5175');
    expect(dev).toContain("'unsafe-inline'");
    expect(dev).toContain('ws://localhost:5175');
    expect(contentSecurityPolicy(null)).toContain("connect-src 'self';");
  });

  it('is written into index.html, because a file:// page never receives the header', async () => {
    const html = await readFile(fileURLToPath(new URL('../../src/renderer/index.html', import.meta.url)), 'utf8');
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
    expect(meta?.[1]).toBe(contentSecurityPolicy(null));
  });
});

describe('the window only ever shows the app', () => {
  const indexFile = process.platform === 'win32' ? 'C:\\Program Files\\Airwave Companion\\resources\\app.asar\\dist\\renderer\\index.html' : '/opt/companion/resources/app.asar/dist/renderer/index.html';
  const indexUrl = pathToFileURL(indexFile).href;

  it('allows the bundled index.html, with or without a fragment', () => {
    expect(isAllowedAppUrl(indexUrl, null, indexFile)).toBe(true);
    expect(isAllowedAppUrl(`${indexUrl}#/hub`, null, indexFile)).toBe(true);
  });

  it('refuses any other local file, which would otherwise inherit the preload bridge', () => {
    expect(isAllowedAppUrl(pathToFileURL(join(indexFile, '..', 'other.html')).href, null, indexFile)).toBe(false);
    expect(isAllowedAppUrl('file:///C:/Users/Sam/Downloads/index.html', null, indexFile)).toBe(false);
    expect(isAllowedAppUrl(`${indexUrl}?x=1`, null, indexFile)).toBe(false);
    expect(isAllowedAppUrl('https://example.com/', null, indexFile)).toBe(false);
    expect(isAllowedAppUrl('not a url', null, indexFile)).toBe(false);
  });

  it('allows the dev server only in development, and nothing local alongside it', () => {
    expect(isAllowedAppUrl('http://localhost:5175/', 'http://localhost:5175', indexFile)).toBe(true);
    expect(isAllowedAppUrl('http://localhost:5176/', 'http://localhost:5175', indexFile)).toBe(false);
    expect(isAllowedAppUrl(indexUrl, 'http://localhost:5175', indexFile)).toBe(false);
  });

  it('trusts an IPC sender only when its frame is the app page', () => {
    const guard = appUrlGuard(null, indexFile);
    expect(isTrustedSender({ senderFrame: { url: indexUrl } }, guard)).toBe(true);
    expect(isTrustedSender({ senderFrame: { url: 'file:///C:/evil.html' } }, guard)).toBe(false);
    expect(isTrustedSender({ senderFrame: null }, guard)).toBe(false);
    expect(isTrustedSender({}, guard)).toBe(false);
  });

  it('lets its own page put text on the clipboard, and grants nothing else to anything', () => {
    const guard = appUrlGuard(null, indexFile);
    // Copy Ticket and the helper token's Copy need this; without it they fail silently.
    expect(permissionAllowed('clipboard-sanitized-write', indexUrl, guard)).toBe(true);
    for (const permission of ['clipboard-read', 'media', 'geolocation', 'notifications', 'openExternal', 'fullscreen', 'hid', 'serial', 'usb', 'fileSystem']) {
      expect(permissionAllowed(permission, indexUrl, guard), permission).toBe(false);
    }
    // Not another page, and not a request with no page behind it.
    expect(permissionAllowed('clipboard-sanitized-write', 'https://example.com/', guard)).toBe(false);
    expect(permissionAllowed('clipboard-sanitized-write', 'file:///C:/evil.html', guard)).toBe(false);
    expect(permissionAllowed('clipboard-sanitized-write', undefined, guard)).toBe(false);
    expect(permissionAllowed('clipboard-sanitized-write', null, guard)).toBe(false);
  });
});

describe('an unencrypted hub address', () => {
  it('is accepted quietly on this computer or a home network', () => {
    for (const endpoint of ['http://localhost:4546', 'http://127.0.0.1:4546', 'http://192.168.1.20:4546', 'http://10.0.0.5', 'http://172.20.0.2', 'http://nas:4546', 'http://nas.local', 'http://[::1]:4546', 'https://hub.example.com']) {
      expect(isPlainHttpOverInternet(endpoint)).toBe(false);
    }
  });

  it('is flagged when it crosses the internet', () => {
    for (const endpoint of ['http://hub.example.com', 'http://8.8.8.8:4546', 'http://172.32.0.1']) {
      expect(isPlainHttpOverInternet(endpoint)).toBe(true);
    }
  });
});

describe('opening a link', () => {
  it('opens a web link in the real browser', async () => {
    openExternal.mockClear();
    await expect(openExternally('https://example.com/help')).resolves.toEqual({ opened: true, reason: null });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/help');
  });

  it('refuses a scheme that could start a program, and says why', async () => {
    for (const url of ['file:///C:/Windows/System32/cmd.exe', 'ms-msdt:/id', 'javascript:alert(1)', 'vbscript:msgbox', 'smb://nas/share']) {
      openExternal.mockClear();
      const result = await openExternally(url);
      expect(result.opened).toBe(false);
      expect(result.reason).toMatch(/start a program|not a valid link/);
      expect(openExternal).not.toHaveBeenCalled();
    }
  });

  it('refuses a string that is not a link at all', async () => {
    await expect(openExternally('not a url')).resolves.toEqual({ opened: false, reason: 'That is not a valid link.' });
  });
});

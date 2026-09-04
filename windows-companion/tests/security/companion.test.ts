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
import { describe, expect, it, vi } from 'vitest';

const openExternal = vi.fn(async (_url: string) => undefined);
vi.mock('electron', () => ({
  app: { requestSingleInstanceLock: () => true, on: () => undefined },
  shell: { openExternal: (url: string) => openExternal(url) },
}));

const { sanitize } = await import('../../src/main/hub.js');
const { allowedOrigins, contentSecurityPolicy, openExternally } = await import('../../src/main/security.js');
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
    expect(allowedOrigins('http://localhost:5175')).toEqual(['http://localhost:5175', 'file://']);
    expect(allowedOrigins(null)).toEqual(['file://']);
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

/**
 * Electron hardening.
 *
 * Electron is a browser with filesystem access, so its default posture has to be narrowed
 * deliberately. Each control below closes a specific, documented path from "a page renders
 * something unexpected" to "a program runs on the user's machine":
 *
 * - **Context isolation and no node integration**: renderer JavaScript cannot reach Node at all.
 * - **A strict CSP with no inline or remote script**: the interface is bundled; nothing else loads.
 *   It is sent as a header (dev server) and written into `index.html` (packaged `file://` load).
 * - **Navigation is pinned**: the window may only ever show the bundled `index.html` (or the dev
 *   server in development) — not another local file, which would inherit the preload bridge.
 * - **New windows are refused**: `window.open` and target=_blank open in the real browser instead,
 *   and only for http(s) links.
 * - **IPC checks its sender**: a request from any frame other than the app page is refused.
 * - **Permissions are denied by default**: the companion needs no camera, microphone or location,
 *   so a request for one is refused rather than prompting.
 * - **WebView tags are stripped**: they are a second, weaker security boundary and are not used.
 */
import { app, shell, type BrowserWindow, type Session, type WebContents } from 'electron';
import { URL, pathToFileURL } from 'node:url';
import { contentSecurityPolicy } from './csp.js';

export { contentSecurityPolicy };

/** Decides whether a URL is the app itself. */
export type AppUrlGuard = (url: string) => boolean;

/**
 * True only for the app's own page: in development any page of the dev server's origin, otherwise
 * exactly the bundled `index.html` (a fragment is allowed; nothing else under `file://` is).
 */
export function isAllowedAppUrl(url: string, devServerUrl: string | null, indexFile: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (devServerUrl) return parsed.origin === new URL(devServerUrl).origin;
  if (parsed.protocol !== 'file:' || parsed.search) return false;
  const expected = pathToFileURL(indexFile);
  const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  return parsed.host === expected.host && same(decodeURIComponent(parsed.pathname), decodeURIComponent(expected.pathname));
}

export function appUrlGuard(devServerUrl: string | null, indexFile: string): AppUrlGuard {
  return (url) => isAllowedAppUrl(url, devServerUrl, indexFile);
}

/** Whether an IPC message came from the app page (and not from some other frame or page). */
export function isTrustedSender(event: { senderFrame?: { url: string } | null }, isAllowed: AppUrlGuard): boolean {
  const url = event.senderFrame?.url;
  return typeof url === 'string' && isAllowed(url);
}

/**
 * The one permission the app's own page has: putting text on the clipboard, which is what Copy
 * Ticket and the helper token's Copy do. Reading the clipboard is not it, and no other page gets
 * even this.
 */
export function permissionAllowed(permission: string, pageUrl: string | null | undefined, isAllowed: AppUrlGuard): boolean {
  return permission === 'clipboard-sanitized-write' && typeof pageUrl === 'string' && isAllowed(pageUrl);
}

export function applySessionSecurity(session: Session, devServerUrl: string | null, isAllowed: AppUrlGuard): void {
  const csp = contentSecurityPolicy(devServerUrl);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  // The companion needs no camera, microphone, location or notification. Denying rather than
  // prompting means a compromised page cannot even ask. Its own page may write text to the
  // clipboard, and that is all (see permissionAllowed).
  session.setPermissionRequestHandler((contents, permission, callback) => callback(permissionAllowed(permission, contents?.getURL(), isAllowed)));
  session.setPermissionCheckHandler((contents, permission) => permissionAllowed(permission, contents?.getURL(), isAllowed));

  // No device access at all: no serial, no HID, no USB, no Bluetooth.
  session.setDevicePermissionHandler(() => false);
}

export function applyWindowSecurity(window: BrowserWindow, isAllowed: AppUrlGuard): void {
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) {
      event.preventDefault();
      // openExternally itself refuses anything but http(s).
      void openExternally(url);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternally(url);
    return { action: 'deny' };
  });

  // A renderer that somehow attaches a webview loses its own preload and node access anyway.
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

/**
 * Open a link in the user's real browser — but only http(s). A `file:` or a custom scheme handed to
 * the shell is a way to start a program, so anything else is refused with a reason.
 */
export async function openExternally(url: string): Promise<{ opened: boolean; reason: string | null }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { opened: false, reason: 'That is not a valid link.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { opened: false, reason: `Links using ${parsed.protocol} are not opened, because that can start a program on your computer. Only web links are opened.` };
  }
  await shell.openExternal(parsed.toString());
  return { opened: true, reason: null };
}

/** Applied to every renderer as it is created, including any this code did not construct. */
export function guardWebContents(contents: WebContents, isAllowed: AppUrlGuard): void {
  contents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) event.preventDefault();
  });
  // A server redirect is a navigation too, and does not pass through will-navigate.
  contents.on('will-redirect', (event, url) => {
    if (!isAllowed(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    void openExternally(url);
    return { action: 'deny' };
  });
}

/** A single instance keeps two processes from writing the same database. */
export function enforceSingleInstance(onSecondInstance: () => void): boolean {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) return false;
  app.on('second-instance', onSecondInstance);
  return true;
}

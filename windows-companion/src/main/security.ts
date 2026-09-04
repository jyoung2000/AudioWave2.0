/**
 * Electron hardening.
 *
 * Electron is a browser with filesystem access, so its default posture has to be narrowed
 * deliberately. Each control below closes a specific, documented path from "a page renders
 * something unexpected" to "a program runs on the user's machine":
 *
 * - **Context isolation and no node integration**: renderer JavaScript cannot reach Node at all.
 * - **A strict CSP with no inline or remote script**: the interface is bundled; nothing else loads.
 * - **Navigation is pinned**: the window cannot be steered to a remote origin.
 * - **New windows are refused**: `window.open` and target=_blank open in the real browser instead,
 *   and only for http(s) links.
 * - **Permissions are denied by default**: the companion needs no camera, microphone or location,
 *   so a request for one is refused rather than prompting.
 * - **WebView tags are stripped**: they are a second, weaker security boundary and are not used.
 */
import { app, shell, type BrowserWindow, type Session, type WebContents } from 'electron';
import { URL } from 'node:url';

/** The only origins the window may ever be at: the bundled app, and the dev server in development. */
export function allowedOrigins(devServerUrl: string | null): string[] {
  return devServerUrl ? [new URL(devServerUrl).origin, 'file://'] : ['file://'];
}

export function contentSecurityPolicy(devServerUrl: string | null): string {
  const connect = ["'self'", 'http://localhost:*', 'http://127.0.0.1:*', 'https:', 'ws://localhost:*', 'ws://127.0.0.1:*', 'wss:'];
  // The dev server needs its own websocket and inline style for HMR; the packaged app allows neither.
  const script = devServerUrl ? ["'self'", devServerUrl, "'unsafe-inline'"] : ["'self'"];
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: http://localhost:* http://127.0.0.1:* https:",
    `connect-src ${connect.join(' ')}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
  ].join('; ');
}

export function applySessionSecurity(session: Session, devServerUrl: string | null): void {
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

  // The companion needs none of these. Denying rather than prompting means a compromised page
  // cannot even ask.
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);

  // No device access at all: no serial, no HID, no USB, no Bluetooth.
  session.setDevicePermissionHandler(() => false);
}

export function applyWindowSecurity(window: BrowserWindow, devServerUrl: string | null): void {
  const origins = allowedOrigins(devServerUrl);

  window.webContents.on('will-navigate', (event, url) => {
    if (!origins.some((origin) => url.startsWith(origin))) {
      event.preventDefault();
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
export function guardWebContents(contents: WebContents, devServerUrl: string | null): void {
  const origins = allowedOrigins(devServerUrl);
  contents.on('will-navigate', (event, url) => {
    if (!origins.some((origin) => url.startsWith(origin))) event.preventDefault();
  });
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

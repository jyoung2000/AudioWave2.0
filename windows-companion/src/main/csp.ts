/**
 * The renderer's content security policy.
 *
 * Kept free of Electron imports so the renderer build (`src/renderer/vite.config.ts`) and the
 * tests can read it: the packaged app loads its interface from `file://`, where no response header
 * is ever applied, so the same policy is also written into `src/renderer/index.html` as a `<meta>`
 * tag. A test keeps the two identical.
 *
 * The renderer reaches the main process only over IPC and loads nothing from the network, so
 * `connect-src` and `media-src` are limited to the app itself.
 */
export function contentSecurityPolicy(devServerUrl: string | null): string {
  const dev = devServerUrl ? new URL(devServerUrl) : null;
  // The dev server needs its own websocket and inline script for HMR; the packaged app allows neither.
  const script = dev ? ["'self'", dev.origin, "'unsafe-inline'"] : ["'self'"];
  const connect = dev ? ["'self'", dev.origin, `ws://${dev.host}`] : ["'self'"];
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src ${connect.join(' ')}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
  ].join('; ');
}

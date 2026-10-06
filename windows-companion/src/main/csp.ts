/**
 * The renderer's content security policy.
 *
 * Kept free of Electron imports so the renderer build (`src/renderer/vite.config.ts`) and the
 * tests can read it: the packaged app loads its interface from `file://`, where no response header
 * is ever applied, so the same policy is also written into `src/renderer/index.html` as a `<meta>`
 * tag. A test keeps the two identical.
 *
 * The renderer reaches the main process only over IPC, so `connect-src` is the app itself. The one
 * exception to "nothing from the network" is the Search tool's covers and 30-second previews
 * (DEC-039): `img-src` and `media-src` also allow the music services' artwork and clip hosts —
 * `CATALOG_MEDIA_HOSTS` in the contracts, over https only; a test keeps the two lists equal.
 */
export const CATALOG_MEDIA_SOURCES: readonly string[] = ['https://*.mzstatic.com', 'https://audio-ssl.itunes.apple.com', 'https://cdn-images.dzcdn.net', 'https://*.dzcdn.net', 'https://i.ytimg.com', 'https://*.sndcdn.com', 'https://archive.org', 'https://*.archive.org', 'https://i.scdn.co'];

export function contentSecurityPolicy(devServerUrl: string | null): string {
  const dev = devServerUrl ? new URL(devServerUrl) : null;
  // The dev server needs its own websocket and inline script for HMR; the packaged app allows neither.
  const script = dev ? ["'self'", dev.origin, "'unsafe-inline'"] : ["'self'"];
  const connect = dev ? ["'self'", dev.origin, `ws://${dev.host}`] : ["'self'"];
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${CATALOG_MEDIA_SOURCES.join(' ')}`,
    `media-src 'self' blob: ${CATALOG_MEDIA_SOURCES.join(' ')}`,
    `connect-src ${connect.join(' ')}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
  ].join('; ');
}

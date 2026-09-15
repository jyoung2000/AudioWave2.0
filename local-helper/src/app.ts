/**
 * Serving the player from the helper, which is what makes this one download instead of two.
 *
 * When the helper serves the page, the page and the tools share an origin. No CORS, no origin to
 * configure, no token to copy out of a terminal — the token goes into the document on its way out,
 * and the app finds it there. That is the whole reason this file exists: every awkward part of
 * talking to a program on localhost disappears if the program hands you the page.
 *
 * It takes either a built directory or the single-file build (`now-playing.html`). The single file
 * is the interesting case: it is already in the repository, already verified by a gate, and served
 * over http it is strictly better off than it is from `file://` — a real origin, so IndexedDB, the
 * origin-private file system and the rest all work properly.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { HELPER_TOKEN_META } from '@now-playing/contracts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface AppSource {
  /** The directory to serve from, or the directory holding the single file. */
  root: string;
  /** The document to serve at `/`, absolute. */
  index: string;
  /** True when there is nothing beside the document — the single-file build. */
  singleFile: boolean;
}

/** How far up from the program to look for a player before giving up. */
const SEARCH_DEPTH = 4;

/**
 * Work out what to serve.
 *
 * Two situations, and both should need no arguments. Downloaded, the helper sits in a folder beside
 * `now-playing.html` and finds it immediately. In a checkout it is several directories deep, so it
 * walks up — and at each level prefers a built directory, because that is the whole player with its
 * service worker and its split chunks, falling back to the single file, which is always there.
 */
export function findApp(explicit: string | null, from: string): AppSource | null {
  if (explicit) return sourceAt(explicit);
  let directory = resolve(from);
  for (let level = 0; level <= SEARCH_DEPTH; level += 1) {
    for (const candidate of [join(directory, 'app'), join(directory, 'music-player', 'dist'), join(directory, 'now-playing.html')]) {
      const source = sourceAt(candidate);
      if (source) return source;
    }
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function sourceAt(candidate: string): AppSource | null {
  if (!existsSync(candidate)) return null;
  if (statSync(candidate).isFile()) return { root: resolve(candidate, '..'), index: resolve(candidate), singleFile: true };
  const index = join(candidate, 'index.html');
  return existsSync(index) ? { root: resolve(candidate), index: resolve(index), singleFile: false } : null;
}

/**
 * Put the run's token into the document.
 *
 * It goes in a meta tag rather than a cookie or a header because the page has to read it from
 * JavaScript, and a meta tag is the one place a page can always look. It is not a secret from the
 * person using the app — it is a secret from every *other* page in their browser.
 */
export function withToken(html: string, token: string): string {
  const meta = `<meta name="${HELPER_TOKEN_META}" content="${token}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return `${html.slice(0, head.index + head[0].length)}${meta}${html.slice(head.index + head[0].length)}`;
  return `${meta}${html}`;
}

export interface ServeResult {
  served: boolean;
}

export function serveApp(source: AppSource, urlPath: string, token: string, response: ServerResponse): ServeResult {
  const path = urlPath === '/' || urlPath === '' ? source.index : withinRoot(source.root, urlPath);
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    // A built player is a single-page app: an unknown path is a route, not a missing file. The
    // single-file build has no routes, so there is nothing to fall back to and 404 is the truth.
    if (source.singleFile) return { served: false };
    return sendDocument(source.index, token, response);
  }
  if (path === source.index) return sendDocument(path, token, response);

  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  response.writeHead(200, {
    'content-type': type,
    'content-length': statSync(path).size,
    // Hashed asset names make this safe, and the document below is the one that must never stick.
    'cache-control': 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(path).pipe(response);
  return { served: true };
}

function sendDocument(path: string, token: string, response: ServerResponse): ServeResult {
  const html = withToken(readFileSync(path, 'utf8'), token);
  response.writeHead(200, {
    'content-type': TYPES['.html']!,
    'content-length': Buffer.byteLength(html),
    // The token changes every run, so a cached copy of the document is a copy that cannot talk.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(html);
  return { served: true };
}

/**
 * Resolve a request path inside the root, or refuse.
 *
 * A climb out is refused rather than clamped. Normalising `/../../etc/passwd` into something inside
 * the root would also be safe — the check at the end sees to that either way — but it turns a
 * request that was obviously an attempt into a quiet 404 for a path nobody asked for. Saying no to
 * the segment itself is shorter to read and leaves a log line that means what it says.
 */
export function withinRoot(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '');
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segments = decoded.split(/[/\\]/);
  if (segments.some((segment) => segment === '..')) return null;
  const candidate = resolve(root, `./${segments.filter(Boolean).join('/')}`);
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}

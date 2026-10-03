/**
 * What the helper will and will not do for whoever is on the socket.
 *
 * A program that runs subprocesses and listens on a port is the most dangerous thing in this
 * repository, so the rules are short enough to hold in your head:
 *
 *   1. It binds to loopback. Nothing outside this machine can reach it at all — unless the
 *      companion's "use the helper without pairing on this network" is on, and then another device
 *      reaches only the four token-free read routes in `LAN_READ_ROUTES`, and nothing else.
 *   2. A page may only talk to it if its origin is allowed. Every request is checked, not just the
 *      preflight — a `fetch` that skips preflight must not slip a side effect through.
 *   3. Anything that starts work needs the run token. It is new every start, so a page that saw one
 *      yesterday has nothing today.
 *   4. The client names a URL, a tool and a format. It never names an argument. A page that could
 *      pass flags to a subprocess is a page that can run anything.
 *   5. The URL must be on the allowlist, must be https, and must not resolve to this network.
 *
 * Rule 4 is the one worth being stubborn about. Every remote-code-execution bug in a thing like
 * this is the same bug: a string from outside reached a command line.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { validateOutboundUrl } from '@now-playing/domain';

/** A fresh secret per run, long enough that guessing it is not a strategy. */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function tokenMatches(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  // Compare the length separately: timingSafeEqual throws on a mismatch, and the length of a token
  // is not a secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface OriginPolicy {
  /** Origins allowed in addition to the helper's own. Exact matches, scheme and port included. */
  allowed: readonly string[];
  /** The helper's own origin, when it is serving the player. */
  self: string | null;
  /**
   * Answer a page served from this machine's loopback address on any port — the companion's case,
   * where the player is opened from the hub (127.0.0.1:4546), a dev server or the installed PWA,
   * never from the helper itself. A remote site still cannot talk to it, and the Host check below
   * still stops a rebound name.
   */
  loopbackPages?: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackPage(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname) && url.origin === origin;
  } catch {
    return false;
  }
}

/**
 * Whether a request may be answered at all.
 *
 * The rule follows what browsers actually send. A cross-origin request always carries `Origin`, and
 * so does any same-origin request that is not a GET — so an absent `Origin` means either the app
 * reading on its own origin or something that is not a page at all, and since the socket is
 * loopback-only, both are fine. The token is what stands between those and doing any work.
 *
 * `null` is refused on purpose. It is the origin of a sandboxed frame and of a page opened from
 * disk, and neither can be told apart from a hostile one — so the supported way to use the
 * single-file build with a helper is to let the helper serve it.
 */
export function originAllowed(policy: OriginPolicy, origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === 'null' || origin === '') return false;
  if (policy.self && selfOrigins(policy.self).includes(origin)) return true;
  if (policy.loopbackPages && isLoopbackPage(origin)) return true;
  return policy.allowed.includes(origin);
}

/** The helper's own origin, and the same port spelled `localhost`, which is the same socket. */
function selfOrigins(self: string): string[] {
  const url = new URL(self);
  return [self, `${url.protocol}//localhost:${url.port}`];
}

/**
 * Whether the `Host` header names this helper.
 *
 * This is the DNS-rebinding check. A hostile page can point its own name at 127.0.0.1 and then read
 * responses as same-origin — no `Origin` header, so the check above lets it through — and the
 * document served at `/` carries the token. The browser still sends the hostile name in `Host`, so
 * anything that is not a loopback spelling of this port is refused.
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}` || value === `[::1]:${port}`;
}

/**
 * The routes another device on this network may reach when the companion lets it (Settings ▸
 * Network, off by default): the ones that need no token and only read — whether a helper is here,
 * a radio station's title, and the Live TV channels and guide. Everything else stays this PC's.
 */
export const LAN_READ_ROUTES: readonly string[] = ['/helper/v1/health', '/helper/v1/radio/now-playing', '/helper/v1/tv/channels', '/helper/v1/tv/guide'];

/** Whether a socket's peer is this machine. Node spells IPv4 loopback inside IPv6 as `::ffff:127.x`. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.toLowerCase();
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.');
}

/** An IPv4 address on a home or office network: 10/8, 172.16/12, 192.168/16, or link-local 169.254/16. */
export function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if ([a, b, Number(match[3]), Number(match[4])].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Whether a page another device on this network served may read the LAN routes: an http(s) origin
 * whose host is a private IPv4 address, spelled exactly as a browser sends it. A name is not
 * accepted — any website can make a name resolve to a private address — and neither is a public
 * address.
 */
export function lanPageAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin && isPrivateIpv4(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The `Host` a device on this network sends: one of this PC's own network addresses and this port.
 * The DNS-rebinding check, for the LAN: a hostile name pointed at this PC still arrives as that name.
 */
export function lanHostAllowed(host: string | undefined, port: number, ownAddresses: readonly string[]): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  return ownAddresses.some((address) => value === `${address}:${port}`);
}

export interface UrlCheck {
  ok: boolean;
  url?: URL;
  reason?: string;
}

/**
 * The URL a fetch may name.
 *
 * `validateOutboundUrl` already refuses credentials in the URL, non-https schemes and anything that
 * points at a private address — the last of which matters here more than anywhere else, because
 * this program runs on the inside of someone's network.
 */
export function checkFetchUrl(input: string, allowedHosts: readonly string[]): UrlCheck {
  // An empty list means "anything" to the shared validator; here it can only be a mistake.
  if (!allowedHosts.length) return { ok: false, reason: 'The host allowlist is empty, so nothing may be fetched.' };
  const result = validateOutboundUrl(input, { allowedHosts, allowedSchemes: ['https:'], maxLength: 2048 });
  if (!result.ok || !result.url) return { ok: false, ...(result.reason ? { reason: result.reason } : {}) };
  return { ok: true, url: result.url };
}

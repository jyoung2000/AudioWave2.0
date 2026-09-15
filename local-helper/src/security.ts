/**
 * What the helper will and will not do for whoever is on the socket.
 *
 * A program that runs subprocesses and listens on a port is the most dangerous thing in this
 * repository, so the rules are short enough to hold in your head:
 *
 *   1. It binds to loopback. Nothing outside this machine can reach it at all.
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
  if (policy.self && origin === policy.self) return true;
  return policy.allowed.includes(origin);
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
  const result = validateOutboundUrl(input, { allowedHosts, allowedSchemes: ['https:'], maxLength: 2048 });
  if (!result.ok || !result.url) return { ok: false, ...(result.reason ? { reason: result.reason } : {}) };
  return { ok: true, url: result.url };
}

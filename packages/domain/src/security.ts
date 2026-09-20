/** Security helpers shared by every product. All pure; no I/O. */

export interface UrlValidationResult {
  ok: boolean;
  reason?: string;
  url?: URL;
}

const DEFAULT_SCHEMES = ['https:'];

function isPrivateIpv4(bytes: readonly number[]): boolean {
  const [a, b, c] = [bytes[0]!, bytes[1]!, bytes[2]!];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast/reserved/broadcast
  return false;
}

function parseIpv4(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return parts.some((n) => n > 255) ? null : parts;
}

/** Parse any textual IPv6 form (compressed, zone id, embedded dotted IPv4) into 16 bytes. */
export function parseIpv6(input: string): number[] | null {
  let h = input.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  if (!h.includes(':') || !/^[0-9a-f:.]+$/.test(h)) return null;
  // An embedded dotted IPv4 tail becomes two hex groups.
  const lastColon = h.lastIndexOf(':');
  const tail = h.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    h = `${h.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function isPrivateIpv6(b: readonly number[]): boolean {
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d (incl. :: and ::1), SIIT ::ffff:0:a.b.c.d
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4(b.slice(12));
  if (zeros(0, 12)) return true;
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return isPrivateIpv4(b.slice(12));
  // NAT64 64:ff9b::/96 and local-use 64:ff9b:1::/48 can reach arbitrary IPv4 targets.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;
  // 6to4 2002::/16 embeds an IPv4 address.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4(b.slice(2, 6));
  // Teredo 2001::/32 embeds an obfuscated address; documentation 2001:db8::/32.
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))) return true;
  // Only global unicast 2000::/3 is public; everything else (ULA, link/site-local, multicast, discard) is not.
  return (b[0]! & 0xe0) !== 0x20;
}

/** Is this an IPv4/IPv6 literal (or special hostname) that points at private, loopback, link-local, multicast, CGNAT or metadata ranges? */
export function isPrivateAddress(host: string): boolean {
  const h = host
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') return true;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    const v4 = parseIpv4(h);
    return v4 ? isPrivateIpv4(v4) : true;
  }
  if (h.includes(':')) {
    const v6 = parseIpv6(h);
    return v6 ? isPrivateIpv6(v6) : true; // unparseable literals are refused
  }
  // decimal / hex / octal / short-form IPv4 obfuscation (127.1, 0x7f.1, 2130706433)
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/.test(h)) return true;
  return false;
}

/** Match host against an allowlist that may contain wildcards ("*.youtube.com" matches subdomains, not the apex unless listed). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

/**
 * Validate an outbound URL for provider fetches: scheme + host allowlist + no private targets + no credentials.
 * An empty `allowedHosts` denies every host; a caller that genuinely accepts any public host must say so with
 * `allowAnyHost: true`.
 */
export function validateOutboundUrl(input: string, options: { allowedHosts: readonly string[]; allowedSchemes?: readonly string[]; maxLength?: number; allowAnyHost?: boolean } = { allowedHosts: [] }): UrlValidationResult {
  if (input.length > (options.maxLength ?? 2048)) return { ok: false, reason: 'URL too long' };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'Malformed URL' };
  }
  const schemes = options.allowedSchemes ?? DEFAULT_SCHEMES;
  if (!schemes.includes(url.protocol)) return { ok: false, reason: `Scheme ${url.protocol} not allowed` };
  if (url.username || url.password) return { ok: false, reason: 'Credentials in URL are not allowed' };
  if (!url.hostname) return { ok: false, reason: 'Missing host' };
  if (isPrivateAddress(url.hostname)) return { ok: false, reason: 'Private or local addresses are blocked' };
  if (!options.allowAnyHost) {
    if (!options.allowedHosts.length) return { ok: false, reason: 'No hosts are allowed for this request' };
    const host = url.hostname.replace(/\.$/, '');
    if (!options.allowedHosts.some((p) => hostMatches(host, p))) return { ok: false, reason: `Host ${url.hostname} is not on the allowlist` };
  }
  return { ok: true, url };
}

/** Resolved-address check to be run after DNS resolution (defeats rebinding). */
export function isResolvedAddressAllowed(addresses: readonly string[]): { ok: boolean; reason?: string } {
  if (!addresses.length) return { ok: false, reason: 'No addresses resolved' };
  const bad = addresses.find((a) => isPrivateAddress(a));
  return bad ? { ok: false, reason: `Resolved to a private address (${bad})` } : { ok: true };
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\x00-\x1f<>:"/\\|?*]/g;

/** Safe cross-platform filename. Never returns an empty string, dot-only names, reserved names or path separators. */
export function sanitizeFilename(name: string, options: { maxLength?: number; fallback?: string } = {}): string {
  const maxLength = options.maxLength ?? 180;
  let out = name
    .normalize('NFC')
    .replace(UNSAFE_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`;
  if (!out || out === '.' || out === '..') out = options.fallback ?? 'untitled';
  if (out.length > maxLength) {
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(out)?.[0] ?? '';
    out = out.slice(0, maxLength - ext.length).replace(/[. ]+$/, '') + ext;
  }
  return out;
}

/** Render a filename template such as "{artist} - {title}" with sanitized values. Unknown tokens are removed. */
export function renderFilenameTemplate(template: string, values: Record<string, string | number | null | undefined>, extension: string): string {
  const body = template.replace(/\{([a-zA-Z_]+)\}/g, (_m, key: string) => {
    const v = values[key];
    return v === null || v === undefined ? '' : sanitizeFilename(String(v), { maxLength: 80, fallback: '' });
  });
  const ext = extension.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return `${sanitizeFilename(body, { fallback: 'track' })}${ext ? `.${ext}` : ''}`;
}

function normalizeSegments(path: string): string[] | null {
  const segs = path.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(s);
  }
  return out;
}

/** True when `candidate` (relative) stays inside a root after normalisation; rejects traversal, NUL bytes and absolute paths. */
export function isSafeRelativePath(candidate: string): boolean {
  if (!candidate || candidate.includes('\0')) return false;
  if (/^([a-zA-Z]:|[\\/])/.test(candidate)) return false;
  if (/^\\\\/.test(candidate)) return false;
  const segs = normalizeSegments(candidate);
  return segs !== null && segs.length > 0 && !segs.some((s) => WINDOWS_RESERVED.test(s));
}

/** Join a root and a relative path using pure string logic; returns null when the result would escape the root. */
export function joinInsideRoot(root: string, relative: string): string | null {
  if (!isSafeRelativePath(relative)) return null;
  const segs = normalizeSegments(relative)!;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  return `${trimmed}${sep}${segs.join(sep)}`;
}

const SECRET_KEY_RE = /(token|secret|password|passwd|pwd|authorization|cookie|api[-_]?key|client[-_]?secret|refresh|bearer|credential|private[-_]?key|set-cookie)/i;
const SECRET_VALUE_RE = /(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{16,})/g;

/** Deep-redact secrets from any log/diagnostic structure. Keys matching common secret names and values that look like tokens are masked. */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 12) return '[depth]' as unknown as T;
  if (typeof value === 'string') return value.replace(SECRET_VALUE_RE, '[REDACTED]') as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? (v === null || v === undefined ? v : '[REDACTED]') : redactSecrets(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Privacy-minimised IP display: 203.0.113.x / 2001:db8:1234::/48 */
export function truncateIp(ip: string): string {
  const v = ip.replace(/^::ffff:/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split('.').slice(0, 3).join('.') + '.x';
  if (v.includes(':')) {
    const groups = v.split('::')[0]!.split(':').filter(Boolean).slice(0, 3);
    return `${groups.join(':')}::/48`;
  }
  return 'unknown';
}

export function maskSecretHint(secret: string): string {
  if (!secret) return '';
  return `••••${secret.slice(-4)}`;
}

/** Parse a CIDR and test membership (IPv4 and IPv6). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsText] = cidr.split('/');
  if (!range) return false;
  const bits = bitsText === undefined ? (range.includes(':') ? 128 : 32) : Number(bitsText);
  const a = ipToBytes(ip.replace(/^::ffff:/, ''));
  const b = ipToBytes(range);
  if (!a || !b || a.length !== b.length) return false;
  let remaining = bits;
  for (let i = 0; i < a.length; i += 1) {
    if (remaining <= 0) return true;
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
    if ((a[i]! & mask) !== (b[i]! & mask)) return false;
    remaining -= 8;
  }
  return true;
}

function ipToBytes(ip: string): number[] | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    return parts.some((p) => p > 255) ? null : parts;
  }
  if (ip.includes(':')) {
    const halves = ip.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
    if (groups.length !== 8) return null;
    const bytes: number[] = [];
    for (const g of groups) {
      const n = Number.parseInt(g || '0', 16);
      if (Number.isNaN(n) || n > 0xffff) return null;
      bytes.push(n >> 8, n & 0xff);
    }
    return bytes;
  }
  return null;
}

/** Sniff common audio containers from leading bytes instead of trusting the extension. */
export function sniffAudioMime(head: Uint8Array): string | null {
  const ascii = (o: number, n: number) => String.fromCharCode(...head.slice(o, o + n));
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (head.length >= 4 && ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (head.length >= 4 && ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (head.length >= 3 && ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe6) === 0xe2) return 'audio/mpeg';
  if (head.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    return brand.startsWith('M4A') || brand.startsWith('mp4') || brand.startsWith('iso') ? 'audio/mp4' : 'video/mp4';
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'audio/webm';
  return null;
}

export const BROWSER_DECODABLE_MIME = new Set(['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/webm', 'audio/aac']);

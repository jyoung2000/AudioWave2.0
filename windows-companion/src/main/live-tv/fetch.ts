/**
 * Reading a link someone pasted, safely.
 *
 * The address comes from a text field, so everything a pasted address could abuse is closed off
 * before and while it is read — the same rules the radio reader keeps (packages/domain
 * `radio-node.ts`): only http(s), no credentials, no private or loopback address (checked on the
 * name and again on every address it resolves to, so DNS rebinding cannot reach the inside of the
 * network), at most five redirects with each hop checked again, a deadline, and a cap on what is
 * read both on the wire and after decompression.
 *
 * The body is handed over as text, a piece at a time: nothing here keeps the whole file, so a guide
 * of a few hundred megabytes costs the memory of one piece. A gzip body is recognised by its first
 * two bytes rather than by the address's ending, because `.xml.gz` is a habit, not a rule.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { createGunzip, type Gunzip } from 'node:zlib';
import { isResolvedAddressAllowed, validateOutboundUrl } from '@now-playing/domain';

export type LinkFailure = 'invalid' | 'private' | 'unreachable' | 'status' | 'timeout' | 'too-large' | 'unreadable';

/** Why a link could not be read. `kind` is what the caller words for the person; `message` is for the log. */
export class LinkError extends Error {
  constructor(
    readonly kind: LinkFailure,
    message: string,
  ) {
    super(message);
    this.name = 'LinkError';
  }
}

export interface ReadLinkOptions {
  timeoutMs: number;
  /** Bytes on the wire. */
  maxBytes: number;
  /** Bytes after decompression: what stops a small gzip file from unfolding without end. */
  maxDecodedBytes: number;
  userAgent: string;
  signal?: AbortSignal;
  /** Tests serve fixtures from 127.0.0.1. Never set outside a test. */
  allowPrivateNetworkForTests?: boolean;
}

export interface ReadLinkResult {
  bytes: number;
  decodedBytes: number;
  gzip: boolean;
  finalUrl: string;
}

/** Reads `url` and calls `onText` with each decoded piece, in order. */
export type ReadLink = (url: string, options: ReadLinkOptions, onText: (text: string) => void) => Promise<ReadLinkResult>;

const MAX_REDIRECTS = 5;

/** Checks an address before anything is connected. Returns the reason it is refused, or null. */
export function checkLink(input: string, allowPrivateNetworkForTests = false): LinkError | null {
  const checked = validateOutboundUrl(input.trim(), { allowedHosts: [], allowAnyHost: true, allowedSchemes: ['http:', 'https:'] });
  if (checked.ok) return null;
  if (checked.reason === 'Private or local addresses are blocked') return allowPrivateNetworkForTests ? null : new LinkError('private', checked.reason);
  return new LinkError('invalid', checked.reason ?? 'That address cannot be read');
}

export const readLink: ReadLink = async (input, options, onText) => {
  const deadline = Date.now() + options.timeoutMs;
  let url = input.trim();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const refused = checkLink(url, options.allowPrivateNetworkForTests);
    if (refused) throw refused;
    const left = deadline - Date.now();
    if (left <= 0) throw new LinkError('timeout', 'The link did not answer in time');
    const outcome = await once(url, { ...options, timeoutMs: left }, onText);
    if ('redirect' in outcome) {
      try {
        url = new URL(outcome.redirect, url).toString();
      } catch {
        throw new LinkError('unreachable', 'The link redirected somewhere unreadable');
      }
      continue;
    }
    return { ...outcome, finalUrl: url };
  }
  throw new LinkError('unreachable', 'The link redirected too many times');
};

/** The encoding an XML declaration names, when it is one `TextDecoder` knows; UTF-8 otherwise. */
function declaredEncoding(head: Buffer): string {
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  const match = /<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head.subarray(0, 200).toString('latin1'));
  if (!match) return 'utf-8';
  try {
    return new TextDecoder(match[1]).encoding;
  } catch {
    return 'utf-8';
  }
}

function once(url: string, options: ReadLinkOptions, onText: (text: string) => void): Promise<Omit<ReadLinkResult, 'finalUrl'> | { redirect: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    let settled = false;
    let gunzip: Gunzip | null = null;

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      gunzip?.destroy();
      request.destroy();
    };
    const fail = (error: LinkError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value: Omit<ReadLinkResult, 'finalUrl'> | { redirect: string }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = (): void => fail(new LinkError('unreachable', 'Stopped'));

    const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
      dnsLookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
        if (err) return callback(err, '', 0);
        const list = addresses as unknown as LookupAddress[];
        const verdict = isResolvedAddressAllowed(list.map((a) => a.address));
        if (!verdict.ok && !options.allowPrivateNetworkForTests) return callback(new Error(`private: ${verdict.reason ?? 'Blocked address'}`), '', 0);
        if (lookupOptions.all) return callback(null, list);
        const first = list[0]!;
        return callback(null, first.address, first.family);
      });
    };

    const request = client.get(target, { headers: { 'User-Agent': options.userAgent, Accept: '*/*', 'Accept-Encoding': 'identity' }, lookup }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) return succeed({ redirect: response.headers.location });
      if (status !== 200) return fail(new LinkError('status', `The link answered ${status}`));
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > options.maxBytes) return fail(new LinkError('too-large', 'The file is larger than the limit'));

      let bytes = 0;
      let decodedBytes = 0;
      let decoder: TextDecoder | null = null;
      let first = true;
      let isGzip = false;

      const text = (chunk: Buffer): void => {
        decodedBytes += chunk.length;
        if (decodedBytes > options.maxDecodedBytes) return fail(new LinkError('too-large', 'The file unpacks to more than the limit'));
        decoder ??= new TextDecoder(declaredEncoding(chunk));
        const piece = decoder.decode(chunk, { stream: true });
        if (!piece) return;
        try {
          onText(piece);
        } catch (err) {
          fail(new LinkError('unreadable', err instanceof Error ? err.message : String(err)));
        }
      };
      const finish = (): void => {
        const tail = decoder?.decode() ?? '';
        if (tail) onText(tail);
        succeed({ bytes, decodedBytes, gzip: isGzip });
      };

      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > options.maxBytes) return fail(new LinkError('too-large', 'The file is larger than the limit'));
        if (first) {
          first = false;
          isGzip = chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b;
          if (isGzip) {
            gunzip = createGunzip();
            gunzip.on('data', text);
            gunzip.on('end', finish);
            gunzip.on('error', () => fail(new LinkError('unreadable', 'The file could not be unpacked')));
          }
        }
        if (gunzip) {
          // Honour the unpacker's pace, so a fast download cannot pile up behind a slow parse.
          if (!gunzip.write(chunk)) {
            response.pause();
            gunzip.once('drain', () => response.resume());
          }
        } else {
          text(chunk);
        }
      });
      response.on('end', () => {
        if (settled) return;
        if (gunzip) gunzip.end();
        else finish();
      });
      response.on('error', () => fail(new LinkError('unreachable', 'The link stopped sending')));
    });
    request.on('error', (err) => fail(new LinkError(/private/i.test(err.message) ? 'private' : 'unreachable', err.message)));
    const timer = setTimeout(() => fail(new LinkError('timeout', 'The link did not answer in time')), options.timeoutMs);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

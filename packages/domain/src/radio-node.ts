/**
 * Reading what a radio station is playing, over the network. Node only — imported by the hub and
 * the local helper through `@now-playing/domain/radio-node`, never re-exported from the package
 * index, because the player bundles that index for the browser.
 *
 * One short connection per question: ask for metadata, skip the audio up to the first title, close.
 * Everything a URL from a page could abuse is closed off: only http(s), no credentials, no private
 * or loopback address — checked on the name and again on every address it resolves to, so DNS
 * rebinding cannot reach the inside of the network — at most three redirects, a byte cap and a
 * deadline.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import tls from 'node:tls';
import { IcyReader, parseStreamTitle, splitOnAir } from './icy.js';
import { isResolvedAddressAllowed, validateOutboundUrl } from './security.js';

export interface StationTitle {
  /** The StreamTitle exactly as the station sent it. */
  raw: string | null;
  artist: string | null;
  title: string | null;
  /** The station's own name (`icy-name`), when it sends one. */
  station: string | null;
  /** Why there is no title, in words a person can read; null when there is one. */
  reason: string | null;
}

export interface ReadStationTitleOptions {
  timeoutMs?: number;
  /** Stop reading after this many bytes even if no title has arrived. */
  maxBytes?: number;
  userAgent?: string;
  /** Tests run the station on 127.0.0.1. Never set outside a test. */
  allowPrivateNetworkForTests?: boolean;
}

const MAX_REDIRECTS = 3;

function none(reason: string, station: string | null = null): StationTitle {
  return { raw: null, artist: null, title: null, station, reason };
}

export async function readStationTitle(input: string, options: ReadStationTitleOptions = {}): Promise<StationTitle> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const deadline = Date.now() + timeoutMs;
  let url = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = validateOutboundUrl(url, { allowedHosts: [], allowAnyHost: true, allowedSchemes: ['http:', 'https:'] });
    if (!checked.ok) {
      const privateOnly = checked.reason === 'Private or local addresses are blocked';
      if (!(privateOnly && options.allowPrivateNetworkForTests)) return none(checked.reason ?? 'That address cannot be read');
    }
    const left = deadline - Date.now();
    if (left <= 0) return none('The station did not answer in time');
    const outcome = await once(url, { ...options, timeoutMs: left });
    if ('redirect' in outcome) {
      try {
        url = new URL(outcome.redirect, url).toString();
      } catch {
        return none('The station redirected somewhere unreadable');
      }
      continue;
    }
    return outcome;
  }
  return none('The station redirected too many times');
}

function once(url: string, options: ReadStationTitleOptions & { timeoutMs: number }): Promise<StationTitle | { redirect: string }> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const maxBytes = options.maxBytes ?? 512 * 1024;
    const startedAt = Date.now();
    let settled = false;
    const finish = (value: StationTitle | { redirect: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(value);
    };
    const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
      dnsLookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
        if (err) return callback(err, '', 0);
        const list = addresses as unknown as LookupAddress[];
        const verdict = isResolvedAddressAllowed(list.map((a) => a.address));
        if (!verdict.ok && !options.allowPrivateNetworkForTests) return callback(new Error(verdict.reason ?? 'Blocked address'), '', 0);
        if (lookupOptions.all) return callback(null, list);
        const first = list[0]!;
        return callback(null, first.address, first.family);
      });
    };
    const request = client.get(
      target,
      {
        headers: { 'Icy-MetaData': '1', 'User-Agent': options.userAgent ?? 'NowPlaying/1.0', Accept: '*/*' },
        lookup,
        // SHOUTcast v1 answers "ICY 200 OK" and headers that are not quite HTTP.
        insecureHTTPParser: true,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) return finish({ redirect: response.headers.location });
        if (status !== 200) return finish(none(`The station answered ${status}`));
        const feed = titleConsumer(response.headers, maxBytes, finish);
        if (!feed) return;
        response.on('data', feed);
        response.on('end', () => finish(none('The station sent no song title', headerText(response.headers['icy-name']))));
        response.on('error', () => finish(none('The station stopped sending', headerText(response.headers['icy-name']))));
      },
    );
    request.on('error', (err) => {
      // Node's parser refuses SHOUTcast v1's "ICY 200 OK" even in lenient mode; read that one raw.
      if (/^HPE_/.test((err as NodeJS.ErrnoException).code ?? '') && !settled) {
        settled = true;
        clearTimeout(timer);
        request.destroy();
        // What is left of this hop's time, not the whole of it again.
        void rawOnce(target, { ...options, timeoutMs: Math.max(1, options.timeoutMs - (Date.now() - startedAt)) }, lookup, maxBytes).then(resolve);
        return;
      }
      finish(none(/private/i.test(err.message) ? 'Private or local addresses are blocked' : 'The station could not be reached'));
    });
    const timer = setTimeout(() => finish(none('The station did not answer in time')), options.timeoutMs);
  });
}

/**
 * The part both transports share: given the response headers, a function that eats body bytes and
 * finishes with the first title. Null (and already finished) when the station sends no metadata.
 */
function titleConsumer(headers: Record<string, string | string[] | undefined>, maxBytes: number, finish: (value: StationTitle) => void): ((chunk: Buffer) => void) | null {
  const stationName = headerText(headers['icy-name']);
  const metaint = Number.parseInt(headerText(headers['icy-metaint']) ?? '', 10);
  if (!Number.isInteger(metaint) || metaint <= 0 || metaint > 256 * 1024) {
    finish(none('This station does not send song titles', stationName));
    return null;
  }
  const reader = new IcyReader(metaint);
  let seen = 0;
  let blocks = 0;
  return (chunk: Buffer) => {
    seen += chunk.length;
    for (const meta of reader.feed(chunk)) {
      blocks += 1;
      const raw = parseStreamTitle(meta);
      if (raw) {
        const parts = splitOnAir(raw);
        finish({ raw, artist: parts?.artist ?? null, title: parts?.title ?? null, station: stationName, reason: parts ? null : 'The station sent no song title' });
        return;
      }
    }
    // Two empty blocks in a row is a station between songs; asking again later is the answer.
    if (blocks >= 2 || seen > maxBytes) finish(none('The station sent no song title', stationName));
  };
}

/** The same request over a bare socket, for servers whose status line is "ICY 200 OK". */
function rawOnce(target: URL, options: ReadStationTitleOptions & { timeoutMs: number }, lookup: LookupFunction, maxBytes: number): Promise<StationTitle | { redirect: string }> {
  return new Promise((resolve) => {
    const secure = target.protocol === 'https:';
    const port = Number(target.port) || (secure ? 443 : 80);
    const socket = secure ? tls.connect({ host: target.hostname, port, servername: target.hostname, lookup }) : net.connect({ host: target.hostname, port, lookup });
    let settled = false;
    const finish = (value: StationTitle | { redirect: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(none('The station did not answer in time')), options.timeoutMs);
    let head: Buffer = Buffer.alloc(0);
    let feed: ((chunk: Buffer) => void) | null = null;
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      socket.write(`GET ${target.pathname}${target.search} HTTP/1.0\r\nHost: ${target.host}\r\nIcy-MetaData: 1\r\nUser-Agent: ${options.userAgent ?? 'NowPlaying/1.0'}\r\nAccept: */*\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      if (feed) return feed(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 16 * 1024) finish(none('The station sent a reply this cannot read'));
        return;
      }
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      const status = /^(?:ICY|HTTP\/1\.[01]) (\d{3})/.exec(lines[0] ?? '');
      if (!status) return finish(none('The station sent a reply this cannot read'));
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      const code = Number(status[1]);
      if (code >= 300 && code < 400 && headers['location']) return finish({ redirect: headers['location'] });
      if (code !== 200) return finish(none(`The station answered ${code}`));
      feed = titleConsumer(headers, maxBytes, finish);
      const rest = head.subarray(end + 4);
      if (feed && rest.length) feed(rest);
    });
    socket.on('end', () => finish(none('The station sent no song title')));
    socket.on('error', (err) => finish(none(/private/i.test(err.message) ? 'Private or local addresses are blocked' : 'The station could not be reached')));
  });
}

function headerText(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || null;
}

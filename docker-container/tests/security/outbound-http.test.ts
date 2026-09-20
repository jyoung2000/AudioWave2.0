/**
 * Outbound HTTP hardening: every textual form of a private address is refused, an empty allowlist
 * denies everything, credentials and bodies never follow a redirect to another origin, the header
 * timeout does not cut off a streaming body, and the production fetch connects only to the
 * address that passed the SSRF check.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isPrivateAddress, validateOutboundUrl } from '@now-playing/domain';
import { nodePinnedFetch, SafeHttpClient } from '../../src/providers/http.js';

describe('isPrivateAddress', () => {
  it('refuses private targets in every IPv6 and obfuscated form', () => {
    for (const h of [
      '::ffff:7f00:1',
      '::ffff:127.0.0.1',
      '[::ffff:7f00:1]',
      '::7f00:1',
      '::127.0.0.1',
      '0:0:0:0:0:ffff:a9fe:a9fe',
      '::ffff:0:7f00:1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '::',
      'fe80::1%eth0',
      'fec0::1',
      'fd12:3456::1',
      'ff02::1',
      '64:ff9b::7f00:1',
      '64:ff9b::808:808',
      '2002:7f00:1::',
      '2002:c0a8:0101::1',
      '2001:0:4136:e378::1',
      '2001:db8::1',
      '100::1',
      '127.1',
      '0x7f.1',
      '0177.0.0.1',
      'localhost.',
      '198.18.0.1',
      '::gggg',
    ]) {
      expect(isPrivateAddress(h), h).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const h of ['8.8.8.8', '93.184.216.34', '2606:4700::1111', '2001:4860:4860::8888', '2002:0808:0808::1', '::ffff:8.8.8.8', 'example.com']) {
      expect(isPrivateAddress(h), h).toBe(false);
    }
  });
});

describe('validateOutboundUrl allowlist', () => {
  it('treats an empty allowlist as deny-all', () => {
    expect(validateOutboundUrl('https://example.com/', { allowedHosts: [] }).ok).toBe(false);
    expect(validateOutboundUrl('https://example.com/').ok).toBe(false);
  });

  it('allows any public host only when asked explicitly', () => {
    expect(validateOutboundUrl('https://example.com/', { allowedHosts: [], allowAnyHost: true }).ok).toBe(true);
    expect(validateOutboundUrl('https://127.0.0.1/', { allowedHosts: [], allowAnyHost: true }).ok).toBe(false);
  });

  it('refuses IPv4-mapped IPv6 URL hosts', () => {
    expect(validateOutboundUrl('https://[::ffff:7f00:1]/', { allowedHosts: ['*'], allowAnyHost: true }).ok).toBe(false);
  });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function scriptedFetch(responses: Array<() => Response>): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

const client = (fetchImpl: typeof globalThis.fetch) => new SafeHttpClient({ fetch: fetchImpl, dnsLookup: async () => ['93.184.216.34'], userAgent: 'test' });

describe('SafeHttpClient redirects', () => {
  it('strips credentials when a redirect leaves the origin', async () => {
    const f = scriptedFetch([() => new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/file' } }), () => new Response('ok')]);
    const res = await client(f.fetch).request('https://api.example.com/download', { allowedHosts: ['api.example.com', 'cdn.example.net'], headers: { Authorization: 'OAuth secret', Cookie: 'a=b', 'X-Other': 'kept' } });
    expect(await res.text()).toBe('ok');
    expect(f.calls[0]!.headers['authorization']).toBe('OAuth secret');
    expect(f.calls[1]!.headers['authorization']).toBeUndefined();
    expect(f.calls[1]!.headers['cookie']).toBeUndefined();
    expect(f.calls[1]!.headers['x-other']).toBe('kept');
  });

  it('keeps credentials on a same-origin redirect', async () => {
    const f = scriptedFetch([() => new Response(null, { status: 302, headers: { location: '/v2/file' } }), () => new Response('ok')]);
    await client(f.fetch).request('https://api.example.com/download', { allowedHosts: ['api.example.com'], headers: { Authorization: 'OAuth secret' } });
    expect(f.calls[1]!.headers['authorization']).toBe('OAuth secret');
  });

  it('never resends a body to another origin', async () => {
    const f = scriptedFetch([() => new Response(null, { status: 307, headers: { location: 'https://other.example.net/token' } })]);
    await expect(client(f.fetch).request('https://api.example.com/token', { method: 'POST', allowedHosts: ['api.example.com', 'other.example.net'], body: 'secret=1' })).rejects.toThrow(/body/);
    expect(f.calls).toHaveLength(1);
  });

  it('turns a 303 into a body-less GET', async () => {
    const f = scriptedFetch([() => new Response(null, { status: 303, headers: { location: 'https://other.example.net/done' } }), () => new Response('{}')]);
    await client(f.fetch).request('https://api.example.com/token', { method: 'POST', allowedHosts: ['api.example.com', 'other.example.net'], body: 'secret=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(f.calls[1]!.method).toBe('GET');
    expect(f.calls[1]!.body).toBeUndefined();
    expect(f.calls[1]!.headers['content-type']).toBeUndefined();
  });

  it('refuses a redirect to a host outside the allowlist', async () => {
    const f = scriptedFetch([() => new Response(null, { status: 302, headers: { location: 'https://evil.example.org/' } })]);
    await expect(client(f.fetch).request('https://api.example.com/x', { allowedHosts: ['api.example.com'] })).rejects.toThrow(/Blocked/);
  });
});

describe('SafeHttpClient timeouts', () => {
  it('does not abort a streaming body once headers have arrived', async () => {
    let signal: AbortSignal | null = null;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? null;
      return new Response(new ReadableStream({ start: () => undefined }));
    }) as typeof globalThis.fetch;
    const res = await client(fetchImpl).request('https://api.example.com/stream', { allowedHosts: ['api.example.com'], timeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    expect(signal!.aborted).toBe(false);
    await res.body?.cancel();
  });

  it('still bounds the wait for headers', async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
      })) as typeof globalThis.fetch;
    await expect(client(fetchImpl).request('https://api.example.com/slow', { allowedHosts: ['api.example.com'], timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});

describe('nodePinnedFetch', () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it('connects to the validated address, never re-resolving the host name', async () => {
    const seen: Array<{ host: string | undefined; body: string }> = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ host: req.headers.host, body });
        res.writeHead(200, { 'content-type': 'text/plain', 'x-multi': 'a' });
        res.end('pinned');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    // `.invalid` can never resolve, so reaching the server proves the pinned address was used.
    const res = await nodePinnedFetch(`http://pinned.invalid:${port}/x`, { method: 'POST', headers: { 'x-test': '1' }, body: new URLSearchParams({ a: 'b' }) }, ['127.0.0.1']);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-multi')).toBe('a');
    expect(await res.text()).toBe('pinned');
    expect(seen[0]).toEqual({ host: `pinned.invalid:${port}`, body: 'a=b' });
  });

  it('refuses to connect without a validated address', async () => {
    await expect(nodePinnedFetch('http://example.com/', {}, [])).rejects.toThrow(/validated address/);
  });
});

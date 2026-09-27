import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { readStationTitle } from '../../src/radio-node.js';

/**
 * The connector against real sockets: a raw TCP server plays the station, so the old
 * `ICY 200 OK` status line (which is not HTTP) is exercised exactly as SHOUTcast v1 sends it.
 */
function metaBlock(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = Math.ceil(body.length / 16);
  const out = Buffer.alloc(1 + len * 16);
  out[0] = len;
  body.copy(out, 1);
  return out;
}

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

function station(handler: (socket: Socket, request: string) => void): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((socket) => {
      socket.once('data', (d) => handler(socket, d.toString('latin1')));
      socket.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/stream`);
    });
  });
}

const LOCAL = { allowPrivateNetworkForTests: true, timeoutMs: 3000 } as const;

describe('readStationTitle', () => {
  it('reads the title from an Icecast-style HTTP response, and asks for metadata', async () => {
    let asked = '';
    const url = await station((socket, request) => {
      asked = request;
      socket.write('HTTP/1.0 200 OK\r\nContent-Type: audio/mpeg\r\nicy-metaint: 16\r\nicy-name: Test FM\r\n\r\n');
      socket.write(Buffer.concat([Buffer.alloc(16, 0x41), metaBlock("StreamTitle='Artist - Song';"), Buffer.alloc(16, 0x41)]));
    });
    const r = await readStationTitle(url, LOCAL);
    expect(asked.toLowerCase()).toContain('icy-metadata: 1');
    expect(r).toMatchObject({ raw: 'Artist - Song', artist: 'Artist', title: 'Song', station: 'Test FM', reason: null });
  });

  it('understands the SHOUTcast v1 "ICY 200 OK" status line', async () => {
    const url = await station((socket) => {
      socket.write('ICY 200 OK\r\nicy-metaint: 8\r\n\r\n');
      socket.write(Buffer.concat([Buffer.alloc(8, 0x41), metaBlock("StreamTitle='Old - School';")]));
    });
    const r = await readStationTitle(url, LOCAL);
    expect(r.title).toBe('School');
    expect(r.artist).toBe('Old');
  });

  it('a station without metadata says so instead of guessing', async () => {
    const url = await station((socket) => {
      socket.write('HTTP/1.0 200 OK\r\nContent-Type: audio/mpeg\r\n\r\n');
      socket.write(Buffer.alloc(64, 0x41));
    });
    const r = await readStationTitle(url, LOCAL);
    expect(r.title).toBeNull();
    expect(r.reason).toMatch(/does not send song titles/);
  });

  it('gives up at the timeout when the station never sends a block', async () => {
    const url = await station((socket) => {
      socket.write('HTTP/1.0 200 OK\r\nicy-metaint: 16000\r\n\r\n');
      socket.write(Buffer.alloc(100, 0x41));
    });
    const t0 = Date.now();
    const r = await readStationTitle(url, { ...LOCAL, timeoutMs: 400 });
    expect(r.title).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('follows a redirect to the real stream', async () => {
    const target = await station((socket) => {
      socket.write('HTTP/1.0 200 OK\r\nicy-metaint: 4\r\n\r\n');
      socket.write(Buffer.concat([Buffer.alloc(4, 0x41), metaBlock("StreamTitle='After - Hop';")]));
    });
    const first = server;
    server = null;
    const hop = await station((socket) => socket.end(`HTTP/1.1 302 Found\r\nLocation: ${target}\r\nContent-Length: 0\r\n\r\n`));
    const r = await readStationTitle(hop, LOCAL);
    expect(r.raw).toBe('After - Hop');
    await new Promise<void>((resolve) => first!.close(() => resolve()));
  });

  it('refuses private and loopback addresses unless a test says otherwise', async () => {
    const r = await readStationTitle('http://127.0.0.1:1/stream', { timeoutMs: 1000 });
    expect(r.title).toBeNull();
    expect(r.reason).toMatch(/Private or local/);
    const bad = await readStationTitle('ftp://example.com/stream', { timeoutMs: 1000 });
    expect(bad.reason).toMatch(/Scheme/);
  });
});

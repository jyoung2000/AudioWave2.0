/// <reference lib="webworker" />
/**
 * The AWSP client's home: a dedicated worker owned by the page (docs/AWSP.md §6).
 *
 * It hosts the wasm client (music-player/awsp-web, iroh's browser build) and holds the policy the
 * crate leaves out: pairing, `hello` with the `resume_token`, a ping every 5 s with three missed
 * pongs counted as a lost connection, reconnection with exponential backoff (250 ms → 30 s, full
 * jitter), and audio fetches that survive a reconnection by asking again from the last contiguous
 * byte they had already handed on (§3.1).
 *
 * iroh does not document running inside a service worker, so the endpoint lives here and the service
 * worker is only a byte-range bridge in front of it: for each `/awsp/track/<id>` request the page
 * hands this worker a MessagePort to the service worker, and the bytes flow between those two
 * directly, one pull at a time, so the element's reading speed paces the QUIC stream.
 *
 * Messages in: `{id, op, …}` requests, answered `{id, ok, value | error}`; and `{op: 'serve', req}`
 * carrying a port. Messages out, unprompted: `{event, data}` — `status`, `connection`, `state`,
 * `library_delta`.
 */
import init, { AwspClient, ticket_info, type AwspAudio, type AwspConnection, type AwspControl } from './awsp-web/awsp_web.js';

declare const self: DedicatedWorkerGlobalScope;

interface Frame {
  id: number;
  type: string;
  seq: number;
  payload: Record<string, unknown>;
  re?: number;
}

interface Live {
  conn: AwspConnection;
  control: AwspControl;
  gen: number;
  missed: number;
  timer: ReturnType<typeof setInterval> | null;
  pending: Map<number, { resolve: (f: Frame) => void; reject: (e: Error) => void }>;
  dead: boolean;
}

export type AwspStatus = 'idle' | 'pairing' | 'connecting' | 'connected' | 'reconnecting' | 'refused';

interface ServeRequest {
  track_id: string;
  start: number;
  end: number | null;
  suffix: number | null;
  tag: string | null;
}

/** Why a resumed fetch started where it did: `from` must equal `request_start + held`. */
export interface ResumeRecord {
  tag: string | null;
  track_id: string;
  request_start: number;
  held: number;
  from: number;
  gen: number;
}

const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 30_000;
const MISSED_PONGS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 15_000;

let ready: Promise<unknown> | null = null;
let client: AwspClient | null = null;
let ticket = '';
let deviceName = 'Browser';
let relayOverride: string | null = null;
let pingMs = 5_000;
let live: Live | null = null;
let gen = 0;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let status: AwspStatus = 'idle';
let resumeToken: string | null = null;
let serverName: string | null = null;
let connectionType: string | null = null;
let rttMs: number | null = null;
let lastError: string | null = null;
let nextId = 0;
const waiters: Array<{ resolve: (l: Live) => void; reject: (e: Error) => void }> = [];
const stats = { connects: 0, welcomes: 0, resumedWelcomes: 0, lost: 0, fetches: 0, bytes: 0, resumes: [] as ResumeRecord[] };

function emit(event: string, data: unknown): void {
  self.postMessage({ event, data });
}

function snapshot() {
  return { status, serverName, connectionType, rttMs, endpointId: client?.endpoint_id() ?? null, lastError, stats: { ...stats, resumes: stats.resumes.slice() } };
}

function setStatus(next: AwspStatus, error: string | null = lastError): void {
  status = next;
  lastError = error;
  emit('status', snapshot());
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** `awsp-reset:<code>` — the server refused the stream (§3.2); anything else on a fetch is a lost connection. */
function resetCode(e: unknown): number | null {
  const m = /awsp-reset:(\d+)/.exec(message(e));
  return m ? Number(m[1]) : null;
}

/** The connection went away under a stream (`awsp-lost:` from the crate): worth reconnecting for. */
const isLost = (e: unknown): boolean => message(e).startsWith('awsp-lost');

/* --------------------------------------------------------------- the client */

async function ensureClient(secret: Uint8Array | null): Promise<AwspClient> {
  ready ??= init();
  await ready;
  if (client) return client;
  const info = JSON.parse(ticket_info(ticket)) as { endpoint_id: string; relay_urls: string[] };
  const relays = relayOverride ? [relayOverride] : info.relay_urls;
  client = await AwspClient.create(secret ?? new Uint8Array(), relays);
  return client;
}

/* ------------------------------------------------------------- the session */

async function send(l: Live, type: string, payload: Record<string, unknown>): Promise<number> {
  const id = ++nextId;
  await l.control.send(JSON.stringify({ id, type, seq: 0, payload }));
  return id;
}

async function request(l: Live, type: string, payload: Record<string, unknown>): Promise<Frame> {
  const id = ++nextId;
  const reply = new Promise<Frame>((resolve, reject) => l.pending.set(id, { resolve, reject }));
  await l.control.send(JSON.stringify({ id, type, seq: 0, payload }));
  const f = await withTimeout(reply, REQUEST_TIMEOUT_MS, type).finally(() => l.pending.delete(id));
  if (f.type === 'error') throw new Error(`${String(f.payload['code'])}: ${String(f.payload['message'] ?? '')}`);
  return f;
}

async function readLoop(l: Live): Promise<void> {
  try {
    for (;;) {
      const text = (await l.control.recv()) as string | null;
      if (text === null) break;
      const f = JSON.parse(text) as Frame;
      if (f.type === 'pong') l.missed = 0;
      const waiting = f.re !== undefined ? l.pending.get(f.re) : undefined;
      if (waiting) {
        waiting.resolve(f);
        continue;
      }
      if (f.type === 'state' || f.type === 'library_delta') emit(f.type, f.payload);
      else if (f.type === 'error') lastError = `${String(f.payload['code'])}: ${String(f.payload['message'] ?? '')}`;
    }
    lost(l, 'the control stream ended');
  } catch (e) {
    lost(l, message(e));
  }
}

/**
 * One connection: connect, open the control stream, `pair` first when a code is given, then
 * `hello` with the resume token. Resolves once `welcome` has arrived.
 */
async function session(pairCode: string | null): Promise<Live> {
  const c = client!;
  const conn = (await withTimeout(c.connect(ticket, relayOverride) as Promise<AwspConnection>, CONNECT_TIMEOUT_MS, 'connecting')) as AwspConnection;
  stats.connects++;
  let control: AwspControl;
  try {
    control = (await conn.open_control()) as AwspControl;
  } catch (e) {
    conn.close(0, 'no control stream');
    throw e;
  }
  const l: Live = { conn, control, gen: ++gen, missed: 0, timer: null, pending: new Map(), dead: false };
  void readLoop(l);
  void (conn.closed() as Promise<string>).then((text) => {
    const why = JSON.parse(text) as { code: number | null; reason: string };
    lost(l, why.code === null ? why.reason : `closed ${why.code}: ${why.reason}`, why.code);
  });
  try {
    if (pairCode !== null) {
      const paired = await request(l, 'pair', { code: pairCode, device_name: deviceName, client_kind: 'pwa' });
      serverName = String(paired.payload['server_name'] ?? '');
    }
    const welcome = await request(l, 'hello', { device_name: deviceName, client_kind: 'pwa', protocol_version: 1, ...(resumeToken ? { resume_token: resumeToken } : {}) });
    stats.welcomes++;
    if (welcome.payload['resumed'] === true) stats.resumedWelcomes++;
    resumeToken = String(welcome.payload['resume_token'] ?? '') || null;
    serverName = String(welcome.payload['server_name'] ?? serverName ?? '');
  } catch (e) {
    l.dead = true;
    conn.close(0, 'session failed');
    throw e;
  }
  // The browser build is relay-only, so this is `relay` — read from the path, not assumed (§5).
  connectionType = conn.connection_type();
  rttMs = Math.round(conn.rtt_ms());
  console.info(`awsp connection ${conn.remote_id()} type=${connectionType} rtt=${rttMs}`);
  live = l;
  attempt = 0;
  l.timer = setInterval(() => {
    if (l.dead) return;
    if (l.missed >= MISSED_PONGS) {
      lost(l, `${MISSED_PONGS} pongs missed`);
      return;
    }
    l.missed++;
    send(l, 'ping', {}).catch(() => undefined);
  }, pingMs);
  setStatus('connected', null);
  emit('connection', { type: connectionType, rttMs, serverName });
  for (const w of waiters.splice(0)) w.resolve(l);
  return l;
}

/** Close a connection and fail what waited on it. True when it was the current one. */
function drop(l: Live, why: string): boolean {
  if (l.dead) return false;
  l.dead = true;
  if (l.timer) clearInterval(l.timer);
  try {
    l.conn.close(0, 'lost');
  } catch {
    // Already closed: nothing to release.
  }
  for (const p of l.pending.values()) p.reject(new Error(`awsp-lost: ${why}`));
  l.pending.clear();
  if (live !== l) return false;
  live = null;
  return true;
}

/** A connection is gone: drop it, and reconnect unless the server refused us. */
function lost(l: Live, why: string, code: number | null = null): void {
  if (!drop(l, why)) return;
  stats.lost++;
  console.info(`awsp connection lost: ${why}`);
  if (code === 0x1) {
    // unknown-device: revoked, or never paired. Reconnecting would only be refused again (§1).
    resumeToken = null;
    setStatus('refused', 'This PC no longer accepts this player. Pair again.');
    for (const w of waiters.splice(0)) w.reject(new Error('refused'));
    return;
  }
  setStatus('reconnecting', why);
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer || status === 'refused' || status === 'idle') return;
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const delay = Math.random() * ceiling;
  attempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    session(null).catch((e: unknown) => {
      if (status === 'idle' || status === 'refused') return;
      lastError = message(e);
      scheduleReconnect();
    });
  }, delay);
}

function waitLive(): Promise<Live> {
  if (live && !live.dead) return Promise.resolve(live);
  if (status === 'idle' || status === 'refused') return Promise.reject(new Error(status === 'refused' ? 'This PC refused this player.' : 'Not connected to a PC.'));
  return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}

/* ------------------------------------------------------------ audio fetches */

/**
 * Serve one `/awsp/track/<id>` request to the service worker over `port`: a `header` message, then
 * one `chunk` per `pull`, then `end` — or `error` with the §3.2 code. A lost connection mid-range is
 * not an error: the fetch waits for the reconnection and asks again from the first byte it has not
 * handed on, so the service worker's stream never sees the gap.
 */
async function serve(port: MessagePort, req: ServeRequest): Promise<void> {
  let audio: AwspAudio | null = null;
  let audioGen = -1;
  let cancelled = false;
  let delivered = 0;
  let start = req.start;
  let end = req.end;

  const open = async (from: number, last: number | null): Promise<AwspAudio> => {
    for (;;) {
      if (cancelled) throw new Error('cancelled');
      const l = await waitLive();
      try {
        const a = (await l.conn.fetch(req.track_id, from, last, 'lossless')) as AwspAudio;
        audioGen = l.gen;
        return a;
      } catch (e) {
        if (!isLost(e)) throw e;
        lost(l, message(e));
        await sleep(50);
      }
    }
  };

  try {
    if (req.suffix !== null) {
      // `bytes=-N`: AWSP ranges are absolute, so learn the length from a one-byte probe first.
      const probe = await open(0, 0);
      await probe.cancel();
      start = Math.max(0, probe.total_len - req.suffix);
      end = null;
    }
    stats.fetches++;
    audio = await open(start, end);
    const total = audio.total_len;
    end = end === null ? total - 1 : Math.min(end, total - 1);
    port.postMessage({ type: 'header', total, codec: audio.codec, tier: audio.tier, start, end });
  } catch (e) {
    port.postMessage({ type: 'error', code: resetCode(e) ?? 0, message: message(e) });
    port.close();
    return;
  }

  const last = end;
  let busy = false;
  port.onmessage = async (ev: MessageEvent<{ type: string }>) => {
    if (ev.data.type === 'cancel') {
      cancelled = true;
      const a = audio;
      port.close();
      if (a) await a.cancel().catch(() => undefined);
      return;
    }
    if (ev.data.type !== 'pull' || busy) return;
    busy = true;
    try {
      for (;;) {
        try {
          const chunk = (await audio!.read()) as Uint8Array | null;
          if (cancelled) return;
          if (chunk === null) {
            port.postMessage({ type: 'end' });
            port.close();
            return;
          }
          delivered += chunk.length;
          stats.bytes += chunk.length;
          port.postMessage({ type: 'chunk', bytes: chunk.buffer }, [chunk.buffer as ArrayBuffer]);
          return;
        } catch (e) {
          if (cancelled) return;
          if (!isLost(e)) {
            port.postMessage({ type: 'error', code: resetCode(e) ?? 0, message: message(e) });
            port.close();
            return;
          }
          // The connection went away under this range. Resume from the last contiguous byte held.
          if (live && live.gen === audioGen) lost(live, message(e));
          const from = start + delivered;
          if (from > last) {
            port.postMessage({ type: 'end' });
            port.close();
            return;
          }
          audio = await open(from, last);
          stats.resumes.push({ tag: req.tag, track_id: req.track_id, request_start: start, held: delivered, from, gen: audioGen });
          console.info(`awsp resumed ${req.track_id} at byte ${from} (${delivered} held)`);
        }
      }
    } catch (e) {
      port.postMessage({ type: 'error', code: 0, message: message(e) });
      port.close();
    } finally {
      busy = false;
    }
  };
}

/* ------------------------------------------------------------------ requests */

interface Start {
  ticket: string;
  secret: Uint8Array | null;
  deviceName?: string;
  relayOverride?: string | null;
  pingMs?: number;
}

async function start(s: Start): Promise<{ secret: Uint8Array; endpointId: string }> {
  if (client && s.ticket !== ticket) {
    await stop();
  }
  ticket = s.ticket.trim();
  if (s.deviceName) deviceName = s.deviceName;
  if (s.relayOverride !== undefined) relayOverride = s.relayOverride;
  if (s.pingMs) pingMs = s.pingMs;
  const c = await ensureClient(s.secret);
  return { secret: c.secret_key(), endpointId: c.endpoint_id() };
}

async function connect(pairCode: string | null): Promise<ReturnType<typeof snapshot>> {
  if (!client) throw new Error('Not started.');
  if (live && !live.dead && pairCode === null) return snapshot();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (live) drop(live, 'reconnecting on request');
  setStatus(pairCode !== null ? 'pairing' : 'connecting', null);
  try {
    await session(pairCode);
  } catch (e) {
    const why = message(e);
    if (pairCode !== null || /^pair-|refused|unknown-device/.test(why)) {
      setStatus('idle', why);
      throw new Error(why, { cause: e });
    }
    // A PC that is asleep or offline: keep trying in the background, and say so.
    setStatus('reconnecting', why);
    scheduleReconnect();
  }
  return snapshot();
}

async function stop(): Promise<void> {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  status = 'idle';
  if (live) drop(live, 'stopped');
  resumeToken = null;
  for (const w of waiters.splice(0)) w.reject(new Error('stopped'));
  const c = client;
  client = null;
  if (c) await c.close().catch(() => undefined);
  setStatus('idle', null);
}

type Op =
  | ({ op: 'start' } & Start)
  | { op: 'pair'; code: string }
  | { op: 'connect' }
  | { op: 'stop' }
  | { op: 'status' }
  | { op: 'request'; type: string; payload: Record<string, unknown> };

async function handle(msg: Op): Promise<unknown> {
  switch (msg.op) {
    case 'start':
      return start(msg);
    case 'pair':
      return connect(msg.code);
    case 'connect':
      return connect(null);
    case 'stop':
      return stop();
    case 'status':
      return snapshot();
    case 'request': {
      const l = await withTimeout(waitLive(), REQUEST_TIMEOUT_MS, 'waiting for the PC');
      return (await request(l, msg.type, msg.payload)).payload;
    }
  }
}

self.onmessage = (ev: MessageEvent<({ id: number } & Op) | { op: 'serve'; req: ServeRequest }>) => {
  const msg = ev.data;
  if (msg.op === 'serve') {
    const port = ev.ports[0];
    if (port) void serve(port, msg.req);
    return;
  }
  const { id } = msg as { id: number };
  handle(msg as Op).then(
    (value) => self.postMessage({ id, ok: true, value }),
    (e: unknown) => self.postMessage({ id, ok: false, error: message(e) }),
  );
};

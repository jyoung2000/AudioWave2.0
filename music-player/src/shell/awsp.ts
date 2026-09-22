/**
 * Streaming from a PC (AWSP, docs/AWSP.md §6): the page's side.
 *
 * `window.NP_AWSP` is what the shell calls — pair with a ticket and a code, connect, browse — and
 * it is the page's broker between the two workers that do the work:
 *
 * - the **dedicated worker** (`awsp-worker.ts`) holds the wasm iroh client and the connection;
 * - the **service worker** (`public/awsp-sw.js`, imported by the generated `sw.js`) answers the media
 *   element's `/awsp/track/<id>` requests with HTTP range semantics. It asks this page for the
 *   bytes; the page hands the MessagePort straight to the dedicated worker, and the bytes flow
 *   between the two workers without passing through here.
 *
 * Nothing of this is in the first load: the bridge imports this module lazily, and the worker and
 * its 2.3 MB of wasm are started only when someone pairs, or when a PC was paired before.
 *
 * Keys (§1): the client's iroh secret key is kept in the player's IndexedDB, encrypted with AES-GCM
 * under a WebCrypto key generated non-extractable and stored beside it — script on this origin can
 * use it, but no one can read it out. The ticket and the PC's name are kept in the shell's `kv`.
 */
import type { TrackRef } from '@now-playing/contracts';
import { getSetting, putSetting, type PlayerDatabase } from '../lib/db.js';
import { publishMetadata } from '../lib/media-session.js';

/** A row from the PC's library, as the shell draws it (see `window.LIBRARY`). */
export interface RemoteSong {
  id: string;
  kind: 'music';
  title: string;
  artist: string;
  album: string;
  duration: number;
  bpm: null;
  platform: string;
  url: null;
  /** Not on this device: played through `/awsp/track/<remoteId>` from the paired PC. */
  remote: true;
  remoteId: string;
}

export interface AwspStatusView {
  paired: boolean;
  serverName: string | null;
  status: 'idle' | 'pairing' | 'connecting' | 'connected' | 'reconnecting' | 'refused';
  connectionType: 'relay' | 'direct' | 'bridge' | null;
  endpointId: string | null;
  lastError: string | null;
  tracks: number;
}

type Listener = (data: unknown) => void;

export interface ShellAwsp {
  /** Pair with the PC whose ticket this is, using its six-digit code. */
  pair(ticket: string, code: string): Promise<{ ok: boolean; serverName: string | null; reason: string | null }>;
  /** Connect to the paired PC (after a reload, say). */
  connect(): Promise<{ ok: boolean; reason: string | null }>;
  status(): Promise<AwspStatusView>;
  /** One page (100 rows) of the PC's library, optionally a full-text query. */
  browse(page?: number, query?: string): Promise<{ page: number; total: number; items: Array<Record<string, unknown>> }>;
  /** `relay` in a browser (§5), or null when not connected. */
  connectionType(): 'relay' | 'direct' | 'bridge' | null;
  /** `status`, `connection`, `state`, `library`. Returns the unsubscribe. */
  on(event: string, listener: Listener): () => void;
  /**
   * Play a row from the PC: `load` is the engine's (it loads `url` for `ref` and plays). Checks the
   * service worker is there to answer, shows the indicator, and publishes the Media Session metadata.
   */
  play(row: RemoteSong, load: (ref: TrackRef, url: string) => Promise<{ ok: boolean; reason: string | null }>): Promise<{ ok: boolean; reason: string | null }>;
  /** Where the media element fetches a remote track: answered by the service worker. */
  trackUrl(remoteId: string): string;
  /** The track's picture as a `data:` URL, or null. */
  artwork(remoteId: string, size?: number): Promise<string | null>;
  /** Show or hide the connection indicator beside the transport. */
  indicate(remotePlaying: boolean): void;
  /** Forget the PC: the ticket, the rows. The key is kept, so pairing again is the same device. */
  forget(): Promise<void>;
  /** What the worker counted — connects, resumed fetches and where they resumed. */
  stats(): Promise<unknown>;
  /** Test knobs: the ping interval (default 5 s), a relay to use instead of the ticket's. */
  tune(options: { pingMs?: number; relayOverride?: string | null }): void;
}

const KV = 'awsp:pc';
const LABEL: Record<string, string> = { relay: 'relay-carried', direct: 'direct', bridge: 'bridge' };

interface Paired {
  ticket: string;
  serverName: string | null;
  pairedAt: string;
}

async function readPaired(): Promise<Paired | null> {
  const got = (await window.storage?.get(KV)) as { value?: string } | null | undefined;
  if (!got?.value) return null;
  try {
    const v = JSON.parse(got.value) as Paired | null;
    return v && typeof v.ticket === 'string' ? v : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- keys */

async function wrappingKey(db: PlayerDatabase): Promise<CryptoKey> {
  const have = await getSetting<CryptoKey | null>(db, 'awsp.wrap', null);
  if (have) return have;
  // extractable: false — the raw key never leaves WebCrypto; IndexedDB stores the handle.
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await putSetting(db, 'awsp.wrap', key);
  return key;
}

async function loadSecret(db: PlayerDatabase): Promise<Uint8Array | null> {
  const sealed = await getSetting<{ iv: Uint8Array; data: ArrayBuffer } | null>(db, 'awsp.secret', null);
  if (!sealed) return null;
  try {
    const key = await wrappingKey(db);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv as BufferSource }, key, sealed.data));
  } catch {
    return null;
  }
}

async function saveSecret(db: PlayerDatabase, secret: Uint8Array): Promise<void> {
  const key = await wrappingKey(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret as BufferSource);
  await putSetting(db, 'awsp.secret', { iv, data });
}

function remoteRef(row: RemoteSong): TrackRef {
  return {
    trackId: row.remoteId,
    title: row.title,
    artistName: row.artist || 'Unknown artist',
    albumName: row.album || null,
    durationMs: row.duration ? row.duration * 1000 : null,
    artworkId: null,
    identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} },
    locators: [],
    provider: 'local',
    genre: null,
    year: null,
  };
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'a device';
  return `Now Playing in ${browser} on ${os}`;
}

/* ------------------------------------------------------------------ install */

export function installAwsp(db: PlayerDatabase, note: (line: string) => void): ShellAwsp {
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, data: unknown) => listeners.get(event)?.forEach((fn) => fn(data));
  let worker: Worker | null = null;
  let seq = 0;
  const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let started: Promise<void> | null = null;
  let status: AwspStatusView['status'] = 'idle';
  let serverName: string | null = null;
  let connType: AwspStatusView['connectionType'] = null;
  let endpointId: string | null = null;
  let lastError: string | null = null;
  let tracks = 0;
  let remotePlaying = false;
  let playing: TrackRef | null = null;
  const tuning: { pingMs?: number; relayOverride?: string | null } = {};

  function onWorker(e: MessageEvent<{ event?: string; data?: unknown; id?: number; ok?: boolean; value?: unknown; error?: string }>): void {
    const m = e.data;
    if (m.event) {
      if (m.event === 'status' || m.event === 'connection') {
        const s = m.data as { status?: AwspStatusView['status']; connectionType?: string | null; type?: string; serverName?: string | null; endpointId?: string | null; lastError?: string | null };
        if (s.status) status = s.status;
        const t = s.type ?? s.connectionType;
        connType = status === 'connected' && t ? (t as AwspStatusView['connectionType']) : null;
        if (s.serverName) serverName = s.serverName;
        if (s.endpointId !== undefined) endpointId = s.endpointId;
        if (s.lastError !== undefined) lastError = s.lastError;
        paintIndicator();
      }
      if (m.event === 'library_delta') void loadLibrary();
      emit(m.event, m.data);
      return;
    }
    const call = m.id !== undefined ? calls.get(m.id) : undefined;
    if (!call) return;
    calls.delete(m.id!);
    if (m.ok) call.resolve(m.value);
    else call.reject(new Error(m.error ?? 'failed'));
  }

  function call<T>(msg: Record<string, unknown>): Promise<T> {
    if (!worker) {
      worker = new Worker(new URL('./awsp-worker.ts', import.meta.url), { type: 'module', name: 'awsp' });
      worker.onmessage = onWorker;
    }
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker!.postMessage({ id, ...msg });
    });
  }

  async function startWith(ticket: string): Promise<void> {
    const secret = await loadSecret(db);
    const r = await call<{ secret: Uint8Array; endpointId: string }>({ op: 'start', ticket, secret, deviceName: deviceName(), ...tuning });
    endpointId = r.endpointId;
    if (!secret) await saveSecret(db, r.secret);
  }

  /** Start the worker for the stored ticket and connect. Idempotent. */
  function ensureStarted(): Promise<void> {
    started ??= (async () => {
      const paired = await readPaired();
      if (!paired) throw new Error('No PC is paired. Pair one in Settings ▸ Sources ▸ Connections.');
      serverName = paired.serverName;
      await startWith(paired.ticket);
      await call({ op: 'connect' });
    })();
    started.catch(() => { started = null; });
    return started;
  }

  function rowOf(t: Record<string, unknown>): RemoteSong | null {
    const id = typeof t['id'] === 'string' ? t['id'] : null;
    if (!id) return null;
    const str = (k: string) => (typeof t[k] === 'string' ? (t[k] as string) : '');
    return {
      id: `awsp:${id}`, kind: 'music', title: str('title') || 'Untitled', artist: str('artistName'), album: str('albumName'),
      duration: Math.round((typeof t['durationMs'] === 'number' ? t['durationMs'] : 0) / 1000), bpm: null,
      platform: serverName || 'PC', url: null, remote: true, remoteId: id,
    };
  }

  /** The PC's whole library as rows (up to 5,000), replacing the ones from before. */
  async function loadLibrary(): Promise<number> {
    const rows: RemoteSong[] = [];
    for (let page = 0; page < 50; page++) {
      const r = await api.browse(page);
      for (const item of r.items) {
        const row = rowOf(item);
        if (row) rows.push(row);
      }
      if (rows.length >= r.total || !r.items.length) break;
    }
    const target = window.LIBRARY ?? (window.LIBRARY = []);
    const kept = target.filter((row) => !(row as { remote?: boolean }).remote);
    target.splice(0, target.length, ...kept, ...rows);
    tracks = rows.length;
    document.dispatchEvent(new CustomEvent('library:refresh', { detail: { count: target.length } }));
    emit('library', { count: rows.length });
    note(`awsp: ${rows.length} tracks from ${serverName ?? 'the PC'}`);
    return rows.length;
  }

  function paintIndicator(): void {
    const el = document.getElementById('npConn');
    if (!el) return;
    const label = remotePlaying ? (connType ? LABEL[connType] : status === 'reconnecting' || status === 'connecting' ? 'reconnecting…' : null) : null;
    el.hidden = !label;
    el.textContent = label ?? '';
    if (label) el.setAttribute('title', connType === 'relay' ? 'Streaming from ' + (serverName ?? 'your PC') + ', carried by its relay, end-to-end encrypted' : label);
  }

  const api: ShellAwsp = {
    async pair(ticket, code) {
      ticket = ticket.trim();
      code = code.replace(/\s+/g, '');
      if (!/^endpoint[a-z2-7]+$/.test(ticket)) return { ok: false, serverName: null, reason: 'That is not a ticket. Copy it from the companion app: Settings ▸ Remote.' };
      if (!/^\d{6}$/.test(code)) return { ok: false, serverName: null, reason: 'The pairing code is six digits.' };
      started = null;
      try {
        await startWith(ticket);
        const s = await call<{ serverName: string | null }>({ op: 'pair', code });
        serverName = s.serverName;
        await window.storage?.set(KV, JSON.stringify({ ticket, serverName, pairedAt: new Date().toISOString() } satisfies Paired));
        started = Promise.resolve();
        note(`awsp: paired with ${serverName ?? 'a PC'}`);
        void loadLibrary().catch((e: unknown) => note(`awsp: library not loaded: ${String(e)}`));
        return { ok: true, serverName, reason: null };
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        const reason = why.startsWith('pair-rejected') ? 'The PC did not accept that code. Check it and try again.'
          : why.startsWith('pair-no-code') ? 'That code has expired or was already used. Ask the PC for a new one.'
          : /timed out/.test(why) ? 'The PC did not answer. Is the companion app running, and online?'
          : why;
        return { ok: false, serverName: null, reason };
      }
    },
    async connect() {
      try {
        await ensureStarted();
        void loadLibrary().catch((e: unknown) => note(`awsp: library not loaded: ${String(e)}`));
        return { ok: true, reason: null };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    async status() {
      const paired = await readPaired();
      return { paired: !!paired, serverName: serverName ?? paired?.serverName ?? null, status, connectionType: connType, endpointId, lastError, tracks };
    },
    async browse(page = 0, query) {
      await ensureStarted();
      return call({ op: 'request', type: 'browse', payload: { page, ...(query ? { query } : {}) } });
    },
    connectionType: () => connType,
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    async play(row, load) {
      if (!navigator.serviceWorker?.controller) {
        return { ok: false, reason: 'Streaming from a PC starts working once the player’s offline worker is running. Reload the page and try again.' };
      }
      const ref = remoteRef(row);
      playing = ref;
      api.indicate(true);
      // No Wake Lock (§6): a playing <audio> keeps the page, this worker and the network alive.
      publishMetadata(ref, null);
      void api.artwork(row.remoteId).then((art) => {
        if (art && playing === ref) publishMetadata(ref, art);
      });
      return load(ref, api.trackUrl(row.remoteId));
    },
    trackUrl: (remoteId) => `${import.meta.env.BASE_URL}awsp/track/${encodeURIComponent(remoteId)}`,
    async artwork(remoteId, size = 512) {
      try {
        await ensureStarted();
        const a = await call<{ mime: string | null; data: string | null }>({ op: 'request', type: 'get_artwork', payload: { track_id: remoteId, size } });
        return a.mime && a.data ? `data:${a.mime};base64,${a.data}` : null;
      } catch {
        return null;
      }
    },
    indicate(on) {
      remotePlaying = on;
      if (!on) playing = null;
      paintIndicator();
    },
    async forget() {
      if (worker) await call({ op: 'stop' }).catch(() => undefined);
      started = null;
      serverName = null;
      connType = null;
      await window.storage?.set(KV, 'null');
      const target = window.LIBRARY ?? [];
      target.splice(0, target.length, ...target.filter((row) => !(row as { remote?: boolean }).remote));
      tracks = 0;
      document.dispatchEvent(new CustomEvent('library:refresh', { detail: { count: target.length } }));
      paintIndicator();
    },
    stats: () => (worker ? call({ op: 'status' }) : Promise.resolve(null)),
    tune(options) {
      Object.assign(tuning, options);
    },
  };

  /*
   * The service worker's requests for bytes. The port goes to the dedicated worker untouched; the
   * worker is started (and the PC connected) on the first request if this visit has not yet.
   */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; req?: unknown }>) => {
      if (e.data?.type !== 'awsp-serve') return;
      const port = e.ports[0];
      if (!port) return;
      ensureStarted().then(
        () => worker!.postMessage({ op: 'serve', req: e.data.req }, [port]),
        (err: unknown) => {
          port.postMessage({ type: 'error', code: 0, message: err instanceof Error ? err.message : String(err) });
          port.close();
        },
      );
    });
    navigator.serviceWorker.startMessages();
  }

  // A PC paired on an earlier visit: reconnect now, so its rows are in the library.
  void readPaired().then((p) => {
    if (p) void api.connect();
  });
  return api;
}

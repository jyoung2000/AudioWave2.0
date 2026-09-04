/**
 * The companion's hub connection: pairing, sync and file transfer.
 *
 * The credential is stored in the local SQLite database with the rest of the app's state, not in a
 * plain file beside the executable. It is a bearer secret; treating it like a preference would be
 * wrong.
 *
 * Sync sends *metadata only*. The `sanitize` step below is not a formality: it is the check that a
 * Windows path never reaches a hub, applied to every record on the way out regardless of where the
 * record came from.
 */
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { SyncChange, SyncCollection, SyncDeltaResponse, SyncManifest } from '@now-playing/contracts';
import { WS_PROTOCOL_VERSION } from '@now-playing/contracts';
import { collectionsNeedingSync, summarize, uuidv7, type SyncRecord } from '@now-playing/domain';
import type { HubConnection, PairingChallenge } from '../shared/ipc.js';
import type { CompanionStore } from './store.js';
import { absolutePathOf, fullHash } from './library.js';

const CREDENTIAL_KEY = 'hub.credential';
const SYNC_COLLECTIONS: SyncCollection[] = ['tracks', 'playlists', 'playlistItems', 'eqPresets', 'eqBindings'];
const CHUNK_BYTES = 4 * 1024 * 1024;

/** Fields that must never appear in a synced record, whatever produced it. */
const FORBIDDEN_KEYS = new Set(['absolutePath', 'path', 'filePath', 'fsPath', 'localPath', 'directory', 'folderPath']);

export interface HubCredential {
  endpoint: string;
  hubId: string;
  hubName: string;
  hubFingerprint: string;
  deviceId: string;
  credentialId: string;
  secret: string;
  scopes: string[];
  pairedAt: string;
}

export interface PendingPairing extends PairingChallenge {
  endpoint: string;
  claimSecret: string;
}

export class HubClient {
  private credential: HubCredential | null = null;
  private pending: PendingPairing | null = null;
  private status: HubConnection = { endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null };

  constructor(
    private readonly store: CompanionStore,
    private readonly deviceName: string,
    private readonly onStatus: (status: HubConnection) => void,
  ) {
    this.credential = store.get<HubCredential | null>(CREDENTIAL_KEY, null);
    if (this.credential) {
      this.status = { ...this.status, endpoint: this.credential.endpoint, hubId: this.credential.hubId, hubName: this.credential.hubName, hubFingerprint: this.credential.hubFingerprint, scopes: this.credential.scopes, reason: 'Not checked yet.' };
    }
  }

  getStatus(): HubConnection {
    return this.status;
  }

  private setStatus(patch: Partial<HubConnection>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  async refresh(): Promise<HubConnection> {
    if (!this.credential) {
      this.setStatus({ connected: false, reason: 'No hub is paired.' });
      return this.status;
    }
    try {
      const identity = await this.request<{ hubId: string; name: string; fingerprint: string }>('GET', '/api/v1/hub', { authenticated: false });
      if (identity.hubId !== this.credential.hubId) {
        // A different hub answering at the same address is what the fingerprint exists to catch.
        this.setStatus({ connected: false, reason: `The server at ${this.credential.endpoint} is a different hub than the one you paired with. Nothing was sent to it.` });
        return this.status;
      }
      this.setStatus({ connected: true, reason: null, hubName: identity.name });
    } catch (err) {
      this.setStatus({ connected: false, reason: describeNetworkError(err, this.credential.endpoint) });
    }
    return this.status;
  }

  /* --------------------------------------------------------------- pairing */

  async startPairing(endpoint: string, code: string): Promise<{ challenge: PairingChallenge | null; reason: string | null }> {
    const base = normalizeEndpoint(endpoint);
    try {
      const response = await fetch(`${base}/api/v1/pairing/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim().toUpperCase(), deviceName: this.deviceName, deviceKind: 'companion', publicKey: this.devicePublicKey(), appVersion: '0.1.0', protocolVersion: WS_PROTOCOL_VERSION, platform: 'windows' }),
      });
      if (!response.ok) return { challenge: null, reason: await problemMessage(response) };
      const claimed = (await response.json()) as { sessionId: string; claimSecret: string; verificationFingerprint: string; hubFingerprint: string; hubName: string; expiresAt: string };
      this.pending = { ...claimed, endpoint: base };
      return { challenge: { sessionId: claimed.sessionId, verificationFingerprint: claimed.verificationFingerprint, hubFingerprint: claimed.hubFingerprint, hubName: claimed.hubName, expiresAt: claimed.expiresAt }, reason: null };
    } catch (err) {
      return { challenge: null, reason: describeNetworkError(err, base) };
    }
  }

  /**
   * Wait for the person at the hub to confirm the fingerprint, then exchange the session for a
   * credential. Polling stops on any terminal state rather than spinning forever.
   */
  async awaitPairing(sessionId: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<{ connection: HubConnection; reason: string | null }> {
    const pending = this.pending;
    if (!pending || pending.sessionId !== sessionId) return { connection: this.status, reason: 'That pairing is no longer in progress. Start again.' };
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    const interval = options.intervalMs ?? 2000;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${pending.endpoint}/api/v1/pairing/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, claimSecret: pending.claimSecret }) });
        if (!response.ok) return { connection: this.status, reason: await problemMessage(response) };
        const { state } = (await response.json()) as { state: string };
        if (state === 'confirmed') {
          const completed = await fetch(`${pending.endpoint}/api/v1/pairing/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, claimSecret: pending.claimSecret }) });
          if (!completed.ok) return { connection: this.status, reason: await problemMessage(completed) };
          const issued = (await completed.json()) as { credentialId: string; deviceId: string; hubId: string; hubName: string; hubFingerprint: string; secret: string; scopes: string[]; issuedAt: string };
          this.credential = { endpoint: pending.endpoint, hubId: issued.hubId, hubName: issued.hubName, hubFingerprint: issued.hubFingerprint, deviceId: issued.deviceId, credentialId: issued.credentialId, secret: issued.secret, scopes: issued.scopes, pairedAt: issued.issuedAt };
          this.store.set(CREDENTIAL_KEY, this.credential, new Date().toISOString());
          this.pending = null;
          this.setStatus({ endpoint: pending.endpoint, hubId: issued.hubId, hubName: issued.hubName, hubFingerprint: issued.hubFingerprint, scopes: issued.scopes, connected: true, reason: null });
          return { connection: this.status, reason: null };
        }
        if (state === 'expired' || state === 'revoked') {
          this.pending = null;
          return { connection: this.status, reason: `The pairing was ${state}. Ask for a new code.` };
        }
      } catch (err) {
        return { connection: this.status, reason: describeNetworkError(err, pending.endpoint) };
      }
      await sleep(interval);
    }
    this.pending = null;
    return { connection: this.status, reason: 'Nobody confirmed the pairing in time. Start again.' };
  }

  forget(): HubConnection {
    this.credential = null;
    this.pending = null;
    this.store.set(CREDENTIAL_KEY, null, new Date().toISOString());
    this.setStatus({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, scopes: [], reason: 'No hub is paired.' });
    return this.status;
  }

  hasScope(scope: string): boolean {
    return this.credential?.scopes.includes(scope) ?? false;
  }

  /* ------------------------------------------------------------------ sync */

  /**
   * One sync round: exchange manifests to see what differs, then exchange deltas for those
   * collections only. Metadata only — no audio moves here.
   */
  async sync(): Promise<{ pushed: number; pulled: number; conflicts: number; reason: string | null }> {
    if (!this.credential) return { pushed: 0, pulled: 0, conflicts: 0, reason: 'No hub is paired.' };
    if (!this.hasScope('library:share')) return { pushed: 0, pulled: 0, conflicts: 0, reason: 'This companion was not given permission to share its library with the hub. Change its permissions in the hub, under Devices.' };

    try {
      const local = await this.localManifest();
      const exchange = await this.request<{ serverManifest: SyncManifest; needed: string[] }>('POST', '/api/v1/sync/manifest', { body: local });
      const needed = new Set([...exchange.needed, ...collectionsNeedingSync(local.collections, exchange.serverManifest.collections)]);
      if (!needed.size) {
        this.setStatus({ lastSyncAt: new Date().toISOString() });
        return { pushed: 0, pulled: 0, conflicts: 0, reason: null };
      }

      const changes = this.localChanges([...needed] as SyncCollection[]);
      const since: Record<string, string | null> = {};
      for (const collection of needed) since[collection] = this.store.raw.prepare<[string], { cursor: string | null }>('SELECT cursor FROM sync_cursors WHERE collection = ?').get(collection)?.cursor ?? null;

      const response = await this.request<SyncDeltaResponse>('POST', '/api/v1/sync/delta', {
        body: { deviceId: this.credential.deviceId, since, changes, enabledCollections: [...needed] },
      });

      this.applyRemote(response.changes);
      for (const [collection, cursor] of Object.entries(response.cursors)) {
        this.store.raw.prepare('INSERT INTO sync_cursors (collection, cursor) VALUES (?, ?) ON CONFLICT(collection) DO UPDATE SET cursor = excluded.cursor').run(collection, cursor ?? null);
      }
      this.setStatus({ lastSyncAt: new Date().toISOString(), reason: null });
      return { pushed: response.applied, pulled: response.changes.length, conflicts: response.conflicts.length, reason: null };
    } catch (err) {
      const reason = describeNetworkError(err, this.credential.endpoint);
      this.setStatus({ reason });
      return { pushed: 0, pulled: 0, conflicts: 0, reason };
    }
  }

  private async localManifest(): Promise<SyncManifest> {
    const collections = await Promise.all(SYNC_COLLECTIONS.map(async (collection) => summarize(collection, this.recordsFor(collection))));
    return { schemaVersion: 1, deviceId: this.credential!.deviceId, generatedAt: new Date().toISOString(), protocolVersion: WS_PROTOCOL_VERSION, collections };
  }

  private recordsFor(collection: SyncCollection): SyncRecord[] {
    if (collection === 'tracks') {
      return this.store.raw
        .prepare<[], { id: string; track: string; updated_at: string; deleted_at: string | null }>('SELECT id, track, updated_at, deleted_at FROM tracks')
        .all()
        .map((row) => sanitize({ ...(JSON.parse(row.track) as Record<string, unknown>), id: row.id, updatedAt: row.updated_at, deletedAt: row.deleted_at }));
    }
    const table = { playlists: 'playlists', playlistItems: 'playlist_items', eqPresets: 'eq_presets', eqBindings: 'eq_bindings' }[collection as 'playlists' | 'playlistItems' | 'eqPresets' | 'eqBindings'];
    if (!table) return [];
    return this.store.raw
      .prepare<[], { id: string; body: string; updated_at: string; deleted_at: string | null }>(`SELECT id, body, updated_at, deleted_at FROM ${table}`)
      .all()
      .map((row) => sanitize({ ...(JSON.parse(row.body) as Record<string, unknown>), id: row.id, updatedAt: row.updated_at, deletedAt: row.deleted_at }));
  }

  private localChanges(collections: readonly SyncCollection[]): SyncChange[] {
    const changes: SyncChange[] = [];
    for (const collection of collections) {
      for (const record of this.recordsFor(collection)) {
        const { id, updatedAt, deletedAt, ...body } = record;
        changes.push({ collection, id, updatedAt: (deletedAt as string | null) ?? (updatedAt as string), deleted: Boolean(deletedAt), body: deletedAt ? null : body, changeId: uuidv7() });
        if (changes.length >= 2000) return changes;
      }
    }
    return changes;
  }

  private applyRemote(changes: readonly SyncChange[]): void {
    const now = new Date().toISOString();
    for (const change of changes) {
      if (change.collection === 'tracks') continue; // The hub never dictates what is on this disk.
      const table = { playlists: 'playlists', playlistItems: 'playlist_items', eqPresets: 'eq_presets', eqBindings: 'eq_bindings' }[change.collection as 'playlists' | 'playlistItems' | 'eqPresets' | 'eqBindings'];
      if (!table) continue;
      this.store.putSynced(table as 'playlists' | 'playlist_items' | 'eq_presets' | 'eq_bindings', change.id, change.body ?? {}, change.updatedAt, change.deleted ? change.updatedAt : null);
    }
    void now;
  }

  /* -------------------------------------------------------------- transfers */

  /**
   * Send one track's bytes to the hub, chunked and resumable. The hub verifies the SHA-256 before
   * accepting it, so a truncated upload is discarded rather than stored as a corrupt file.
   */
  async uploadTrack(trackId: string, onProgress?: (bytesDone: number, bytesTotal: number) => void): Promise<{ ok: boolean; reason: string | null }> {
    if (!this.credential) return { ok: false, reason: 'No hub is paired.' };
    if (!this.hasScope('transfers:receive')) return { ok: false, reason: 'This companion was not given permission to transfer files.' };
    const path = absolutePathOf(this.store, trackId);
    if (!path) return { ok: false, reason: 'That track is not on this computer any more.' };

    try {
      const contents = await readFile(path);
      const hash = await fullHash(path);
      const head = await fetch(`${this.credential.endpoint}/api/v1/files/${hash}`, { method: 'HEAD', headers: this.authHeaders() });
      let offset = Number(head.headers.get('x-received-bytes') ?? 0);
      if (head.status === 200) {
        onProgress?.(contents.byteLength, contents.byteLength);
        return { ok: true, reason: null }; // The hub already has it.
      }

      while (offset < contents.byteLength) {
        const end = Math.min(offset + CHUNK_BYTES, contents.byteLength);
        // A fresh ArrayBuffer per chunk: a Buffer view into a pooled allocation would send the
        // wrong bytes if the pool were reused before fetch read it.
        const chunk = contents.subarray(offset, end);
        const body = new Uint8Array(chunk.byteLength);
        body.set(chunk);
        const init: RequestInit = {
          method: 'PUT',
          headers: { ...this.authHeaders(), 'content-type': 'application/octet-stream' },
          body,
        };
        const response = await fetch(`${this.credential.endpoint}/api/v1/files/${hash}?offset=${offset}&total=${contents.byteLength}`, init);
        if (!response.ok) return { ok: false, reason: await problemMessage(response) };
        const result = (await response.json()) as { receivedBytes: number; complete: boolean };
        offset = result.receivedBytes;
        onProgress?.(offset, contents.byteLength);
        if (result.complete) break;
      }
      return { ok: true, reason: null };
    } catch (err) {
      return { ok: false, reason: describeNetworkError(err, this.credential.endpoint) };
    }
  }

  /** Stream a file rather than buffering it, for the large-library case. */
  openTrackStream(trackId: string): NodeJS.ReadableStream | null {
    const path = absolutePathOf(this.store, trackId);
    return path ? createReadStream(path) : null;
  }

  /* ----------------------------------------------------------------- plumbing */

  private authHeaders(): Record<string, string> {
    return this.credential ? { authorization: `Bearer ${this.credential.credentialId}.${this.credential.secret}` } : {};
  }

  private async request<T>(method: string, path: string, options: { body?: unknown; authenticated?: boolean } = {}): Promise<T> {
    if (!this.credential) throw new Error('No hub is paired.');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.authenticated !== false) Object.assign(headers, this.authHeaders());
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(`${this.credential.endpoint}${path}`, init);
    if (!response.ok) throw new Error(await problemMessage(response));
    return (await response.json()) as T;
  }

  private devicePublicKey(): string {
    const existing = this.store.get<string | null>('devicePublicKey', null);
    if (existing) return existing;
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    const key = Buffer.from(bytes).toString('base64url');
    this.store.set('devicePublicKey', key, new Date().toISOString());
    return key;
  }
}

/**
 * Strip anything path-shaped before a record leaves this machine. Applied on the way out to every
 * record, so a field added later cannot leak by being forgotten here.
 */
export function sanitize(record: Record<string, unknown>): SyncRecord {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (typeof value === 'string' && /^[A-Za-z]:[\\/]|^\\\\/.test(value)) continue;
    clean[key] = value;
  }
  return clean as SyncRecord;
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

async function problemMessage(response: Response): Promise<string> {
  try {
    const problem = (await response.json()) as { detail?: string; title?: string };
    return problem.detail ?? problem.title ?? `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function describeNetworkError(err: unknown, endpoint: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(message)) {
    return `Could not reach ${endpoint}. The hub may be off, or this computer may be on a different network. Your library on this computer is unaffected.`;
  }
  return message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

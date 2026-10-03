/**
 * The companion's hub connection: pairing, sync and file transfer.
 *
 * The credential is stored in the local SQLite database with the rest of the app's state, not in a
 * plain file beside the executable. It is a bearer secret, so the secret half is encrypted with the
 * operating system's key store (Electron `safeStorage`, which is DPAPI on Windows) whenever that is
 * available; treating it like a preference would be wrong.
 *
 * Sync sends *metadata only*. The `sanitize` step below is not a formality: it is the check that a
 * Windows path never reaches a hub, applied to every record on the way out regardless of where the
 * record came from.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import {
  EqBinding,
  EqPreset,
  HUB_LIVE_TV_MAX_CHANNELS,
  isPlainWebUrl,
  Playlist,
  PlaylistItem,
  SyncChange,
  SyncDeltaResponse,
  SyncManifest,
  WS_PROTOCOL_VERSION,
  type HelperTvChannel,
  type HelperTvGuideEntry,
  type SyncCollection,
} from '@now-playing/contracts';
import { collectionsNeedingSync, summarize, uuidv7, type SyncRecord } from '@now-playing/domain';
import type { HubConnection, PairingChallenge } from '../shared/ipc.js';
import type { CompanionStore, SyncedTable } from './store.js';
import { absolutePathOf, fullHash } from './library.js';

const CREDENTIAL_KEY = 'hub.credential';
/** Set while the hub holds a copy of this companion's Live TV, so turning sharing off can remove it. */
const LIVE_TV_SENT_KEY = 'hub.liveTvSent';
/** Live TV changes come in bursts (one per playlist refreshed); one push follows the burst. */
const LIVE_TV_PUSH_DELAY_MS = 3_000;

/**
 * Where the companion's Live TV comes from, and whether this PC shares with the hub. Given to the
 * client once at start-up (`setLiveTvSource`), so a sync can send the channels along with it.
 */
export interface LiveTvSource {
  channels(): Promise<HelperTvChannel[]>;
  guide(): Promise<HelperTvGuideEntry[]>;
  sharing(): boolean;
}
const SYNC_COLLECTIONS: SyncCollection[] = ['tracks', 'playlists', 'playlistItems', 'eqPresets', 'eqBindings'];
const CHUNK_BYTES = 4 * 1024 * 1024;
/** Local changes sent per delta request; the hub accepts at most 2000. */
const PUSH_PAGE_SIZE = 500;
/** A backstop against a hub that keeps answering `more: true` without making progress. */
const MAX_SYNC_ROUNDS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_CHUNK_TIMEOUT_MS = 5 * 60_000;
/** How long a successful identity check is trusted before the hub is asked again. */
const VERIFIED_FOR_MS = 60_000;

/** Fields that must never appear in a synced record, whatever produced it. */
const FORBIDDEN_KEYS = new Set(['absolutePath', 'path', 'filePath', 'fsPath', 'localPath', 'directory', 'folderPath']);

/** Where each collection the hub may change lives here, and the shape a record must have to be kept. */
const REMOTE_COLLECTIONS: Partial<Record<SyncCollection, { table: SyncedTable; schema: z.ZodType }>> = {
  playlists: { table: 'playlists', schema: Playlist },
  playlistItems: { table: 'playlist_items', schema: PlaylistItem },
  eqPresets: { table: 'eq_presets', schema: EqPreset },
  eqBindings: { table: 'eq_bindings', schema: EqBinding },
};

const ManifestExchange = z.object({ serverManifest: SyncManifest, needed: z.array(z.string()) });
/** Changes are checked one by one, so one malformed record cannot stall the whole page. */
const DeltaEnvelope = SyncDeltaResponse.extend({ conflicts: z.array(z.unknown()), changes: z.array(z.unknown()) });

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

/** The credential as written to the database: the secret is encrypted when the OS allows it. */
type StoredCredential = Omit<HubCredential, 'secret'> & { secret?: string; secretEncrypted?: string };

/** The subset of Electron's `safeStorage` this module uses; injected so tests need no Electron. */
export interface SecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface HubClientOptions {
  secretBox?: SecretBox;
  appVersion?: string;
  /** A warning the person should see, such as an unencrypted connection over the internet. */
  onNotice?: (message: string) => void;
}

export interface PendingPairing extends PairingChallenge {
  endpoint: string;
  claimSecret: string;
}

interface PushCursor {
  updatedAt: string;
  id: string;
}

export class HubClient {
  private credential: HubCredential | null = null;
  private pending: PendingPairing | null = null;
  private status: HubConnection = { endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, reason: 'No hub is paired.', scopes: [], lastSyncAt: null };
  /** When the hub last proved to be the one paired with; zero means "not since the last failure". */
  private verifiedAt = 0;
  private liveTv: LiveTvSource | null = null;
  private liveTvTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: CompanionStore,
    private readonly deviceName: string,
    private readonly onStatus: (status: HubConnection) => void,
    private readonly options: HubClientOptions = {},
  ) {
    const loaded = this.loadCredential();
    this.credential = loaded.credential;
    if (this.credential) {
      this.status = { ...this.status, endpoint: this.credential.endpoint, hubId: this.credential.hubId, hubName: this.credential.hubName, hubFingerprint: this.credential.hubFingerprint, scopes: this.credential.scopes, reason: 'Not checked yet.' };
    } else if (loaded.reason) {
      this.status = { ...this.status, reason: loaded.reason };
    }
  }

  getStatus(): HubConnection {
    return this.status;
  }

  private setStatus(patch: Partial<HubConnection>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  /* ------------------------------------------------------------ credential */

  private loadCredential(): { credential: HubCredential | null; reason: string | null } {
    const stored = this.store.get<StoredCredential | null>(CREDENTIAL_KEY, null);
    if (!stored) return { credential: null, reason: null };
    const { secret: plain, secretEncrypted, ...rest } = stored;
    const box = this.options.secretBox;
    if (secretEncrypted) {
      if (!box?.isEncryptionAvailable()) return { credential: null, reason: 'The saved hub credential cannot be unlocked on this computer. Pair with the hub again.' };
      try {
        return { credential: { ...rest, secret: box.decryptString(Buffer.from(secretEncrypted, 'base64')) }, reason: null };
      } catch {
        return { credential: null, reason: 'The saved hub credential cannot be unlocked on this computer. Pair with the hub again.' };
      }
    }
    if (typeof plain !== 'string') return { credential: null, reason: null };
    const credential: HubCredential = { ...rest, secret: plain };
    // A credential saved by an older build is plain text; encrypt it now that it has been read.
    if (box?.isEncryptionAvailable()) this.saveCredential(credential);
    return { credential, reason: null };
  }

  private saveCredential(credential: HubCredential | null): void {
    const now = new Date().toISOString();
    if (!credential) {
      this.store.set(CREDENTIAL_KEY, null, now);
      return;
    }
    const { secret, ...rest } = credential;
    const box = this.options.secretBox;
    const stored: StoredCredential = box?.isEncryptionAvailable() ? { ...rest, secretEncrypted: box.encryptString(secret).toString('base64') } : { ...rest, secret };
    this.store.set(CREDENTIAL_KEY, stored, now);
  }

  /* ---------------------------------------------------------- verification */

  /**
   * Ask the hub who it is, without credentials, and compare the answer with what pairing recorded:
   * the hub id and the fingerprint the person confirmed. Nothing secret is sent to a hub until this
   * has passed.
   *
   * The identity endpoint is unauthenticated, so this catches a different or reinstalled hub at the
   * same address; it is not a cryptographic proof against an attacker who copies the identity. TLS
   * (an https endpoint) is what protects against that.
   */
  async refresh(): Promise<HubConnection> {
    if (!this.credential) {
      this.verifiedAt = 0;
      this.setStatus({ connected: false, reason: this.status.reason ?? 'No hub is paired.' });
      return this.status;
    }
    try {
      const identity = await this.request<{ hubId?: unknown; name?: unknown; fingerprint?: unknown }>('GET', '/api/v1/hub', { authenticated: false });
      const fingerprintMatches = !this.credential.hubFingerprint || identity.fingerprint === this.credential.hubFingerprint;
      if (identity.hubId !== this.credential.hubId || !fingerprintMatches) {
        // A different hub answering at the same address is what the fingerprint exists to catch.
        this.verifiedAt = 0;
        this.setStatus({ connected: false, reason: `The server at ${this.credential.endpoint} is a different hub than the one you paired with. Nothing was sent to it.` });
        return this.status;
      }
      this.verifiedAt = Date.now();
      this.setStatus({ connected: true, reason: null, hubName: typeof identity.name === 'string' ? identity.name : this.credential.hubName });
    } catch (err) {
      this.verifiedAt = 0;
      this.setStatus({ connected: false, reason: describeNetworkError(err, this.credential.endpoint) });
    }
    return this.status;
  }

  /** Null when the hub is verified (recently enough), otherwise the reason nothing will be sent. */
  private async ensureVerified(): Promise<string | null> {
    if (this.status.connected && Date.now() - this.verifiedAt < VERIFIED_FOR_MS) return null;
    const status = await this.refresh();
    return status.connected ? null : (status.reason ?? 'The hub could not be verified, so nothing was sent to it.');
  }

  /* --------------------------------------------------------------- pairing */

  async startPairing(endpoint: string, code: string): Promise<{ challenge: PairingChallenge | null; reason: string | null }> {
    let base: string;
    try {
      base = normalizeEndpoint(endpoint);
    } catch {
      return { challenge: null, reason: 'That hub address is not a valid http or https address.' };
    }
    if (isPlainHttpOverInternet(base)) {
      this.options.onNotice?.(`${base} is not encrypted and is not on your local network. Anyone between this computer and the hub could read what is sent, including the pairing credential. Use an https address if the hub has one.`);
    }
    try {
      const response = await fetchWithTimeout(`${base}/api/v1/pairing/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim().toUpperCase(), deviceName: this.deviceName, deviceKind: 'companion', publicKey: this.deviceIdentity(), appVersion: this.appVersion(), protocolVersion: WS_PROTOCOL_VERSION, platform: 'windows' }),
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
        const response = await fetchWithTimeout(`${pending.endpoint}/api/v1/pairing/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, claimSecret: pending.claimSecret }) });
        if (!response.ok) return { connection: this.status, reason: await problemMessage(response) };
        const { state } = (await response.json()) as { state: string };
        if (state === 'confirmed') {
          const completed = await fetchWithTimeout(`${pending.endpoint}/api/v1/pairing/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, claimSecret: pending.claimSecret }) });
          if (!completed.ok) return { connection: this.status, reason: await problemMessage(completed) };
          const issued = (await completed.json()) as { credentialId: string; deviceId: string; hubId: string; hubName: string; hubFingerprint: string; secret: string; scopes: string[]; issuedAt: string };
          this.pending = null;
          if (issued.hubFingerprint !== pending.hubFingerprint) {
            // The credential came from a hub other than the one whose fingerprint was shown.
            return { connection: this.status, reason: 'The hub that issued the credential is not the one whose fingerprint was shown. Nothing was saved. Start again.' };
          }
          this.credential = { endpoint: pending.endpoint, hubId: issued.hubId, hubName: issued.hubName, hubFingerprint: issued.hubFingerprint, deviceId: issued.deviceId, credentialId: issued.credentialId, secret: issued.secret, scopes: issued.scopes, pairedAt: issued.issuedAt };
          this.saveCredential(this.credential);
          // A new hub starts from nothing: cursors from a previous pairing mean nothing to it.
          this.resetSyncState();
          this.verifiedAt = Date.now();
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
    this.verifiedAt = 0;
    this.saveCredential(null);
    this.store.set(LIVE_TV_SENT_KEY, false, new Date().toISOString());
    this.resetSyncState();
    this.setStatus({ endpoint: null, hubId: null, hubName: null, hubFingerprint: null, connected: false, scopes: [], reason: 'No hub is paired.' });
    return this.status;
  }

  hasScope(scope: string): boolean {
    return this.credential?.scopes.includes(scope) ?? false;
  }

  /* ------------------------------------------------------------------ sync */

  /**
   * One sync: exchange manifests to see what differs, then exchange deltas for those collections
   * only, a page at a time, until neither side has anything left. Metadata only — no audio moves
   * here.
   *
   * Local changes are sent from a per-collection cursor ordered by (updatedAt, id), so each
   * record is sent once rather than the whole library every time. Cursors move only after the page
   * they describe was accepted and the hub's page was applied, in one transaction.
   */
  async sync(): Promise<{ pushed: number; pulled: number; conflicts: number; reason: string | null }> {
    if (!this.credential) return { pushed: 0, pulled: 0, conflicts: 0, reason: 'No hub is paired.' };
    if (!this.hasScope('library:share')) return { pushed: 0, pulled: 0, conflicts: 0, reason: 'This companion was not given permission to share its library with the hub. Change its permissions in the hub, under Devices.' };
    const unverified = await this.ensureVerified();
    if (unverified) return { pushed: 0, pulled: 0, conflicts: 0, reason: unverified };
    const credential = this.credential;

    try {
      const local = await this.localManifest();
      const exchange = ManifestExchange.parse(await this.request<unknown>('POST', '/api/v1/sync/manifest', { body: local }));
      const differing = new Set<string>([...exchange.needed, ...collectionsNeedingSync(local.collections, exchange.serverManifest.collections)]);
      const needed = SYNC_COLLECTIONS.filter((collection) => differing.has(collection));
      if (!needed.length) {
        this.setStatus({ lastSyncAt: new Date().toISOString() });
        this.scheduleLiveTvPush(0);
        return { pushed: 0, pulled: 0, conflicts: 0, reason: null };
      }

      // A hub holding nothing for a collection (new, or restored from nothing) gets all of it again.
      const serverCounts = new Map(exchange.serverManifest.collections.map((summary) => [summary.collection, summary.count]));
      for (const collection of needed) if (!serverCounts.get(collection)) this.setCursor(pushKey(collection), null);

      let pushed = 0;
      let pulled = 0;
      let conflicts = 0;
      for (let round = 0; round < MAX_SYNC_ROUNDS; round += 1) {
        const page = this.localChanges(needed, PUSH_PAGE_SIZE);
        const since: Record<string, string | null> = {};
        for (const collection of needed) since[collection] = this.getCursor(collection);

        const response = DeltaEnvelope.parse(
          await this.request<unknown>('POST', '/api/v1/sync/delta', {
            body: { deviceId: credential.deviceId, since, changes: page.changes, enabledCollections: needed },
          }),
        );

        this.store.transaction(() => {
          pulled += this.applyRemote(response.changes);
          for (const [collection, cursor] of Object.entries(response.cursors)) this.setCursor(collection, cursor ?? null);
          for (const [collection, cursor] of page.cursors) this.advancePushCursor(collection, cursor);
        });
        pushed += response.applied;
        conflicts += response.conflicts.length;
        if (!page.more && !response.more) break;
      }
      this.setStatus({ lastSyncAt: new Date().toISOString(), reason: null });
      this.scheduleLiveTvPush(0);
      return { pushed, pulled, conflicts, reason: null };
    } catch (err) {
      const reason = err instanceof z.ZodError ? 'The hub sent a sync answer this app does not understand. Nothing from it was applied.' : describeNetworkError(err, credential.endpoint);
      this.setStatus({ reason });
      return { pushed: 0, pulled: 0, conflicts: 0, reason };
    }
  }

  /* --------------------------------------------------------------- live tv */

  /** Where the channels come from and whether sharing is on. Called once, at start-up. */
  setLiveTvSource(source: LiveTvSource): void {
    this.liveTv = source;
  }

  /** Send the Live TV soon: after a sync, or once a burst of Live TV changes has settled. */
  scheduleLiveTvPush(delayMs = LIVE_TV_PUSH_DELAY_MS): void {
    if (!this.liveTv) return;
    if (this.liveTvTimer) clearTimeout(this.liveTvTimer);
    this.liveTvTimer = setTimeout(() => {
      this.liveTvTimer = null;
      void this.pushLiveTv().then((result) => {
        if (result.reason) this.options.onNotice?.(result.reason);
      });
    }, delayMs);
    this.liveTvTimer.unref?.();
  }

  /**
   * Give the hub a copy of this companion's channels and guide (`PUT /api/v1/live-tv`), so players
   * that are not on this PC get Live TV too. Only while this PC shares with the hub; once sharing is
   * turned off, a copy sent earlier is removed. Channels whose address is not a plain web link, or
   * that carries a user name and password, stay on this PC: every paired player would see it.
   * Returns a reason only when something worth telling the person went wrong.
   */
  async pushLiveTv(): Promise<{ sent: boolean; reason: string | null }> {
    const source = this.liveTv;
    if (!source || !this.credential || !this.hasScope('library:share')) return { sent: false, reason: null };
    const sentBefore = this.store.get<boolean>(LIVE_TV_SENT_KEY, false);
    const sharing = source.sharing();
    try {
      const channels = sharing
        ? (await source.channels())
            .filter((c) => isPlainWebUrl(c.url))
            .map((c) => ({ ...c, logo: c.logo && isPlainWebUrl(c.logo) ? c.logo : null }))
            .slice(0, HUB_LIVE_TV_MAX_CHANNELS)
        : [];
      if (!channels.length) {
        if (!sentBefore) return { sent: false, reason: null };
        if (await this.ensureVerified()) return { sent: false, reason: null };
        await this.request<unknown>('DELETE', '/api/v1/live-tv');
        this.store.set(LIVE_TV_SENT_KEY, false, new Date().toISOString());
        return { sent: true, reason: null };
      }
      const unverified = await this.ensureVerified();
      if (unverified) return { sent: false, reason: null };
      const ids = new Set(channels.map((c) => c.tvgId?.toLowerCase()).filter(Boolean));
      const guide = (await source.guide()).filter((g) => ids.has(g.tvgId.toLowerCase())).slice(0, HUB_LIVE_TV_MAX_CHANNELS);
      await this.request<unknown>('PUT', '/api/v1/live-tv', { body: { channels, guide } });
      this.store.set(LIVE_TV_SENT_KEY, true, new Date().toISOString());
      return { sent: true, reason: null };
    } catch (err) {
      return { sent: false, reason: `Live TV could not be sent to the hub: ${err instanceof Error ? err.message : String(err)}` };
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
    const table = REMOTE_COLLECTIONS[collection]?.table;
    if (!table) return [];
    return this.store.raw
      .prepare<[], { id: string; body: string; updated_at: string; deleted_at: string | null }>(`SELECT id, body, updated_at, deleted_at FROM ${table}`)
      .all()
      .map((row) => sanitize({ ...(JSON.parse(row.body) as Record<string, unknown>), id: row.id, updatedAt: row.updated_at, deletedAt: row.deleted_at }));
  }

  /**
   * The next page of local changes: records after each collection's push cursor, oldest first.
   * Records that arrived *from* the hub (and have not changed since) are skipped, but the cursor
   * still moves past them.
   */
  private localChanges(collections: readonly SyncCollection[], limit: number): { changes: SyncChange[]; cursors: Array<[SyncCollection, PushCursor]>; more: boolean } {
    const changes: SyncChange[] = [];
    const cursors: Array<[SyncCollection, PushCursor]> = [];
    let more = false;
    for (const collection of collections) {
      const budget = limit - changes.length;
      if (budget <= 0) {
        more = true;
        break;
      }
      const remoteTable = REMOTE_COLLECTIONS[collection]?.table;
      const source = collection === 'tracks' ? { table: 'tracks', body: 'track' } : remoteTable ? { table: remoteTable, body: 'body' } : null;
      if (!source) continue;
      const after = this.pushCursor(collection) ?? { updatedAt: '', id: '' };
      const rows = this.store.raw
        .prepare<[string, string, string, string, number], { id: string; body: string; updated_at: string; deleted_at: string | null; echo: string | null }>(
          `SELECT t.id, t.${source.body} AS body, t.updated_at, t.deleted_at, e.id AS echo FROM ${source.table} t LEFT JOIN sync_echoes e ON e.collection = ? AND e.id = t.id AND e.updated_at = t.updated_at WHERE t.updated_at > ? OR (t.updated_at = ? AND t.id > ?) ORDER BY t.updated_at, t.id LIMIT ?`,
        )
        .all(collection, after.updatedAt, after.updatedAt, after.id, budget);
      for (const row of rows) {
        if (row.echo !== null) continue;
        const { id, updatedAt, deletedAt, ...body } = sanitize({ ...(JSON.parse(row.body) as Record<string, unknown>), id: row.id, updatedAt: row.updated_at, deletedAt: row.deleted_at });
        changes.push({ collection, id, updatedAt: deletedAt ?? updatedAt, deleted: Boolean(deletedAt), body: deletedAt ? null : body, changeId: uuidv7() });
      }
      const last = rows[rows.length - 1];
      if (last) cursors.push([collection, { updatedAt: last.updated_at, id: last.id }]);
      if (rows.length === budget) {
        more = true;
        break;
      }
    }
    return { changes, cursors, more };
  }

  /**
   * Apply one page of the hub's changes. Each change is validated against the contract before it
   * is stored; a malformed one is skipped rather than failing the page, so the cursor still moves.
   * Tracks are never taken from the hub — it does not dictate what is on this disk — and a record
   * edited here more recently than the hub's copy is kept. Returns how many changes were applied.
   */
  private applyRemote(changes: readonly unknown[]): number {
    let applied = 0;
    for (const raw of changes) {
      const parsed = SyncChange.safeParse(raw);
      if (!parsed.success) continue;
      const change = parsed.data;
      const target = REMOTE_COLLECTIONS[change.collection];
      if (!target) continue;
      const local = this.store.syncedState(target.table, change.id);
      if (local && Date.parse(local.updatedAt) > Date.parse(change.updatedAt)) continue;
      if (change.deleted) {
        this.store.tombstoneSynced(target.table, change.id, change.updatedAt);
      } else {
        const entity = target.schema.safeParse({ createdAt: change.updatedAt, ...(change.body ?? {}), id: change.id, updatedAt: change.updatedAt, deletedAt: null });
        if (!entity.success) continue;
        this.store.putSynced(target.table, change.id, entity.data, change.updatedAt, null);
      }
      // Remember that this version came from the hub, so it is not sent straight back.
      this.store.raw.prepare('INSERT INTO sync_echoes (collection, id, updated_at) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET updated_at = excluded.updated_at').run(change.collection, change.id, change.updatedAt);
      applied += 1;
    }
    return applied;
  }

  private getCursor(key: string): string | null {
    return this.store.raw.prepare<[string], { cursor: string | null }>('SELECT cursor FROM sync_cursors WHERE collection = ?').get(key)?.cursor ?? null;
  }

  private setCursor(key: string, cursor: string | null): void {
    this.store.raw.prepare('INSERT INTO sync_cursors (collection, cursor) VALUES (?, ?) ON CONFLICT(collection) DO UPDATE SET cursor = excluded.cursor').run(key, cursor);
  }

  private pushCursor(collection: SyncCollection): PushCursor | null {
    const value = this.getCursor(pushKey(collection));
    if (!value) return null;
    try {
      const [updatedAt, id] = JSON.parse(value) as [unknown, unknown];
      return typeof updatedAt === 'string' && typeof id === 'string' ? { updatedAt, id } : null;
    } catch {
      return null;
    }
  }

  private advancePushCursor(collection: SyncCollection, cursor: PushCursor): void {
    this.setCursor(pushKey(collection), JSON.stringify([cursor.updatedAt, cursor.id]));
    // Echo markers at or before the cursor have done their job.
    this.store.raw.prepare('DELETE FROM sync_echoes WHERE collection = ? AND (updated_at < ? OR (updated_at = ? AND id <= ?))').run(collection, cursor.updatedAt, cursor.updatedAt, cursor.id);
  }

  private resetSyncState(): void {
    this.store.transaction(() => {
      this.store.raw.prepare('DELETE FROM sync_cursors').run();
      this.store.raw.prepare('DELETE FROM sync_echoes').run();
    });
  }

  /* -------------------------------------------------------------- transfers */

  /**
   * Send one track's bytes to the hub, chunked and resumable. The file is read a chunk at a time,
   * so its size is not limited by memory. The hub verifies the SHA-256 before accepting it, so a
   * truncated upload is discarded rather than stored as a corrupt file.
   */
  async uploadTrack(trackId: string, onProgress?: (bytesDone: number, bytesTotal: number) => void, signal?: AbortSignal): Promise<{ ok: boolean; reason: string | null }> {
    if (!this.credential) return { ok: false, reason: 'No hub is paired.' };
    if (!this.hasScope('transfers:receive')) return { ok: false, reason: 'This companion was not given permission to transfer files.' };
    const path = absolutePathOf(this.store, trackId);
    if (!path) return { ok: false, reason: 'That track is not on this computer any more.' };
    const unverified = await this.ensureVerified();
    if (unverified) return { ok: false, reason: unverified };
    const endpoint = this.credential.endpoint;

    let handle: FileHandle | undefined;
    try {
      handle = await open(path, 'r');
      const size = (await handle.stat()).size;
      const hash = await fullHash(path);
      signal?.throwIfAborted();
      const head = await fetchWithTimeout(`${endpoint}/api/v1/files/${hash}`, { method: 'HEAD', headers: this.authHeaders() }, { signal });
      if (head.status === 200) {
        onProgress?.(size, size);
        return { ok: true, reason: null }; // The hub already has it.
      }
      let offset = parseByteCount(head.headers.get('x-received-bytes') ?? '0');
      if (offset === null || offset > size) return { ok: false, reason: 'The hub reported an upload position that does not fit this file. Nothing more was sent.' };

      let complete = false;
      do {
        const length = Math.min(CHUNK_BYTES, size - offset);
        // A fresh buffer per chunk: fetch may still hold the previous one.
        const body = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(body, filled, length - filled, offset + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        if (filled < length) return { ok: false, reason: 'The file got shorter while it was being sent. Try again once it has stopped changing.' };
        const response = await fetchWithTimeout(
          `${endpoint}/api/v1/files/${hash}?offset=${offset}&total=${size}`,
          { method: 'PUT', headers: { ...this.authHeaders(), 'content-type': 'application/octet-stream' }, body },
          { signal, timeoutMs: UPLOAD_CHUNK_TIMEOUT_MS },
        );
        if (!response.ok) return { ok: false, reason: await problemMessage(response) };
        const result = (await response.json()) as { receivedBytes?: unknown; complete?: unknown };
        const received = typeof result.receivedBytes === 'number' && Number.isSafeInteger(result.receivedBytes) && result.receivedBytes >= 0 ? result.receivedBytes : null;
        complete = result.complete === true;
        // Refuse an answer that does not move the upload forward, rather than looping on it.
        if (received === null || received > size || (!complete && received <= offset)) return { ok: false, reason: 'The hub gave an unexpected answer while receiving the file. The upload was stopped.' };
        offset = received;
        onProgress?.(offset, size);
      } while (!complete && offset < size);
      if (!complete) return { ok: false, reason: 'The hub did not confirm that it received the whole file.' };
      return { ok: true, reason: null };
    } catch (err) {
      if (signal?.aborted) return { ok: false, reason: 'Cancelled.' };
      return { ok: false, reason: describeNetworkError(err, endpoint) };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Stream a file rather than buffering it, for the large-library case. */
  openTrackStream(trackId: string): NodeJS.ReadableStream | null {
    const path = absolutePathOf(this.store, trackId);
    return path ? createReadStream(path) : null;
  }

  /* ----------------------------------------------------------------- plumbing */

  private appVersion(): string {
    return this.options.appVersion ?? process.env['NP_VERSION'] ?? '0.0.0';
  }

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
    const response = await fetchWithTimeout(`${this.credential.endpoint}${path}`, init);
    if (!response.ok) throw new Error(await problemMessage(response));
    return (await response.json()) as T;
  }

  /**
   * A stable per-device identity: 32 random bytes, generated once and kept.
   *
   * Not a public key, and there is no private key to go with it — the old name said otherwise. It
   * is an identifier the hub fingerprints at pairing so a credential belongs to one device, and so
   * both ends can show the same confirmation string. It proves possession of nothing.
   *
   * Kept under the old storage key, and sent as the wire field of the same name, so a companion
   * that paired before the rename keeps the identity it paired with.
   */
  private deviceIdentity(): string {
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

function pushKey(collection: string): string {
  return `push:${collection}`;
}

/** A non-negative whole number of bytes, or null for anything else (including `NaN`). */
export function parseByteCount(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported scheme');
  return withScheme;
}

/**
 * True for an unencrypted address that is neither this computer nor a private network. Plain http
 * on a home network is the common self-hosting case and is allowed without comment.
 */
export function isPlainHttpOverInternet(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa') || host.endsWith('.internal')) return false;
  if (!host.includes('.') && !host.includes(':')) return false; // A single-label name only resolves on a local network.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
  }
  if (host.includes(':')) return !(host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host));
  return true;
}

async function fetchWithTimeout(url: string, init: RequestInit, options: { signal?: AbortSignal | undefined; timeoutMs?: number } = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
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
  if (err instanceof Error && err.name === 'TimeoutError') {
    return `${endpoint} did not answer in time. The hub may be busy or unreachable. Your library on this computer is unaffected.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(message)) {
    return `Could not reach ${endpoint}. The hub may be off, or this computer may be on a different network. Your library on this computer is unaffected.`;
  }
  return message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

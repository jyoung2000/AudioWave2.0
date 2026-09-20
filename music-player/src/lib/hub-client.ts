/**
 * Optional hub connection.
 *
 * The player is complete without a hub: the client exists so that *if* one is paired, search,
 * group listening and shared links become available. Every method reports unavailability as a
 * reason string rather than throwing into the UI, because "no hub" is a normal state, not an error.
 *
 * The device credential is stored in IndexedDB, never in localStorage: it is a bearer secret, and
 * localStorage is readable by any script that manages to run on the page.
 */
import { ReleaseMetadata } from '@now-playing/contracts';
import type { GroupPlaybackState, GroupView, HubIdentity, ProviderDescriptor, Queue, QueueCommand, SearchResponse, ShareLinkView, TrackRef } from '@now-playing/contracts';
import { getSetting, putSetting, type PlayerDatabase } from './db.js';

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

export interface HubStatus {
  connected: boolean;
  endpoint: string | null;
  hubName: string | null;
  /** Why the hub is unusable right now, in a sentence. Null when it is fine. */
  reason: string | null;
  identity: HubIdentity | null;
  scopes: string[];
}

const CREDENTIAL_KEY = 'hub.credential';

export class HubClient {
  private credential: HubCredential | null = null;
  private readonly signedStreams = new Map<string, { url: string; expiresAt: number }>();
  private status: HubStatus = { connected: false, endpoint: null, hubName: null, reason: 'No hub is paired.', identity: null, scopes: [] };
  private readonly listeners = new Set<(status: HubStatus) => void>();

  constructor(private readonly db: PlayerDatabase) {}

  subscribe(listener: (status: HubStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  getStatus(): HubStatus {
    return this.status;
  }

  private setStatus(patch: Partial<HubStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }

  async load(): Promise<void> {
    this.credential = await getSetting<HubCredential | null>(this.db, CREDENTIAL_KEY, null);
    if (!this.credential) {
      this.setStatus({ connected: false, endpoint: null, hubName: null, reason: 'No hub is paired.', scopes: [] });
      return;
    }
    this.setStatus({ endpoint: this.credential.endpoint, hubName: this.credential.hubName, scopes: this.credential.scopes });
    await this.refresh();
  }

  /** Check the hub is reachable and is still the hub we paired with. */
  async refresh(): Promise<HubStatus> {
    if (!this.credential) return this.status;
    try {
      const identity = await this.request<HubIdentity>('GET', '/api/v1/hub', { authenticated: false });
      if (identity.hubId !== this.credential.hubId) {
        // A different hub answering on the same address is exactly the case a fingerprint exists to
        // catch. Refuse rather than sending a credential to it.
        this.setStatus({ connected: false, identity: null, reason: `The server at ${this.credential.endpoint} is a different hub than the one you paired with. Nothing was sent to it.` });
        return this.status;
      }
      this.setStatus({ connected: true, identity, hubName: identity.name, reason: null });
    } catch (err) {
      this.setStatus({ connected: false, identity: null, reason: describeNetworkError(err, this.credential.endpoint) });
    }
    return this.status;
  }

  async savePairing(credential: HubCredential): Promise<void> {
    this.credential = credential;
    this.signedStreams.clear();
    await putSetting(this.db, CREDENTIAL_KEY, credential);
    this.setStatus({ endpoint: credential.endpoint, hubName: credential.hubName, scopes: credential.scopes });
    await this.refresh();
  }

  async forget(): Promise<void> {
    this.credential = null;
    this.signedStreams.clear();
    await putSetting(this.db, CREDENTIAL_KEY, null);
    this.setStatus({ connected: false, endpoint: null, hubName: null, identity: null, reason: 'No hub is paired.', scopes: [] });
  }

  hasScope(scope: string): boolean {
    return this.credential?.scopes.includes(scope) ?? false;
  }

  /**
   * Pair with a hub using a code from its admin GUI. The fingerprint the hub returns is shown to
   * the person *before* the credential is issued: they compare it with the hub's screen, and only
   * then confirm. That comparison is the whole point of the handshake.
   */
  async claim(endpoint: string, code: string, deviceName: string): Promise<{ sessionId: string; claimSecret: string; verificationFingerprint: string; hubFingerprint: string; hubId: string; hubName: string; expiresAt: string }> {
    const base = normalizeEndpoint(endpoint);
    const response = await fetch(`${base}/api/v1/pairing/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), deviceName, deviceKind: 'player', publicKey: await deviceIdentity(this.db), appVersion: '0.1.0', protocolVersion: 1, platform: navigator.userAgent.slice(0, 80) }),
      signal: requestTimeout(),
    });
    if (!response.ok) throw new Error(await problemMessage(response));
    return (await response.json()) as never;
  }

  /** Poll until the person at the hub confirms the fingerprint. */
  async pairingStatus(endpoint: string, sessionId: string, claimSecret: string): Promise<string> {
    const response = await fetch(`${normalizeEndpoint(endpoint)}/api/v1/pairing/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, claimSecret }), signal: requestTimeout() });
    if (!response.ok) throw new Error(await problemMessage(response));
    return ((await response.json()) as { state: string }).state;
  }

  async complete(endpoint: string, sessionId: string, claimSecret: string): Promise<HubCredential> {
    const base = normalizeEndpoint(endpoint);
    const response = await fetch(`${base}/api/v1/pairing/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, claimSecret }), signal: requestTimeout() });
    if (!response.ok) throw new Error(await problemMessage(response));
    const credential = (await response.json()) as { credentialId: string; deviceId: string; hubId: string; hubName: string; hubFingerprint: string; secret: string; scopes: string[]; issuedAt: string };
    const stored: HubCredential = { endpoint: base, hubId: credential.hubId, hubName: credential.hubName, hubFingerprint: credential.hubFingerprint, deviceId: credential.deviceId, credentialId: credential.credentialId, secret: credential.secret, scopes: credential.scopes, pairedAt: credential.issuedAt };
    await this.savePairing(stored);
    return stored;
  }

  /* --------------------------------------------------------------- features */

  /**
   * What the hub's administrator actually enabled, and how each provider is faring right now. The
   * player carries its own reviewed table of what the platforms permit; this narrows it to what is
   * configured and reachable today.
   */
  async providers(): Promise<ProviderDescriptor[]> {
    const result = await this.request<{ items: ProviderDescriptor[] }>('GET', '/api/v1/providers');
    return result.items;
  }

  async search(query: string, scope = 'all'): Promise<SearchResponse> {
    return this.request<SearchResponse>('GET', `/api/v1/search?q=${encodeURIComponent(query)}&scope=${encodeURIComponent(scope)}`);
  }

  async createShare(input: { kind: 'track' | 'album' | 'playlist' | 'library'; targetId: string; title?: string; allowStream?: boolean; allowDownload?: boolean; expiresInSeconds?: number | null; maxAccesses?: number | null; items?: unknown[] }): Promise<{ share: ShareLinkView; token: string; url: string | null }> {
    const result = await this.request<{ share: ShareLinkView; token: string }>('POST', '/api/v1/shares', {
      body: {
        kind: input.kind,
        targetId: input.targetId,
        title: input.title,
        allowStream: input.allowStream ?? true,
        allowDownload: input.allowDownload ?? false,
        expiresInSeconds: input.expiresInSeconds ?? null,
        maxAccesses: input.maxAccesses ?? null,
        items: input.items,
      },
    });
    return { ...result, url: result.share.url ?? (this.credential ? `${this.credential.endpoint}/s/${result.token}` : null) };
  }

  /**
   * The Windows companion release this hub is offering, or null when it is offering none.
   *
   * A 404 is the documented answer for "no release configured" and is not an error to shout about —
   * the caller renders nothing rather than a dead download button. The route is unauthenticated, so
   * it also answers before a pairing is complete.
   */
  async windowsCompanionRelease(): Promise<ReleaseMetadata | null> {
    try {
      const body = await this.request<unknown>('GET', '/api/v1/releases/windows-companion/latest', { authenticated: false });
      const parsed = ReleaseMetadata.safeParse(body);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async listShares(): Promise<ShareLinkView[]> {
    return (await this.request<{ items: ShareLinkView[] }>('GET', '/api/v1/shares')).items;
  }

  async revokeShare(shareId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/shares/${encodeURIComponent(shareId)}`);
  }

  /* ------------------------------------------------------------- shared listening */

  async listGroups(): Promise<GroupView[]> {
    return (await this.request<{ items: GroupView[] }>('GET', '/api/v1/groups')).items;
  }

  async createGroup(name: string): Promise<GroupView> {
    return this.request<GroupView>('POST', '/api/v1/groups', { body: { name } });
  }

  async joinGroup(inviteCode: string, displayName: string): Promise<GroupView> {
    return this.request<GroupView>('POST', '/api/v1/groups/join', { body: { inviteCode, displayName } });
  }

  async leaveGroup(groupId: string): Promise<void> {
    await this.request('POST', `/api/v1/groups/${encodeURIComponent(groupId)}/leave`);
  }

  async createInvite(groupId: string, ttlSeconds = 3600): Promise<{ inviteCode: string; expiresAt: string }> {
    return this.request('POST', `/api/v1/groups/${encodeURIComponent(groupId)}/invites`, { body: { ttlSeconds, role: 'member' } });
  }

  async groupQueue(groupId: string): Promise<{ queue: Queue; playback: GroupPlaybackState; serverTime: string }> {
    return this.request('GET', `/api/v1/groups/${encodeURIComponent(groupId)}/queue`);
  }

  /**
   * A revisioned, idempotent queue command.
   *
   * `baseRevision` is what makes a shared queue safe: two people pressing skip at the same moment
   * send the same base, and the hub applies one and rejects the other with `stale-revision` rather
   * than skipping two songs. The rejection is not an error to hide — it is the answer.
   */
  async groupCommand(groupId: string, idempotencyKey: string, baseRevision: number, command: QueueCommand): Promise<unknown> {
    return this.request('POST', `/api/v1/groups/${encodeURIComponent(groupId)}/queue/commands`, { body: { idempotencyKey, baseRevision, command } });
  }

  /**
   * Everything needed to open the realtime socket, or null with the reason.
   *
   * The credential is handed out as a *subprotocol token* because that is the only header a browser
   * WebSocket lets you set, and it is what the hub reads. It stays inside this module otherwise:
   * the group client is given a URL and a protocol list, never the secret to keep.
   */
  realtimeTarget(): { url: string; protocols: string[] } | { url: null; reason: string } {
    if (!this.credential) return { url: null, reason: 'No hub is paired.' };
    if (typeof WebSocket === 'undefined') return { url: null, reason: 'This browser has no WebSocket support.' };
    const base = this.credential.endpoint.replace(/^http/i, 'ws');
    return { url: `${base}/api/v1/realtime?protocol=1`, protocols: ['np-v1', `np-auth-${this.credential.credentialId}.${this.credential.secret}`] };
  }

  async sendEvents(events: readonly unknown[]): Promise<{ accepted: number; duplicates: number }> {
    return this.request('POST', '/api/v1/listening-events', { body: { events } });
  }

  /**
   * An `<audio>` element cannot send the bearer credential, so the hub signs a short-lived URL for
   * it. Cached until shortly before it expires.
   */
  async streamUrl(track: TrackRef): Promise<string | null> {
    const hubLocator = track.locators.find((l) => l.kind === 'hub-blob');
    if (!hubLocator || !this.credential) return null;
    const cached = this.signedStreams.get(track.trackId);
    if (cached && cached.expiresAt - Date.now() > STREAM_URL_MARGIN_MS) return cached.url;
    const signed = await this.request<{ items: Array<{ trackId: string; url: string }>; expiresAt: string }>('POST', '/api/v1/library/stream-urls', { body: { trackIds: [track.trackId] } });
    const url = signed.items.find((item) => item.trackId === track.trackId)?.url ?? null;
    if (url) this.signedStreams.set(track.trackId, { url, expiresAt: Date.parse(signed.expiresAt) });
    return url;
  }

  /* ----------------------------------------------------------------- plumbing */

  private async request<T>(method: string, path: string, options: { body?: unknown; authenticated?: boolean } = {}): Promise<T> {
    if (!this.credential) throw new Error('No hub is paired.');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.authenticated !== false) headers['authorization'] = `Bearer ${this.credential.credentialId}.${this.credential.secret}`;
    const init: RequestInit = { method, headers, signal: requestTimeout() };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(`${this.credential.endpoint}${path}`, init);
    if (!response.ok) throw new Error(await problemMessage(response));
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

/** A signed stream URL is replaced this long before it expires, so a long track never outlives it mid-seek. */
const STREAM_URL_MARGIN_MS = 60 * 60 * 1000;

/** How long any hub request may take. A hub on a network this device has left would otherwise hang. */
const REQUEST_TIMEOUT_MS = 10_000;

function requestTimeout(): AbortSignal | null {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : null;
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
  if (err instanceof Error && err.name === 'TimeoutError') {
    return `${endpoint} did not answer in time. The hub may be off, or this device may be on a different network. The player keeps working with the music on this device.`;
  }
  if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
    return `Could not reach ${endpoint}. The hub may be off, or this device may be on a different network. The player keeps working with the music on this device.`;
  }
  return message;
}

/**
 * A stable per-device identity: 32 random bytes, generated once and kept.
 *
 * It is **not** a public key and there is no private key — an earlier comment here claimed one
 * "never leaves this browser", which described something that was never built. What it actually
 * provides is an identifier the hub can fingerprint at pairing, so a credential is tied to one
 * device rather than floating free, and so the two ends can read the same short confirmation
 * string to each other. It proves possession of nothing; the pairing code and the hub-issued
 * credential are what carry the security here.
 *
 * Stored under the old `devicePublicKey` key so devices paired before the rename keep the identity
 * they paired with. It is sent as the wire field of the same name, which is why that field is not
 * renamed either — see `routes.pairingClaim`.
 */
async function deviceIdentity(db: PlayerDatabase): Promise<string> {
  const stored = await getSetting<string | null>(db, 'devicePublicKey', null);
  if (stored) return stored;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await putSetting(db, 'devicePublicKey', key);
  return key;
}

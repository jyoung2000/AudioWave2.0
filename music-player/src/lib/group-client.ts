/**
 * Shared listening: the player's side of a hub group.
 *
 * The hub has had the whole of this for a while — groups, memberships, a revisioned queue with an
 * idempotent command log, presence, and a realtime socket that pushes snapshots and deltas. The
 * player never used any of it, which meant "shared listening" existed as a feature of the system
 * and not as something a person could do. This connects the two.
 *
 * Three rules shape the code:
 *
 * - **The hub is the queue.** Nothing here keeps a local copy that could disagree. Every mutation
 *   is a command sent with the revision it was based on; the hub applies it or rejects it, and the
 *   rejection is shown rather than retried into a race.
 * - **Unavailable is a state, not an exception.** No hub, an unreachable hub, a browser that will
 *   not open a socket from a `file://` page — each of those is a `reason` string the UI prints. The
 *   switch is never present and inert.
 * - **Reconnect, but say so.** A dropped socket reconnects with backoff and asks for a replay from
 *   the last sequence it saw. While it is down the UI says the queue may be behind, because it may.
 */
import type { GroupPlaybackState, GroupView, Queue, QueueCommand } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import type { HubClient } from './hub-client.js';
import { isFileOrigin } from './build-flags.js';

export interface SharedMember {
  memberId: string;
  displayName: string;
  role: string;
  online: boolean;
}

export interface SharedState {
  /** Null when shared listening can be used; otherwise the sentence explaining why not. */
  unavailableReason: string | null;
  connection: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
  group: { id: string; name: string; role: string | null } | null;
  members: SharedMember[];
  queue: Queue | null;
  playback: GroupPlaybackState | null;
  /** The last command the hub refused, and why. Cleared when the next one is accepted. */
  rejection: string | null;
  /** Set while the socket is down, so the UI can stop pretending the queue is current. */
  staleSince: string | null;
}

const IDLE: SharedState = { unavailableReason: null, connection: 'idle', group: null, members: [], queue: null, playback: null, rejection: null, staleSince: null };

type Listener = (state: SharedState) => void;

export class GroupClient {
  private state: SharedState = { ...IDLE };
  private readonly listeners = new Set<Listener>();
  private socket: WebSocket | null = null;
  private lastSeq = 0;
  private attempt = 0;
  private retryTimer: number | null = null;
  private closing = false;

  constructor(
    private readonly hub: HubClient,
    private readonly displayName: () => string,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): SharedState {
    return this.state;
  }

  private patch(patch: Partial<SharedState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /**
   * Why shared listening cannot be used right now, or null.
   *
   * Ordered from the most specific cause to the least, so the sentence a person reads names the
   * thing they can actually change.
   */
  availability(hubConnected: boolean, hubReason: string | null): string | null {
    if (isFileOrigin()) return 'Shared listening needs a WebSocket, and a browser will not open one from a page loaded off the disk. Serve the player over http to listen with other people.';
    const target = this.hub.realtimeTarget();
    if (target.url === null) return target.reason === 'No hub is paired.' ? 'Shared listening needs a paired hub — something both devices can reach. Pair one in Settings.' : target.reason;
    if (!hubConnected) return hubReason ?? 'The hub is not reachable from here.';
    return null;
  }

  refreshAvailability(hubConnected: boolean, hubReason: string | null): void {
    const reason = this.availability(hubConnected, hubReason);
    if (reason !== this.state.unavailableReason) this.patch({ unavailableReason: reason });
    if (reason && this.socket) this.disconnect();
  }

  /* ------------------------------------------------------------------ groups */

  async list(): Promise<GroupView[]> {
    return this.hub.listGroups();
  }

  async create(name: string): Promise<GroupView> {
    const group = await this.hub.createGroup(name);
    await this.open(group);
    return group;
  }

  async join(inviteCode: string): Promise<GroupView> {
    const group = await this.hub.joinGroup(inviteCode.trim(), this.displayName());
    await this.open(group);
    return group;
  }

  async invite(ttlSeconds = 3600): Promise<{ inviteCode: string; expiresAt: string }> {
    const group = this.state.group;
    if (!group) throw new Error('Join or create a group first.');
    return this.hub.createInvite(group.id, ttlSeconds);
  }

  async leave(): Promise<void> {
    const group = this.state.group;
    this.disconnect();
    if (group) await this.hub.leaveGroup(group.id);
    this.patch({ group: null, members: [], queue: null, playback: null, rejection: null, staleSince: null });
  }

  /** Attach to a group: fetch the authoritative queue once over HTTP, then follow the socket. */
  async open(group: GroupView | { id: string; name: string; myRole?: string | null }): Promise<void> {
    const id = 'id' in group ? group.id : '';
    const name = group.name;
    const role = 'myRole' in group ? (group.myRole ?? null) : null;
    this.patch({ group: { id, name, role }, rejection: null });
    try {
      const snapshot = await this.hub.groupQueue(id);
      this.patch({ queue: snapshot.queue, playback: snapshot.playback });
    } catch (error) {
      // Not fatal: the socket sends a snapshot of its own on subscribe. Recorded so the UI can say
      // the first view came from the socket rather than silently showing an empty queue.
      this.patch({ rejection: describe(error) });
    }
    this.connect();
  }

  /* ------------------------------------------------------------------ socket */

  private connect(): void {
    const group = this.state.group;
    if (!group || this.socket) return;
    const target = this.hub.realtimeTarget();
    if (target.url === null) {
      this.patch({ connection: 'failed', unavailableReason: target.reason });
      return;
    }
    this.closing = false;
    this.patch({ connection: this.attempt ? 'reconnecting' : 'connecting' });
    const socket = new WebSocket(target.url, target.protocols);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.patch({ connection: 'connected', staleSince: null });
      this.send('group.subscribe', { groupId: group.id });
    });

    socket.addEventListener('message', (event) => {
      this.receive(String(event.data));
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      if (this.closing) {
        this.patch({ connection: 'idle' });
        return;
      }
      this.patch({ connection: 'reconnecting', staleSince: this.state.staleSince ?? new Date().toISOString() });
      this.scheduleReconnect();
    });

    // `error` always arrives with a `close` behind it, so the reconnect lives there and this only
    // has to make sure the reason is not lost.
    socket.addEventListener('error', () => {
      if (this.state.connection === 'connecting') this.patch({ rejection: 'The hub refused the realtime connection.' });
    });
  }

  private scheduleReconnect(): void {
    if (this.retryTimer !== null) return;
    this.attempt += 1;
    // The hub publishes these numbers in REALTIME_DEFAULTS; matching them means a hub restart does
    // not produce a thundering herd of players.
    const base = Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6));
    const delay = base * (1 + (Math.random() - 0.5) * 0.6);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private send(type: string, payload: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ eventId: uuidv7(), type, occurredAt: new Date().toISOString(), schemaVersion: 1, actorId: this.displayName(), payload }));
  }

  private receive(raw: string): void {
    let envelope: { type?: string; payload?: unknown; seq?: number };
    try {
      envelope = JSON.parse(raw) as typeof envelope;
    } catch {
      return;
    }
    if (typeof envelope.seq === 'number') this.lastSeq = envelope.seq;
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    switch (envelope.type) {
      case 'group.snapshot':
        this.patch({
          queue: payload['queue'] as Queue,
          playback: payload['playback'] as GroupPlaybackState,
          members: (payload['members'] as SharedMember[]) ?? [],
          staleSince: null,
        });
        break;
      case 'group.queue.updated':
        this.patch({ queue: payload['queue'] as Queue, rejection: null });
        break;
      case 'group.playback':
        this.patch({ playback: payload as unknown as GroupPlaybackState });
        break;
      case 'group.command.rejected':
        this.patch({ rejection: String(payload['reason'] ?? 'The hub refused that change.') });
        break;
      case 'presence': {
        const memberId = String(payload['memberId'] ?? '');
        const online = Boolean(payload['online']);
        const known = this.state.members.some((m) => m.memberId === memberId);
        this.patch({
          members: known
            ? this.state.members.map((m) => (m.memberId === memberId ? { ...m, online } : m))
            : [...this.state.members, { memberId, displayName: String(payload['displayName'] ?? 'Someone'), role: 'member', online }],
        });
        break;
      }
      case 'resync.required':
        this.send('resync', { groupId: this.state.group?.id, fromSeq: this.lastSeq });
        break;
      case 'error':
        this.patch({ rejection: String(payload['message'] ?? 'The hub reported an error.') });
        break;
      default:
        break;
    }
  }

  disconnect(): void {
    this.closing = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.attempt = 0;
    this.patch({ connection: 'idle' });
  }

  /**
   * Propose a change to the shared queue.
   *
   * Sent over HTTP rather than the socket: the HTTP route answers with the outcome, so a person who
   * pressed skip learns whether it happened. The socket then broadcasts the same change to
   * everyone, this player included, which is why nothing is applied locally here.
   */
  async command(command: QueueCommand): Promise<void> {
    const group = this.state.group;
    if (!group) throw new Error('You are not in a group.');
    const baseRevision = this.state.queue?.revision ?? 0;
    try {
      await this.hub.groupCommand(group.id, uuidv7(), baseRevision, command);
      this.patch({ rejection: null });
    } catch (error) {
      this.patch({ rejection: describe(error) });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

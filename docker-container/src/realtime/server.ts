import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { ClientEventPayloads, Envelope as EnvelopeSchema, REALTIME_DEFAULTS, REALTIME_PATH, WS_MIN_SUPPORTED_PROTOCOL_VERSION, WS_PROTOCOL_VERSION, type ConnectionView, type Envelope } from '@now-playing/contracts';
import { DomainError, uuidv7 } from '@now-playing/domain';
import type { HubContext } from '../context.js';
import { SESSION_COOKIE } from '../auth/service.js';
import type { Principal } from '../auth/principal.js';
import { parseCookies, requestBaseUrl } from '../api/register.js';
import type { PresenceProvider } from '../pairing/devices.js';
import type { GroupActor, GroupEventSink, GroupPresence } from '../group/service.js';

export const WS_SUBPROTOCOL = 'np-v1';
const AUTH_PREFIX = 'np-auth-';

interface Connection {
  id: string;
  socket: WebSocket;
  principal: Principal;
  memberId: string;
  displayName: string;
  kind: 'player' | 'companion' | 'hub' | 'admin';
  subscriptions: Set<string>;
  connectedAt: string;
  lastSeenAt: number;
  latencyMs: number | null;
  lastAckSeq: number;
  ipDisplay: string | null;
  appVersion: string;
  protocolVersion: number;
  reconnects: number;
  pingSentAt: number | null;
}

interface RecentConnection extends Omit<ConnectionView, 'groupId' | 'latencyMs'> {
  groupId: string | null;
  latencyMs: number | null;
}

type Deps = Pick<HubContext, 'auth' | 'deviceAuth' | 'groups' | 'devices' | 'identity' | 'clock' | 'log' | 'metrics' | 'network' | 'config' | 'deps'>;

/**
 * WebSocket fan-out for group state, presence, jobs and Discord status. Authentication happens at upgrade time
 * (device credential in the subprotocol list, or the admin cookie for same-origin browser sessions) and the principal
 * is re-checked on every message so revocation takes effect immediately.
 */
export class RealtimeServer implements GroupEventSink, GroupPresence, PresenceProvider {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  private readonly connections = new Map<string, Connection>();
  private readonly recent: RecentConnection[] = [];
  private readonly reconnectsByMember = new Map<string, number>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly subscribers = new Set<(envelope: Envelope) => void>();

  constructor(private readonly ctx: Deps) {}

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== REALTIME_PATH) {
        socket.destroy();
        return;
      }
      void this.handleUpgrade(req, socket, head);
    });
    if (!this.ctx.deps.disableBackgroundJobs) {
      this.heartbeat = setInterval(() => this.tick(), REALTIME_DEFAULTS.heartbeatIntervalMs);
      this.heartbeat.unref?.();
    }
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reject = (status: number, message: string) => {
      socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      this.ctx.metrics.increment('ws.upgrade_rejected');
    };
    try {
      const protocols = (req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (!protocols.includes(WS_SUBPROTOCOL)) return reject(426, 'Upgrade Required');
      let principal: Principal | null = null;
      const authToken = protocols.find((p) => p.startsWith(AUTH_PREFIX));
      if (authToken) {
        const [credentialId, secret] = authToken.slice(AUTH_PREFIX.length).split('.');
        if (credentialId && secret) principal = await this.ctx.deviceAuth.authenticate(credentialId, secret);
      } else {
        const cookies = parseCookies(req.headers.cookie);
        const origin = req.headers.origin;
        const base = requestBaseUrl(this.ctx, { headers: req.headers, protocol: 'http', socket: req.socket } as never);
        const sameOrigin = typeof origin !== 'string' || safeOrigin(origin) === safeOrigin(base) || (typeof req.headers.host === 'string' && (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`)) || this.ctx.network.allowedOrigins().includes(origin);
        if (sameOrigin) principal = this.ctx.auth.resolveSession(cookies[SESSION_COOKIE]);
      }
      if (!principal || principal.kind === 'anonymous') return reject(401, 'Unauthorized');
      if (!this.ctx.auth.setupComplete()) return reject(403, 'Setup Required');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const protocolVersion = Number(url.searchParams.get('protocol') ?? WS_PROTOCOL_VERSION);
      const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = this.register(ws, principal!, protocolVersion, ip);
        if (!Number.isInteger(protocolVersion) || protocolVersion < WS_MIN_SUPPORTED_PROTOCOL_VERSION) {
          this.send(conn, 'upgrade-required', { clientProtocolVersion: protocolVersion, serverProtocolVersion: WS_PROTOCOL_VERSION, minSupportedProtocolVersion: WS_MIN_SUPPORTED_PROTOCOL_VERSION, message: 'Update the app to reconnect' });
          ws.close(4426, 'upgrade-required');
          return;
        }
        this.send(conn, 'hello', { protocolVersion: WS_PROTOCOL_VERSION, minSupportedProtocolVersion: WS_MIN_SUPPORTED_PROTOCOL_VERSION, serverTime: this.nowIso(), heartbeatIntervalMs: REALTIME_DEFAULTS.heartbeatIntervalMs, replayWindow: REALTIME_DEFAULTS.replayWindow, hubId: this.ctx.identity.hubId, deviceId: principal!.kind === 'device' ? principal!.deviceId : '00000000-0000-7000-8000-000000000000' });
      });
    } catch (err) {
      this.ctx.log.warn({ module: 'realtime', err: err instanceof Error ? err.message : String(err) }, 'upgrade failed');
      reject(500, 'Internal Server Error');
    }
  }

  private register(ws: WebSocket, principal: Principal, protocolVersion: number, ip: string): Connection {
    const memberId = principal.kind === 'device' ? principal.deviceId : 'admin';
    const reconnects = this.reconnectsByMember.get(memberId) ?? 0;
    this.reconnectsByMember.set(memberId, reconnects + 1);
    const conn: Connection = {
      id: uuidv7(this.ctx.clock.now()),
      socket: ws,
      principal,
      memberId,
      displayName: principal.kind === 'device' ? principal.displayName : principal.kind === 'admin' ? principal.username : 'anonymous',
      kind: principal.kind === 'device' ? principal.device.kind : 'admin',
      subscriptions: new Set(),
      connectedAt: this.nowIso(),
      lastSeenAt: this.ctx.clock.now(),
      latencyMs: null,
      lastAckSeq: 0,
      ipDisplay: this.ctx.network.ipDisplay(ip),
      appVersion: principal.kind === 'device' ? principal.device.appVersion : 'admin-gui',
      protocolVersion,
      reconnects,
      pingSentAt: null,
    };
    this.connections.set(conn.id, conn);
    this.ctx.metrics.increment('ws.connections');
    this.ctx.metrics.increment('total.ws.connections');
    if (reconnects > 0) this.ctx.metrics.increment('ws.reconnects');
    ws.on('message', (data) => void this.onMessage(conn, data.toString()));
    ws.on('pong', () => {
      conn.lastSeenAt = this.ctx.clock.now();
      if (conn.pingSentAt !== null) {
        conn.latencyMs = Math.max(0, this.ctx.clock.now() - conn.pingSentAt);
        conn.pingSentAt = null;
      }
    });
    ws.on('close', () => this.unregister(conn));
    ws.on('error', (err) => {
      this.ctx.metrics.increment('ws.errors');
      this.ctx.log.debug({ module: 'realtime', err: err.message }, 'socket error');
    });
    return conn;
  }

  private unregister(conn: Connection): void {
    if (!this.connections.delete(conn.id)) return;
    for (const groupId of conn.subscriptions) this.announcePresence(groupId, conn, false);
    this.recent.unshift({ ...this.view(conn), groupId: [...conn.subscriptions][0] ?? null });
    if (this.recent.length > 50) this.recent.length = 50;
  }

  private nowIso(): string {
    return new Date(this.ctx.clock.now()).toISOString();
  }

  private send(conn: Connection, type: string, payload: unknown, seq?: number): void {
    if (conn.socket.readyState !== WebSocket.OPEN) return;
    const envelope: Envelope = { eventId: uuidv7(this.ctx.clock.now()), type, occurredAt: this.nowIso(), schemaVersion: WS_PROTOCOL_VERSION, actorId: 'hub', payload, ...(seq !== undefined ? { seq } : {}) };
    conn.socket.send(JSON.stringify(envelope));
    this.ctx.metrics.increment('ws.messages_out');
  }

  private sendEnvelope(conn: Connection, envelope: Envelope): void {
    if (conn.socket.readyState !== WebSocket.OPEN) return;
    conn.socket.send(JSON.stringify(envelope));
    this.ctx.metrics.increment('ws.messages_out');
  }

  private sendError(conn: Connection, code: string, message: string, fatal = false): void {
    this.send(conn, 'error', { code, message, fatal });
    if (fatal) conn.socket.close(4401, code);
  }

  private actorFor(conn: Connection): GroupActor {
    if (conn.principal.kind === 'admin') return { id: 'admin', kind: 'admin', displayName: conn.displayName, isHubAdmin: true };
    return { id: conn.memberId, kind: 'device', displayName: conn.displayName };
  }

  /** Re-validate the principal on every message so revoked credentials cannot keep an open socket useful. */
  private stillValid(conn: Connection): boolean {
    if (conn.principal.kind === 'device') {
      // The secret is not retained after the upgrade; revocation is checked through the device record on every message.
      const device = this.ctx.devices.find(conn.principal.deviceId);
      return !!device && !device.revokedAt && !device.deletedAt;
    }
    if (conn.principal.kind === 'admin') return true;
    return false;
  }

  private async onMessage(conn: Connection, raw: string): Promise<void> {
    conn.lastSeenAt = this.ctx.clock.now();
    this.ctx.metrics.increment('ws.messages_in');
    let envelope: Envelope;
    try {
      envelope = EnvelopeSchema.parse(JSON.parse(raw));
    } catch {
      this.sendError(conn, 'invalid-envelope', 'Message is not a valid envelope');
      return;
    }
    if (!this.stillValid(conn)) {
      this.sendError(conn, 'unauthenticated', 'Credential is no longer valid', true);
      return;
    }
    const schema = ClientEventPayloads[envelope.type as keyof typeof ClientEventPayloads];
    if (!schema) {
      this.sendError(conn, 'unknown-type', `Unknown message type ${envelope.type}`);
      return;
    }
    const parsed = schema.safeParse(envelope.payload);
    if (!parsed.success) {
      this.sendError(conn, 'invalid-payload', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    const payload = parsed.data as Record<string, unknown>;
    try {
      switch (envelope.type as keyof typeof ClientEventPayloads) {
        case 'ping': {
          const receive = this.ctx.clock.now();
          this.send(conn, 'pong', { clientTime: payload['clientTime'], serverReceive: receive, serverSend: this.ctx.clock.now() });
          break;
        }
        case 'ack':
          conn.lastAckSeq = payload['lastSeq'] as number;
          break;
        case 'group.subscribe': {
          const groupId = payload['groupId'] as string;
          this.ctx.groups.requireMember(groupId, this.actorFor(conn));
          conn.subscriptions.add(groupId);
          this.sendSnapshot(conn, groupId);
          this.announcePresence(groupId, conn, true);
          break;
        }
        case 'group.unsubscribe': {
          const groupId = payload['groupId'] as string;
          conn.subscriptions.delete(groupId);
          this.announcePresence(groupId, conn, false);
          break;
        }
        case 'resync': {
          const groupId = payload['groupId'] as string;
          this.ctx.groups.requireMember(groupId, this.actorFor(conn));
          conn.subscriptions.add(groupId);
          const events = this.ctx.groups.eventsAfter(groupId, payload['fromSeq'] as number);
          if (events === null) {
            this.send(conn, 'resync.required', { groupId, reason: 'Replay window exceeded; sending a snapshot' });
            this.sendSnapshot(conn, groupId);
          } else {
            for (const e of events) this.sendEnvelope(conn, e);
          }
          this.ctx.metrics.increment('ws.resyncs');
          break;
        }
        case 'group.command': {
          const groupId = payload['groupId'] as string;
          const outcome = this.ctx.groups.applyCommand(groupId, this.actorFor(conn), { idempotencyKey: payload['idempotencyKey'] as string, baseRevision: payload['baseRevision'] as number, command: payload['command'] as never });
          if (outcome.idempotentReplay) this.send(conn, 'group.queue.updated', { groupId, revision: outcome.revision, command: payload['command'], idempotencyKey: payload['idempotencyKey'], queue: outcome.queue, actorDisplayName: conn.displayName });
          break;
        }
        case 'group.drift':
          this.ctx.groups.requireMember(payload['groupId'] as string, this.actorFor(conn));
          this.ctx.groups.recordDrift(payload['groupId'] as string, conn.memberId, { driftMs: payload['driftMs'] as number, positionMs: payload['positionMs'] as number, dspLatencyMs: (payload['dspLatencyMs'] as number | undefined) ?? 0, revision: payload['revision'] as number });
          break;
        case 'group.availability':
          this.ctx.groups.reportAvailability(payload['groupId'] as string, this.actorFor(conn), payload['itemId'] as string, payload['available'] as boolean, (payload['reason'] as string | undefined) ?? null);
          break;
      }
    } catch (err) {
      if (err instanceof DomainError) this.sendError(conn, err.code, err.message);
      else {
        this.ctx.log.error({ module: 'realtime', err: err instanceof Error ? err.message : String(err) }, 'message handling failed');
        this.sendError(conn, 'internal', 'Internal error');
      }
    }
  }

  private sendSnapshot(conn: Connection, groupId: string): void {
    const view = this.ctx.groups.view(groupId, conn.memberId);
    this.send(conn, 'group.snapshot', { groupId, queue: view.queue, playback: view.playback, members: view.members.map((m) => ({ memberId: m.memberId, displayName: m.displayName, role: m.role, online: m.online })), lastSeq: this.ctx.groups.lastSeq(groupId) }, this.ctx.groups.lastSeq(groupId));
  }

  private announcePresence(groupId: string, conn: Connection, online: boolean): void {
    const stillOnline = this.onlineMembers(groupId).has(conn.memberId);
    if (online && this.countSubscribed(groupId, conn.memberId) > 1) return; // already announced by another connection
    if (!online && stillOnline) return;
    try {
      this.ctx.groups.publish(groupId, 'presence', { groupId, memberId: conn.memberId, displayName: conn.displayName, online, latencyMs: conn.latencyMs }, conn.memberId);
    } catch {
      /* group may have been archived */
    }
  }

  private countSubscribed(groupId: string, memberId: string): number {
    let n = 0;
    for (const c of this.connections.values()) if (c.memberId === memberId && c.subscriptions.has(groupId)) n += 1;
    return n;
  }

  private tick(): void {
    const now = this.ctx.clock.now();
    for (const conn of this.connections.values()) {
      if (now - conn.lastSeenAt > REALTIME_DEFAULTS.heartbeatTimeoutMs) {
        conn.socket.terminate();
        this.ctx.metrics.increment('ws.timeouts');
        continue;
      }
      if (conn.socket.readyState === WebSocket.OPEN) {
        conn.pingSentAt = now;
        conn.socket.ping();
      }
    }
  }

  /* ---- GroupEventSink ---- */
  broadcast(groupId: string, envelope: Envelope): void {
    for (const conn of this.connections.values()) if (conn.subscriptions.has(groupId)) this.sendEnvelope(conn, envelope);
    for (const s of this.subscribers) s(envelope);
  }

  /** Non-group events (job progress, Discord status) go to every admin connection and, when a device id is given, to that device. */
  notify(type: string, payload: unknown, target: { deviceId?: string; adminsOnly?: boolean } = {}): void {
    for (const conn of this.connections.values()) {
      const isAdmin = conn.principal.kind === 'admin';
      if (target.deviceId && conn.memberId === target.deviceId) this.send(conn, type, payload);
      else if (isAdmin && (target.adminsOnly || !target.deviceId)) this.send(conn, type, payload);
      else if (!target.deviceId && !target.adminsOnly) this.send(conn, type, payload);
    }
  }

  /** In-process listeners (Discord worker) receive every group event without a socket. */
  subscribe(listener: (envelope: Envelope) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /* ---- GroupPresence ---- */
  onlineMembers(groupId: string): ReadonlySet<string> {
    const out = new Set<string>();
    for (const c of this.connections.values()) if (c.subscriptions.has(groupId) && c.socket.readyState === WebSocket.OPEN) out.add(c.memberId);
    return out;
  }

  latencyMs(memberId: string): number | null {
    for (const c of this.connections.values()) if (c.memberId === memberId && c.latencyMs !== null) return c.latencyMs;
    return null;
  }

  /* ---- PresenceProvider ---- */
  presence(deviceId: string) {
    for (const c of this.connections.values()) {
      if (c.memberId === deviceId) return { online: c.socket.readyState === WebSocket.OPEN, latencyMs: c.latencyMs, groupId: [...c.subscriptions][0] ?? null, connectedAt: c.connectedAt, ipDisplay: c.ipDisplay };
    }
    return null;
  }

  disconnectDevice(deviceId: string, reason: string): void {
    for (const c of [...this.connections.values()]) {
      if (c.memberId === deviceId) {
        this.send(c, 'device.revoked', { deviceId, reason });
        c.socket.close(4401, reason);
        this.unregister(c);
      }
    }
  }

  /* ---- views ---- */
  private view(conn: Connection): ConnectionView {
    return { deviceId: conn.principal.kind === 'device' ? conn.principal.deviceId : '00000000-0000-7000-8000-000000000000', name: conn.displayName, kind: conn.kind === 'admin' ? 'hub' : conn.kind, appVersion: conn.appVersion, protocolVersion: conn.protocolVersion, scopes: conn.principal.kind === 'device' ? conn.principal.scopes : [], groupId: [...conn.subscriptions][0] ?? null, connectedAt: conn.connectedAt, lastSeenAt: new Date(conn.lastSeenAt).toISOString(), latencyMs: conn.latencyMs, syncDriftMs: null, transferState: null, ipDisplay: conn.ipDisplay, reconnects: conn.reconnects };
  }

  activeConnections(): ConnectionView[] {
    return [...this.connections.values()].map((c) => this.view(c));
  }

  recentConnections(): ConnectionView[] {
    return this.recent.map((r) => ({ ...r }));
  }

  counts(): { active: number; players: number; companions: number; historical: number; reconnects: number; wsErrors: number } {
    let players = 0, companions = 0;
    for (const c of this.connections.values()) {
      if (c.kind === 'player') players += 1;
      else if (c.kind === 'companion') companions += 1;
    }
    return { active: this.connections.size, players, companions, historical: this.ctx.metrics.counter('total.ws.connections'), reconnects: this.ctx.metrics.counter('ws.reconnects'), wsErrors: this.ctx.metrics.counter('ws.errors') };
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.connections.values()) c.socket.close(1001, 'server shutting down');
    this.connections.clear();
    this.wss.close();
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

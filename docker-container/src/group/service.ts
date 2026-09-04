import type { AggregateTasteProfile, Envelope, Group, GroupHistoryEntry, GroupMembership, GroupPlaybackState, GroupRole, GroupSettings, GroupSyncGrade, HistoryImportReport, Queue, QueueCommand, TrackRef } from '@now-playing/contracts';
import { WS_PROTOCOL_VERSION } from '@now-playing/contracts';
import { GroupSettings as GroupSettingsSchema, GroupHistoryEntry as GroupHistoryEntrySchema } from '@now-playing/contracts';
import { applyQueueCommand, compareAggregates, createQueue, currentItem, DomainError, generateInviteCode, historyToCsv, mergeAggregates, parseHistoryCsv, planHistoryImport, uuidv7, type HistoryCsvParseResult, type QueueActor, type QueueEffect } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { CanonicalRepository } from '../db/repositories/canonical.js';
import type { GroupsRepository, MembershipRecord } from '../db/repositories/groups.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import { sha256Hex } from '../util.js';

export const PREFLIGHT_LEAD_MS = 1500;
export const RESUME_LEAD_MS = 400;
export const ENDED_GRACE_MS = 750;
export const EVENT_RING_SIZE = 500;
export const AGGREGATE_MIN_COHORT = 3;
const RECENT_HISTORY_FOR_DUPLICATES = 50;
const COMMAND_RESULT_RETENTION_MS = 24 * 3600 * 1000;

export interface GroupActor {
  id: string;
  kind: 'device' | 'user' | 'discord' | 'admin' | 'system';
  displayName: string;
  /** Hub admin sessions bypass group roles. */
  isHubAdmin?: boolean;
  /**
   * The role an actor was granted by an authority outside this hub — today, a Discord guild's DJ
   * and admin roles, checked by `authorizeCommand` before the command ever reaches this service.
   *
   * Only `kind: 'discord'` may use it, because a Discord user has no hub identity and therefore no
   * group membership to check: refusing them for "not a member" would make the bot unable to
   * control any group at all. Everything else still goes through `requireMember`, so a paired
   * device cannot escape group permissions by claiming a role.
   */
  authorizedRole?: GroupRole;
}

export interface GroupPresence {
  onlineMembers(groupId: string): ReadonlySet<string>;
  latencyMs(memberId: string): number | null;
}

/** Fan-out implemented by the realtime server. Persistence into the replay ring happens here, before fan-out. */
export interface GroupEventSink {
  broadcast(groupId: string, envelope: Envelope): void;
}

export interface CommandInput {
  idempotencyKey: string;
  baseRevision: number;
  command: QueueCommand;
}

export interface CommandOutcome {
  accepted: boolean;
  revision: number;
  queue: Queue;
  playback: GroupPlaybackState;
  rejection: { code: string; reason: string } | null;
  idempotentReplay: boolean;
  effects: QueueEffect[];
}

/**
 * Zod's `.partial()` produces properties typed `T | undefined` rather than optional ones, so the
 * service accepts that shape directly instead of forcing every caller to strip undefined keys.
 */
export type GroupSettingsPatch = { [K in keyof GroupSettings]?: GroupSettings[K] | undefined };

export interface GroupViewData {
  group: Group;
  members: Array<MembershipRecord & { online: boolean; latencyMs: number | null }>;
  queue: Queue;
  playback: GroupPlaybackState;
  myRole: GroupRole | null;
}

const DJ_ROLES: readonly GroupRole[] = ['owner', 'admin'];

/**
 * Authoritative group state: queue + playback timeline, revisioned idempotent commands, history, drift and availability.
 * The reducer is the shared domain one; this service adds persistence, permissions, the hub timeline and fan-out.
 */
export class GroupService {
  private sink: GroupEventSink | null = null;
  private presence: GroupPresence | null = null;
  private syncGradeFor: (track: TrackRef) => { grade: GroupSyncGrade; reason: string | null } = () => ({ grade: 'best_effort', reason: null });
  private readonly timers = new Map<string, { at: number; handle: ReturnType<typeof setTimeout> | null; kind: 'start' | 'ended' }>();

  constructor(
    private readonly repo: GroupsRepository,
    private readonly canonical: CanonicalRepository,
    private readonly hubId: string,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
    private readonly options: { backgroundTimers: boolean } = { backgroundTimers: true },
  ) {}

  attachSink(sink: GroupEventSink): void {
    this.sink = sink;
  }

  attachPresence(presence: GroupPresence): void {
    this.presence = presence;
  }

  attachSyncGrader(fn: (track: TrackRef) => { grade: GroupSyncGrade; reason: string | null }): void {
    this.syncGradeFor = fn;
  }

  private nowMs(): number {
    return this.clock.now();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  /** Append to the group's replay ring (last 500 events) and fan out. Returns the stream sequence number. */
  publish(groupId: string, type: string, payload: unknown, actorId: string): number {
    const seq = this.repo.nextSeq(groupId);
    const envelope: Envelope = { eventId: uuidv7(this.nowMs()), type, occurredAt: this.nowIso(), schemaVersion: WS_PROTOCOL_VERSION, actorId, payload, seq };
    this.repo.appendEvent({ group_id: groupId, seq, event_id: envelope.eventId, type, occurred_at: envelope.occurredAt, actor_id: actorId, payload: JSON.stringify(payload) }, EVENT_RING_SIZE);
    this.sink?.broadcast(groupId, envelope);
    return seq;
  }

  /** Replay window for reconnecting clients: events after `fromSeq`, or null when the ring no longer covers it. */
  eventsAfter(groupId: string, fromSeq: number, limit = EVENT_RING_SIZE): Envelope[] | null {
    const oldest = this.repo.oldestSeq(groupId);
    const last = this.repo.lastSeq(groupId);
    if (fromSeq >= last) return [];
    if (oldest === null || fromSeq + 1 < oldest) return null;
    return this.repo.eventsAfter(groupId, fromSeq, limit).map((r) => ({ eventId: r.event_id, type: r.type, occurredAt: r.occurred_at, schemaVersion: WS_PROTOCOL_VERSION, actorId: r.actor_id, payload: JSON.parse(r.payload) as unknown, seq: r.seq }));
  }

  lastSeq(groupId: string): number {
    return this.repo.lastSeq(groupId);
  }

  /* ------------------------------------------------------------------ groups */

  create(actor: GroupActor, input: { name: string; settings?: GroupSettingsPatch | undefined }, meta: { ip: string | null; correlationId: string | null }): GroupViewData {
    const now = this.nowIso();
    const settings = GroupSettingsSchema.parse({ ...input.settings });
    const group: Group = { id: uuidv7(this.nowMs()), schemaVersion: 1, createdAt: now, updatedAt: now, deletedAt: null, hubId: this.hubId, name: input.name, ownerId: actor.id, status: 'active', settings, inviteCodeHash: null };
    const queue = createQueue({ mode: 'group', groupId: group.id, now, fairQueue: settings.fairQueue });
    const playback: GroupPlaybackState = { groupId: group.id, revision: 0, sourceRevision: 0, status: 'idle', currentItemId: null, startAt: null, positionMs: 0, pausedAt: null, syncGrade: 'exact', syncReason: null, updatedAt: now };
    this.repo.transaction(() => {
      this.repo.create(group);
      this.repo.saveState(group.id, queue, playback, now);
      this.repo.upsertMembership(this.newMembership(group.id, actor, 'owner', now));
    });
    this.metrics.increment('groups.created');
    this.audit.record({ actor: { kind: actor.kind === 'system' ? 'system' : actor.kind === 'user' ? 'device' : actor.kind, id: actor.id, displayName: actor.displayName }, action: 'group.create', outcome: 'success', target: { kind: 'group', id: group.id }, ip: meta.ip, correlationId: meta.correlationId });
    return this.view(group.id, actor.id);
  }

  private newMembership(groupId: string, actor: GroupActor, role: GroupRole, now: string): MembershipRecord {
    return { id: uuidv7(this.nowMs()), schemaVersion: 1, createdAt: now, updatedAt: now, deletedAt: null, groupId, memberId: actor.id, memberKind: actor.kind === 'system' ? 'admin' : actor.kind, role, displayName: actor.displayName.slice(0, 120), joinedAt: now, revokedAt: null, shareAggregate: false, lastRequestAt: null };
  }

  find(groupId: string): Group {
    const g = this.repo.find(groupId);
    if (!g || g.deletedAt) throw new DomainError('not-found', 'Group not found');
    return g;
  }

  listVisible(actor: GroupActor): GroupViewData[] {
    const groups = actor.isHubAdmin ? this.repo.listAll() : this.repo.listForMember(actor.id);
    return groups.map((g) => this.view(g.id, actor.id));
  }

  membership(groupId: string, memberId: string): MembershipRecord | undefined {
    const m = this.repo.findMembership(groupId, memberId);
    return m && !m.revokedAt ? m : undefined;
  }

  requireMember(groupId: string, actor: GroupActor): MembershipRecord | null {
    if (actor.isHubAdmin) return this.membership(groupId, actor.id) ?? null;
    const m = this.membership(groupId, actor.id);
    if (!m) throw new DomainError('forbidden', 'You are not a member of this group');
    return m;
  }

  /** True when the actor's authority was established outside the hub (see `GroupActor`). */
  private hasExternalAuthority(actor: GroupActor): boolean {
    return actor.kind === 'discord' && actor.authorizedRole !== undefined;
  }

  requireDj(groupId: string, actor: GroupActor): void {
    if (actor.isHubAdmin) return;
    if (this.hasExternalAuthority(actor) && DJ_ROLES.includes(actor.authorizedRole!)) return;
    const m = this.membership(groupId, actor.id);
    if (!m || !DJ_ROLES.includes(m.role)) throw new DomainError('forbidden', 'Owner or admin role required');
  }

  isDj(groupId: string, actor: GroupActor): boolean {
    if (actor.isHubAdmin) return true;
    if (this.hasExternalAuthority(actor)) return DJ_ROLES.includes(actor.authorizedRole!);
    const m = this.membership(groupId, actor.id);
    return !!m && DJ_ROLES.includes(m.role);
  }

  update(groupId: string, actor: GroupActor, patch: { name?: string | undefined; settings?: GroupSettingsPatch | undefined }): GroupViewData {
    const group = this.find(groupId);
    this.requireDj(groupId, actor);
    const now = this.nowIso();
    const settings = patch.settings ? GroupSettingsSchema.parse({ ...group.settings, ...patch.settings }) : undefined;
    this.repo.update(groupId, { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(settings ? { settings } : {}) }, now);
    if (settings && settings.fairQueue !== group.settings.fairQueue) {
      this.applyCommand(groupId, { id: 'system', kind: 'system', displayName: 'Hub', isHubAdmin: true }, { idempotencyKey: `fair:${groupId}:${now}`, baseRevision: this.state(groupId).queue.revision, command: { type: 'setFairQueue', enabled: settings.fairQueue } });
    }
    return this.view(groupId, actor.id);
  }

  archive(groupId: string, actor: GroupActor): void {
    this.find(groupId);
    this.requireDj(groupId, actor);
    const now = this.nowIso();
    this.stopPlayback(groupId, 'stopped');
    this.repo.update(groupId, { status: 'archived' }, now);
    this.clearTimer(groupId);
  }

  /* ---------------------------------------------------------------- invites */

  createInvite(groupId: string, actor: GroupActor, input: { ttlSeconds: number; role: GroupRole }): { inviteCode: string; expiresAt: string } {
    this.find(groupId);
    this.requireDj(groupId, actor);
    const code = generateInviteCode();
    const now = this.nowMs();
    const expiresAt = new Date(now + input.ttlSeconds * 1000).toISOString();
    this.repo.createInvite({ id: uuidv7(now), group_id: groupId, code_hash: sha256Hex(`invite:v1:${code}`), role: input.role, created_by: actor.id, created_at: this.nowIso(), expires_at: expiresAt });
    return { inviteCode: code, expiresAt };
  }

  join(actor: GroupActor, inviteCode: string, displayName?: string): GroupViewData {
    const normalized = inviteCode.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
    const invite = this.repo.findInviteByHash(sha256Hex(`invite:v1:${normalized}`));
    const now = this.nowIso();
    if (!invite || invite.expires_at <= now) throw new DomainError('forbidden', 'Invalid or expired invite code');
    const group = this.find(invite.group_id);
    if (group.status !== 'active') throw new DomainError('conflict', 'This group is archived');
    const existing = this.repo.findMembership(group.id, actor.id);
    const membership = existing ? { ...existing, role: existing.role === 'owner' ? existing.role : invite.role, displayName: displayName ?? existing.displayName, revokedAt: null, joinedAt: now, updatedAt: now } : this.newMembership(group.id, { ...actor, displayName: displayName ?? actor.displayName }, invite.role, now);
    this.repo.upsertMembership(membership);
    this.repo.markInviteUsed(invite.id, actor.id, now);
    this.metrics.increment('groups.joins');
    this.publish(group.id, 'presence', { groupId: group.id, memberId: actor.id, displayName: membership.displayName, online: this.presence?.onlineMembers(group.id).has(actor.id) ?? false }, actor.id);
    return this.view(group.id, actor.id);
  }

  leave(groupId: string, actor: GroupActor): void {
    const group = this.find(groupId);
    const m = this.membership(groupId, actor.id);
    if (!m) throw new DomainError('not-found', 'Not a member');
    if (group.ownerId === actor.id) throw new DomainError('conflict', 'The owner cannot leave; archive the group instead');
    this.repo.updateMembership(groupId, actor.id, { revokedAt: this.nowIso() }, this.nowIso());
    this.publish(groupId, 'presence', { groupId, memberId: actor.id, displayName: m.displayName, online: false }, actor.id);
  }

  revokeMember(groupId: string, actor: GroupActor, memberId: string): void {
    const group = this.find(groupId);
    this.requireDj(groupId, actor);
    if (memberId === group.ownerId) throw new DomainError('conflict', 'The owner cannot be removed');
    const m = this.membership(groupId, memberId);
    if (!m) throw new DomainError('not-found', 'Member not found');
    this.repo.updateMembership(groupId, memberId, { revokedAt: this.nowIso() }, this.nowIso());
    this.publish(groupId, 'presence', { groupId, memberId, displayName: m.displayName, online: false }, actor.id);
  }

  setMember(groupId: string, actor: GroupActor, memberId: string, patch: { role?: GroupRole | undefined; shareAggregate?: boolean | undefined }): MembershipRecord & { online: boolean; latencyMs: number | null } {
    const group = this.find(groupId);
    const m = this.membership(groupId, memberId);
    if (!m) throw new DomainError('not-found', 'Member not found');
    if (patch.role !== undefined) {
      this.requireDj(groupId, actor);
      if (memberId === group.ownerId) throw new DomainError('conflict', 'The owner role cannot be changed');
    }
    if (patch.shareAggregate !== undefined && memberId !== actor.id && !actor.isHubAdmin) throw new DomainError('forbidden', 'Only the member can change their own sharing preference');
    this.repo.updateMembership(groupId, memberId, { ...(patch.role !== undefined ? { role: patch.role } : {}), ...(patch.shareAggregate !== undefined ? { shareAggregate: patch.shareAggregate } : {}) }, this.nowIso());
    const updated = this.membership(groupId, memberId)!;
    return { ...updated, online: this.presence?.onlineMembers(groupId).has(memberId) ?? false, latencyMs: this.presence?.latencyMs(memberId) ?? null };
  }

  /* ------------------------------------------------------------ queue state */

  state(groupId: string): { queue: Queue; playback: GroupPlaybackState } {
    const s = this.repo.loadState(groupId);
    if (!s) throw new DomainError('not-found', 'Group state not found');
    return { queue: s.queue, playback: this.projectPlayback(s.playback) };
  }

  /** Flip `preparing` to `playing` once the announced start instant has passed, even if the timer has not fired yet. */
  private projectPlayback(p: GroupPlaybackState): GroupPlaybackState {
    if (p.status === 'preparing' && p.startAt && Date.parse(p.startAt) <= this.nowMs()) return { ...p, status: 'playing' };
    return p;
  }

  view(groupId: string, viewerId: string): GroupViewData {
    const group = this.find(groupId);
    const { queue, playback } = this.state(groupId);
    const online = this.presence?.onlineMembers(groupId) ?? new Set<string>();
    const members = this.repo.listMemberships(groupId).map((m) => ({ ...m, online: online.has(m.memberId), latencyMs: this.presence?.latencyMs(m.memberId) ?? null }));
    const mine = members.find((m) => m.memberId === viewerId);
    return { group, members, queue, playback, myRole: mine?.role ?? null };
  }

  listenerCount(groupId: string): number {
    return this.presence?.onlineMembers(groupId).size ?? 0;
  }

  private limitsFor(settings: GroupSettings) {
    return { maxQueuePerUser: settings.maxQueuePerUser, duplicatePolicy: settings.duplicatePolicy, cooldownSeconds: settings.cooldownSeconds, maxTrackDurationMs: settings.maxTrackDurationMs, guestsMayRequest: settings.guestsMayRequest };
  }

  /** Permission check per command type; returns a translated command (member skip → voteSkip) or throws. */
  private authorize(group: Group, queue: Queue, playback: GroupPlaybackState, actor: GroupActor, membership: MembershipRecord | null, command: QueueCommand): QueueCommand {
    const external = this.hasExternalAuthority(actor);
    const dj = actor.isHubAdmin || actor.kind === 'system' || (membership !== null && DJ_ROLES.includes(membership.role)) || (external && DJ_ROLES.includes(actor.authorizedRole!));
    // A Discord actor was already authorized against the guild's roles, so it counts as present in
    // the group for the "is a member" checks below; what it may *do* still depends on `dj`.
    const present = membership !== null || actor.isHubAdmin || actor.kind === 'system' || external;
    const current = currentItem(queue);
    switch (command.type) {
      case 'append':
      case 'insert':
      case 'playNext':
        if (!present) throw new DomainError('forbidden', 'Not a member');
        if (command.type !== 'append' && !dj) throw new DomainError('forbidden', 'Only DJs can insert ahead of others');
        return command;
      case 'remove': {
        const item = queue.items.find((i) => i.id === command.itemId);
        if (!item) throw new DomainError('not-found', 'Item not in queue');
        if (dj || item.addedBy?.id === actor.id) return command;
        throw new DomainError('forbidden', 'You can only remove your own requests');
      }
      case 'skip':
        if (dj || (current && current.addedBy?.id === actor.id)) return command;
        if (group.settings.voteSkipThreshold > 0) return { type: 'voteSkip' };
        throw new DomainError('forbidden', 'Only DJs or the requester may skip');
      case 'voteSkip':
        if (!present) throw new DomainError('forbidden', 'Not a member');
        return command;
      case 'markUnavailable':
        if (!present) throw new DomainError('forbidden', 'Not a member');
        return command;
      case 'advance': {
        if (dj) return command;
        if (!present) throw new DomainError('forbidden', 'Not a member');
        if (command.reason !== 'ended') throw new DomainError('forbidden', 'Report playback problems through availability reports');
        const duration = current?.track.durationMs ?? null;
        const startAt = playback.startAt ? Date.parse(playback.startAt) : null;
        if (duration !== null && startAt !== null && this.nowMs() < startAt + duration - 2000) throw new DomainError('forbidden', 'The current track has not finished on the hub timeline');
        return command;
      }
      default:
        if (!dj) throw new DomainError('forbidden', 'Owner or admin role required for this command');
        return command;
    }
  }

  applyCommand(groupId: string, actor: GroupActor, input: CommandInput): CommandOutcome {
    const group = this.find(groupId);
    if (group.status !== 'active') throw new DomainError('conflict', 'This group is archived');
    const membership = actor.isHubAdmin || actor.kind === 'system' || this.hasExternalAuthority(actor) ? (this.membership(groupId, actor.id) ?? null) : this.requireMember(groupId, actor);
    const replay = this.repo.findCommandResult(groupId, input.idempotencyKey);
    if (replay) {
      if (replay.actorId !== actor.id) throw new DomainError('conflict', 'Idempotency key was used by another actor');
      const stored = JSON.parse(replay.result) as CommandOutcome;
      this.metrics.increment('groups.commands.replayed');
      return { ...stored, idempotentReplay: true, effects: [] };
    }
    const now = this.nowIso();
    const { queue, playback } = this.state(groupId);
    const finish = (outcome: CommandOutcome): CommandOutcome => {
      this.repo.storeCommandResult(groupId, input.idempotencyKey, actor.id, JSON.stringify({ ...outcome, effects: [] }), now);
      return outcome;
    };
    if (input.baseRevision !== queue.revision) {
      this.metrics.increment('groups.commands.stale');
      const outcome = finish({ accepted: false, revision: queue.revision, queue, playback, rejection: { code: 'stale-revision', reason: `Queue is at revision ${queue.revision}` }, idempotentReplay: false, effects: [] });
      this.publish(groupId, 'group.command.rejected', { groupId, idempotencyKey: input.idempotencyKey, baseRevision: input.baseRevision, currentRevision: queue.revision, reason: outcome.rejection!.reason, code: 'stale-revision' }, actor.id);
      return outcome;
    }
    const command = this.authorize(group, queue, playback, actor, membership, input.command);
    const role: QueueActor['role'] = actor.isHubAdmin ? 'admin' : (membership?.role ?? (this.hasExternalAuthority(actor) ? actor.authorizedRole! : 'guest'));
    const ctx = {
      now,
      actor: { id: actor.id, kind: actor.kind, displayName: actor.displayName, role, lastRequestAt: membership?.lastRequestAt ?? null },
      limits: this.limitsFor(group.settings),
      recentTrackIds: this.repo.recentTrackIds(groupId, RECENT_HISTORY_FOR_DUPLICATES),
      listenerCount: Math.max(1, this.listenerCount(groupId)),
      voteSkipThreshold: group.settings.voteSkipThreshold,
      newId: () => uuidv7(this.nowMs()),
    };
    const result = applyQueueCommand(queue, command, ctx);
    if (!result.accepted) {
      this.metrics.increment('groups.commands.rejected');
      const outcome = finish({ accepted: false, revision: queue.revision, queue, playback, rejection: result.rejection, idempotentReplay: false, effects: [] });
      this.publish(groupId, 'group.command.rejected', { groupId, idempotencyKey: input.idempotencyKey, baseRevision: input.baseRevision, currentRevision: queue.revision, reason: result.rejection!.reason, code: result.rejection!.code }, actor.id);
      return outcome;
    }
    const nextPlayback = this.repo.transaction(() => {
      const projected = this.applyEffects(groupId, result.queue, playback, result.effects, command, now);
      this.repo.saveState(groupId, result.queue, projected, now);
      const seq = this.publish(groupId, 'group.queue.updated', { groupId, revision: result.queue.revision, command, idempotencyKey: input.idempotencyKey, queue: result.queue, actorDisplayName: actor.displayName }, actor.id);
      this.repo.recordRevision({ groupId, revision: result.queue.revision, seq, command, actorId: actor.id, idempotencyKey: input.idempotencyKey, occurredAt: now });
      if (projected !== playback) this.publish(groupId, 'group.playback', projected, actor.id);
      if (['append', 'insert', 'playNext'].includes(command.type) && membership) this.repo.updateMembership(groupId, actor.id, { lastRequestAt: now }, now);
      return projected;
    });
    this.metrics.increment('groups.commands.accepted');
    this.scheduleTimers(groupId, result.queue, nextPlayback);
    return finish({ accepted: true, revision: result.queue.revision, queue: result.queue, playback: nextPlayback, rejection: null, idempotentReplay: false, effects: result.effects });
  }

  /** Translate reducer effects into the hub timeline and history. */
  private applyEffects(groupId: string, queue: Queue, playback: GroupPlaybackState, effects: QueueEffect[], command: QueueCommand, now: string): GroupPlaybackState {
    let next: GroupPlaybackState = { ...playback, revision: queue.revision };
    const nowMs = Date.parse(now);
    const closeOpen = (outcome: GroupHistoryEntry['outcome'], skipReason: string | null) => {
      const closed = this.repo.closeOpenHistory(groupId, outcome, skipReason, now);
      for (const entry of closed) this.publish(groupId, 'group.history.appended', { groupId, entry }, 'system');
    };
    for (const effect of effects) {
      switch (effect.type) {
        case 'skipped':
          closeOpen('skipped', effect.reason);
          break;
        case 'play': {
          /*
           * Play on the track that is already playing is not a restart.
           *
           * The reducer cannot tell the difference — it knows the queue, not the playback state —
           * so the decision belongs here. Restarting would yank the song back to the beginning for
           * everyone in the group, and it would file the abandoned part as a 'stopped' entry in the
           * history, which is how a queue that was never interrupted ends up looking like one that
           * was. A paused group resumes; a playing one is left alone.
           */
          if (command.type === 'play' && next.currentItemId === effect.item.id && (next.status === 'playing' || next.status === 'preparing' || next.status === 'paused')) {
            if (next.status === 'paused' && next.startAt !== null) {
              next = { ...next, status: 'preparing', startAt: new Date(nowMs + RESUME_LEAD_MS - next.positionMs).toISOString(), pausedAt: null, updatedAt: now };
            }
            break;
          }
          if (command.type === 'advance') closeOpen(command.reason === 'ended' ? 'completed' : command.reason === 'error' ? 'failed' : 'unavailable', command.reason === 'ended' ? null : command.reason);
          else if (!effects.some((e) => e.type === 'skipped')) closeOpen('stopped', null);
          const grade = this.syncGradeFor(effect.item.track);
          const startAt = new Date(nowMs + PREFLIGHT_LEAD_MS).toISOString();
          next = { ...next, status: 'preparing', currentItemId: effect.item.id, startAt, positionMs: 0, pausedAt: null, sourceRevision: next.sourceRevision + 1, syncGrade: grade.grade, syncReason: grade.reason, updatedAt: now };
          const entry: GroupHistoryEntry = { id: uuidv7(nowMs), schemaVersion: 1, groupId, startedAt: startAt, endedAt: null, track: effect.item.track, provider: effect.item.track.provider, providerTrackId: effect.item.track.identity.providerIds[effect.item.track.provider]?.[0] ?? null, requesterId: effect.item.addedBy?.id ?? 'system', requesterDisplayName: effect.item.addedBy?.displayName ?? 'Hub', outcome: 'playing', skipReason: null, queueRevision: queue.revision };
          this.repo.insertHistory(entry, effect.item.id, now);
          this.repo.clearAvailability(groupId, effect.item.id);
          this.publish(groupId, 'group.history.appended', { groupId, entry }, 'system');
          this.metrics.increment('groups.tracks_started');
          break;
        }
        case 'pause': {
          if (next.status === 'playing' || next.status === 'preparing') {
            const position = next.startAt ? Math.max(0, nowMs - Date.parse(next.startAt)) : next.positionMs;
            next = { ...next, status: 'paused', positionMs: position, pausedAt: now, updatedAt: now };
          }
          break;
        }
        case 'resume': {
          if (next.status === 'paused' && next.currentItemId) {
            next = { ...next, status: 'preparing', startAt: new Date(nowMs + RESUME_LEAD_MS - next.positionMs).toISOString(), pausedAt: null, updatedAt: now };
          }
          break;
        }
        case 'seek': {
          if (next.currentItemId) {
            if (next.status === 'paused') next = { ...next, positionMs: effect.positionMs, updatedAt: now };
            else next = { ...next, status: 'preparing', positionMs: effect.positionMs, startAt: new Date(nowMs + RESUME_LEAD_MS - effect.positionMs).toISOString(), pausedAt: null, updatedAt: now };
          }
          break;
        }
        case 'stop':
          closeOpen('stopped', null);
          next = { ...next, status: 'idle', currentItemId: null, startAt: null, positionMs: 0, pausedAt: null, updatedAt: now };
          break;
        case 'ended':
          closeOpen(command.type === 'advance' ? (command.reason === 'ended' ? 'completed' : command.reason === 'error' ? 'failed' : 'unavailable') : 'skipped', command.type === 'advance' ? (command.reason === 'ended' ? null : command.reason) : 'skipped');
          next = { ...next, status: 'ended', currentItemId: null, startAt: null, positionMs: 0, pausedAt: null, updatedAt: now };
          break;
        case 'voteRecorded':
          this.metrics.increment('groups.votes');
          break;
      }
    }
    if (next.currentItemId && !queue.items.some((i) => i.id === next.currentItemId)) {
      next = { ...next, status: 'idle', currentItemId: null, startAt: null, positionMs: 0, pausedAt: null, updatedAt: now };
    }
    return next;
  }

  private stopPlayback(groupId: string, outcome: GroupHistoryEntry['outcome']): void {
    const s = this.repo.loadState(groupId);
    if (!s) return;
    const now = this.nowIso();
    this.repo.closeOpenHistory(groupId, outcome, null, now);
    const playback: GroupPlaybackState = { ...s.playback, status: 'idle', currentItemId: null, startAt: null, positionMs: 0, pausedAt: null, updatedAt: now };
    this.repo.saveState(groupId, s.queue, playback, now);
    this.publish(groupId, 'group.playback', playback, 'system');
  }

  /* ----------------------------------------------------------------- timers */

  private clearTimer(groupId: string): void {
    const t = this.timers.get(groupId);
    if (t?.handle) clearTimeout(t.handle);
    this.timers.delete(groupId);
  }

  private scheduleTimers(groupId: string, queue: Queue, playback: GroupPlaybackState): void {
    this.clearTimer(groupId);
    let at: number | null = null;
    let kind: 'start' | 'ended' = 'start';
    if (playback.status === 'preparing' && playback.startAt) {
      at = Date.parse(playback.startAt);
      kind = 'start';
    } else if (playback.status === 'playing' && playback.startAt) {
      const duration = currentItem(queue)?.track.durationMs ?? null;
      if (duration !== null) {
        at = Date.parse(playback.startAt) + duration + ENDED_GRACE_MS;
        kind = 'ended';
      }
    }
    if (at === null) return;
    const entry = { at, kind, handle: null as ReturnType<typeof setTimeout> | null };
    if (this.options.backgroundTimers) {
      const delay = Math.max(0, at - this.nowMs());
      entry.handle = setTimeout(() => this.fireTimer(groupId), delay + 5);
      entry.handle.unref?.();
    }
    this.timers.set(groupId, entry);
  }

  private fireTimer(groupId: string): void {
    const t = this.timers.get(groupId);
    if (!t) return;
    this.timers.delete(groupId);
    const s = this.repo.loadState(groupId);
    if (!s) return;
    const now = this.nowIso();
    if (t.kind === 'start' && s.playback.status === 'preparing') {
      const playback: GroupPlaybackState = { ...s.playback, status: 'playing', updatedAt: now };
      this.repo.saveState(groupId, s.queue, playback, now);
      this.publish(groupId, 'group.playback', playback, 'system');
      this.scheduleTimers(groupId, s.queue, playback);
      return;
    }
    if (t.kind === 'ended' && s.playback.status === 'playing') {
      try {
        this.applyCommand(groupId, { id: 'system', kind: 'system', displayName: 'Hub', isHubAdmin: true }, { idempotencyKey: `ended:${groupId}:${s.queue.revision}`, baseRevision: s.queue.revision, command: { type: 'advance', reason: 'ended' } });
      } catch {
        /* state moved on; a client command won the race */
      }
    }
  }

  /** Test hook: fire every timer whose instant has passed. */
  runDueTimers(): number {
    let fired = 0;
    for (const [groupId, t] of [...this.timers.entries()]) {
      if (t.at <= this.nowMs()) {
        this.fireTimer(groupId);
        fired += 1;
      }
    }
    return fired;
  }

  /** On startup, re-arm timers for groups that were mid-playback when the hub stopped. */
  restoreTimers(): void {
    for (const g of this.repo.listAll()) {
      const s = this.repo.loadState(g.id);
      if (s) this.scheduleTimers(g.id, s.queue, this.projectPlayback(s.playback));
    }
  }

  dispose(): void {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }

  /* ---------------------------------------------------- drift + availability */

  recordDrift(groupId: string, memberId: string, report: { driftMs: number; positionMs: number; dspLatencyMs: number; revision: number }): void {
    this.repo.recordDrift({ group_id: groupId, member_id: memberId, drift_ms: report.driftMs, position_ms: report.positionMs, dsp_latency_ms: report.dspLatencyMs, revision: report.revision, reported_at: this.nowIso() });
    this.metrics.observe('groups.drift_ms', Math.abs(report.driftMs));
  }

  syncInfo(groupId: string): { serverTime: string; playback: GroupPlaybackState; members: Array<{ memberId: string; driftMs: number | null; dspLatencyMs: number | null; online: boolean }> } {
    const { playback } = this.state(groupId);
    const drifts = new Map(this.repo.drifts(groupId).map((d) => [d.member_id, d]));
    const online = this.presence?.onlineMembers(groupId) ?? new Set<string>();
    const members = this.repo.listMemberships(groupId).map((m) => {
      const d = drifts.get(m.memberId);
      return { memberId: m.memberId, driftMs: d && online.has(m.memberId) ? d.drift_ms : null, dspLatencyMs: d ? d.dsp_latency_ms : null, online: online.has(m.memberId) };
    });
    return { serverTime: this.nowIso(), playback, members };
  }

  /**
   * A member reports whether it can play an item. When every online listener reports the current item unavailable the
   * hub marks it and advances, so one restricted source never stalls the group.
   */
  reportAvailability(groupId: string, actor: GroupActor, itemId: string, available: boolean, reason: string | null): void {
    this.requireMember(groupId, actor);
    this.repo.recordAvailability(groupId, itemId, actor.id, available, reason, this.nowIso());
    if (available) return;
    const { queue, playback } = this.state(groupId);
    if (playback.currentItemId !== itemId) return;
    const online = this.presence?.onlineMembers(groupId) ?? new Set<string>([actor.id]);
    const reports = this.repo.availabilityReports(groupId, itemId);
    const unavailableFor = new Set(reports.filter((r) => !r.available).map((r) => r.memberId));
    const listeners = [...online].filter((id) => id !== 'admin');
    const everyoneFailed = listeners.length > 0 && listeners.every((id) => unavailableFor.has(id));
    if (!everyoneFailed) return;
    const system: GroupActor = { id: 'system', kind: 'system', displayName: 'Hub', isHubAdmin: true };
    const marked = this.applyCommand(groupId, system, { idempotencyKey: `unavail:${itemId}:${queue.revision}`, baseRevision: queue.revision, command: { type: 'markUnavailable', itemId, reason: reason ?? 'No listener could play this item' } });
    if (marked.accepted) this.applyCommand(groupId, system, { idempotencyKey: `advance-unavail:${itemId}:${marked.revision}`, baseRevision: marked.revision, command: { type: 'advance', reason: 'unavailable' } });
    this.metrics.increment('groups.auto_advanced_unavailable');
  }

  /* ---------------------------------------------------------------- history */

  history(groupId: string, options: { limit: number; before?: string | null }): GroupHistoryEntry[] {
    return this.repo.listHistory(groupId, options);
  }

  exportCsv(groupId: string): string {
    return historyToCsv(this.repo.allHistory(groupId));
  }

  exportJson(groupId: string): { schemaVersion: number; groupId: string; exportedAt: string; entries: GroupHistoryEntry[] } {
    return { schemaVersion: 1, groupId, exportedAt: this.nowIso(), entries: this.repo.allHistory(groupId) };
  }

  importHistory(groupId: string, actor: GroupActor, text: string, format: 'csv' | 'json', dryRun: boolean): HistoryImportReport {
    this.find(groupId);
    this.requireDj(groupId, actor);
    let parsed: HistoryCsvParseResult;
    if (format === 'csv') parsed = parseHistoryCsv(text, { maxRows: 100_000, maxBytes: 20 * 1024 * 1024 });
    else parsed = parseHistoryJson(text);
    const plan = planHistoryImport(parsed, this.repo.historyIds(groupId), groupId, dryRun);
    if (!dryRun && plan.toInsert.length) {
      const now = this.nowIso();
      this.repo.transaction(() => {
        for (const entry of plan.toInsert) this.repo.insertHistory(entry, null, now);
      });
      this.metrics.increment('groups.history_imported', plan.toInsert.length);
    }
    return plan.report;
  }

  nowPlaying(groupId: string): { queue: Queue; playback: GroupPlaybackState; item: ReturnType<typeof currentItem>; requester: string | null; positionMs: number } {
    const { queue, playback } = this.state(groupId);
    const item = playback.currentItemId ? (queue.items.find((i) => i.id === playback.currentItemId) ?? null) : null;
    let positionMs = playback.positionMs;
    if ((playback.status === 'playing' || playback.status === 'preparing') && playback.startAt) positionMs = Math.max(0, this.nowMs() - Date.parse(playback.startAt));
    return { queue, playback, item, requester: item?.addedBy?.displayName ?? null, positionMs };
  }

  /* -------------------------------------------------------------- aggregate */

  aggregate(groupId: string, viewerId: string, viewerAggregate: AggregateTasteProfile | null): { participantCount: number; available: boolean; reason: string | null; merged: AggregateTasteProfile | null; comparison: ReturnType<typeof compareAggregates> | null } {
    this.find(groupId);
    const members = this.repo.listMemberships(groupId).filter((m) => m.shareAggregate);
    const profiles = members.map((m) => this.canonical.getAggregate(m.memberId)).filter((p): p is AggregateTasteProfile => p !== null);
    const merged = mergeAggregates(profiles, { id: uuidv7(this.nowMs()), ownerId: groupId, now: this.nowIso(), minCohort: AGGREGATE_MIN_COHORT });
    if (!merged) return { participantCount: profiles.length, available: false, reason: `At least ${AGGREGATE_MIN_COHORT} members must opt in and upload an aggregate profile (currently ${profiles.length})`, merged: null, comparison: null };
    const mine = viewerAggregate ?? this.canonical.getAggregate(viewerId);
    return { participantCount: profiles.length, available: true, reason: null, merged, comparison: mine ? compareAggregates(mine, merged) : null };
  }

  memberships(groupId: string): MembershipRecord[] {
    return this.repo.listMemberships(groupId);
  }

  maintenance(): void {
    const before = new Date(this.nowMs() - COMMAND_RESULT_RETENTION_MS).toISOString();
    this.repo.purgeCommandResults(before);
    this.repo.purgeInvites(this.nowIso());
  }
}

/** Canonical JSON history import: `{ entries: GroupHistoryEntry[] }` or a bare array. */
export function parseHistoryJson(text: string): HistoryCsvParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { rows: [], errors: [{ row: 0, message: 'Invalid JSON' }], sanitizedCells: 0, totalRows: 0 };
  }
  const entries = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { entries?: unknown }).entries) ? (data as { entries: unknown[] }).entries : null;
  if (!entries) return { rows: [], errors: [{ row: 0, message: 'Expected an array of entries or { entries: [...] }' }], sanitizedCells: 0, totalRows: 0 };
  const rows: HistoryCsvParseResult['rows'] = [];
  const errors: HistoryCsvParseResult['errors'] = [];
  entries.forEach((raw, i) => {
    const parsed = GroupHistoryEntrySchema.safeParse(raw);
    if (parsed.success) rows.push({ row: i + 1, entry: parsed.data });
    else errors.push({ row: i + 1, message: parsed.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`).join('; ') });
  });
  return { rows, errors, sanitizedCells: 0, totalRows: entries.length };
}

export type { MembershipRecord, GroupMembership };

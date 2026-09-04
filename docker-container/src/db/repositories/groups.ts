import type { Group, GroupHistoryEntry, GroupMembership, GroupPlaybackState, GroupRole, GroupSettings, Queue, QueueCommand } from '@now-playing/contracts';
import { GroupSettings as GroupSettingsSchema } from '@now-playing/contracts';
import type { Db } from '../connection.js';

interface GroupRow {
  id: string;
  hub_id: string;
  name: string;
  owner_id: string;
  status: Group['status'];
  settings: string;
  invite_code_hash: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface MembershipRow {
  id: string;
  group_id: string;
  member_id: string;
  member_kind: GroupMembership['memberKind'];
  role: GroupRole;
  display_name: string;
  joined_at: string;
  revoked_at: string | null;
  share_aggregate: number;
  last_request_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface HistoryRow {
  id: string;
  group_id: string;
  started_at: string;
  ended_at: string | null;
  track: string;
  provider: string;
  provider_track_id: string | null;
  requester_id: string;
  requester_display_name: string;
  outcome: GroupHistoryEntry['outcome'];
  skip_reason: string | null;
  queue_revision: number;
  queue_item_id: string | null;
  created_at: string;
}

export interface GroupEventRow {
  group_id: string;
  seq: number;
  event_id: string;
  type: string;
  occurred_at: string;
  actor_id: string;
  payload: string;
}

export interface InviteRow {
  id: string;
  group_id: string;
  code_hash: string;
  role: GroupRole;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
}

export interface DriftRow {
  group_id: string;
  member_id: string;
  drift_ms: number;
  position_ms: number;
  dsp_latency_ms: number;
  revision: number;
  reported_at: string;
}

export interface MembershipRecord extends GroupMembership {
  lastRequestAt: string | null;
}

export function toGroup(r: GroupRow): Group {
  return {
    id: r.id,
    schemaVersion: 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    hubId: r.hub_id,
    name: r.name,
    ownerId: r.owner_id,
    status: r.status,
    settings: GroupSettingsSchema.parse(JSON.parse(r.settings)),
    inviteCodeHash: r.invite_code_hash,
  };
}

export function toMembership(r: MembershipRow): MembershipRecord {
  return {
    id: r.id,
    schemaVersion: 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    groupId: r.group_id,
    memberId: r.member_id,
    memberKind: r.member_kind,
    role: r.role,
    displayName: r.display_name,
    joinedAt: r.joined_at,
    revokedAt: r.revoked_at,
    shareAggregate: r.share_aggregate === 1,
    lastRequestAt: r.last_request_at,
  };
}

export function toHistoryEntry(r: HistoryRow): GroupHistoryEntry {
  return {
    id: r.id,
    schemaVersion: 1,
    groupId: r.group_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    track: JSON.parse(r.track) as GroupHistoryEntry['track'],
    provider: r.provider,
    providerTrackId: r.provider_track_id,
    requesterId: r.requester_id,
    requesterDisplayName: r.requester_display_name,
    outcome: r.outcome,
    skipReason: r.skip_reason,
    queueRevision: r.queue_revision,
  };
}

export class GroupsRepository {
  constructor(private readonly db: Db) {}

  /* ---- groups ---- */
  create(g: Group): void {
    this.db.prepare('INSERT INTO groups (id, hub_id, name, owner_id, status, settings, invite_code_hash, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(g.id, g.hubId, g.name, g.ownerId, g.status, JSON.stringify(g.settings), g.inviteCodeHash, g.createdAt, g.updatedAt, g.deletedAt);
  }

  find(id: string): Group | undefined {
    const r = this.db.prepare<[string], GroupRow>('SELECT * FROM groups WHERE id = ?').get(id);
    return r ? toGroup(r) : undefined;
  }

  listAll(): Group[] {
    return this.db.prepare<[], GroupRow>('SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY created_at').all().map(toGroup);
  }

  listForMember(memberId: string): Group[] {
    return this.db
      .prepare<[string], GroupRow>('SELECT g.* FROM groups g JOIN group_memberships m ON m.group_id = g.id WHERE m.member_id = ? AND m.revoked_at IS NULL AND g.deleted_at IS NULL ORDER BY g.created_at')
      .all(memberId)
      .map(toGroup);
  }

  update(id: string, patch: { name?: string; settings?: GroupSettings; status?: Group['status']; inviteCodeHash?: string | null }, now: string): void {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.settings !== undefined) {
      sets.push('settings = ?');
      params.push(JSON.stringify(patch.settings));
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.inviteCodeHash !== undefined) {
      sets.push('invite_code_hash = ?');
      params.push(patch.inviteCodeHash);
    }
    params.push(id);
    this.db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /* ---- invites ---- */
  createInvite(row: Omit<InviteRow, 'used_at' | 'used_by'>): void {
    this.db.prepare('INSERT INTO group_invites (id, group_id, code_hash, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, row.group_id, row.code_hash, row.role, row.created_by, row.created_at, row.expires_at);
  }

  findInviteByHash(codeHash: string): InviteRow | undefined {
    return this.db.prepare<[string], InviteRow>('SELECT * FROM group_invites WHERE code_hash = ?').get(codeHash);
  }

  markInviteUsed(id: string, usedBy: string, now: string): void {
    this.db.prepare('UPDATE group_invites SET used_at = ?, used_by = ? WHERE id = ?').run(now, usedBy, id);
  }

  purgeInvites(before: string): number {
    return this.db.prepare('DELETE FROM group_invites WHERE expires_at < ?').run(before).changes;
  }

  /* ---- memberships ---- */
  upsertMembership(m: MembershipRecord): void {
    this.db
      .prepare(
        'INSERT INTO group_memberships (id, group_id, member_id, member_kind, role, display_name, joined_at, revoked_at, share_aggregate, last_request_at, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(group_id, member_id) DO UPDATE SET role = excluded.role, display_name = excluded.display_name, revoked_at = NULL, joined_at = excluded.joined_at, updated_at = excluded.updated_at, deleted_at = NULL',
      )
      .run(m.id, m.groupId, m.memberId, m.memberKind, m.role, m.displayName, m.joinedAt, m.revokedAt, m.shareAggregate ? 1 : 0, m.lastRequestAt, m.createdAt, m.updatedAt, m.deletedAt);
  }

  findMembership(groupId: string, memberId: string): MembershipRecord | undefined {
    const r = this.db.prepare<[string, string], MembershipRow>('SELECT * FROM group_memberships WHERE group_id = ? AND member_id = ?').get(groupId, memberId);
    return r ? toMembership(r) : undefined;
  }

  listMemberships(groupId: string, includeRevoked = false): MembershipRecord[] {
    const sql = includeRevoked ? 'SELECT * FROM group_memberships WHERE group_id = ? ORDER BY joined_at' : 'SELECT * FROM group_memberships WHERE group_id = ? AND revoked_at IS NULL ORDER BY joined_at';
    return this.db.prepare<[string], MembershipRow>(sql).all(groupId).map(toMembership);
  }

  updateMembership(groupId: string, memberId: string, patch: { role?: GroupRole; shareAggregate?: boolean; displayName?: string; revokedAt?: string | null; lastRequestAt?: string | null }, now: string): void {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    if (patch.role !== undefined) {
      sets.push('role = ?');
      params.push(patch.role);
    }
    if (patch.shareAggregate !== undefined) {
      sets.push('share_aggregate = ?');
      params.push(patch.shareAggregate ? 1 : 0);
    }
    if (patch.displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(patch.displayName);
    }
    if (patch.revokedAt !== undefined) {
      sets.push('revoked_at = ?');
      params.push(patch.revokedAt);
    }
    if (patch.lastRequestAt !== undefined) {
      sets.push('last_request_at = ?');
      params.push(patch.lastRequestAt);
    }
    params.push(groupId, memberId);
    this.db.prepare(`UPDATE group_memberships SET ${sets.join(', ')} WHERE group_id = ? AND member_id = ?`).run(...params);
  }

  memberGroupIds(memberId: string): string[] {
    return this.db.prepare<[string], { group_id: string }>('SELECT group_id FROM group_memberships WHERE member_id = ? AND revoked_at IS NULL').all(memberId).map((r) => r.group_id);
  }

  /* ---- queue + playback ---- */
  loadState(groupId: string): { queue: Queue; playback: GroupPlaybackState; lastSeq: number } | undefined {
    const r = this.db.prepare<[string], { queue: string; playback: string; last_seq: number }>('SELECT queue, playback, last_seq FROM group_queues WHERE group_id = ?').get(groupId);
    return r ? { queue: JSON.parse(r.queue) as Queue, playback: JSON.parse(r.playback) as GroupPlaybackState, lastSeq: r.last_seq } : undefined;
  }

  saveState(groupId: string, queue: Queue, playback: GroupPlaybackState, now: string): void {
    this.db
      .prepare('INSERT INTO group_queues (group_id, queue, playback, last_seq, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(group_id) DO UPDATE SET queue = excluded.queue, playback = excluded.playback, updated_at = excluded.updated_at')
      .run(groupId, JSON.stringify(queue), JSON.stringify(playback), now);
  }

  /* ---- revisions ---- */
  recordRevision(row: { groupId: string; revision: number; seq: number; command: QueueCommand; actorId: string; idempotencyKey: string; occurredAt: string }): void {
    this.db
      .prepare('INSERT OR REPLACE INTO group_revisions (group_id, revision, seq, command, actor_id, idempotency_key, occurred_at, accepted, reject_reason) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)')
      .run(row.groupId, row.revision, row.seq, JSON.stringify(row.command), row.actorId, row.idempotencyKey, row.occurredAt);
  }

  /* ---- event log (ring) ---- */
  nextSeq(groupId: string): number {
    const r = this.db.prepare<[string], { last_seq: number }>('SELECT last_seq FROM group_queues WHERE group_id = ?').get(groupId);
    const next = (r?.last_seq ?? 0) + 1;
    this.db.prepare('UPDATE group_queues SET last_seq = ? WHERE group_id = ?').run(next, groupId);
    return next;
  }

  lastSeq(groupId: string): number {
    return this.db.prepare<[string], { last_seq: number }>('SELECT last_seq FROM group_queues WHERE group_id = ?').get(groupId)?.last_seq ?? 0;
  }

  appendEvent(row: GroupEventRow, ringSize: number): void {
    this.db.prepare('INSERT INTO group_events (group_id, seq, event_id, type, occurred_at, actor_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.group_id, row.seq, row.event_id, row.type, row.occurred_at, row.actor_id, row.payload);
    this.db.prepare('DELETE FROM group_events WHERE group_id = ? AND seq <= ?').run(row.group_id, row.seq - ringSize);
  }

  eventsAfter(groupId: string, fromSeq: number, limit: number): GroupEventRow[] {
    return this.db.prepare<[string, number, number], GroupEventRow>('SELECT * FROM group_events WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(groupId, fromSeq, limit);
  }

  oldestSeq(groupId: string): number | null {
    return this.db.prepare<[string], { s: number | null }>('SELECT MIN(seq) AS s FROM group_events WHERE group_id = ?').get(groupId)?.s ?? null;
  }

  /* ---- idempotency ---- */
  findCommandResult(groupId: string, key: string): { actorId: string; result: string; createdAt: string } | undefined {
    const r = this.db.prepare<[string, string], { actor_id: string; result: string; created_at: string }>('SELECT actor_id, result, created_at FROM group_command_results WHERE group_id = ? AND idempotency_key = ?').get(groupId, key);
    return r ? { actorId: r.actor_id, result: r.result, createdAt: r.created_at } : undefined;
  }

  storeCommandResult(groupId: string, key: string, actorId: string, result: string, now: string): void {
    this.db.prepare('INSERT OR REPLACE INTO group_command_results (group_id, idempotency_key, actor_id, result, created_at) VALUES (?, ?, ?, ?, ?)').run(groupId, key, actorId, result, now);
  }

  purgeCommandResults(before: string): number {
    return this.db.prepare('DELETE FROM group_command_results WHERE created_at < ?').run(before).changes;
  }

  /* ---- history ---- */
  insertHistory(e: GroupHistoryEntry, queueItemId: string | null, now: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO group_history (id, group_id, started_at, ended_at, track, provider, provider_track_id, requester_id, requester_display_name, outcome, skip_reason, queue_revision, queue_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, e.groupId, e.startedAt, e.endedAt, JSON.stringify(e.track), e.provider, e.providerTrackId, e.requesterId, e.requesterDisplayName, e.outcome, e.skipReason, e.queueRevision, queueItemId, now);
  }

  closeOpenHistory(groupId: string, outcome: GroupHistoryEntry['outcome'], skipReason: string | null, endedAt: string): GroupHistoryEntry[] {
    const open = this.db.prepare<[string], HistoryRow>("SELECT * FROM group_history WHERE group_id = ? AND outcome = 'playing'").all(groupId);
    for (const r of open) this.db.prepare('UPDATE group_history SET outcome = ?, skip_reason = ?, ended_at = ? WHERE id = ?').run(outcome, skipReason, endedAt, r.id);
    return open.map((r) => toHistoryEntry({ ...r, outcome, skip_reason: skipReason, ended_at: endedAt }));
  }

  /*
   * History is ordered by when a track started, then by insertion order.
   *
   * The tiebreak used to be the row id, which is a UUIDv7: two entries created in the same
   * millisecond share their timestamp bits and differ only in random ones, so history came back in
   * a *different order on every read*. `rowid` is SQLite's own insertion counter, so entries that
   * start at the same instant stay in the order they actually happened — which is what the history
   * screen and the CSV export both assume.
   */
  listHistory(groupId: string, options: { limit: number; before?: string | null }): GroupHistoryEntry[] {
    if (options.before) return this.db.prepare<[string, string, number], HistoryRow>('SELECT * FROM group_history WHERE group_id = ? AND started_at < ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(groupId, options.before, options.limit).map(toHistoryEntry);
    return this.db.prepare<[string, number], HistoryRow>('SELECT * FROM group_history WHERE group_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(groupId, options.limit).map(toHistoryEntry);
  }

  allHistory(groupId: string): GroupHistoryEntry[] {
    return this.db.prepare<[string], HistoryRow>('SELECT * FROM group_history WHERE group_id = ? ORDER BY started_at ASC, rowid ASC').all(groupId).map(toHistoryEntry);
  }

  historyIds(groupId: string): Set<string> {
    return new Set(this.db.prepare<[string], { id: string }>('SELECT id FROM group_history WHERE group_id = ?').all(groupId).map((r) => r.id));
  }

  recentTrackIds(groupId: string, limit: number): string[] {
    return this.db
      .prepare<[string, number], { track: string }>('SELECT track FROM group_history WHERE group_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(groupId, limit)
      .map((r) => (JSON.parse(r.track) as { trackId: string }).trackId);
  }

  historyCount(groupId: string): number {
    return this.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM group_history WHERE group_id = ?').get(groupId)?.n ?? 0;
  }

  /* ---- drift + availability ---- */
  recordDrift(row: DriftRow): void {
    this.db
      .prepare('INSERT INTO group_drift (group_id, member_id, drift_ms, position_ms, dsp_latency_ms, revision, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(group_id, member_id) DO UPDATE SET drift_ms = excluded.drift_ms, position_ms = excluded.position_ms, dsp_latency_ms = excluded.dsp_latency_ms, revision = excluded.revision, reported_at = excluded.reported_at')
      .run(row.group_id, row.member_id, row.drift_ms, row.position_ms, row.dsp_latency_ms, row.revision, row.reported_at);
  }

  drifts(groupId: string): DriftRow[] {
    return this.db.prepare<[string], DriftRow>('SELECT * FROM group_drift WHERE group_id = ?').all(groupId);
  }

  driftForMember(memberId: string): DriftRow | undefined {
    return this.db.prepare<[string], DriftRow>('SELECT * FROM group_drift WHERE member_id = ? ORDER BY reported_at DESC LIMIT 1').get(memberId);
  }

  recordAvailability(groupId: string, itemId: string, memberId: string, available: boolean, reason: string | null, now: string): void {
    this.db
      .prepare('INSERT INTO group_availability (group_id, item_id, member_id, available, reason, reported_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(group_id, item_id, member_id) DO UPDATE SET available = excluded.available, reason = excluded.reason, reported_at = excluded.reported_at')
      .run(groupId, itemId, memberId, available ? 1 : 0, reason, now);
  }

  availabilityReports(groupId: string, itemId: string): Array<{ memberId: string; available: boolean; reason: string | null }> {
    return this.db
      .prepare<[string, string], { member_id: string; available: number; reason: string | null }>('SELECT member_id, available, reason FROM group_availability WHERE group_id = ? AND item_id = ?')
      .all(groupId, itemId)
      .map((r) => ({ memberId: r.member_id, available: r.available === 1, reason: r.reason }));
  }

  clearAvailability(groupId: string, itemId: string): void {
    this.db.prepare('DELETE FROM group_availability WHERE group_id = ? AND item_id = ?').run(groupId, itemId);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

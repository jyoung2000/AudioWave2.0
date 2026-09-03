import type { Queue, QueueCommand, QueueItem, QueueRequester, RepeatMode, TrackRef } from '@now-playing/contracts';
import { uuidv7, seededShuffle, fnv1a } from './ids.js';

export interface QueueLimits {
  maxQueuePerUser?: number;
  duplicatePolicy?: 'allow' | 'reject-in-queue' | 'reject-recent';
  cooldownSeconds?: number;
  maxTrackDurationMs?: number;
  guestsMayRequest?: boolean;
}

export interface QueueActor extends QueueRequester {
  role?: 'owner' | 'admin' | 'member' | 'guest' | 'dj';
  lastRequestAt?: string | null;
}

export interface QueueContextInfo {
  now: string;
  actor: QueueActor;
  limits?: QueueLimits;
  /** Recently played track ids for the reject-recent policy. */
  recentTrackIds?: readonly string[];
  /** Number of online listeners for vote-skip evaluation. */
  listenerCount?: number;
  voteSkipThreshold?: number;
  newId?: () => string;
}

export type QueueRejectionCode = 'stale-revision' | 'forbidden' | 'invalid' | 'limit' | 'duplicate' | 'cooldown' | 'unavailable';

export interface QueueRejection {
  code: QueueRejectionCode;
  reason: string;
}

export type QueueEffect =
  | { type: 'play'; item: QueueItem }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'seek'; positionMs: number }
  | { type: 'stop' }
  | { type: 'ended' }
  | { type: 'skipped'; item: QueueItem; reason: string }
  | { type: 'voteRecorded'; item: QueueItem; votes: number; needed: number };

export interface QueueResult {
  queue: Queue;
  accepted: boolean;
  rejection: QueueRejection | null;
  effects: QueueEffect[];
}

export function createQueue(init: Partial<Queue> & Pick<Queue, 'mode'> & { now: string; id?: string }): Queue {
  const { now, ...rest } = init;
  return {
    id: rest.id ?? uuidv7(),
    mode: rest.mode,
    deviceId: rest.deviceId ?? null,
    groupId: rest.groupId ?? null,
    items: rest.items ?? [],
    currentIndex: rest.currentIndex ?? -1,
    revision: rest.revision ?? 0,
    context: rest.context ?? null,
    repeat: rest.repeat ?? 'off',
    shuffle: rest.shuffle ?? false,
    shuffleSeed: rest.shuffleSeed ?? null,
    fairQueue: rest.fairQueue ?? false,
    positionMs: rest.positionMs ?? 0,
    updatedAt: now,
  };
}

export function currentItem(queue: Queue): QueueItem | null {
  return queue.currentIndex >= 0 ? (queue.items[queue.currentIndex] ?? null) : null;
}

function reject(queue: Queue, code: QueueRejectionCode, reason: string): QueueResult {
  return { queue, accepted: false, rejection: { code, reason }, effects: [] };
}

function commit(queue: Queue, next: Partial<Queue>, now: string, effects: QueueEffect[] = []): QueueResult {
  return { queue: { ...queue, ...next, revision: queue.revision + 1, updatedAt: now }, accepted: true, rejection: null, effects };
}

function makeItems(tracks: TrackRef[], ctx: QueueContextInfo, requestId: string | null): QueueItem[] {
  return tracks.map((track) => ({
    id: (ctx.newId ?? uuidv7)(),
    track,
    addedAt: ctx.now,
    addedBy: { id: ctx.actor.id, kind: ctx.actor.kind, displayName: ctx.actor.displayName },
    requestId,
    availability: 'unknown',
    unavailableReason: null,
    votesToSkip: [],
  }));
}

function checkLimits(queue: Queue, tracks: TrackRef[], ctx: QueueContextInfo): QueueRejection | null {
  const limits = ctx.limits ?? {};
  if (ctx.actor.role === 'guest' && limits.guestsMayRequest === false) return { code: 'forbidden', reason: 'Guests may not add to this queue' };
  if (limits.maxQueuePerUser !== undefined) {
    const mine = queue.items.filter((i, idx) => idx > queue.currentIndex && i.addedBy?.id === ctx.actor.id).length;
    if (mine + tracks.length > limits.maxQueuePerUser) return { code: 'limit', reason: `Request limit reached (${limits.maxQueuePerUser} pending per member)` };
  }
  if (limits.cooldownSeconds && ctx.actor.lastRequestAt) {
    const elapsed = (Date.parse(ctx.now) - Date.parse(ctx.actor.lastRequestAt)) / 1000;
    if (elapsed < limits.cooldownSeconds) return { code: 'cooldown', reason: `Please wait ${Math.ceil(limits.cooldownSeconds - elapsed)}s before your next request` };
  }
  if (limits.maxTrackDurationMs) {
    const tooLong = tracks.find((t) => (t.durationMs ?? 0) > limits.maxTrackDurationMs!);
    if (tooLong) return { code: 'limit', reason: `"${tooLong.title}" is longer than the group limit` };
  }
  const policy = limits.duplicatePolicy ?? 'allow';
  if (policy !== 'allow') {
    const pending = new Set(queue.items.slice(Math.max(0, queue.currentIndex)).map((i) => i.track.trackId));
    const recent = new Set(policy === 'reject-recent' ? (ctx.recentTrackIds ?? []) : []);
    const dup = tracks.find((t) => pending.has(t.trackId) || recent.has(t.trackId));
    if (dup) return { code: 'duplicate', reason: `"${dup.title}" is already queued${policy === 'reject-recent' ? ' or was played recently' : ''}` };
  }
  return null;
}

/**
 * Round-robin requesters after the current item without destroying manual order within each requester's run.
 * Items are grouped by requester in first-appearance order; the result interleaves the groups.
 */
export function fairOrder(items: readonly QueueItem[], fromIndex: number): QueueItem[] {
  const head = items.slice(0, fromIndex);
  const tail = items.slice(fromIndex);
  const buckets = new Map<string, QueueItem[]>();
  for (const item of tail) {
    const key = item.addedBy?.id ?? 'anonymous';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  const ordered: QueueItem[] = [];
  const lists = Array.from(buckets.values());
  let remaining = tail.length;
  let cursor = 0;
  while (remaining > 0) {
    const list = lists[cursor % lists.length]!;
    const next = list.shift();
    if (next) {
      ordered.push(next);
      remaining -= 1;
    }
    cursor += 1;
    if (cursor > tail.length * lists.length + lists.length) break;
  }
  return [...head, ...ordered];
}

export function nextIndex(queue: Queue, wrap: boolean = queue.repeat === 'all'): number {
  if (!queue.items.length) return -1;
  if (queue.repeat === 'one') return queue.currentIndex;
  const n = queue.currentIndex + 1;
  if (n < queue.items.length) return n;
  return wrap ? 0 : -1;
}

export function previousIndex(queue: Queue): number {
  if (!queue.items.length) return -1;
  const p = queue.currentIndex - 1;
  if (p >= 0) return p;
  return queue.repeat === 'all' ? queue.items.length - 1 : 0;
}

/** Pure reducer. Idempotency-key replay is handled by the caller (keep a map of key -> result). */
export function applyQueueCommand(queue: Queue, command: QueueCommand, ctx: QueueContextInfo): QueueResult {
  const now = ctx.now;
  switch (command.type) {
    case 'append': {
      const rejection = checkLimits(queue, command.items, ctx);
      if (rejection) return reject(queue, rejection.code, rejection.reason);
      let items = [...queue.items, ...makeItems(command.items, ctx, null)];
      if (queue.fairQueue) items = fairOrder(items, queue.currentIndex + 1);
      const wasEmpty = queue.currentIndex < 0;
      const effects: QueueEffect[] = [];
      let currentIndex = queue.currentIndex;
      if (wasEmpty && queue.mode === 'group') {
        currentIndex = 0;
        effects.push({ type: 'play', item: items[0]! });
      }
      return commit(queue, { items, currentIndex }, now, effects);
    }
    case 'insert': {
      const rejection = checkLimits(queue, command.items, ctx);
      if (rejection) return reject(queue, rejection.code, rejection.reason);
      const at = Math.max(0, Math.min(command.index, queue.items.length));
      const items = [...queue.items.slice(0, at), ...makeItems(command.items, ctx, null), ...queue.items.slice(at)];
      const currentIndex = queue.currentIndex >= at && queue.currentIndex >= 0 ? queue.currentIndex + command.items.length : queue.currentIndex;
      return commit(queue, { items, currentIndex }, now);
    }
    case 'playNext': {
      const rejection = checkLimits(queue, command.items, ctx);
      if (rejection) return reject(queue, rejection.code, rejection.reason);
      const at = queue.currentIndex + 1;
      const items = [...queue.items.slice(0, at), ...makeItems(command.items, ctx, null), ...queue.items.slice(at)];
      return commit(queue, { items }, now);
    }
    case 'remove': {
      const idx = queue.items.findIndex((i) => i.id === command.itemId);
      if (idx < 0) return reject(queue, 'invalid', 'Item not in queue');
      const items = queue.items.filter((i) => i.id !== command.itemId);
      let currentIndex = queue.currentIndex;
      const effects: QueueEffect[] = [];
      if (idx === queue.currentIndex) {
        currentIndex = idx < items.length ? idx : items.length ? (queue.repeat === 'all' ? 0 : -1) : -1;
        if (currentIndex >= 0) effects.push({ type: 'play', item: items[currentIndex]! });
        else effects.push({ type: 'stop' });
      } else if (idx < queue.currentIndex) currentIndex -= 1;
      return commit(queue, { items, currentIndex, positionMs: idx === queue.currentIndex ? 0 : queue.positionMs }, now, effects);
    }
    case 'reorder': {
      const from = queue.items.findIndex((i) => i.id === command.itemId);
      if (from < 0) return reject(queue, 'invalid', 'Item not in queue');
      const to = Math.max(0, Math.min(command.toIndex, queue.items.length - 1));
      if (from === to) return commit(queue, {}, now);
      const items = queue.items.slice();
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved!);
      let currentIndex = queue.currentIndex;
      if (queue.currentIndex === from) currentIndex = to;
      else if (from < queue.currentIndex && to >= queue.currentIndex) currentIndex -= 1;
      else if (from > queue.currentIndex && to <= queue.currentIndex) currentIndex += 1;
      return commit(queue, { items, currentIndex }, now);
    }
    case 'skip':
    case 'advance': {
      const current = currentItem(queue);
      const reason = command.type === 'skip' ? (command.reason ?? 'skipped') : command.reason;
      if (command.type === 'advance' && queue.repeat === 'one' && command.reason === 'ended' && current) {
        return commit(queue, { positionMs: 0 }, now, [{ type: 'play', item: current }]);
      }
      // A manual skip (or a non-'ended' advance) under repeat-one still moves to the next item; repeat-all wraps.
      const n = queue.repeat === 'one' ? (queue.currentIndex + 1 < queue.items.length ? queue.currentIndex + 1 : -1) : nextIndex(queue);
      const effects: QueueEffect[] = [];
      if (current && command.type === 'skip') effects.push({ type: 'skipped', item: current, reason });
      if (n >= 0) effects.push({ type: 'play', item: queue.items[n]! });
      else effects.push({ type: 'ended' });
      return commit(queue, { currentIndex: n, positionMs: 0 }, now, effects);
    }
    case 'voteSkip': {
      const current = currentItem(queue);
      if (!current) return reject(queue, 'invalid', 'Nothing is playing');
      if (current.votesToSkip.includes(ctx.actor.id)) return reject(queue, 'duplicate', 'You already voted');
      const votes = [...current.votesToSkip, ctx.actor.id];
      const listeners = Math.max(1, ctx.listenerCount ?? 1);
      const needed = Math.max(1, Math.ceil(listeners * (ctx.voteSkipThreshold ?? 0.5)));
      const items = queue.items.map((i) => (i.id === current.id ? { ...i, votesToSkip: votes } : i));
      if (votes.length >= needed) {
        const n = nextIndex(queue);
        const effects: QueueEffect[] = [{ type: 'skipped', item: current, reason: 'vote' }];
        if (n >= 0) effects.push({ type: 'play', item: items[n]! });
        else effects.push({ type: 'ended' });
        return commit(queue, { items, currentIndex: n, positionMs: 0 }, now, effects);
      }
      return commit(queue, { items }, now, [{ type: 'voteRecorded', item: current, votes: votes.length, needed }]);
    }
    case 'previous': {
      if (queue.positionMs > 3000 && currentItem(queue)) return commit(queue, { positionMs: 0 }, now, [{ type: 'seek', positionMs: 0 }]);
      const p = previousIndex(queue);
      if (p < 0) return reject(queue, 'invalid', 'Queue is empty');
      return commit(queue, { currentIndex: p, positionMs: 0 }, now, [{ type: 'play', item: queue.items[p]! }]);
    }
    case 'jump': {
      const idx = queue.items.findIndex((i) => i.id === command.itemId);
      if (idx < 0) return reject(queue, 'invalid', 'Item not in queue');
      return commit(queue, { currentIndex: idx, positionMs: 0 }, now, [{ type: 'play', item: queue.items[idx]! }]);
    }
    case 'shuffle': {
      const seed = command.seed ?? fnv1a(`${queue.id}:${queue.revision}:${now}`);
      const current = currentItem(queue);
      const rest = queue.items.filter((i) => i !== current);
      const shuffled = seededShuffle(rest, seed);
      const items = current ? [current, ...shuffled] : shuffled;
      return commit(queue, { items, currentIndex: current ? 0 : items.length ? 0 : -1, shuffleSeed: seed }, now);
    }
    case 'setShuffle':
      return commit(queue, { shuffle: command.enabled, shuffleSeed: command.enabled ? (command.seed ?? fnv1a(`${queue.id}:${now}`)) : null }, now);
    case 'setRepeat':
      return commit(queue, { repeat: command.repeat as RepeatMode }, now);
    case 'clear': {
      const current = currentItem(queue);
      const items = current ? [current] : [];
      return commit(queue, { items, currentIndex: current ? 0 : -1 }, now);
    }
    case 'play': {
      const current = currentItem(queue) ?? (queue.items.length ? queue.items[0]! : null);
      if (!current) return reject(queue, 'invalid', 'Queue is empty');
      return commit(queue, { currentIndex: queue.currentIndex >= 0 ? queue.currentIndex : 0 }, now, [{ type: 'play', item: current }]);
    }
    case 'pause':
      return commit(queue, {}, now, [{ type: 'pause' }]);
    case 'resume':
      return commit(queue, {}, now, [{ type: 'resume' }]);
    case 'seek': {
      const current = currentItem(queue);
      if (!current) return reject(queue, 'invalid', 'Nothing is playing');
      const max = current.track.durationMs ?? Number.MAX_SAFE_INTEGER;
      const positionMs = Math.max(0, Math.min(command.positionMs, max));
      return commit(queue, { positionMs }, now, [{ type: 'seek', positionMs }]);
    }
    case 'stop':
      return commit(queue, { positionMs: 0 }, now, [{ type: 'stop' }]);
    case 'setFairQueue': {
      const items = command.enabled ? fairOrder(queue.items, queue.currentIndex + 1) : queue.items;
      return commit(queue, { fairQueue: command.enabled, items }, now);
    }
    case 'markUnavailable': {
      const idx = queue.items.findIndex((i) => i.id === command.itemId);
      if (idx < 0) return reject(queue, 'invalid', 'Item not in queue');
      const items = queue.items.map((i) => (i.id === command.itemId ? { ...i, availability: 'unavailable' as const, unavailableReason: command.reason } : i));
      return commit(queue, { items }, now);
    }
    default:
      return reject(queue, 'invalid', 'Unknown command');
  }
}

/** Hash of the queue order for quick convergence checks between peers. */
export function queueFingerprint(queue: Queue): string {
  const text = `${queue.revision}|${queue.currentIndex}|${queue.items.map((i) => i.id).join(',')}`;
  return fnv1a(text).toString(16).padStart(8, '0');
}

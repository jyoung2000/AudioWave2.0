/**
 * One command implementation for every surface: the admin GUI, the HTTP API, the player and the
 * Discord bot all call this. Slash and prefix commands in Discord are two parsers in front of the
 * same service, which is what makes their behaviour identical by construction rather than by
 * discipline (docs/architecture/GROUP_PLAYBACK.md).
 *
 * The service owns permission checks (`authorizeCommand` from the domain package), the search and
 * resolve step, and the mapping from an outcome to a template key. It never formats Discord
 * messages itself — it returns a key plus variables, and the caller renders the template.
 */
import type { DiscordTemplateKey, QueueCommand, SearchResult, TrackRef } from '@now-playing/contracts';
import { authorizeCommand, DomainError, isDj, uuidv7, type CommandActor, type CommandPolicy, type MusicCommand } from '@now-playing/domain';
import type { GroupActor, GroupService } from './service.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { SearchService } from '../providers/search-service.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';

export interface CommandRequest {
  command: MusicCommand;
  /** Free-text argument: a search query, a URL, a page number, a setting assignment. */
  args: string;
  groupId: string;
  actor: CommandActor & { kind: 'device' | 'user' | 'discord' | 'admin' | 'system' };
  policy: CommandPolicy;
  transport: 'slash' | 'prefix' | 'web';
  channelId: string;
  /** Provided by the caller when it already knows what to enqueue (the web UI). */
  track?: TrackRef;
  idempotencyKey?: string;
}

export interface CommandOutcome {
  ok: boolean;
  templateKey: DiscordTemplateKey;
  variables: Record<string, string | number | null>;
  /** Present when the command changed the queue. */
  revision?: number;
  /** Present when a search returned nothing usable, so the caller can offer alternatives. */
  candidates?: SearchResult[];
  ephemeral: boolean;
}

const EPHEMERAL_KEYS: ReadonlySet<DiscordTemplateKey> = new Set(['permissionDenied', 'noResults', 'unavailableSource', 'emptyQueue', 'wrongChannel', 'error']);

function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export class CommandService {
  constructor(
    private readonly groups: GroupService,
    private readonly search: SearchService,
    private readonly providers: ProviderRegistry,
    private readonly clock: Clock,
    private readonly metrics: MetricsRegistry,
  ) {}

  private outcome(templateKey: DiscordTemplateKey, variables: Record<string, string | number | null>, ok = true, extra: Partial<CommandOutcome> = {}): CommandOutcome {
    return { ok, templateKey, variables, ephemeral: EPHEMERAL_KEYS.has(templateKey), ...extra };
  }

  /**
   * A Discord user has no hub identity and no group membership, so their authority is the one the
   * guild gave them: `authorizeCommand` has already checked the DJ and admin roles by the time this
   * runs, and the resulting role is handed to the group service explicitly (see `GroupActor`).
   * Devices and admins are unaffected — they still go through the group's own membership checks.
   */
  private groupActor(req: CommandRequest): GroupActor {
    const base: GroupActor = { id: req.actor.id, kind: req.actor.kind === 'system' ? 'system' : req.actor.kind, displayName: req.actor.displayName, ...(req.actor.isHubAdmin ? { isHubAdmin: true } : {}) };
    if (req.actor.kind !== 'discord') return base;
    return { ...base, authorizedRole: isDj(req.actor, req.policy) ? 'admin' : 'member' };
  }

  /** Turn free text into something queueable: a pasted URL resolves, otherwise the first playable search hit. */
  async resolveRequest(query: string, actorId: string): Promise<{ track: TrackRef | null; result: SearchResult | null; candidates: SearchResult[]; reason: string | null }> {
    const trimmed = query.trim();
    if (!trimmed) return { track: null, result: null, candidates: [], reason: 'Say what to play' };
    if (/^https?:\/\//i.test(trimmed)) {
      const resolved = await this.search.resolveUrl(trimmed);
      if (!resolved) return { track: null, result: null, candidates: [], reason: 'That link is not from a provider this hub is configured for' };
      if (resolved.capabilities.playback !== 'available') return { track: null, result: resolved, candidates: [resolved], reason: resolved.capabilities.reason ?? 'This source cannot be played here' };
      return { track: this.search.toTrackRef(resolved), result: resolved, candidates: [resolved], reason: null };
    }
    const page = await this.search.search({ query: trimmed, scope: 'songs', limit: 10, actorId });
    const playable = page.results.find((r) => r.capabilities.playback === 'available');
    if (!playable) {
      const first = page.results[0];
      return { track: null, result: first ?? null, candidates: page.results, reason: first ? (first.capabilities.reason ?? 'No result can be played here') : 'No results' };
    }
    return { track: this.search.toTrackRef(playable), result: playable, candidates: page.results, reason: null };
  }

  async execute(req: CommandRequest): Promise<CommandOutcome> {
    this.metrics.increment(`commands.${req.command}`);
    const decision = authorizeCommand(req.command, req.actor, req.policy, {
      channelId: req.channelId,
      transport: req.transport,
      ...(req.command === 'settings' ? { isChangingSettings: true } : {}),
    });
    if (!decision.allowed && !(req.command === 'skip' && decision.voteEligible)) {
      this.metrics.increment('commands.denied');
      const key: DiscordTemplateKey = decision.code === 'wrong-channel' ? 'wrongChannel' : 'permissionDenied';
      return this.outcome(key, { reason: decision.reason, user: req.actor.displayName, channel: req.policy.designatedChannelId }, false);
    }

    const actor = this.groupActor(req);
    const state = this.groups.state(req.groupId);
    const baseRevision = state.queue.revision;
    const key = req.idempotencyKey ?? uuidv7(this.clock.now());

    const apply = (command: QueueCommand): ReturnType<GroupService['applyCommand']> => this.groups.applyCommand(req.groupId, actor, { idempotencyKey: key, baseRevision, command });

    try {
      switch (req.command) {
        case 'play': {
          let track = req.track ?? null;
          let result: SearchResult | null = null;
          if (!track) {
            const resolved = await this.resolveRequest(req.args, req.actor.id);
            if (!resolved.track) {
              const templateKey: DiscordTemplateKey = resolved.candidates.length ? 'unavailableSource' : 'noResults';
              return this.outcome(templateKey, { reason: resolved.reason, title: resolved.result?.title ?? req.args, artist: resolved.result?.artistName ?? null }, false, { candidates: resolved.candidates });
            }
            track = resolved.track;
            result = resolved.result;
          }
          const outcome = apply({ type: 'append', items: [track] });
          if (!outcome.accepted) return this.outcome('error', { reason: outcome.rejection?.reason ?? 'Rejected' }, false);
          const position = outcome.queue.items.findIndex((i) => i.track.trackId === track.trackId) + 1;
          return this.outcome(
            'queued',
            {
              title: track.title,
              artist: track.artistName,
              album: track.albumName,
              duration: fmtDuration(track.durationMs),
              position,
              requester: req.actor.displayName,
              source: this.providers.has(track.provider) ? this.providers.descriptor(track.provider).displayName : track.provider,
              url: result?.canonicalUrl ?? null,
              count: outcome.queue.items.length,
            },
            true,
            { revision: outcome.revision },
          );
        }

        case 'nowplaying': {
          const np = this.groups.nowPlaying(req.groupId);
          if (!np.item) return this.outcome('emptyQueue', {}, false);
          return this.outcome('nowPlaying', {
            title: np.item.track.title,
            artist: np.item.track.artistName,
            album: np.item.track.albumName,
            requester: np.requester,
            group: this.groups.find(req.groupId).name,
            elapsed: fmtDuration(np.positionMs),
            duration: fmtDuration(np.item.track.durationMs),
            remaining: fmtDuration((np.item.track.durationMs ?? 0) - np.positionMs),
            source: np.item.track.provider,
            position: np.queue.currentIndex + 1,
            count: np.queue.items.length,
          });
        }

        case 'queue': {
          const { queue } = this.groups.state(req.groupId);
          if (!queue.items.length) return this.outcome('emptyQueue', {}, false);
          const page = Math.max(1, Number.parseInt(req.args.trim(), 10) || 1);
          const perPage = 10;
          const pages = Math.max(1, Math.ceil(queue.items.length / perPage));
          const slice = queue.items.slice((page - 1) * perPage, page * perPage);
          const lines = slice.map((item, i) => `${(page - 1) * perPage + i + 1}. ${item.track.title} — ${item.track.artistName} (${item.addedBy?.displayName ?? 'hub'})`);
          return this.outcome('success', { title: `Queue (${queue.items.length})`, reason: lines.join('\n'), page: Math.min(page, pages), pages, count: queue.items.length });
        }

        case 'skip': {
          const current = state.queue.items[state.queue.currentIndex];
          const outcome = apply({ type: 'skip', reason: req.args.slice(0, 120) || 'user' });
          if (!outcome.accepted) return this.outcome('error', { reason: outcome.rejection?.reason ?? 'Rejected' }, false);
          const voted = outcome.effects.some((e) => e.type === 'voteRecorded');
          if (voted) {
            const vote = outcome.effects.find((e) => e.type === 'voteRecorded');
            return this.outcome('success', { title: current?.track.title ?? null, reason: `Vote counted (${vote && vote.type === 'voteRecorded' ? vote.votes : 1}/${vote && vote.type === 'voteRecorded' ? vote.needed : 1})`, user: req.actor.displayName }, true, { revision: outcome.revision });
          }
          return this.outcome('skipped', { title: current?.track.title ?? null, artist: current?.track.artistName ?? null, reason: req.args || 'skipped', user: req.actor.displayName }, true, { revision: outcome.revision });
        }

        case 'pause': {
          const outcome = apply({ type: 'pause' });
          return outcome.accepted ? this.outcome('paused', { user: req.actor.displayName }, true, { revision: outcome.revision }) : this.outcome('error', { reason: outcome.rejection?.reason ?? 'Rejected' }, false);
        }

        case 'resume': {
          const outcome = apply({ type: 'resume' });
          return outcome.accepted ? this.outcome('resumed', { user: req.actor.displayName }, true, { revision: outcome.revision }) : this.outcome('error', { reason: outcome.rejection?.reason ?? 'Rejected' }, false);
        }

        case 'stop': {
          const outcome = apply({ type: 'stop' });
          if (!outcome.accepted) return this.outcome('error', { reason: outcome.rejection?.reason ?? 'Rejected' }, false);
          const cleared = this.groups.applyCommand(req.groupId, actor, { idempotencyKey: `${key}:clear`, baseRevision: outcome.revision, command: { type: 'clear' } });
          return this.outcome('stopped', { user: req.actor.displayName, count: state.queue.items.length }, true, { revision: cleared.revision });
        }

        case 'shuffle': {
          const outcome = apply({ type: 'shuffle' });
          return outcome.accepted ? this.outcome('shuffled', { count: outcome.queue.items.length, user: req.actor.displayName }, true, { revision: outcome.revision }) : this.outcome('error', { reason: outcome.rejection?.reason ?? 'Rejected' }, false);
        }

        case 'clear': {
          const removed = Math.max(0, state.queue.items.length - (state.queue.currentIndex >= 0 ? 1 : 0));
          const outcome = apply({ type: 'clear' });
          return outcome.accepted ? this.outcome('cleared', { count: removed, user: req.actor.displayName }, true, { revision: outcome.revision }) : this.outcome('error', { reason: outcome.rejection?.reason ?? 'Rejected' }, false);
        }

        case 'join':
          // Voice-channel joining is the Discord worker's business; the shared service only authorises it.
          return this.outcome('joined', { channel: req.args || req.channelId, user: req.actor.displayName });

        case 'leave':
          return this.outcome('left', { channel: req.args || req.channelId, user: req.actor.displayName });

        case 'settings':
          return this.outcome('success', { reason: 'Settings are changed in the hub admin GUI (Admin → Discord and Admin → Groups).', user: req.actor.displayName });

        default:
          return this.outcome('error', { reason: `Unknown command ${String(req.command)}` }, false);
      }
    } catch (err) {
      if (err instanceof DomainError) {
        this.metrics.increment('commands.failed');
        const key2: DiscordTemplateKey = err.code === 'forbidden' ? 'permissionDenied' : err.code === 'not-found' ? 'noResults' : 'error';
        return this.outcome(key2, { reason: err.message, user: req.actor.displayName }, false);
      }
      throw err;
    }
  }
}

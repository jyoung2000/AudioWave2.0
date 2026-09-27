/**
 * Group listening: membership, the authoritative queue, history and the opt-in aggregate view.
 *
 * The hub is the single writer for a group's queue and playback. Every mutation goes through one
 * revisioned, idempotent command endpoint: the caller sends the revision it was looking at and an
 * idempotency key, and gets back either the applied result or the same result again on a retry.
 * That is what keeps four devices and a Discord bot from fighting over the same queue
 * (docs/architecture/GROUP_PLAYBACK.md).
 *
 * The aggregate view is opt-in twice over — a member has to share, and the cohort has to be large
 * enough — and it never exposes another member's raw history.
 */
import type { FastifyInstance } from 'fastify';
import { routes } from '@now-playing/contracts';
import { DomainError, type CommandPolicy } from '@now-playing/domain';
import type { GroupView } from '@now-playing/contracts';
import type { HubContext } from '../../context.js';
import { actorDisplayName, actorId, type Principal } from '../../auth/principal.js';
import { currentItem } from '@now-playing/domain';
import type { GroupActor, GroupViewData } from '../../group/service.js';
import { RAW, registerRoute } from '../register.js';

/** Requests from the player: no Discord guild policy applies, so nothing beyond group membership limits them. */
const WEB_REQUEST_POLICY: CommandPolicy = { djRoleIds: [], adminRoleIds: [], guestsMayRequest: true, voteSkipThreshold: 0, designatedChannelId: null, cooldownSeconds: 0, maxRequestsPerUser: Number.MAX_SAFE_INTEGER };

/** Group membership is by actor, so an admin session and a device credential both map to one. */
export function groupActor(principal: Principal): GroupActor {
  if (principal.kind === 'admin') return { id: 'admin', kind: 'admin', displayName: principal.username, isHubAdmin: true };
  if (principal.kind === 'device') return { id: principal.deviceId, kind: 'device', displayName: principal.displayName, profileId: principal.hubUserId };
  throw new DomainError('unauthenticated', 'Authentication required');
}

/**
 * The service works with the group, its members, the queue and the playback state as separate
 * objects; the API flattens them into one view. Doing that here rather than in the service keeps
 * the wire shape a concern of the API layer alone.
 */
function toGroupView(ctx: HubContext, data: GroupViewData): GroupView {
  const item = currentItem(data.queue);
  return {
    ...data.group,
    members: data.members.map((m) => ({ ...m, online: m.online, latencyMs: m.latencyMs })),
    queueLength: data.queue.items.length,
    listenerCount: ctx.groups.listenerCount(data.group.id),
    playback: data.playback,
    currentTrackTitle: item?.track.title ?? null,
    myRole: data.myRole,
  };
}

export function registerGroupRoutes(app: FastifyInstance, ctx: HubContext): void {
  /**
   * Read access to a group's queue, history, sync and aggregate data is limited to its members.
   * Hub admins bypass membership (requireMember returns without throwing for them).
   */
  const requireReader = (groupId: string, principal: Principal): void => {
    ctx.groups.requireMember(groupId, groupActor(principal));
  };

  registerRoute(app, ctx, routes.groupsList, ({ principal }) => ({ items: ctx.groups.listVisible(groupActor(principal)).map((g) => toGroupView(ctx, g)) }));

  registerRoute(app, ctx, routes.groupsCreate, ({ body, principal, ip, correlationId, reply }) => {
    const view = ctx.groups.create(groupActor(principal), { name: body.name, ...(body.settings ? { settings: body.settings } : {}) }, { ip, correlationId });
    reply.status(201);
    return toGroupView(ctx, view);
  });

  registerRoute(app, ctx, routes.groupsGet, ({ params, principal }) => {
    requireReader(params.groupId, principal);
    return toGroupView(ctx, ctx.groups.view(params.groupId, actorId(principal)));
  });

  registerRoute(app, ctx, routes.groupsUpdate, ({ params, body, principal }) =>
    toGroupView(ctx, ctx.groups.update(params.groupId, groupActor(principal), { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.settings ? { settings: body.settings } : {}) })),
  );

  registerRoute(app, ctx, routes.groupsArchive, ({ params, principal }) => {
    ctx.groups.archive(params.groupId, groupActor(principal));
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.groupsInvite, ({ params, body, principal, ip, correlationId }) =>
    ctx.groups.createInvite(params.groupId, groupActor(principal), { ttlSeconds: body.ttlSeconds, role: body.role, toProfileId: body.toProfileId }, { ip, correlationId }),
  );

  registerRoute(app, ctx, routes.groupsInvitesList, ({ params, principal }) => ({ items: ctx.groups.listInvites(params.groupId, groupActor(principal)) }));

  registerRoute(app, ctx, routes.groupsInviteWithdraw, ({ params, principal, ip, correlationId }) => {
    ctx.groups.withdrawInvite(params.groupId, groupActor(principal), params.inviteId, { ip, correlationId });
    return { ok: true as const };
  });

  // Rate-limited like `join`, so previewing cannot be used to guess codes any faster than joining can.
  registerRoute(app, ctx, routes.groupsInvitePreview, ({ query }) => ctx.groups.previewInvite(query.code));

  registerRoute(app, ctx, routes.groupsJoin, ({ body, principal, ip, correlationId }) => toGroupView(ctx, ctx.groups.join(groupActor(principal), body.inviteCode, body.displayName, { ip, correlationId })));

  /* Invites addressed to a person arrive here, without anyone copying a link. */

  registerRoute(app, ctx, routes.myInvitesList, ({ principal }) => {
    const actor = groupActor(principal);
    return { items: actor.profileId ? ctx.groups.invitesFor(actor.profileId) : [] };
  });

  registerRoute(app, ctx, routes.myInviteAccept, ({ params, principal, ip, correlationId }) => toGroupView(ctx, ctx.groups.acceptInvite(groupActor(principal), params.inviteId, { ip, correlationId })));

  registerRoute(app, ctx, routes.myInviteDecline, ({ params, principal, ip, correlationId }) => {
    ctx.groups.declineInvite(groupActor(principal), params.inviteId, { ip, correlationId });
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.groupsLeave, ({ params, principal }) => {
    ctx.groups.leave(params.groupId, groupActor(principal));
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.groupsMemberRevoke, ({ params, principal }) => {
    ctx.groups.revokeMember(params.groupId, groupActor(principal), params.memberId);
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.groupsMemberRole, ({ params, body, principal }) => {
    return ctx.groups.setMember(params.groupId, groupActor(principal), params.memberId, { role: body.role, shareAggregate: body.shareAggregate });
  });

  /* ----------------------------------------------------------------- queue */

  registerRoute(app, ctx, routes.groupsQueueGet, ({ params, principal }) => {
    requireReader(params.groupId, principal);
    const state = ctx.groups.state(params.groupId);
    return { queue: state.queue, playback: state.playback, serverTime: new Date(ctx.clock.now()).toISOString() };
  });

  registerRoute(app, ctx, routes.groupsQueueCommand, ({ params, body, principal }) =>
    ctx.groups.applyCommand(params.groupId, groupActor(principal), { idempotencyKey: body.idempotencyKey, baseRevision: body.baseRevision, command: body.command }),
  );

  /*
   * A song asked for by what it is called — "Artist - Title" read off a radio station, or a pasted
   * link. The same path as Discord's /play (CommandService): the hub finds a playable copy among its
   * providers and library and appends it; when there is none, the answer says why and nothing moves.
   * Web requests carry no guild roles, so the group's own membership and roles are the whole check.
   */
  registerRoute(app, ctx, routes.groupsRequest, async ({ params, body, principal }) => {
    // A stranger is refused as one (403), not answered as if the song were the problem.
    requireReader(params.groupId, principal);
    const actor = groupActor(principal);
    const outcome = await ctx.commands.execute({
      command: 'play',
      args: body.query,
      groupId: params.groupId,
      actor: { id: actor.id, displayName: actor.displayName, kind: actor.kind === 'admin' ? 'admin' : 'device', roleIds: [], isGuildAdmin: false, hasManageGuild: false, isRequesterOfCurrent: false, ...(actor.isHubAdmin ? { isHubAdmin: true } : {}) },
      policy: WEB_REQUEST_POLICY,
      transport: 'web',
      channelId: '',
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    });
    const text = (value: string | number | null | undefined): string | null => (typeof value === 'string' && value && value !== '—' ? value : null);
    const v = outcome.variables;
    return outcome.ok
      ? { queued: true, title: text(v['title']), artistName: text(v['artist']), position: typeof v['position'] === 'number' && v['position'] > 0 ? v['position'] : null, reason: null }
      : { queued: false, title: text(v['title']), artistName: text(v['artist']), position: null, reason: text(v['reason']) ?? 'Nothing that plays here matched that song' };
  });

  /* --------------------------------------------------------------- history */

  registerRoute(app, ctx, routes.groupsHistoryList, ({ params, query, principal }) => {
    requireReader(params.groupId, principal);
    const items = ctx.groups.history(params.groupId, { limit: query.limit, before: query.cursor ?? null });
    const last = items[items.length - 1];
    return { items, nextCursor: items.length === query.limit && last ? last.startedAt : null };
  });

  registerRoute(app, ctx, routes.groupsHistoryExportCsv, ({ params, reply, principal }) => {
    requireReader(params.groupId, principal);
    const csv = ctx.groups.exportCsv(params.groupId);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="history-${params.groupId}.csv"`)
      .send(csv);
    return RAW;
  });

  registerRoute(app, ctx, routes.groupsHistoryExportJson, ({ params, principal }) => {
    requireReader(params.groupId, principal);
    return ctx.groups.exportJson(params.groupId);
  });

  registerRoute(app, ctx, routes.groupsHistoryImport, ({ params, query, body, principal }) =>
    ctx.groups.importHistory(params.groupId, groupActor(principal), typeof body === 'string' ? body : String(body), query.format, query.dryRun),
  );

  /* ------------------------------------------------------------------ sync */

  registerRoute(app, ctx, routes.groupsSync, ({ params, principal }) => {
    requireReader(params.groupId, principal);
    return ctx.groups.syncInfo(params.groupId);
  });

  registerRoute(app, ctx, routes.groupNowPlayingAdmin, ({ params, principal }) => {
    requireReader(params.groupId, principal);
    const np = ctx.groups.nowPlaying(params.groupId);
    const group = ctx.groups.find(params.groupId);
    const track = np.item?.track ?? null;
    const grade = track ? ctx.providers.syncGradeFor(track) : { grade: 'unsupported' as const, reason: null };
    return {
      mode: np.queue.items.length || np.playback.status !== 'idle' ? ('group' as const) : ('solo' as const),
      groupId: params.groupId,
      title: track?.title ?? null,
      artistName: track?.artistName ?? null,
      albumName: track?.albumName ?? null,
      artworkUrl: track?.artworkId ? `/api/v1/library/artwork/${encodeURIComponent(track.artworkId)}` : null,
      source: track?.provider ?? null,
      canonicalUrl: track?.locators.find((l) => l.kind === 'provider')?.canonicalUrl ?? null,
      durationMs: track?.durationMs ?? null,
      positionMs: np.positionMs,
      requester: np.requester,
      syncGrade: grade.grade,
      warning: grade.reason,
      serverTime: new Date(ctx.clock.now()).toISOString(),
      groupName: group.name,
    };
  });

  /* ------------------------------------------------------------- aggregate */

  registerRoute(app, ctx, routes.groupsAggregate, ({ params, principal }) => {
    requireReader(params.groupId, principal);
    const viewerId = actorId(principal);
    const result = ctx.groups.aggregate(params.groupId, viewerId, null);
    const merged = result.merged;
    return {
      groupId: params.groupId,
      participantCount: result.participantCount,
      minimumParticipants: 3,
      available: result.available,
      reason: result.reason,
      sharedFavorites: merged ? merged.artists.slice(0, 20).map((a) => ({ key: a.key, kind: 'artist' as const, participants: result.participantCount, weight: a.weight })) : [],
      complementaryGenres: merged ? merged.genres.slice(0, 20).map((g) => ({ key: g.key, weight: g.weight })) : [],
      overlap: result.comparison ? { artists: result.comparison.overlapPercent.artists / 100, albums: result.comparison.overlapPercent.albums / 100, genres: result.comparison.overlapPercent.genres / 100, eras: result.comparison.overlapPercent.eras / 100 } : null,
      comparison: result.comparison,
      // Acceptance needs feedback the hub only has once people rate group recommendations; until
      // then this is honestly null rather than a made-up number.
      recommendationAcceptance: null,
    };
  });

  registerRoute(app, ctx, routes.aggregatePut, ({ body, principal, ip, userAgent, correlationId }) => {
    const owner = actorId(principal);
    // Uploading is the opt-in. Nothing is inferred from a device simply being paired.
    ctx.repos.canonical.putAggregate(owner, { ...body, ownerId: owner }, new Date(ctx.clock.now()).toISOString());
    ctx.audit.record({ actor: { kind: 'device', id: owner, displayName: actorDisplayName(principal) }, action: 'aggregate.share', outcome: 'success', target: { kind: 'profile', id: owner }, ip, correlationId, details: { sampleSize: String(body.sampleSize) } });
    void userAgent;
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.aggregateDelete, ({ principal, ip, correlationId }) => {
    const owner = actorId(principal);
    ctx.repos.canonical.deleteAggregate(owner);
    ctx.audit.record({ actor: { kind: 'device', id: owner, displayName: actorDisplayName(principal) }, action: 'aggregate.revoke', outcome: 'success', target: { kind: 'profile', id: owner }, ip, correlationId });
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.aggregateGet, ({ principal }) => ({ profile: ctx.repos.canonical.getAggregate(actorId(principal)) }));
}

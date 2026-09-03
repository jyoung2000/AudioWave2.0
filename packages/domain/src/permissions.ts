/** One authorization policy shared by web, slash and prefix commands. */

export const MUSIC_COMMANDS = ['play', 'nowplaying', 'queue', 'skip', 'pause', 'resume', 'stop', 'shuffle', 'clear', 'join', 'leave', 'settings'] as const;
export type MusicCommand = (typeof MUSIC_COMMANDS)[number];

export interface CommandActor {
  id: string;
  displayName: string;
  roleIds: readonly string[];
  isGuildAdmin: boolean;
  hasManageGuild: boolean;
  /** Provided by the caller: is this actor the requester of the current item? */
  isRequesterOfCurrent: boolean;
  isHubAdmin?: boolean;
}

export interface CommandPolicy {
  djRoleIds: readonly string[];
  adminRoleIds: readonly string[];
  guestsMayRequest: boolean;
  voteSkipThreshold: number;
  designatedChannelId: string | null;
  cooldownSeconds: number;
  maxRequestsPerUser: number;
}

export interface CommandContext {
  channelId: string;
  isChangingSettings?: boolean;
  transport: 'slash' | 'prefix' | 'web';
  pendingRequestsByActor?: number;
  secondsSinceLastRequest?: number | null;
}

export interface CommandDecision {
  allowed: boolean;
  /** When false and `voteEligible` is true the caller should record a vote instead of skipping outright. */
  voteEligible: boolean;
  reason: string | null;
  code: 'ok' | 'wrong-channel' | 'role' | 'cooldown' | 'limit' | 'guest';
}

export function isDj(actor: CommandActor, policy: CommandPolicy): boolean {
  return actor.isGuildAdmin || actor.hasManageGuild || actor.isHubAdmin === true || actor.roleIds.some((r) => policy.djRoleIds.includes(r) || policy.adminRoleIds.includes(r));
}

export function isAdmin(actor: CommandActor, policy: CommandPolicy): boolean {
  return actor.isGuildAdmin || actor.hasManageGuild || actor.roleIds.some((r) => policy.adminRoleIds.includes(r)) || actor.isHubAdmin === true;
}

export function authorizeCommand(command: MusicCommand, actor: CommandActor, policy: CommandPolicy, ctx: CommandContext): CommandDecision {
  const ok: CommandDecision = { allowed: true, voteEligible: false, reason: null, code: 'ok' };
  if (command === 'settings') {
    return isAdmin(actor, policy) ? ok : { allowed: false, voteEligible: false, reason: 'Manage Guild or a configured admin role is required', code: 'role' };
  }
  if (ctx.transport !== 'web' && policy.designatedChannelId && ctx.channelId !== policy.designatedChannelId && !ctx.isChangingSettings) {
    return { allowed: false, voteEligible: false, reason: 'wrong channel', code: 'wrong-channel' };
  }
  switch (command) {
    case 'play': {
      if (!policy.guestsMayRequest && !isDj(actor, policy)) return { allowed: false, voteEligible: false, reason: 'Requests are limited to DJs in this group', code: 'guest' };
      if (ctx.pendingRequestsByActor !== undefined && ctx.pendingRequestsByActor >= policy.maxRequestsPerUser && !isDj(actor, policy)) return { allowed: false, voteEligible: false, reason: `Request limit reached (${policy.maxRequestsPerUser})`, code: 'limit' };
      if (ctx.secondsSinceLastRequest !== null && ctx.secondsSinceLastRequest !== undefined && ctx.secondsSinceLastRequest < policy.cooldownSeconds && !isDj(actor, policy)) return { allowed: false, voteEligible: false, reason: `Please wait ${Math.ceil(policy.cooldownSeconds - ctx.secondsSinceLastRequest)}s`, code: 'cooldown' };
      return ok;
    }
    case 'nowplaying':
    case 'queue':
      return ok;
    case 'skip':
      if (isDj(actor, policy) || actor.isRequesterOfCurrent) return ok;
      return { allowed: false, voteEligible: policy.voteSkipThreshold > 0, reason: policy.voteSkipThreshold > 0 ? 'Your vote to skip was counted' : 'Only DJs or the requester may skip', code: 'role' };
    case 'pause':
    case 'resume':
    case 'stop':
    case 'shuffle':
    case 'clear':
    case 'join':
    case 'leave':
      return isDj(actor, policy) ? ok : { allowed: false, voteEligible: false, reason: 'DJ or admin role required', code: 'role' };
    default:
      return { allowed: false, voteEligible: false, reason: 'Unknown command', code: 'role' };
  }
}

/** Minimal Discord permission bitfield for the invite URL: View Channels, Send Messages, Embed Links, Read History, Connect, Speak, Use Slash Commands. */
export const DISCORD_MINIMAL_PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 16n) | (1n << 20n) | (1n << 21n) | (1n << 31n);

export function buildInviteUrl(applicationId: string): string {
  const params = new URLSearchParams({ client_id: applicationId, scope: 'bot applications.commands', permissions: DISCORD_MINIMAL_PERMISSIONS.toString() });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

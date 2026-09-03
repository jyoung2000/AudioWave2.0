import { z } from 'zod';
import { IsoDateTime, SCHEMA_VERSIONS, Uuid } from '../common.js';

export const DISCORD_TEMPLATE_KEYS = [
  'success',
  'queued',
  'nowPlaying',
  'skipped',
  'permissionDenied',
  'noResults',
  'unavailableSource',
  'emptyQueue',
  'joined',
  'left',
  'error',
  'wrongChannel',
  'paused',
  'resumed',
  'stopped',
  'shuffled',
  'cleared',
] as const;
export type DiscordTemplateKey = (typeof DISCORD_TEMPLATE_KEYS)[number];

export const DISCORD_TEMPLATE_VARIABLES = [
  'title',
  'artist',
  'album',
  'requester',
  'position',
  'group',
  'duration',
  'elapsed',
  'remaining',
  'source',
  'url',
  'count',
  'channel',
  'reason',
  'user',
  'page',
  'pages',
] as const;
export type DiscordTemplateVariable = (typeof DISCORD_TEMPLATE_VARIABLES)[number];

export const DISCORD_LIMITS = {
  content: 2000,
  embedTitle: 256,
  embedDescription: 4096,
  embedFieldName: 256,
  embedFieldValue: 1024,
  embedTotal: 6000,
} as const;

export const DiscordTemplate = z.object({
  content: z.string().max(DISCORD_LIMITS.content).default(''),
  embedTitle: z.string().max(DISCORD_LIMITS.embedTitle).nullable().default(null),
  embedDescription: z.string().max(DISCORD_LIMITS.embedDescription).nullable().default(null),
  color: z.number().int().min(0).max(0xffffff).nullable().default(null),
  ephemeral: z.boolean().default(false),
});
export type DiscordTemplate = z.infer<typeof DiscordTemplate>;

export const DiscordTemplates = z.object({
  schemaVersion: z.number().int().positive().default(SCHEMA_VERSIONS.discordTemplates),
  templates: z.record(z.enum(DISCORD_TEMPLATE_KEYS), DiscordTemplate),
  allowedMentionRoleIds: z.array(z.string().regex(/^\d{5,25}$/)).default([]),
  allowEveryone: z.boolean().default(false),
});
export type DiscordTemplates = z.infer<typeof DiscordTemplates>;

export const DiscordRequestPolicy = z.object({
  maxRequestsPerUser: z.number().int().positive().max(100).default(10),
  cooldownSeconds: z.number().int().nonnegative().max(600).default(5),
  maxTrackDurationMs: z.number().int().positive().default(20 * 60 * 1000),
  maxPlaylistItems: z.number().int().positive().max(200).default(50),
  voteSkipThreshold: z.number().min(0).max(1).default(0.5),
  guestsMayRequest: z.boolean().default(true),
});
export type DiscordRequestPolicy = z.infer<typeof DiscordRequestPolicy>;

export const DiscordConfiguration = z.object({
  id: Uuid,
  enabled: z.boolean().default(false),
  applicationId: z.string().regex(/^\d{5,25}$/).nullable().default(null),
  publicKey: z.string().max(200).nullable().default(null),
  tokenSource: z.enum(['none', 'env', 'encrypted']).default('none'),
  tokenLast4: z.string().max(4).nullable().default(null),
  guildAllowlist: z.array(z.string().regex(/^\d{5,25}$/)).default([]),
  defaultGroupId: Uuid.nullable().default(null),
  designatedChannels: z.record(z.string(), z.string()).default({}).describe('guildId -> text channel id'),
  voiceChannelOverrides: z.record(z.string(), z.string()).default({}).describe('guildId -> voice channel id'),
  djRoleIds: z.array(z.string()).default([]),
  adminRoleIds: z.array(z.string()).default([]),
  requestPolicy: DiscordRequestPolicy.prefault({}),
  autoPostNowPlaying: z.boolean().default(true),
  updateInsteadOfSpam: z.boolean().default(true),
  prefixEnabled: z.boolean().default(true),
  prefix: z.string().min(1).max(3).default('!'),
  idleDisconnectSeconds: z.number().int().nonnegative().max(86400).default(300),
  updatedAt: IsoDateTime,
});
export type DiscordConfiguration = z.infer<typeof DiscordConfiguration>;

export const DiscordStatus = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  gateway: z.enum(['disconnected', 'connecting', 'connected', 'reconnecting', 'error', 'stopped']),
  voice: z.enum(['idle', 'connecting', 'connected', 'playing', 'paused', 'error']),
  commandsRegistered: z.boolean(),
  commandsRegisteredAt: IsoDateTime.nullable(),
  messageContentIntent: z.enum(['unknown', 'enabled', 'disabled']),
  latencyMs: z.number().nonnegative().nullable(),
  reconnects: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  uptimeSeconds: z.number().nonnegative(),
  currentGuildId: z.string().nullable(),
  currentVoiceChannelId: z.string().nullable(),
  currentTrackTitle: z.string().nullable(),
  lastError: z.string().nullable(),
  warnings: z.array(z.string()),
});
export type DiscordStatus = z.infer<typeof DiscordStatus>;

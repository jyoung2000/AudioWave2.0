/**
 * The hub's side of the Discord bot: configuration, templates, token storage and the command
 * bridge. The gateway connection itself lives in a separate worker (`discord/worker.ts`) so a
 * Discord outage, a bad token or a crashed websocket cannot take the hub's HTTP API down with it.
 *
 * The token is treated like every other secret: validated once against Discord's own API, sealed
 * with the installation key, never returned by any route and never logged. `tokenLast4` is the only
 * fragment that ever leaves this file, and only so an operator can tell which token is installed.
 *
 * Slash and prefix commands both run through `CommandService`; this class only renders the outcome
 * with the operator's templates. That is the mechanism behind the parity guarantee in
 * docs/DISCORD_BOT.md — there is no second implementation to drift.
 */
import type { DiscordConfiguration, DiscordStatus, DiscordTemplate, DiscordTemplateKey, DiscordTemplates } from '@now-playing/contracts';
import { DISCORD_LIMITS, DISCORD_TEMPLATE_KEYS, DiscordConfiguration as DiscordConfigurationSchema, DiscordTemplates as DiscordTemplatesSchema } from '@now-playing/contracts';
import { DEFAULT_DISCORD_TEMPLATES, DomainError, MUSIC_COMMANDS, renderTemplate, uuidv7, validateTemplate, validateTemplates, type CommandPolicy, type MusicCommand } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { RequestMeta } from '../auth/service.js';
import type { HubConfig } from '../config.js';
import type { Sealer } from '../crypto/seal.js';
import type { SettingsRepository } from '../db/repositories/settings.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { SafeHttpClient } from '../providers/http.js';
import type { CommandService, CommandOutcome } from '../group/command-service.js';
import { sleep } from '../util.js';

const CONFIG_KEY = 'discord.config';
const TEMPLATES_KEY = 'discord.templates';
const TOKEN_KEY = 'discord.token';
const WORKER_STATUS_KEY = 'discord.worker.status';
const CONTROL_KEY = 'discord.control';
const CONTROL_RESULT_KEY = 'discord.control.result';
const WORKER_STALE_MS = 20_000;
const CONTROL_TIMEOUT_MS = 30_000;
const CONTROL_POLL_MS = 250;

export type WorkerAction = 'start' | 'stop' | 'reconnect' | 'register-commands';
export interface ControlRequest {
  id: string;
  action: WorkerAction;
  requestedAt: string;
}
const DISCORD_API = 'https://discord.com/api/v10';
/** The bot needs to read and send in its designated channel and speak in voice. Nothing else. */
const REQUIRED_PERMISSIONS = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'EMBED_LINKS', 'READ_MESSAGE_HISTORY', 'CONNECT', 'SPEAK'] as const;
/** The same six permissions as Discord's bitfield. */
const PERMISSION_BITS = (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 16n) | (1n << 20n) | (1n << 21n);

export type GatewayState = DiscordStatus['gateway'];

/** Implemented by the worker; the hub holds a handle so admin actions can reach the gateway. */
export interface DiscordGateway {
  start(token: string, config: DiscordConfiguration): Promise<void>;
  stop(): Promise<void>;
  reconnect(): Promise<void>;
  registerCommands(): Promise<{ registered: number }>;
  status(): DiscordStatus;
}

export interface CommandTestInput {
  command: string;
  args: string;
  guildId: string;
  channelId: string;
  userId: string;
  roleIds: string[];
  transport: 'slash' | 'prefix';
}


export class DiscordService {
  private gateway: DiscordGateway | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly settings: SettingsRepository,
    private readonly commands: CommandService,
    private readonly sealer: Sealer,
    private readonly http: SafeHttpClient,
    private readonly config: HubConfig,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
  ) {}

  attachGateway(gateway: DiscordGateway): void {
    this.gateway = gateway;
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /* ------------------------------------------------------------- configuration */

  configuration(): DiscordConfiguration {
    const stored = this.settings.get<Partial<DiscordConfiguration>>(CONFIG_KEY);
    const parsed = DiscordConfigurationSchema.safeParse({
      id: stored?.id ?? uuidv7(this.clock.now()),
      updatedAt: stored?.updatedAt ?? this.nowIso(),
      ...stored,
      tokenSource: this.tokenSource(),
      tokenLast4: this.tokenLast4(),
    });
    if (parsed.success) return parsed.data;
    // A configuration that no longer validates (an older schema, a hand-edited row) falls back to
    // defaults rather than taking the admin GUI down.
    return DiscordConfigurationSchema.parse({ id: uuidv7(this.clock.now()), updatedAt: this.nowIso(), tokenSource: this.tokenSource(), tokenLast4: this.tokenLast4() });
  }

  updateConfiguration(patch: Partial<DiscordConfiguration>, actor: { id: string; displayName: string }, meta: RequestMeta): DiscordConfiguration {
    const current = this.configuration();
    const { id: _i, updatedAt: _u, tokenSource: _ts, tokenLast4: _tl, ...allowed } = patch;
    const next = DiscordConfigurationSchema.parse({ ...current, ...allowed, updatedAt: this.nowIso() });
    if (next.enabled && this.tokenSource() === 'none') {
      throw new DomainError('setup-required', 'Paste a bot token before turning the bot on.');
    }
    this.settings.set(CONFIG_KEY, next, this.nowIso());
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'discord.config', outcome: 'success', target: { kind: 'discord', id: next.id }, ip: meta.ip, correlationId: meta.correlationId, details: { enabled: String(next.enabled) } });
    return next;
  }

  /* -------------------------------------------------------------------- token */

  private tokenSource(): DiscordConfiguration['tokenSource'] {
    if (this.settings.get<string>(TOKEN_KEY)) return 'encrypted';
    if (this.config.discordToken) return 'env';
    return 'none';
  }

  private tokenLast4(): string | null {
    const meta = this.settings.get<{ last4: string }>(`${TOKEN_KEY}.meta`);
    if (meta?.last4) return meta.last4;
    return this.config.discordToken ? this.config.discordToken.slice(-4) : null;
  }

  /** Decrypt the token for the worker. Nothing else may call this, and it is never returned by a route. */
  token(): string | null {
    const sealed = this.settings.get<string>(TOKEN_KEY);
    if (sealed) {
      try {
        return this.sealer.open(sealed, 'discord:token');
      } catch {
        this.lastError = 'The stored Discord token could not be decrypted with this installation key. Set it again.';
        return null;
      }
    }
    return this.config.discordToken;
  }

  /**
   * Validate a token with Discord before storing it. A token that does not authenticate is
   * rejected outright — storing it would only produce a bot that silently never connects.
   */
  async setToken(token: string, actor: { id: string; displayName: string }, meta: RequestMeta): Promise<{ valid: boolean; tokenLast4: string; applicationId: string | null; botUsername: string | null; message: string }> {
    const trimmed = token.trim();
    let applicationId: string | null;
    let botUsername: string | null;
    try {
      const response = await this.http.request(`${DISCORD_API}/users/@me`, {
        allowedHosts: ['discord.com'],
        allowedSchemes: ['https:'],
        headers: { authorization: `Bot ${trimmed}` },
        timeoutMs: 10_000,
        maxBytes: 64 * 1024,
      });
      if (response.status === 401) {
        this.metrics.increment('discord.token_rejected');
        this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'discord.token.set', outcome: 'failure', target: { kind: 'discord', id: 'token' }, ip: meta.ip, correlationId: meta.correlationId });
        return { valid: false, tokenLast4: trimmed.slice(-4), applicationId: null, botUsername: null, message: 'Discord rejected that token. Copy it again from the Bot tab of your application (it is the bot token, not the client secret).' };
      }
      if (response.status !== 200) {
        return { valid: false, tokenLast4: trimmed.slice(-4), applicationId: null, botUsername: null, message: `Discord responded ${response.status} when checking the token. Try again in a moment.` };
      }
      const me = (await response.json()) as { id?: string; username?: string };
      applicationId = me.id ?? null;
      botUsername = me.username ?? null;
    } catch (err) {
      return { valid: false, tokenLast4: trimmed.slice(-4), applicationId: null, botUsername: null, message: `Could not reach Discord to validate the token: ${err instanceof Error ? err.message : String(err)}` };
    }

    this.settings.set(TOKEN_KEY, this.sealer.seal(trimmed, 'discord:token'), this.nowIso());
    this.settings.set(`${TOKEN_KEY}.meta`, { last4: trimmed.slice(-4) }, this.nowIso());
    const current = this.configuration();
    if (applicationId && !current.applicationId) this.settings.set(CONFIG_KEY, { ...current, applicationId, updatedAt: this.nowIso() }, this.nowIso());
    this.metrics.increment('discord.token_set');
    // The token itself never appears in the audit trail — only that one was installed.
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'discord.token.set', outcome: 'success', target: { kind: 'discord', id: 'token' }, ip: meta.ip, correlationId: meta.correlationId, details: { last4: trimmed.slice(-4), botUsername: botUsername ?? '' } });
    return { valid: true, tokenLast4: trimmed.slice(-4), applicationId, botUsername, message: `Token accepted for ${botUsername ?? 'the bot'}. Invite it with the link on this page, then start the bot.` };
  }

  clearToken(actor: { id: string; displayName: string }, meta: RequestMeta): void {
    this.settings.delete(TOKEN_KEY);
    this.settings.delete(`${TOKEN_KEY}.meta`);
    const current = this.configuration();
    if (current.enabled) this.settings.set(CONFIG_KEY, { ...current, enabled: false, updatedAt: this.nowIso() }, this.nowIso());
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'discord.token.clear', outcome: 'success', target: { kind: 'discord', id: 'token' }, ip: meta.ip, correlationId: meta.correlationId });
  }

  /** The minimal-permission invite URL, or an explanation of what is missing. */
  inviteUrl(): { url: string | null; permissions: string; scopes: string[]; reason: string | null } {
    const config = this.configuration();
    const scopes = ['bot', 'applications.commands'];
    if (!config.applicationId) {
      return { url: null, permissions: PERMISSION_BITS.toString(), scopes, reason: 'Save a bot token first. The invite link is made from it.' };
    }
    const url = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(config.applicationId)}&scope=${encodeURIComponent(scopes.join(' '))}&permissions=${PERMISSION_BITS.toString()}`;
    return { url, permissions: `${PERMISSION_BITS.toString()} (${REQUIRED_PERMISSIONS.join(', ')})`, scopes, reason: null };
  }

  /* ---------------------------------------------------------------- templates */

  templates(): DiscordTemplates {
    const stored = this.settings.get<DiscordTemplates>(TEMPLATES_KEY);
    if (!stored) return DEFAULT_DISCORD_TEMPLATES;
    const parsed = DiscordTemplatesSchema.safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_DISCORD_TEMPLATES;
  }

  saveTemplates(input: DiscordTemplates, actor: { id: string; displayName: string }, meta: RequestMeta): DiscordTemplates {
    const parsed = DiscordTemplatesSchema.parse(input);
    const results = validateTemplates(parsed);
    const errors = Object.entries(results).flatMap(([key, result]) => result.errors.map((e) => `${key}: ${e}`));
    if (errors.length) throw new DomainError('validation', `These templates cannot be saved: ${errors.join('; ')}`);
    this.settings.set(TEMPLATES_KEY, parsed, this.nowIso());
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'discord.templates', outcome: 'success', target: { kind: 'discord', id: 'templates' }, ip: meta.ip, correlationId: meta.correlationId });
    return parsed;
  }

  resetTemplates(): DiscordTemplates {
    this.settings.set(TEMPLATES_KEY, DEFAULT_DISCORD_TEMPLATES, this.nowIso());
    return DEFAULT_DISCORD_TEMPLATES;
  }

  /** Render one template with sample variables so the operator sees the result before saving. */
  previewTemplate(key: DiscordTemplateKey, template: DiscordTemplate, sample?: Record<string, string>): { content: string; embedTitle: string | null; embedDescription: string | null; warnings: string[]; errors: string[]; variablesUsed: string[] } {
    const validation = validateTemplate(template);
    const vars: Record<string, string> = {
      title: 'Blue Monday',
      artist: 'New Order',
      album: 'Power, Corruption & Lies',
      requester: 'alex',
      position: '3',
      group: 'Kitchen',
      duration: '7:29',
      elapsed: '2:14',
      remaining: '5:15',
      source: 'Hub library',
      url: 'https://example.invalid/track',
      count: '12',
      channel: '#music',
      reason: 'requested by a listener',
      user: 'alex',
      page: '1',
      pages: '2',
      ...sample,
    };
    const templates = this.templates();
    const rendered = renderTemplate(template, vars, { allowedRoleIds: templates.allowedMentionRoleIds, allowEveryone: templates.allowEveryone });
    void key;
    return {
      content: rendered.content,
      embedTitle: rendered.embedTitle,
      embedDescription: rendered.embedDescription,
      warnings: validation.warnings,
      errors: validation.errors,
      variablesUsed: validation.variablesUsed,
    };
  }

  /** Render a command outcome through the operator's templates. Used by the worker and by tests. */
  render(outcome: CommandOutcome): { content: string; embedTitle: string | null; embedDescription: string | null; ephemeral: boolean } {
    const templates = this.templates();
    const template = templates.templates[outcome.templateKey] ?? DEFAULT_DISCORD_TEMPLATES.templates[outcome.templateKey];
    const vars = Object.fromEntries(Object.entries(outcome.variables).map(([k, v]) => [k, v ?? '']));
    const rendered = renderTemplate(template, vars, { allowedRoleIds: templates.allowedMentionRoleIds, allowEveryone: templates.allowEveryone });
    return {
      content: rendered.content.slice(0, DISCORD_LIMITS.content),
      embedTitle: rendered.embedTitle,
      embedDescription: rendered.embedDescription,
      ephemeral: outcome.ephemeral || template.ephemeral,
    };
  }

  /**
   * The policy the command service authorises against, derived from the operator's configuration
   * and the roles Discord reports for the caller.
   */
  policyFor(guildId: string, _roleIds: readonly string[]): CommandPolicy {
    const config = this.configuration();
    return {
      designatedChannelId: config.designatedChannels[guildId] ?? null,
      djRoleIds: config.djRoleIds,
      adminRoleIds: config.adminRoleIds,
      guestsMayRequest: config.requestPolicy.guestsMayRequest,
      voteSkipThreshold: config.requestPolicy.voteSkipThreshold,
      cooldownSeconds: config.requestPolicy.cooldownSeconds,
      maxRequestsPerUser: config.requestPolicy.maxRequestsPerUser,
    };
  }

  /**
   * Run a command exactly as Discord would, without Discord. This is what makes slash/prefix
   * parity testable: the fixture tests call this twice with different transports and compare.
   */
  async runCommand(input: CommandTestInput): Promise<{ ok: boolean; templateKey: string; content: string; embedTitle: string | null; embedDescription: string | null; ephemeral: boolean }> {
    const config = this.configuration();
    if (config.guildAllowlist.length && !config.guildAllowlist.includes(input.guildId)) {
      throw new DomainError('forbidden', 'That server isn’t on this hub’s server allowlist.');
    }
    if (!config.defaultGroupId) throw new DomainError('setup-required', 'Choose a group in Sharing ▸ Discord bot ▸ Group it controls first.');
    const command = normalizeCommand(input.command);
    if (!command) throw new DomainError('validation', `${input.command} is not a command this bot understands`);

    const outcome = await this.commands.execute({
      command,
      args: input.args,
      groupId: config.defaultGroupId,
      actor: { kind: 'discord', id: input.userId, displayName: input.userId, roleIds: input.roleIds, isGuildAdmin: false, hasManageGuild: false, isRequesterOfCurrent: false },
      policy: this.policyFor(input.guildId, input.roleIds),
      transport: input.transport,
      channelId: input.channelId,
    });
    const rendered = this.render(outcome);
    this.metrics.increment(`discord.command.${command}`);
    return { ok: outcome.ok, templateKey: outcome.templateKey, ...rendered };
  }

  /* ------------------------------------------------------------------- actions */

  async act(action: WorkerAction | 'test', actor: { id: string; displayName: string }, meta: RequestMeta): Promise<DiscordStatus> {
    const config = this.configuration();
    const token = this.token();
    if ((action === 'start' || action === 'reconnect' || action === 'register-commands' || action === 'test') && !token) {
      throw new DomainError('setup-required', 'Paste a bot token in Sharing ▸ Discord bot first.');
    }
    if (action === 'test') {
      // "Test" checks the token without touching the running connection, so it needs no worker.
      const result = await this.setToken(token!, actor, meta);
      if (!result.valid) throw new DomainError('validation', result.message);
    } else if (this.gateway) {
      switch (action) {
        case 'start':
          await this.gateway.start(token!, config);
          break;
        case 'stop':
          await this.gateway.stop();
          break;
        case 'reconnect':
          await this.gateway.reconnect();
          break;
        case 'register-commands':
          await this.gateway.registerCommands();
          break;
      }
    } else {
      // The gateway lives in the worker container; the shared database is the only channel to it.
      if (action === 'start' && !config.enabled) throw new DomainError('setup-required', 'The bot is switched off. Choose Save and Start to turn it on.');
      await this.requestFromWorker(action);
    }
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: `discord.${action}`, outcome: 'success', target: { kind: 'discord', id: 'bot' }, ip: meta.ip, correlationId: meta.correlationId });
    return this.status();
  }

  status(): DiscordStatus {
    const config = this.configuration();
    const configured = this.tokenSource() !== 'none';
    const warnings: string[] = [];
    if (!configured) warnings.push('The bot has no token yet. Paste one in Bot token, then choose Save and Start.');
    if (configured && !config.enabled) warnings.push('The bot has a token but is switched off. Choose Save and Start to turn it on.');
    if (!config.defaultGroupId) warnings.push('No group is chosen in Group it controls, so commands have nothing to play to.');
    if (config.prefixEnabled) warnings.push('Prefix commands only work once Discord lets the bot read messages: turn on Message Content Intent for the bot in Discord’s Developer Portal. Slash commands work without it.');
    if (!config.guildAllowlist.length) warnings.push('The bot answers in every server it is invited to. To limit it, list server IDs in Server allowlist.');

    const live = this.gateway?.status() ?? this.workerHeartbeat();
    if (live) {
      return { ...live, enabled: config.enabled, configured, warnings: [...warnings, ...live.warnings], lastError: live.lastError ?? this.lastError };
    }
    return {
      enabled: config.enabled,
      configured,
      gateway: 'stopped',
      voice: 'idle',
      commandsRegistered: false,
      commandsRegisteredAt: null,
      messageContentIntent: 'unknown',
      latencyMs: null,
      reconnects: 0,
      errors: 0,
      uptimeSeconds: 0,
      currentGuildId: null,
      currentVoiceChannelId: null,
      currentTrackTitle: null,
      lastError: this.lastError,
      warnings: [...warnings, 'The hub’s Discord service isn’t running, so the bot can’t start. Install the hub again with the Discord option (see the Discord bot guide), then choose Save and Start.'],
    };
  }

  /* ------------------------------------------------- worker process channel */

  /** Called by the worker every few seconds so the hub's admin GUI can show the live connection. */
  publishWorkerStatus(status: DiscordStatus): void {
    this.settings.set(WORKER_STATUS_KEY, { status, at: this.clock.now() }, this.nowIso());
  }

  private workerHeartbeat(): DiscordStatus | null {
    const beat = this.settings.get<{ status: DiscordStatus; at: number }>(WORKER_STATUS_KEY);
    return beat && this.clock.now() - beat.at < WORKER_STALE_MS ? beat.status : null;
  }

  /** The newest admin request the worker has not handled yet. Requests older than the worker are ignored. */
  pendingControlRequest(handledId: string | null, notBefore: number): ControlRequest | null {
    const request = this.settings.get<ControlRequest>(CONTROL_KEY);
    if (!request || request.id === handledId || Date.parse(request.requestedAt) < notBefore) return null;
    return request;
  }

  completeControlRequest(id: string, error: string | null): void {
    this.settings.set(CONTROL_RESULT_KEY, { id, ok: error === null, error, at: this.nowIso() }, this.nowIso());
  }

  private async requestFromWorker(action: WorkerAction): Promise<void> {
    if (!this.workerHeartbeat()) {
      throw new DomainError('unavailable', 'The hub’s Discord service isn’t running, so the bot can’t start. Install the hub again with the Discord option (see the Discord bot guide), then choose Save and Start.');
    }
    const id = uuidv7(this.clock.now());
    this.settings.set(CONTROL_KEY, { id, action, requestedAt: this.nowIso() } satisfies ControlRequest, this.nowIso());
    const deadline = Date.now() + CONTROL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(CONTROL_POLL_MS);
      const result = this.settings.get<{ id: string; ok: boolean; error: string | null }>(CONTROL_RESULT_KEY);
      if (result?.id !== id) continue;
      if (!result.ok) throw new DomainError('unavailable', result.error ?? 'The hub’s Discord service couldn’t do that. Try again in a moment.');
      return;
    }
    throw new DomainError('unavailable', 'The hub’s Discord service hasn’t answered yet. It may still be working on it; the status will update in a moment.');
  }

  /** Command names accepted on both transports, for slash-command registration. */
  commandNames(): readonly MusicCommand[] {
    return MUSIC_COMMANDS;
  }

  templateKeys(): readonly DiscordTemplateKey[] {
    return DISCORD_TEMPLATE_KEYS;
  }
}

export function normalizeCommand(input: string): MusicCommand | null {
  const name = input.trim().toLowerCase().replace(/^[!/]/, '');
  const aliases: Record<string, MusicCommand> = { np: 'nowplaying', now: 'nowplaying', p: 'play', s: 'skip', q: 'queue', next: 'skip', unpause: 'resume', disconnect: 'leave' };
  if (aliases[name]) return aliases[name];
  return (MUSIC_COMMANDS as readonly string[]).includes(name) ? (name as MusicCommand) : null;
}

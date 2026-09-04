/**
 * The Discord gateway connection.
 *
 * Slash commands and prefix commands are two *parsers* in front of `CommandService`. Neither
 * contains any music logic: both build the same `CommandRequest` and render the same outcome
 * through the operator's templates. That is the mechanism behind the parity guarantee — there is no
 * second implementation that could drift, and the fixture tests exercise both paths through the
 * same service.
 *
 * Message Content is a privileged intent Discord only grants after an operator enables it. The bot
 * therefore starts *without* it, notices at runtime whether prefix commands can work, and reports
 * `messageContentIntent` honestly rather than silently ignoring `!play`.
 */
import { Client, Events, GatewayIntentBits, MessageFlags, Partials, REST, Routes, SlashCommandBuilder, type ChatInputCommandInteraction, type Message } from 'discord.js';
import type { DiscordConfiguration, DiscordStatus } from '@now-playing/contracts';
import type { Logger } from 'pino';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { DiscordGateway, DiscordService } from './service-interface.js';

/** Commands registered with Discord, and the free-text argument each accepts. */
const COMMAND_SPECS = [
  { name: 'play', description: 'Search for a track, or paste a link, and add it to the queue', arg: { name: 'query', description: 'Search terms or a link', required: true } },
  { name: 'nowplaying', description: 'Show what is playing now', arg: null },
  { name: 'queue', description: 'Show the queue', arg: { name: 'page', description: 'Page number', required: false } },
  { name: 'skip', description: 'Skip the current track (or vote to skip)', arg: { name: 'reason', description: 'Why', required: false } },
  { name: 'pause', description: 'Pause playback', arg: null },
  { name: 'resume', description: 'Resume playback', arg: null },
  { name: 'stop', description: 'Stop playback and clear the queue', arg: null },
  { name: 'shuffle', description: 'Shuffle the queue', arg: null },
  { name: 'clear', description: 'Clear the queue', arg: null },
  { name: 'join', description: 'Join a voice channel', arg: { name: 'channel', description: 'Channel name or id', required: false } },
  { name: 'leave', description: 'Leave the voice channel', arg: null },
  { name: 'settings', description: 'Where to change the bot settings', arg: null },
] as const;

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

export class DiscordGatewayClient implements DiscordGateway {
  private client: Client | null = null;
  private token: string | null = null;
  private config: DiscordConfiguration | null = null;
  private state: DiscordStatus['gateway'] = 'stopped';
  private voice: DiscordStatus['voice'] = 'idle';
  private messageContentIntent: DiscordStatus['messageContentIntent'] = 'unknown';
  private commandsRegisteredAt: string | null = null;
  private connectedAt: number | null = null;
  private reconnects = 0;
  private errors = 0;
  private lastError: string | null = null;
  private stopping = false;

  constructor(
    private readonly service: DiscordService,
    private readonly clock: Clock,
    private readonly metrics: MetricsRegistry,
    private readonly log: Logger,
  ) {}

  async start(token: string, config: DiscordConfiguration): Promise<void> {
    if (this.client) await this.stop();
    this.token = token;
    this.config = config;
    this.stopping = false;
    this.state = 'connecting';

    // Message Content is requested only when prefix commands are enabled: asking for a privileged
    // intent that is not needed makes Discord's verification harder for the operator for nothing.
    const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages];
    if (config.prefixEnabled) intents.push(GatewayIntentBits.MessageContent);

    const client = new Client({ intents, partials: [Partials.Channel] });
    this.client = client;

    client.once(Events.ClientReady, () => {
      this.state = 'connected';
      this.connectedAt = this.clock.now();
      this.lastError = null;
      this.log.info({ module: 'discord', user: client.user?.tag }, 'gateway connected');
      this.metrics.increment('discord.connected');
    });

    client.on(Events.Error, (err: Error) => {
      this.errors += 1;
      this.lastError = err.message;
      this.state = 'error';
      this.log.warn({ module: 'discord', err: err.message }, 'gateway error');
      this.metrics.increment('discord.errors');
    });

    client.on(Events.ShardDisconnect, () => {
      if (this.stopping) return;
      this.state = 'reconnecting';
      this.reconnects += 1;
      this.metrics.increment('discord.reconnects');
    });

    client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      void this.handleSlash(interaction);
    });

    client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message);
    });

    try {
      await client.login(token);
    } catch (err) {
      this.state = 'error';
      this.errors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      // A rejected token is the operator's problem to fix, not something to retry forever.
      if (this.lastError.toLowerCase().includes('token')) {
        this.log.error({ module: 'discord' }, 'Discord rejected the bot token; the bot will not reconnect until it is replaced');
        await this.stop();
        throw new Error('Discord rejected the bot token. Set a new one in Admin → Discord.', { cause: err });
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.state = 'stopped';
    this.voice = 'idle';
    this.connectedAt = null;
    const client = this.client;
    this.client = null;
    if (client) await client.destroy();
  }

  async reconnect(): Promise<void> {
    if (!this.token || !this.config) throw new Error('The bot is not configured');
    const token = this.token;
    const config = this.config;
    await this.stop();
    await this.start(token, config);
  }

  /**
   * Register slash commands. Guild-scoped when an allowlist exists (they appear immediately),
   * global otherwise (Discord takes up to an hour to propagate those, which the message says).
   */
  async registerCommands(): Promise<{ registered: number }> {
    if (!this.token || !this.config?.applicationId) throw new Error('Set the bot token and application id before registering commands');
    const body = COMMAND_SPECS.map((spec) => {
      const builder = new SlashCommandBuilder().setName(spec.name).setDescription(spec.description);
      if (spec.arg) builder.addStringOption((option) => option.setName(spec.arg!.name).setDescription(spec.arg!.description).setRequired(spec.arg!.required));
      return builder.toJSON();
    });
    const rest = new REST({ version: '10' }).setToken(this.token);
    const guilds = this.config.guildAllowlist;
    if (guilds.length) {
      for (const guildId of guilds) await rest.put(Routes.applicationGuildCommands(this.config.applicationId, guildId), { body });
    } else {
      await rest.put(Routes.applicationCommands(this.config.applicationId), { body });
    }
    this.commandsRegisteredAt = new Date(this.clock.now()).toISOString();
    this.metrics.increment('discord.commands_registered');
    return { registered: body.length };
  }

  status(): DiscordStatus {
    const config = this.config;
    const warnings: string[] = [];
    if (config?.prefixEnabled && this.messageContentIntent === 'disabled') {
      warnings.push('Prefix commands are enabled but Discord has not granted the Message Content intent, so only slash commands work. Enable it in the Developer Portal under Bot → Privileged Gateway Intents.');
    }
    return {
      enabled: config?.enabled ?? false,
      configured: this.token !== null,
      gateway: this.state,
      voice: this.voice,
      commandsRegistered: this.commandsRegisteredAt !== null,
      commandsRegisteredAt: this.commandsRegisteredAt,
      messageContentIntent: this.messageContentIntent,
      latencyMs: this.client?.ws.ping !== undefined && this.client.ws.ping >= 0 ? this.client.ws.ping : null,
      reconnects: this.reconnects,
      errors: this.errors,
      uptimeSeconds: this.connectedAt === null ? 0 : Math.max(0, Math.round((this.clock.now() - this.connectedAt) / 1000)),
      currentGuildId: null,
      currentVoiceChannelId: null,
      currentTrackTitle: null,
      lastError: this.lastError,
      warnings,
    };
  }

  /* ------------------------------------------------------------ slash path */

  private async handleSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This bot works in a server, not in a direct message.', flags: MessageFlags.Ephemeral });
      return;
    }
    // A search can outlast Discord's three-second reply window, so acknowledge first.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const args = interaction.options.data.map((o) => String(o.value ?? '')).join(' ');
    const roleIds = await this.roleIdsOf(interaction.guildId, interaction.user.id);
    try {
      const result = await this.service.runCommand({
        command: interaction.commandName,
        args,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        roleIds,
        transport: 'slash',
      });
      await interaction.editReply(this.payloadFor(result));
    } catch (err) {
      await interaction.editReply({ content: this.errorText(err) });
    }
  }

  /* ----------------------------------------------------------- prefix path */

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || !message.guildId) return;
    const config = this.config;
    if (!config?.prefixEnabled) return;

    // An empty content field on a guild message is how a missing Message Content intent shows up.
    if (message.content === '' ) {
      if (this.messageContentIntent === 'unknown') {
        this.messageContentIntent = 'disabled';
        this.log.warn({ module: 'discord' }, 'guild messages arrive empty: the Message Content intent is not granted, so prefix commands cannot work');
      }
      return;
    }
    this.messageContentIntent = 'enabled';
    if (!message.content.startsWith(config.prefix)) return;

    const [rawCommand, ...rest] = message.content.slice(config.prefix.length).trim().split(/\s+/);
    if (!rawCommand) return;
    const roleIds = message.member?.roles.cache.map((r) => r.id) ?? [];
    try {
      const result = await this.service.runCommand({
        command: rawCommand,
        args: rest.join(' '),
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        roleIds,
        transport: 'prefix',
      });
      // Discord has no ephemeral replies for normal messages; an "ephemeral" outcome is sent as a
      // reply to the author rather than an announcement, which is the closest honest equivalent.
      await message.reply(this.payloadFor(result));
    } catch (err) {
      await message.reply({ content: this.errorText(err) });
    }
  }

  private payloadFor(result: { content: string; embedTitle: string | null; embedDescription: string | null }): { content: string; embeds?: Array<{ title?: string; description?: string }> } {
    const embeds = result.embedTitle || result.embedDescription ? [{ ...(result.embedTitle ? { title: result.embedTitle } : {}), ...(result.embedDescription ? { description: result.embedDescription } : {}) }] : undefined;
    return { content: result.content || (embeds ? '' : '…'), ...(embeds ? { embeds } : {}) };
  }

  private errorText(err: unknown): string {
    this.metrics.increment('discord.command_failed');
    const message = err instanceof Error ? err.message : String(err);
    this.log.warn({ module: 'discord', err: message }, 'command failed');
    // The user sees the reason, not a stack trace or an internal identifier.
    return message.slice(0, 400);
  }

  private async roleIdsOf(guildId: string, userId: string): Promise<string[]> {
    try {
      const guild = await this.client?.guilds.fetch(guildId);
      const member = await guild?.members.fetch(userId);
      return member?.roles.cache.map((r) => r.id) ?? [];
    } catch {
      // A member the bot cannot read is treated as having no roles, which is the safe direction:
      // fewer permissions, not more.
      return [];
    }
  }
}

export { RECONNECT_BASE_MS, RECONNECT_MAX_MS, COMMAND_SPECS };

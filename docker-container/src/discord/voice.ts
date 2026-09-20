/**
 * The bot's voice output.
 *
 * The hub's group timeline is the authority: `startAt`, `status` and `currentItemId` say what should
 * be heard and from where. This player only follows it — it never keeps a queue of its own — so a
 * track skipped from a phone stops in Discord too, and a track the bot finishes advances the same
 * shared queue everyone sees.
 *
 * Audio is decoded and encoded by FFmpeg straight to Ogg/Opus, which @discordjs/voice can send
 * without re-encoding. When the installed FFmpeg lacks libopus it falls back to raw PCM, which the
 * library encodes with opusscript.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioResource,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from '@discordjs/voice';
import type { DiscordStatus, GroupPlaybackState, Queue, QueueItem } from '@now-playing/contracts';
import type { Logger } from 'pino';
import type { FfmpegInfo } from '../deps.js';

export type VoiceInput = { kind: 'file'; path: string } | { kind: 'url'; url: string };
export type ResolvedInput = { ok: true; input: VoiceInput } | { ok: false; reason: string };

/** What the player needs from the hub. The worker implements it over the shared services. */
export interface VoiceHost {
  groupId(): string | null;
  state(groupId: string): { queue: Queue; playback: GroupPlaybackState };
  resolve(item: QueueItem): Promise<ResolvedInput>;
  /** Advance the shared queue past `itemId`, only if it is still the current item. */
  advance(groupId: string, itemId: string, reason: 'ended' | 'error' | 'unavailable'): void;
  ffmpeg(): Promise<FfmpegInfo>;
  now(): number;
  idleDisconnectMs(): number;
}

interface ActiveTrack {
  itemId: string;
  sourceRevision: number;
  title: string;
  offsetMs: number;
  startedAtMs: number;
  process: ChildProcessByStdio<null, Readable, Readable> | null;
  resource: AudioResource | null;
  stopping: boolean;
  /** Set once this track has been reported finished or failed, so it is never reported twice. */
  settled: boolean;
  stderr: string;
}

const READY_TIMEOUT_MS = 20_000;
const RECONNECT_WINDOW_MS = 5_000;
/** Paused audio closer than this to the timeline is resumed rather than restarted. */
const RESUME_TOLERANCE_MS = 1_500;
/** Playing audio further than this from the timeline is restarted at the right place (a seek). */
const DRIFT_RESTART_MS = 3_000;
const START_EARLY_MS = 150;

export class VoicePlayer {
  private connection: VoiceConnection | null = null;
  private readonly player: AudioPlayer;
  private track: ActiveTrack | null = null;
  private phase: DiscordStatus['voice'] = 'idle';
  private guildId: string | null = null;
  private channelId: string | null = null;
  private idleSince: number | null = null;
  private lastError: string | null = null;
  private syncing = false;
  private resyncRequested = false;
  private wake: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: VoiceHost,
    private readonly log: Logger,
  ) {
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.player.on('error', (err) => {
      this.lastError = err.message;
      this.log.warn({ module: 'discord-voice', err: err.message }, 'audio player error');
    });
    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) void this.onTrackStreamEnded();
    });
  }

  /* ------------------------------------------------------------ connection */

  get connectedChannelId(): string | null {
    return this.connection ? this.channelId : null;
  }

  async join(guildId: string, channelId: string, adapterCreator: DiscordGatewayAdapterCreator): Promise<void> {
    const existing = this.connection;
    if (existing && this.guildId === guildId && this.channelId === channelId && existing.state.status !== VoiceConnectionStatus.Destroyed) return;
    if (existing) this.destroyConnection();

    this.phase = 'connecting';
    this.guildId = guildId;
    this.channelId = channelId;
    const connection = joinVoiceChannel({ guildId, channelId, adapterCreator, selfDeaf: true });
    this.connection = connection;

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // A moved or briefly dropped connection recovers by itself; a kick or a deleted channel does not.
      void Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_WINDOW_MS), entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_WINDOW_MS)]).catch(() => {
        if (this.connection === connection) {
          this.log.info({ module: 'discord-voice', guildId }, 'voice connection lost; leaving');
          this.leave();
        }
      });
    });
    connection.on('error', (err) => {
      this.lastError = err.message;
      this.log.warn({ module: 'discord-voice', err: err.message }, 'voice connection error');
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } catch (err) {
      if (this.connection === connection) this.destroyConnection();
      this.phase = 'error';
      this.lastError = 'Could not connect to the voice channel. Check that the bot has Connect and Speak there, and that outbound UDP is not blocked.';
      throw new Error(this.lastError, { cause: err });
    }
    connection.subscribe(this.player);
    this.phase = 'connected';
    this.lastError = null;
    this.idleSince = this.host.now();
    this.log.info({ module: 'discord-voice', guildId, channelId }, 'joined voice channel');
    await this.sync();
  }

  leave(): void {
    this.stopTrack();
    this.destroyConnection();
    this.phase = 'idle';
  }

  private destroyConnection(): void {
    const connection = this.connection;
    this.connection = null;
    this.guildId = null;
    this.channelId = null;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }

  /* ------------------------------------------------------------------ sync */

  /** Bring the audio in line with the hub timeline. Safe to call as often as wanted. */
  async sync(): Promise<void> {
    if (this.syncing) {
      this.resyncRequested = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.resyncRequested = false;
        await this.syncOnce();
      } while (this.resyncRequested);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.warn({ module: 'discord-voice', err: this.lastError }, 'voice sync failed');
    } finally {
      this.syncing = false;
    }
  }

  private async syncOnce(): Promise<void> {
    const groupId = this.host.groupId();
    if (!this.connection || !groupId) {
      this.stopTrack();
      return;
    }
    const now = this.host.now();
    const { queue, playback } = this.host.state(groupId);
    const item = playback.currentItemId ? (queue.items.find((i) => i.id === playback.currentItemId) ?? null) : null;

    if (!item || playback.status === 'idle' || playback.status === 'ended') {
      this.stopTrack();
      this.checkIdle(now);
      return;
    }

    if (playback.status === 'paused') {
      if (this.track?.itemId === item.id && this.track.sourceRevision === playback.sourceRevision && this.player.state.status === AudioPlayerStatus.Playing) this.player.pause(true);
      else if (this.track?.itemId !== item.id) this.stopTrack();
      this.phase = 'paused';
      this.checkIdle(now);
      return;
    }

    // preparing | playing
    this.idleSince = null;
    const startAt = playback.startAt ? Date.parse(playback.startAt) : now;
    if (now < startAt - START_EARLY_MS) {
      if (this.track && this.track.itemId !== item.id) this.stopTrack();
      this.wakeAt(startAt - START_EARLY_MS);
      return;
    }
    const expected = Math.max(0, now - startAt);

    const t = this.track;
    if (t && t.itemId === item.id && t.sourceRevision === playback.sourceRevision) {
      if (t.settled) return;
      const status = this.player.state.status;
      const drift = Math.abs(this.positionMs(t) - expected);
      if (status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused) {
        if (drift <= RESUME_TOLERANCE_MS) {
          this.player.unpause();
          this.phase = 'playing';
          return;
        }
      } else if (drift <= DRIFT_RESTART_MS || now - t.startedAtMs < DRIFT_RESTART_MS) {
        return;
      }
      // Resumed or seeked too far from where the audio is: start again at the timeline position.
    }
    await this.startTrack(groupId, item, playback.sourceRevision, expected);
  }

  private positionMs(t: ActiveTrack): number {
    return t.offsetMs + (t.resource?.playbackDuration ?? 0);
  }

  private wakeAt(at: number): void {
    if (this.wake) clearTimeout(this.wake);
    this.wake = setTimeout(() => {
      this.wake = null;
      void this.sync();
    }, Math.max(0, at - this.host.now()));
    this.wake.unref?.();
  }

  private checkIdle(now: number): void {
    const limit = this.host.idleDisconnectMs();
    this.idleSince ??= now;
    if (limit > 0 && this.connection && now - this.idleSince >= limit) {
      this.log.info({ module: 'discord-voice' }, 'idle; leaving the voice channel');
      this.leave();
    }
  }

  /* ---------------------------------------------------------------- tracks */

  private async startTrack(groupId: string, item: QueueItem, sourceRevision: number, offsetMs: number): Promise<void> {
    this.stopTrack();
    const track: ActiveTrack = { itemId: item.id, sourceRevision, title: item.track.title, offsetMs, startedAtMs: this.host.now(), process: null, resource: null, stopping: false, settled: false, stderr: '' };
    this.track = track;

    const resolved = await this.host.resolve(item);
    if (this.track !== track) return;
    if (!resolved.ok) {
      track.settled = true;
      this.lastError = `Skipped "${item.track.title}": ${resolved.reason}`;
      this.log.info({ module: 'discord-voice', itemId: item.id, reason: resolved.reason }, 'track cannot be played in voice');
      this.host.advance(groupId, item.id, 'unavailable');
      return;
    }

    const ffmpeg = await this.host.ffmpeg();
    if (this.track !== track) return;
    if (!ffmpeg.available || !ffmpeg.path) {
      track.settled = true;
      this.phase = 'error';
      this.lastError = 'FFmpeg is not installed, so the bot cannot decode audio. Install it or set NP_FFMPEG_PATH.';
      return;
    }

    const opus = ffmpeg.encoders.includes('libopus');
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (resolved.input.kind === 'url') args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    if (offsetMs > 250) args.push('-ss', (offsetMs / 1000).toFixed(3));
    // `file:` stops FFmpeg from reading a colon in a file name as a protocol prefix.
    args.push('-i', resolved.input.kind === 'file' ? `file:${resolved.input.path}` : resolved.input.url, '-vn', '-map', '0:a:0', '-ar', '48000', '-ac', '2');
    if (opus) args.push('-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg', 'pipe:1');
    else args.push('-f', 's16le', 'pipe:1');

    const child = spawn(ffmpeg.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    track.process = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      track.stderr = (track.stderr + chunk).slice(-2000);
    });
    child.on('error', (err) => {
      track.stderr = err.message;
    });
    child.stdout.on('error', () => undefined);

    const resource = createAudioResource(child.stdout, { inputType: opus ? StreamType.OggOpus : StreamType.Raw });
    track.resource = resource;
    this.player.play(resource);
    this.player.unpause();
    this.phase = 'playing';
    this.lastError = null;
    this.log.info({ module: 'discord-voice', itemId: item.id, title: item.track.title, offsetMs: Math.round(offsetMs), codec: opus ? 'opus' : 'pcm' }, 'playing');
  }

  private stopTrack(): void {
    const t = this.track;
    this.track = null;
    if (!t) return;
    t.stopping = true;
    if (t.process && t.process.exitCode === null) t.process.kill('SIGKILL');
    if (this.player.state.status !== AudioPlayerStatus.Idle) this.player.stop(true);
    if (this.phase === 'playing' || this.phase === 'paused') this.phase = this.connection ? 'connected' : 'idle';
  }

  /** The audio stream ran out: either the track finished, or FFmpeg could not read it. */
  private async onTrackStreamEnded(): Promise<void> {
    const t = this.track;
    if (!t || t.stopping || t.settled) return;
    const exitCode = await waitForExit(t.process);
    if (this.track !== t || t.stopping || t.settled) return;
    t.settled = true;
    const groupId = this.host.groupId();
    this.phase = this.connection ? 'connected' : 'idle';
    if (!groupId) return;
    const failed = exitCode !== 0 || (t.resource?.playbackDuration ?? 0) === 0;
    if (failed) {
      this.lastError = `Could not play "${t.title}": ${t.stderr.trim().split('\n').pop() || `FFmpeg exited with ${exitCode}`}`;
      this.log.warn({ module: 'discord-voice', itemId: t.itemId, exitCode, stderr: t.stderr.slice(-500) }, 'track failed');
    }
    this.host.advance(groupId, t.itemId, failed ? 'error' : 'ended');
    await this.sync();
  }

  /* ---------------------------------------------------------------- status */

  status(): Pick<DiscordStatus, 'voice' | 'currentGuildId' | 'currentVoiceChannelId' | 'currentTrackTitle'> & { lastError: string | null } {
    return {
      voice: this.phase,
      currentGuildId: this.connection ? this.guildId : null,
      currentVoiceChannelId: this.connection ? this.channelId : null,
      currentTrackTitle: this.track && !this.track.settled ? this.track.title : null,
      lastError: this.lastError,
    };
  }

  destroy(): void {
    if (this.wake) clearTimeout(this.wake);
    this.leave();
    this.player.stop(true);
  }
}

function waitForExit(child: ActiveTrack['process']): Promise<number | null> {
  if (!child) return Promise.resolve(null);
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode), 5_000);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

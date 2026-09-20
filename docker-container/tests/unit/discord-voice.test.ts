/**
 * The voice player follows the hub timeline. Discord's voice stack and FFmpeg are replaced with
 * fakes, so these tests check the decisions — what to play, from where, when to pause, when to
 * advance the shared queue — not the network.
 */
import type { EventEmitter } from 'node:events';
import type { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { GroupPlaybackState, Queue, QueueItem } from '@now-playing/contracts';
import type { VoiceHost } from '../../src/discord/voice.js';

const fakes = vi.hoisted(() => ({ players: [] as unknown[], spawns: [] as unknown[] }));

vi.mock('@discordjs/voice', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakePlayer extends Emitter {
    state: { status: string } = { status: 'idle' };
    played: unknown[] = [];
    set(status: string): void {
      const old = this.state;
      this.state = { status };
      this.emit('stateChange', old, this.state);
    }
    play(resource: unknown): void {
      this.played.push(resource);
      this.set('playing');
    }
    pause(): boolean {
      this.set('paused');
      return true;
    }
    unpause(): boolean {
      if (this.state.status === 'paused') this.set('playing');
      return true;
    }
    stop(): boolean {
      if (this.state.status !== 'idle') this.set('idle');
      return true;
    }
  }
  return {
    AudioPlayerStatus: { Idle: 'idle', Buffering: 'buffering', Paused: 'paused', Playing: 'playing', AutoPaused: 'autopaused' },
    VoiceConnectionStatus: { Signalling: 'signalling', Connecting: 'connecting', Ready: 'ready', Disconnected: 'disconnected', Destroyed: 'destroyed' },
    NoSubscriberBehavior: { Pause: 'pause' },
    StreamType: { OggOpus: 'ogg/opus', Raw: 'raw' },
    createAudioPlayer: () => {
      const player = new FakePlayer();
      fakes.players.push(player);
      return player;
    },
    createAudioResource: (stream: unknown, options: unknown) => ({ stream, options, playbackDuration: 0 }),
    entersState: async () => undefined,
    joinVoiceChannel: (joinConfig: unknown) => {
      const connection = Object.assign(new Emitter(), { state: { status: 'ready' }, joinConfig, subscribe: () => undefined });
      return Object.assign(connection, {
        destroy: () => {
          connection.state = { status: 'destroyed' };
        },
      });
    },
  };
});

vi.mock('node:child_process', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  const { PassThrough: Pipe } = await import('node:stream');
  return {
    spawn: (command: string, args: string[]) => {
      const child = Object.assign(new Emitter(), { command, args, stdout: new Pipe(), stderr: new Pipe(), exitCode: null as number | null, signalCode: null as string | null });
      Object.assign(child, {
        kill: () => {
          child.signalCode = 'SIGKILL';
          child.emit('close', null);
          return true;
        },
      });
      fakes.spawns.push(child);
      return child;
    },
  };
});

const { VoicePlayer } = await import('../../src/discord/voice.js');

interface FakePlayer extends EventEmitter {
  state: { status: string };
  played: Array<{ playbackDuration: number }>;
  set(status: string): void;
}
interface FakeChild extends EventEmitter {
  args: string[];
  stdout: PassThrough;
  exitCode: number | null;
  signalCode: string | null;
}

const GROUP = '0192b1f0-0000-7000-8000-00000000aaaa';
const NOW = Date.parse('2026-09-16T12:00:00.000Z');

function item(n: number): QueueItem {
  return {
    id: `0192b1f0-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`,
    track: { trackId: `0192b1f0-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`, title: `Track ${n}`, artistName: 'Artist', albumName: null, durationMs: 180_000, artworkId: null, identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} }, locators: [], provider: 'hub', genre: null, year: null },
    addedAt: new Date(NOW).toISOString(),
    addedBy: null,
    requestId: null,
    availability: 'unknown',
    unavailableReason: null,
    votesToSkip: [],
  };
}

function harness(options: { idleMs?: number } = {}) {
  let now = NOW;
  const items = [item(1), item(2)];
  const queue = { items, currentIndex: 0, revision: 3 } as unknown as Queue;
  let playback = { status: 'playing', currentItemId: items[0]!.id, startAt: new Date(NOW - 30_000).toISOString(), positionMs: 0, sourceRevision: 1 } as unknown as GroupPlaybackState;
  const advanced: Array<{ itemId: string; reason: string }> = [];
  const unplayable = new Set<string>();
  const host: VoiceHost = {
    groupId: () => GROUP,
    state: () => ({ queue, playback }),
    resolve: async (i) => (unplayable.has(i.id) ? { ok: false, reason: 'not on the hub' } : { ok: true, input: { kind: 'file', path: `/data/library/${i.track.title}.flac` } }),
    advance: (_groupId, itemId, reason) => {
      advanced.push({ itemId, reason });
    },
    ffmpeg: async () => ({ available: true, path: '/usr/bin/ffmpeg', version: '7.1', encoders: ['libopus'] }),
    now: () => now,
    idleDisconnectMs: () => options.idleMs ?? 0,
  };
  const voice = new VoicePlayer(host, pino({ level: 'silent' }));
  const player = fakes.players.at(-1) as FakePlayer;
  return {
    voice,
    player,
    items,
    advanced,
    unplayable,
    setPlayback: (patch: Partial<GroupPlaybackState>) => {
      playback = { ...playback, ...patch };
    },
    setNow: (ms: number) => {
      now = ms;
    },
    join: () => voice.join('111', '222', (() => ({ sendPayload: () => true, destroy: () => undefined })) as never),
  };
}

const lastSpawn = (): FakeChild => fakes.spawns.at(-1) as FakeChild;

beforeEach(() => {
  fakes.players.length = 0;
  fakes.spawns.length = 0;
});

describe('discord voice player', () => {
  it('joins and plays the current item from where the group timeline is', async () => {
    const h = harness();
    await h.join();
    expect(fakes.spawns).toHaveLength(1);
    expect(lastSpawn().args).toEqual(expect.arrayContaining(['-ss', '30.000', '-i', 'file:/data/library/Track 1.flac', '-c:a', 'libopus', '-f', 'ogg']));
    expect(h.player.state.status).toBe('playing');
    expect(h.voice.status()).toMatchObject({ voice: 'playing', currentVoiceChannelId: '222', currentTrackTitle: 'Track 1' });
  });

  it('waits for a start instant in the future instead of playing early', async () => {
    const h = harness();
    h.setPlayback({ status: 'preparing', startAt: new Date(NOW + 1500).toISOString() });
    await h.join();
    expect(fakes.spawns).toHaveLength(0);
    h.setNow(NOW + 1500);
    await h.voice.sync();
    expect(fakes.spawns).toHaveLength(1);
    expect(lastSpawn().args).not.toContain('-ss');
  });

  it('pauses in place and resumes without restarting the stream', async () => {
    const h = harness();
    await h.join();
    h.player.played[0]!.playbackDuration = 10_000;
    h.setNow(NOW + 10_000);
    h.setPlayback({ status: 'paused', positionMs: 40_000 });
    await h.voice.sync();
    expect(h.player.state.status).toBe('paused');

    h.setNow(NOW + 60_000);
    h.setPlayback({ status: 'playing', startAt: new Date(NOW + 60_000 - 40_000).toISOString() });
    await h.voice.sync();
    expect(h.player.state.status).toBe('playing');
    expect(fakes.spawns).toHaveLength(1);
  });

  it('restarts at the new position after a seek', async () => {
    const h = harness();
    await h.join();
    h.setNow(NOW + 10_000);
    h.player.played[0]!.playbackDuration = 10_000;
    h.setPlayback({ startAt: new Date(NOW + 10_000 - 120_000).toISOString() });
    await h.voice.sync();
    expect(fakes.spawns).toHaveLength(2);
    expect(lastSpawn().args).toEqual(expect.arrayContaining(['-ss', '120.000']));
  });

  it('advances the shared queue when the track finishes', async () => {
    const h = harness();
    await h.join();
    h.player.played[0]!.playbackDuration = 150_000;
    lastSpawn().exitCode = 0;
    h.player.set('idle');
    await vi.waitFor(() => expect(h.advanced).toEqual([{ itemId: h.items[0]!.id, reason: 'ended' }]));
  });

  it('reports a decode failure as an error, not a finished track', async () => {
    const h = harness();
    await h.join();
    lastSpawn().exitCode = 1;
    h.player.set('idle');
    await vi.waitFor(() => expect(h.advanced).toEqual([{ itemId: h.items[0]!.id, reason: 'error' }]));
  });

  it('skips a track it cannot play instead of going silent', async () => {
    const h = harness();
    h.unplayable.add(h.items[0]!.id);
    await h.join();
    expect(fakes.spawns).toHaveLength(0);
    expect(h.advanced).toEqual([{ itemId: h.items[0]!.id, reason: 'unavailable' }]);
    expect(h.voice.status().lastError).toContain('not on the hub');
  });

  it('follows a track change made elsewhere and stops when the group stops', async () => {
    const h = harness();
    await h.join();
    const first = lastSpawn();
    h.setPlayback({ currentItemId: h.items[1]!.id, startAt: new Date(NOW).toISOString(), sourceRevision: 2 });
    await h.voice.sync();
    expect(first.signalCode).toBe('SIGKILL');
    expect(lastSpawn().args).toContain('file:/data/library/Track 2.flac');

    h.setPlayback({ status: 'idle', currentItemId: null, startAt: null });
    await h.voice.sync();
    expect(lastSpawn().signalCode).toBe('SIGKILL');
    expect(h.player.state.status).toBe('idle');
    // Stopping deliberately is never mistaken for a track that finished.
    expect(h.advanced).toEqual([]);
  });

  it('leaves the channel once it has been idle for the configured time', async () => {
    const h = harness({ idleMs: 30_000 });
    h.setPlayback({ status: 'idle', currentItemId: null, startAt: null });
    await h.join();
    h.setNow(NOW + 10_000);
    await h.voice.sync();
    expect(h.voice.connectedChannelId).toBe('222');
    h.setNow(NOW + 31_000);
    await h.voice.sync();
    expect(h.voice.connectedChannelId).toBeNull();
    expect(h.voice.status().voice).toBe('idle');
  });
});

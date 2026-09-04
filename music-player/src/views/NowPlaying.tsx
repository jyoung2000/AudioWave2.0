/**
 * Now playing: the song, its artwork, and an honest account of how it is being processed.
 *
 * The signal-chain panel is not decoration. When someone asks "is the equaliser actually doing
 * anything to this?", the answer here is derived from the engine's own reported state — including
 * the cases where it is not, and why.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, EmptyState, IconButton, Panel, PanelSection, KeyValueList, StatusDot } from '@now-playing/aqua-ui';
import { formatTime, useAppState, usePlayer } from '../state/context.js';
import { ShareSheet } from '../components/ShareSheet.js';
import { AddToPlaylistSheet } from '../components/AddToPlaylistSheet.js';

export function NowPlayingView() {
  const { store, hubStatus } = usePlayer();
  const state = useAppState();
  const [artwork, setArtwork] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const entry = state.queue[state.queueIndex] ?? null;
  const track = entry ? state.library.tracks.find((t) => t.id === entry.track.trackId) ?? null : null;

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    void store.artworkUrl(entry?.track.artworkId ?? null).then((next) => {
      if (cancelled) {
        if (next) URL.revokeObjectURL(next);
        return;
      }
      url = next;
      setArtwork(next);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [entry?.track.artworkId, store]);

  // A spectrum drawn from the analyser. Paused playback stops the loop rather than burning a frame
  // budget on a still image.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || state.playback.status !== 'playing') return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const data = new Uint8Array(new ArrayBuffer(1024));
    let frame = 0;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const draw = (): void => {
      store.playback.analyser(data, 'frequency');
      const { width, height } = canvas;
      context.clearRect(0, 0, width, height);
      const bars = 64;
      const step = Math.floor(data.length / bars);
      for (let i = 0; i < bars; i += 1) {
        let sum = 0;
        for (let j = 0; j < step; j += 1) sum += data[i * step + j] ?? 0;
        const value = sum / step / 255;
        const barHeight = Math.max(1, value * height);
        context.fillStyle = `hsl(${205 + value * 30} 60% ${40 + value * 25}%)`;
        context.fillRect((i / bars) * width, height - barHeight, width / bars - 1, barHeight);
      }
      // Reduced motion still shows a level, just not sixty times a second.
      frame = requestAnimationFrame(reduced ? () => setTimeout(draw, 250) : draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [state.playback.status, store]);

  if (!entry) {
    return (
      <Panel>
        <EmptyState title="Nothing playing" text="Choose a song from your library." />
      </Panel>
    );
  }

  const engine = state.playback.engine;
  const latency = store.playback.latency();

  return (
    <>
      <Panel>
        <div className="player-now">
          <div className="player-now__art">
            {artwork ? <img src={artwork} alt="" /> : <div className="player-now__art-placeholder" aria-hidden="true" />}
          </div>
          <div className="player-now__meta">
            <h2>{entry.track.title}</h2>
            <p className="player-now__artist">{entry.track.artistName}</p>
            {entry.track.albumName ? <p className="player-hint">{entry.track.albumName}{entry.track.year ? ` · ${entry.track.year}` : ''}</p> : null}
            <p className="player-hint">Playing from {entry.context.name ?? 'your library'}</p>
            <div className="player-now__actions">
              <IconButton icon="star" label={track?.liked ? 'Remove from favourites' : 'Add to favourites'} pressed={track?.liked ?? false} disabled={!track} onClick={() => track && void store.toggleLike(track.id)} />
              <Button size="small" icon="add" onClick={() => setPlaylistOpen(true)} ellipsis>
                Add to playlist
              </Button>
              <Button size="small" icon="share" onClick={() => setShareOpen(true)} ellipsis disabled={!hubStatus.connected} title={hubStatus.connected ? undefined : 'Sharing needs a paired hub'}>
                Share
              </Button>
            </div>
            <canvas ref={canvasRef} width={480} height={72} className="player-spectrum" aria-hidden="true" />
          </div>
        </div>
      </Panel>

      <Panel title="How this is being played">
        <PanelSection>
          <KeyValueList
            items={[
              { key: 'Position', value: `${formatTime(state.playback.positionMs)} of ${formatTime(state.playback.durationMs)}` },
              { key: 'Source', value: entry.track.locators.some((l) => l.kind === 'browser-handle') ? 'A file on this device' : entry.track.locators.some((l) => l.kind === 'hub-blob') ? 'Streamed from your hub' : 'Unknown' },
              {
                key: 'Equaliser',
                value: state.playback.dspUnavailableReason ? (
                  <span className="player-inline-status">
                    <StatusDot kind="warning" label="Not applied" /> {state.playback.dspUnavailableReason}
                  </span>
                ) : (
                  `${state.resolvedEq.presetName} — ${state.resolvedEq.explanation}`
                ),
              },
              { key: 'Limiter', value: engine?.limiterEnabled ? 'On — prevents clipping when the equaliser adds gain' : 'Off' },
              { key: 'Headroom', value: engine ? `${engine.headroomTrimDb.toFixed(1)} dB trim applied to keep the boosted signal below full scale` : '—' },
              {
                key: 'Retuning',
                value:
                  state.retune.mode === 'off'
                    ? 'Off — playing at the original pitch'
                    : `${state.retune.referenceHz} Hz reference${state.retuneNote ? ` — ${state.retuneNote}` : engine?.retune.applied === 'worklet' ? ' — pitch shifted, tempo unchanged' : ''}`,
              },
              { key: 'Added latency', value: latency ? `${latency.totalMs.toFixed(1)} ms` : '—' },
              ...(state.playback.error ? [{ key: 'Problem', value: state.playback.error }] : []),
            ]}
          />
        </PanelSection>
      </Panel>

      <ShareSheet open={shareOpen} onClose={() => setShareOpen(false)} kind="track" track={entry.track} />
      <AddToPlaylistSheet open={playlistOpen} onClose={() => setPlaylistOpen(false)} tracks={[entry.track]} />
    </>
  );
}

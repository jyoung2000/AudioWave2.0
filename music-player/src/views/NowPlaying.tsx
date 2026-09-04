/**
 * Now playing: an honest account of how the song above is being processed.
 *
 * The record, its artwork and the transport moved to the hero, which is on every screen — so this
 * section is no longer "where the song is". It is where the *answer* is, for the question a person
 * asks when they wonder whether any of this is doing anything: which preset resolved, whether the
 * equaliser is actually applied, how much headroom was taken, whether retuning shifted pitch or
 * fell back to changing speed, and how much latency the chain added. Every value is read from the
 * engine's own reported state, including the cases where the answer is "it isn't", and why.
 *
 * In shared mode this is also where the group lives: creating one, joining one, inviting someone.
 */
import { useEffect, useRef } from 'react';
import { EmptyState, KeyValueList, Panel, PanelSection, StatusDot } from '@now-playing/aqua-ui';
import { formatTime, useAppState, usePlayer } from '../state/context.js';
import { SharedInvite, SharedSetup } from '../components/Shared.js';

export function NowPlayingView() {
  const { store, mode, shared } = usePlayer();
  const state = useAppState();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const entry = state.queue[state.queueIndex] ?? null;

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

  const engine = state.playback.engine;
  const latency = store.playback.latency();

  return (
    <>
      <div className="np-section-head">
        <h2>Now playing</h2>
        <p>{entry ? 'What the audio chain is doing to this song, measured rather than assumed.' : 'Nothing is queued yet.'}</p>
      </div>

      {mode === 'shared' ? (
        <>
          <SharedSetup />
          <SharedInvite />
          {shared.queue ? (
            <Panel title="The group's queue">
              <PanelSection>
                <p className="player-hint">
                  {shared.queue.items.length === 0
                    ? 'Nothing queued yet. Anything anyone adds appears here for everyone.'
                    : `${shared.queue.items.length} queued, at revision ${shared.queue.revision}. The hub keeps this order; your player follows it.`}
                </p>
                {shared.queue.items.length ? (
                  <ol className="player-list">
                    {shared.queue.items.slice(0, 12).map((item) => (
                      <li key={item.id}>
                        {item.track.title} — {item.track.artistName}
                        {item.addedBy ? ` (added by ${item.addedBy.displayName})` : ''}
                        {item.availability === 'unavailable' ? ` — unavailable${item.unavailableReason ? `: ${item.unavailableReason}` : ''}` : ''}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </PanelSection>
            </Panel>
          ) : null}
        </>
      ) : null}

      {entry ? (
        <Panel title="How this is being played">
          <PanelSection>
            <KeyValueList
              items={[
                { key: 'Song', value: `${entry.track.title} — ${entry.track.artistName}` },
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
            <canvas ref={canvasRef} width={480} height={72} className="player-spectrum" aria-hidden="true" />
          </PanelSection>
        </Panel>
      ) : (
        <Panel>
          <EmptyState title="Nothing playing" text="Choose a song from your library. The controls at the top of the page work on whatever is playing, from any section." />
        </Panel>
      )}
    </>
  );
}

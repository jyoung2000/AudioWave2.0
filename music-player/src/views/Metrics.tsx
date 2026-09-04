/**
 * Listening metrics, computed from the local event log.
 *
 * Every number here is derived on this device from events that never left it. The panel says so,
 * and it says how complete the data is: a library with no genre tags gives a genre chart that is
 * mostly "unknown", and hiding that would make the chart a lie.
 */
import { useMemo } from 'react';
import { AquaTable, Button, EmptyState, KeyValueList, Panel, PanelSection, ProgressBar } from '@now-playing/aqua-ui';
import type { RankedEntry, TrendPoint } from '@now-playing/domain';
import { computeListeningMetrics, listeningEventsToCsv } from '@now-playing/domain';
import { useAppState } from '../state/context.js';

export function MetricsView() {
  const state = useAppState();
  // The event array is replaced (never mutated) on every append, so it is a sound dependency: the
  // metrics recompute exactly when the log changes and not on every unrelated render.
  const events = state.events;
  const metrics = useMemo(() => computeListeningMetrics(events, { topN: 10 }), [events]);

  if (!state.events.length) {
    return (
      <Panel>
        <EmptyState title="Nothing to show yet" text="Play some music and this fills in. Everything here is worked out on this device from a log that never leaves it." />
      </Panel>
    );
  }

  return (
    <>
      <div className="np-section-head">
        <h2>Listening</h2>
        <p>Worked out on this device from a log that never leaves it.</p>
      </div>
      <Panel title="Listening">
        <PanelSection>
          <KeyValueList
            items={[
              { key: 'Time listened', value: `${Math.round(metrics.totalMinutes)} minutes` },
              { key: 'Songs played', value: `${metrics.plays} (${metrics.meaningfulListens} for more than half)` },
              { key: 'Finished', value: `${metrics.completions} (${Math.round(metrics.completionRate * 100)}%)` },
              { key: 'Skipped', value: `${metrics.skips} (${Math.round(metrics.skipRate * 100)}%), ${metrics.earlySkips} within ten seconds` },
              { key: 'Current streak', value: `${metrics.currentStreakDays} day${metrics.currentStreakDays === 1 ? '' : 's'} (longest ${metrics.longestStreakDays})` },
              { key: 'Typical session', value: `${Math.round(metrics.averageSessionMinutes)} minutes across ${metrics.sessions.length} sessions` },
              { key: 'New to you', value: `${Math.round(metrics.discoveryRate * 100)}% of plays were artists you had not played before` },
            ]}
          />
        </PanelSection>

        <PanelSection title="How complete this is">
          <p className="player-hint">
            These figures are only as good as your files' tags. {metrics.coverage.total} songs are counted: {Math.round((metrics.coverage.withGenre / Math.max(1, metrics.coverage.total)) * 100)}% have a
            genre, {Math.round((metrics.coverage.withYear / Math.max(1, metrics.coverage.total)) * 100)}% a year, {Math.round((metrics.coverage.withDuration / Math.max(1, metrics.coverage.total)) * 100)}% a
            duration. {metrics.unknownGenrePercent > 0 ? `${Math.round(metrics.unknownGenrePercent)}% of listening has no genre at all, so the genre breakdown below is partial.` : ''}
          </p>
          <ProgressBar value={(metrics.coverage.withGenre / Math.max(1, metrics.coverage.total)) * 100} label="Songs with a genre tag" />
        </PanelSection>
      </Panel>

      <Panel title="Most played">
        <div className="player-metric-columns">
          <RankedTable label="Artists" rows={metrics.topArtists} />
          <RankedTable label="Albums" rows={metrics.topAlbums} />
          <RankedTable label="Songs" rows={metrics.topSongs} />
          <RankedTable label="Genres" rows={metrics.topGenres} />
        </div>
      </Panel>

      <Panel title="When you listen">
        <PanelSection>
          <HourChart hours={metrics.hourOfDay} />
          <TrendChart points={metrics.byWeek.slice(-12)} label="Minutes per week" />
        </PanelSection>
      </Panel>

      <Panel title="Your data">
        <PanelSection>
          <p className="player-hint">
            {state.events.length} events are stored on this device. They are append-only: a skip is recorded as a new event rather than changing an earlier one, which is what lets these figures be
            recomputed from scratch and audited.
          </p>
          <div className="player-toolbar-row">
            <Button
              size="small"
              onClick={() => {
                const csv = listeningEventsToCsv(state.events);
                downloadText(csv, `now-playing-history-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
              }}
            >
              Export as CSV
            </Button>
            <Button
              size="small"
              onClick={() => downloadText(JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), events: state.events }, null, 2), `now-playing-history-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')}
            >
              Export as JSON
            </Button>
          </div>
        </PanelSection>
      </Panel>
    </>
  );
}

function RankedTable({ label, rows }: { label: string; rows: readonly RankedEntry[] }) {
  if (!rows.length) return null;
  return (
    <div className="player-metric-column">
      <h3 className="player-subhead">{label}</h3>
      <AquaTable
        variant="page"
        label={`Most played ${label.toLowerCase()}`}
        rowKey={(row: RankedEntry) => row.key}
        rows={[...rows]}
        rowHeight={20}
        columns={[
          { id: 'label', header: label, primary: true, cell: (row) => row.label },
          { id: 'plays', header: 'Plays', align: 'right', width: 52, cell: (row) => row.plays },
          { id: 'minutes', header: 'Minutes', align: 'right', width: 64, cell: (row) => Math.round(row.minutes) },
        ]}
      />
    </div>
  );
}

/** A day's listening by hour, as a simple bar row — readable without colour or interaction. */
function HourChart({ hours }: { hours: readonly number[] }) {
  const peak = Math.max(1, ...hours);
  return (
    <div className="player-hours" role="img" aria-label={`Listening by hour of day. Busiest hour: ${hours.indexOf(peak)}:00.`}>
      {hours.map((value, hour) => (
        <span key={hour} className="player-hours__bar" style={{ height: `${(value / peak) * 100}%` }} title={`${hour}:00 — ${Math.round(value)} minutes`} />
      ))}
    </div>
  );
}

function TrendChart({ points, label }: { points: readonly TrendPoint[]; label: string }) {
  if (!points.length) return null;
  const peak = Math.max(1, ...points.map((p) => p.minutes));
  return (
    <div className="player-trend" role="img" aria-label={`${label}. ${points.map((p) => `${p.key}: ${Math.round(p.minutes)} minutes`).join('. ')}`}>
      {points.map((point) => (
        <span key={point.key} className="player-trend__bar" style={{ height: `${(point.minutes / peak) * 100}%` }} title={`${point.key} — ${Math.round(point.minutes)} minutes`} />
      ))}
    </div>
  );
}

function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** What the companion found. Reveal opens Explorer at the file, which only this app can do. */
import { useState } from 'react';
import { AquaTable, Button, EmptyState, Panel, SearchField, useToast } from '@now-playing/aqua-ui';
import type { Track } from '@now-playing/contracts';
import { invoke } from '../bridge.js';
import { useAction, useChannel, type Resource } from '../hooks.js';
import type { HelperStatus } from '../../shared/ipc.js';

/**
 * Why the Tempo column is still empty, when it is (NP-PRIN-002, UX-SETUP-001): FFmpeg is on its way,
 * FFmpeg could not be set up, or there is none and this PC cannot get one automatically. Null when
 * FFmpeg is here and nothing needs saying.
 */
export function tempoHint(status: HelperStatus | null): string | null {
  const ffmpeg = status?.tools.find((t) => t.id === 'ffmpeg');
  if (!status || ffmpeg?.present) return null;
  if (ffmpeg?.setup?.state === 'installing') return 'Setting up ffmpeg — tempos appear once it finishes.';
  if (ffmpeg?.setup?.state === 'failed') return 'Tempo needs ffmpeg, which could not be set up automatically. Try again in Settings.';
  return 'Tempo needs ffmpeg — install it and rescan.';
}

export function LibraryView({ helper }: { helper: Resource<HelperStatus> }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const tracks = useChannel('library:tracks', { query: query.trim() || undefined, limit: 300, offset: 0 });
  const hint = tempoHint(helper.data);
  const toast = useToast();
  const reveal = useAction(async (trackId: string) => invoke('app:reveal', { trackId }));
  const send = useAction(async (trackIds: string[]) => invoke('transfers:send', { trackIds }));

  const items = tracks.data?.items ?? [];

  return (
    <Panel title="Music">
      <div className="companion-actions">
        <SearchField label="Search" value={query} onChange={setQuery} placeholder="Search titles, artists and albums" />
        <Button
          size="small"
          icon="upload"
          disabled={selected.size === 0}
          busy={send.busy}
          onClick={() =>
            void send.run([...selected]).then((result) => {
              if (result?.reason) toast.show(result.reason, { kind: 'warning' });
              else if (result) toast.show(`Sending ${result.queued} file${result.queued === 1 ? '' : 's'} to the hub`, { kind: 'success' });
            })
          }
        >
          {selected.size ? `Send ${selected.size} to hub` : 'Send to hub'}
        </Button>
        {tracks.data ? <span className="companion-hint">{tracks.data.total.toLocaleString()} tracks{query ? ' matching' : ''}</span> : null}
        {/* Unavailable is shown and explained (NP-PRIN-002): silent rows stay silent until the decoder exists. */}
        {hint && items.some((row) => row.bpm === null) ? <span className="companion-hint">{hint}</span> : null}
      </div>

      {items.length ? (
        <AquaTable
          label="Music"
          rowKey={(row: Track) => row.id}
          rows={items}
          selectedKeys={selected}
          onSelectionChange={setSelected}
          onActivate={(row) => void reveal.run(row.id).then((r) => r && !r.ok && r.reason && toast.show(r.reason, { kind: 'warning' }))}
          columns={[
            { id: 'title', header: 'Title', primary: true, cell: (row) => row.title, stackText: (row) => row.artistName },
            { id: 'artist', header: 'Artist', cell: (row) => row.artistName },
            { id: 'album', header: 'Album', cell: (row) => row.albumName ?? '' },
            { id: 'year', header: 'Year', align: 'right', width: 56, cell: (row) => row.year ?? '' },
            { id: 'time', header: 'Time', align: 'right', width: 56, cell: (row) => formatDuration(row.durationMs) },
            {
              id: 'tempo',
              header: 'Tempo',
              align: 'right',
              width: 64,
              // A tag is plain; a measurement wears ≈ and says so, so nobody mistakes one for the other.
              cell: (row) => (row.bpm ? (row.bpmSource === 'analysis' ? <span title="Measured from the audio">≈{row.bpm}</span> : String(row.bpm)) : '—'),
            },
            { id: 'format', header: 'Format', width: 96, cell: (row) => row.format?.codec ?? row.format?.container ?? '' },
            {
              id: 'reveal',
              header: '',
              headerLabel: 'Show in Explorer',
              width: 130,
              cell: (row) => (
                <Button size="mini" onClick={() => void reveal.run(row.id).then((r) => r && !r.ok && r.reason && toast.show(r.reason, { kind: 'warning' }))}>
                  Show in Explorer
                </Button>
              ),
            },
          ]}
        />
      ) : (
        <EmptyState title={query ? 'Nothing matches that' : 'No music indexed yet'} text={query ? 'Try fewer words.' : 'Add a folder and scan it.'} />
      )}
    </Panel>
  );
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

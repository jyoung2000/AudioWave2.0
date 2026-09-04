/**
 * Downloads.
 *
 * The format table is generated from the FFmpeg build actually installed in this container, and
 * every unavailable format says why. The lossy/lossless note is there because converting a lossy
 * source to FLAC makes a bigger file, not a better one, and the UI should say so rather than let
 * someone discover it later.
 */
import { AquaTable, Panel, PanelSection, ProgressBar, StatusDot, useToast } from '@now-playing/aqua-ui';
import type { DownloadJob, FormatAvailability } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { Ago, AsyncPanel, Bytes, ConfirmButton } from './common.js';

const BASIS_LABELS: Record<string, string> = {
  'user-owned': 'Content the requester owns',
  'creator-download': 'The creator enabled downloads',
  'purchased-export': 'Exported from a purchase',
  'public-domain': 'Public domain',
  licensed: 'Licensed',
  'hub-hosted': 'Already hosted by this hub',
};

export function DownloadsView() {
  const jobs = useResource('downloadsList', {}, { pollMs: 3_000 });
  const formats = useResource('downloadsFormats');
  const storage = useResource('downloadsStorage', {}, { pollMs: 30_000 });
  const act = useAction(async (jobId: string, action: 'cancel' | 'pause' | 'resume' | 'retry') => api('downloadsAction', { params: { jobId, action } }));
  const toast = useToast();

  return (
    <>
      <AsyncPanel
        resource={jobs}
        title="Download jobs"
        emptyWhen={(d) => (d as { items: DownloadJob[] }).items.length === 0}
        emptyTitle="No downloads"
        emptyText="Downloads are requested from a player or the companion, and only for content whose rights basis the requester states."
      >
        {(raw) => (
          <AquaTable
            label="Downloads"
            rowKey={(row: DownloadJob) => row.id}
            rows={(raw as { items: DownloadJob[] }).items}
            columns={[
              { id: 'title', header: 'Title', primary: true, cell: (row) => row.source.title ?? row.source.providerTrackId ?? row.source.url ?? row.id.slice(0, 8) },
              { id: 'provider', header: 'Source', cell: (row) => row.source.provider },
              { id: 'basis', header: 'Rights basis', cell: (row) => BASIS_LABELS[row.authorization.basis] ?? row.authorization.basis },
              { id: 'state', header: 'State', cell: (row) => <StatusDot kind={row.state === 'completed' ? 'ok' : row.state === 'failed' ? 'error' : row.state === 'running' ? 'info' : 'neutral'} label={row.state} /> },
              {
                id: 'progress',
                header: 'Progress',
                cell: (row) =>
                  row.state === 'running' || row.state === 'retrying' ? (
                    <ProgressBar value={row.progress.percent ?? null} label={`${row.progress.stage}${row.progress.percent !== null ? ` ${Math.round(row.progress.percent)}%` : ''}`} />
                  ) : (
                    row.progress.stage
                  ),
              },
              { id: 'size', header: 'Size', align: 'right', cell: (row) => <Bytes value={row.resultSizeBytes ?? row.progress.bytesDone} /> },
              { id: 'error', header: 'Note', cell: (row) => row.error ?? '' },
              {
                id: 'actions',
                header: '',
                headerLabel: 'Actions',
                cell: (row) => {
                  const action = row.state === 'failed' || row.state === 'cancelled' ? 'retry' : row.state === 'paused' ? 'resume' : row.state === 'running' || row.state === 'queued' ? 'pause' : null;
                  if (!action) return null;
                  return (
                    <ConfirmButton
                      label={action === 'retry' ? 'Retry' : action === 'resume' ? 'Resume' : 'Pause'}
                      confirmLabel={`${action[0]!.toUpperCase()}${action.slice(1)} this download?`}
                      danger={false}
                      busy={act.busy}
                      onConfirm={() => void act.run(row.id, action).then(() => jobs.reload())}
                    />
                  );
                },
              },
            ]}
          />
        )}
      </AsyncPanel>

      <AsyncPanel resource={formats} title="Output formats">
        {(raw) => {
          const data = raw as { formats: FormatAvailability[]; ffmpeg: { available: boolean; version: string | null; encoders: string[] } };
          return (
            <>
              <p className="admin-hint">
                {data.ffmpeg.available
                  ? `FFmpeg ${data.ffmpeg.version ?? ''} is installed with ${data.ffmpeg.encoders.length} of the encoders this hub looks for.`
                  : 'FFmpeg is not available in this build, so files can only be copied byte for byte. That is lossless, but no conversion is possible.'}
              </p>
              <AquaTable
                label="Formats"
                rowKey={(row: FormatAvailability) => row.format}
                rows={data.formats}
                columns={[
                  { id: 'format', header: 'Format', primary: true, cell: (row) => row.format },
                  { id: 'available', header: 'Available', cell: (row) => <StatusDot kind={row.available ? 'ok' : 'neutral'} label={row.available ? 'yes' : 'no'} /> },
                  { id: 'lossy', header: 'Lossy', cell: (row) => (row.lossy ? 'yes' : 'no') },
                  { id: 'quality', header: 'Quality', cell: (row) => row.qualityNote },
                  { id: 'reason', header: 'Why not', cell: (row) => row.reason ?? '' },
                ]}
              />
            </>
          );
        }}
      </AsyncPanel>

      <AsyncPanel resource={storage} title="Storage">
        {(raw) => {
          const data = raw as { dataDir: string; freeBytes: number | null; totalBytes: number | null; usedByDownloadsBytes: number; partialFiles: number; cleanupPolicy: { keepFailedDays: number; keepPartialHours: number } };
          return (
            <PanelSection>
              <ul className="admin-list">
                <li>
                  Data volume <code>{data.dataDir}</code>: {data.freeBytes === null ? 'free space unknown on this filesystem' : <><Bytes value={data.freeBytes} /> free of <Bytes value={data.totalBytes} /></>}
                </li>
                <li>
                  Downloaded content: <Bytes value={data.usedByDownloadsBytes} />
                </li>
                <li>Unfinished uploads: {data.partialFiles}</li>
                <li>
                  Cleanup: failed jobs are dropped after {data.cleanupPolicy.keepFailedDays} days, unfinished files after {data.cleanupPolicy.keepPartialHours} hours.
                </li>
              </ul>
            </PanelSection>
          );
        }}
      </AsyncPanel>
      <div hidden>{toast ? '' : ''}</div>
    </>
  );
}

export { Panel, Ago };

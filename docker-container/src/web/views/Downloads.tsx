/**
 * Downloads.
 *
 * The jobs table is the design's: item, where it came from, format, progress. The output formats
 * are read from the FFmpeg build actually installed in this container — a format the hub cannot
 * write is struck through and says why — and the storage line is what the data volume reports.
 * Nothing here is a setting the hub does not have.
 */
import type { DownloadJob, FormatAvailability, ProviderDescriptor } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, EmptyCells, errorSentence, formatBytes, Group, listState, Note, Push, useHubUi } from '../ui.js';

export const BASIS_LABELS: Record<string, string> = {
  'user-owned': 'The requester owns it',
  'creator-download': 'The artist allows downloads',
  'purchased-export': 'Exported from a purchase',
  'public-domain': 'Public domain',
  licensed: 'Licensed',
  'hub-hosted': 'Already on this hub',
};

const FORMAT_LABELS: Record<string, string> = { original: 'Original', mp3: 'MP3', aac: 'AAC', opus: 'Opus', flac: 'FLAC' };
const STAGES: Record<string, string> = { preflight: 'Checking', downloading: 'Downloading', verifying: 'Verifying', converting: 'Converting', finalizing: 'Finishing', transferring: 'Sending', done: 'Done' };

type JobAction = 'cancel' | 'pause' | 'resume' | 'retry';

export function DownloadsView() {
  const jobs = useResource('downloadsList', {}, { pollMs: 3_000 });
  const formats = useResource('downloadsFormats');
  const storage = useResource('downloadsStorage', {}, { pollMs: 30_000 });
  const providers = useResource('providersList');
  const act = useAction(async (jobId: string, action: JobAction) => api('downloadsAction', { params: { jobId, action } }));
  const { confirm } = useHubUi();

  const items = (jobs.data as { items: DownloadJob[] } | null)?.items ?? [];
  const state = listState(jobs, (d) => (d as { items: DownloadJob[] }).items.length === 0, 'No downloads. A player or the companion asks for one.');
  const names = new Map(((providers.data as { items: ProviderDescriptor[] } | null)?.items ?? []).map((p) => [p.provider, p.displayName]));
  const formatData = formats.data as { formats: FormatAvailability[]; ffmpeg: { available: boolean; version: string | null; encoders: string[] } } | null;
  const store = storage.data as { dataDir: string; freeBytes: number | null; totalBytes: number | null; usedByDownloadsBytes: number; partialFiles: number; cleanupPolicy: { keepFailedDays: number; keepPartialHours: number } } | null;

  const run = (job: DownloadJob, action: JobAction): void => void act.run(job.id, action).then(() => jobs.reload());

  return (
    <Group title="Downloads">
      <div className="well">
        <table className="tbl" aria-label="Downloads">
          <colgroup>
            <col />
            <col className="hide-sm" style={{ width: '18%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: 132 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="hide-sm">
                From
              </th>
              <th scope="col">Format</th>
              <th scope="col">Progress</th>
              <th scope="col">
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state ? <EmptyCells columns={5} {...state} /> : null}
            {state
              ? null
              : items.map((job) => {
                  const title = [job.source.title, job.source.artistName].filter(Boolean).join(' — ') || job.source.url || 'Untitled';
                  const percent = job.progress.percent === null ? null : Math.round(job.progress.percent);
                  const stage = STAGES[job.progress.stage] ?? 'Working';
                  // A playlist link is one row per entry; the row says which list, and where in it.
                  const batch = job.source.batch ? `${job.source.batch.title ?? 'Playlist'}, ${job.source.batch.index + 1} of ${job.source.batch.total}` : null;
                  return (
                    <tr key={job.id}>
                      <td title={[title, batch, BASIS_LABELS[job.authorization.basis] ?? 'Allowed'].filter(Boolean).join(' · ')}>{title}</td>
                      <td className="hide-sm" title={batch ?? undefined}>
                        {names.get(job.source.provider) ?? job.source.provider}
                        {batch ? <span className="sub"> · {batch}</span> : null}
                      </td>
                      <td>{FORMAT_LABELS[job.target.format] ?? job.target.format}</td>
                      <td>
                        {job.state === 'completed' ? (
                          <span className="ok" title={job.resultSizeBytes ? formatBytes(job.resultSizeBytes) : undefined}>
                            ✓ Done
                          </span>
                        ) : job.state === 'queued' ? (
                          <span className="sub">Waiting</span>
                        ) : job.state === 'paused' ? (
                          <span className="sub">Paused{percent === null ? '' : ` at ${percent}%`}</span>
                        ) : job.state === 'failed' ? (
                          <span className="bad" title={job.error ?? undefined}>
                            Failed
                          </span>
                        ) : job.state === 'cancelled' ? (
                          <span className="sub">Cancelled</span>
                        ) : percent === null ? (
                          <span className="sub">{stage}…</span>
                        ) : (
                          <div className="bar" role="progressbar" aria-label={`${stage}, ${percent}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} title={`${stage} · ${percent}%`}>
                            <i style={{ width: `${percent}%` }} />
                          </div>
                        )}
                      </td>
                      <td className="acts">
                        {job.state === 'failed' || job.state === 'cancelled' ? (
                          <Push busy={act.busy} aria-label={`Retry ${title}`} onClick={() => run(job, 'retry')}>
                            Retry
                          </Push>
                        ) : null}
                        {job.state === 'paused' ? (
                          <Push busy={act.busy} aria-label={`Resume ${title}`} onClick={() => run(job, 'resume')}>
                            Resume
                          </Push>
                        ) : null}
                        {job.state === 'running' || job.state === 'queued' || job.state === 'retrying' ? (
                          <Push busy={act.busy} aria-label={`Pause ${title}`} onClick={() => run(job, 'pause')}>
                            Pause
                          </Push>
                        ) : null}
                        {job.state === 'running' || job.state === 'queued' || job.state === 'retrying' || job.state === 'paused' ? (
                          <Push
                            busy={act.busy}
                            aria-label={`Cancel ${title}`}
                            onClick={() =>
                              void confirm({ title: 'Cancel this download?', text: `“${title}” stops and what was fetched so far is thrown away.`, verb: 'Cancel Download' }).then((go) => {
                                if (go) run(job, 'cancel');
                              })
                            }
                          >
                            Cancel
                          </Push>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      {items.some((j) => j.state === 'failed' && j.error) ? <Note>{items.find((j) => j.state === 'failed' && j.error)?.error}</Note> : null}
      <ActionError error={act.error} />

      <div className="pref pref--after">
        <span className="k top">Output formats:</span>
        <div className="v">
          {formatData ? (
            <>
              <span className="caps">
                {formatData.formats.map((f) => (
                  <span key={f.format} className={`cap ${f.available ? 'cap--yes' : 'cap--no'}`} title={f.available ? f.qualityNote : (f.reason ?? 'Not available in this build')}>
                    {FORMAT_LABELS[f.format] ?? f.format}
                    <span className="sr">: {f.available ? 'available' : 'not available'}</span>
                  </span>
                ))}
              </span>
              <span className="sub">
                {formatData.ffmpeg.available
                  ? 'Converted with the FFmpeg in this container. Turning a lossy file into FLAC makes it bigger, not better.'
                  : 'This container has no FFmpeg, so files are saved as they are and nothing is converted.'}
              </span>
            </>
          ) : (
            <span className="sub">{formats.error ? errorSentence(formats.error) : 'Loading…'}</span>
          )}
        </div>
        <span className="k top">Storage:</span>
        <div className="v">
          {store ? (
            <>
              <span>
                <span className="path">{store.dataDir}</span> · {formatBytes(store.usedByDownloadsBytes)} used by downloads · {store.freeBytes === null ? 'free space unknown' : `${formatBytes(store.freeBytes)} free`}
              </span>
              <span className="sub">
                Failed downloads are cleared after {store.cleanupPolicy.keepFailedDays} days, unfinished files after {store.cleanupPolicy.keepPartialHours} hours.
                {store.partialFiles ? ` ${store.partialFiles} unfinished now.` : ''}
              </span>
            </>
          ) : (
            <span className="sub">{storage.error ? errorSentence(storage.error) : 'Loading…'}</span>
          )}
        </div>
      </div>
      <Note>A stream never implies a download. Where a provider doesn’t allow saving, there’s no button — not one that fails.</Note>
    </Group>
  );
}

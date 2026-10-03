/**
 * Backup, as the design drew it and the main process does it: where archives go, how much room that
 * has (in use · this backup · free after it), what to include, how often, how many to keep, and the
 * archives that are there.
 *
 * Every number is measured by the main process with the same code the helper's estimate route
 * uses, so this pane and the player's Backup pane agree by construction. Back Up Now is disabled
 * with the reason whenever the backup could not run — no folder chosen, a folder that could not be
 * measured, not enough room — rather than failing after the click. Sizes are decimal units
 * (1 GB = 10⁹ bytes), as the player shows them.
 */
import { useState } from 'react';
import type { BackupArchive, BackupProgress, BackupSettings } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { dateTime, formatDecimal, plural } from '../format.js';
import { useAction, useChannel, useEvent } from '../hooks.js';
import { Check, EmptyRow, LoadingRow, Pop, Progress, Push, Remove, Rows, useConfirm } from '../ui.js';

export { formatDecimal };

type Part = keyof BackupSettings['include'];

const INCLUDE: ReadonlyArray<{ key: Part; label: string }> = [
  { key: 'music', label: 'Music' },
  { key: 'tv', label: 'TV' },
  { key: 'movies', label: 'Movies' },
  { key: 'playlists', label: 'Playlists' },
  { key: 'presets', label: 'EQ presets' },
  { key: 'settings', label: 'These settings' },
];

const PART_WORDS: Record<Part, string> = { music: 'Music', tv: 'TV', movies: 'Movies', playlists: 'Playlists', presets: 'EQ presets', settings: 'Settings' };

const SCHEDULE_WORDS: Record<BackupSettings['schedule'], string> = { manual: 'when you click', daily: 'every day', weekly: 'every week' };

function drive(path: string): string {
  const root = /^[A-Za-z]:/.exec(path)?.[0];
  return root ? root.toUpperCase() : path;
}

function phaseWords(progress: BackupProgress, dir: string | null): string {
  if (progress.phase === 'measuring') return 'Measuring what to copy…';
  if (progress.phase === 'pruning') return 'Tidying old backups…';
  if (progress.phase === 'writing') return 'Writing playlists and settings…';
  const pct = progress.bytesTotal ? ` ${Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100))}%` : '';
  return `Backing up${dir ? ` to ${dir}` : ''}…${pct}`;
}

export function BackupView({ say }: { say: (text: string) => void }) {
  const confirm = useConfirm();
  const settings = useChannel('backup:settings:get', undefined);
  const estimate = useChannel('backup:estimate', undefined, { pollMs: 60_000 });
  const archives = useChannel('backup:list', undefined, { pollMs: 30_000 });
  const [progress, setProgress] = useState<BackupProgress | null>(null);

  const refresh = () => {
    settings.reload();
    estimate.reload();
    archives.reload();
  };

  useEvent('event:backup-progress', (p) => {
    setProgress(p);
    if (p.phase === 'done' || p.phase === 'failed') refresh();
  });

  const update = useAction(async (patch: Parameters<typeof invoke<'backup:settings:set'>>[1]) => invoke('backup:settings:set', patch));
  const pick = useAction(async () => invoke('backup:pick-dir', undefined));
  const create = useAction(async () => invoke('backup:create', undefined));
  const restore = useAction(async (id?: string) => invoke('backup:restore', id ? { id } : {}));
  const remove = useAction(async (id: string) => invoke('backup:remove', { id }));
  const exportPlaylists = useAction(async () => invoke('backup:export-playlists', undefined));

  const s = settings.data;
  const e = estimate.data;
  const patch = (p: Parameters<typeof invoke<'backup:settings:set'>>[1]) =>
    void update.run(p).then((next) => {
      if (next) say('Saved. Settings are kept on this PC.');
      refresh();
    });

  const running = Boolean(progress && progress.phase !== 'done' && progress.phase !== 'failed') || create.busy;
  const dest = e?.destination ?? null;
  const known = dest && dest.totalBytes !== null && dest.freeBytes !== null && dest.totalBytes > 0 ? { free: dest.freeBytes, total: dest.totalBytes } : null;
  const used = known ? known.total - known.free : null;
  const short = Boolean(known && e?.complete && e.expectedBytes > known.free);
  const share = (bytes: number) => (known ? `${Math.max(0, Math.min(100, (bytes / known.total) * 100))}%` : '0%');
  const anything = s ? Object.values(s.include).some(Boolean) : false;

  const backUp = () =>
    void create.run().then((result) => {
      if (result?.backup) say(`Backed up ${formatDecimal(result.backup.sizeBytes)} to ${result.backup.path}.`);
      else if (result?.reason) say(result.reason);
      refresh();
    });

  const restoreArchive = async (row: BackupArchive) => {
    const yes = await confirm({ title: `Restore the backup from ${dateTime(row.createdAt)}?`, detail: 'Playlists, EQ presets and settings come back. Newer versions already on this PC are kept, and copied music stays in the backup folder.', action: 'Restore' });
    if (!yes) return;
    const result = await restore.run(row.id);
    if (result?.restored) say('Restored. Playlists, EQ presets and settings are back.');
    else if (result?.reason) say(result.reason);
    refresh();
  };

  const removeArchive = async (row: BackupArchive) => {
    const yes = await confirm({ title: `Delete the backup from ${dateTime(row.createdAt)}?`, detail: `${row.path} is removed from the backup folder. This can’t be undone.`, action: 'Delete Backup', destructive: true });
    if (!yes) return;
    const result = await remove.run(row.id);
    if (result?.reason) say(result.reason);
    refresh();
  };

  const restoreFile = () =>
    void restore.run().then((result) => {
      if (result?.restored) say('Restored. Playlists and EQ presets are back.');
      else if (result?.reason) say(result.reason);
      refresh();
    });

  const exportAll = () =>
    void exportPlaylists.run().then((result) => {
      if (result?.path) say(`Exported ${plural(result.count, 'playlist')} to ${result.path}.`);
      else if (result?.reason) say(result.reason);
    });

  const stateLine =
    running && progress && progress.phase !== 'done' && progress.phase !== 'failed'
      ? phaseWords(progress, s?.dir ?? null)
      : running
        ? 'Starting…'
        : e?.blocked
          ? e.blocked
          : s?.lastRunError
            ? `The last backup didn’t finish: ${s.lastRunError}`
            : !anything && s
              ? 'Tick something to back up.'
              : e?.complete
                ? `About ${formatDecimal(e.expectedBytes)} · ${SCHEDULE_WORDS[s?.schedule ?? 'manual']}${s?.lastRunAt ? ` · last backed up ${dateTime(s.lastRunAt)}` : ''}`
                : ' ';

  return (
    <fieldset>
      <legend>Backup</legend>
      <div className="pref">
        <span className="k top" id="backup-dir-k">
          Back up to:
        </span>
        <div className="v">
          {s?.dir ? (
            <span className="path" id="backup-dir" aria-labelledby="backup-dir-k backup-dir">
              {s.dir}
            </span>
          ) : (
            <span className="dim">{s ? 'Not chosen yet' : ' '}</span>
          )}
          <Push busy={pick.busy} disabled={running} onClick={() => void pick.run().then(refresh)}>
            Choose…
          </Push>
          <span className="sub">A folder on this PC or a drive you plug in. The hub keeps its own backups.</span>
        </div>

        <span className="k top">Space:</span>
        <div className="v stack" style={{ gap: 3 }}>
          {e && dest ? (
            <>
              <span>
                {known ? (
                  <>
                    <b>{formatDecimal(known.free)} free</b> of {formatDecimal(known.total)} on {drive(dest.path)}
                  </>
                ) : (
                  'Free space on that drive isn’t known'
                )}
                {anything ? (e.complete ? ` · this backup needs about ${formatDecimal(e.expectedBytes)}` : ' · still measuring this backup') : ''}
                {short ? (
                  <>
                    {' · '}
                    <b className="short">not enough space</b>
                  </>
                ) : null}
              </span>
              <div className={short ? 'spacebar is-short' : 'spacebar'} role="img" aria-label={known ? `${formatDecimal(used)} used, this backup ${formatDecimal(e.expectedBytes)}, ${formatDecimal(known.free)} free` : 'Free space unknown'}>
                {known && used !== null ? <i className="used" style={{ width: share(used) }} /> : null}
                {known && used !== null && e.complete && anything ? <i className="this" style={{ left: share(used), width: share(Math.min(e.expectedBytes, known.free)) }} /> : null}
              </div>
              <span className="sub">{short ? 'Choose a bigger drive, or untick Movies or TV.' : known && e.complete ? `Grey is in use, blue is this backup; ${formatDecimal(Math.max(0, known.free - e.expectedBytes))} stays free after it.` : 'Grey is in use, blue is this backup.'}</span>
            </>
          ) : (
            <span className="dim">{s?.dir ? (estimate.error ? 'That folder couldn’t be measured. Choose it again.' : 'Measuring…') : s ? 'Choose a folder to see how much room it has.' : ' '}</span>
          )}
        </div>

        <span className="k top">What:</span>
        <div className="v stack">
          {INCLUDE.map((item) => {
            const measured = item.key === 'music' || item.key === 'tv' || item.key === 'movies' ? e?.parts[item.key] : undefined;
            return (
              <Check key={item.key} checked={s?.include[item.key] ?? false} disabled={!s || running} onChange={(event) => patch({ include: { [item.key]: event.currentTarget.checked } })}>
                {item.label}
                {measured ? (
                  <span className="sub">
                    {' '}
                    — {formatDecimal(measured.bytes)} in {plural(measured.files, 'file')}
                  </span>
                ) : null}
              </Check>
            );
          })}
        </div>

        <label className="k" htmlFor="backup-when">
          How often:
        </label>
        <div className="v">
          <Pop
            id="backup-when"
            value={s?.schedule ?? 'manual'}
            disabled={!s}
            onChange={(event) => patch({ schedule: event.currentTarget.value as BackupSettings['schedule'] })}
            options={[
              { value: 'manual', label: 'Only when I click Back Up Now' },
              { value: 'daily', label: 'Every day, while the companion is open' },
              { value: 'weekly', label: 'Every week, while the companion is open' },
            ]}
          />
        </div>

        <label className="k" htmlFor="backup-keep">
          Keep:
        </label>
        <div className="v">
          <Pop
            id="backup-keep"
            value={String(s?.keep ?? 5)}
            disabled={!s}
            onChange={(event) => patch({ keep: Number(event.currentTarget.value) as BackupSettings['keep'] })}
            options={[
              { value: '3', label: 'The last 3 backups' },
              { value: '5', label: 'The last 5 backups' },
              { value: '10', label: 'The last 10 backups' },
              { value: '0', label: 'Every backup' },
            ]}
          />
        </div>

        <span className="k top" />
        <div className="v">
          <Push busy={running} disabled={!e || Boolean(e.blocked)} reason={e?.blocked ?? null} onClick={backUp}>
            Back Up Now
          </Push>
          <span className="note" style={{ margin: 0 }} role="status">
            {stateLine}
          </span>
          {running && progress?.phase === 'copying' ? <Progress label="Backing up" value={progress.bytesTotal ? (progress.bytesDone / progress.bytesTotal) * 100 : null} /> : null}
        </div>
      </div>

      <Rows label="Backups" className="well--gap">
        {!archives.data ? (
          <LoadingRow />
        ) : archives.data.items.length ? (
          archives.data.items.map((row) => (
            <li key={row.id}>
              <span className="name" title={row.path}>
                <b>{dateTime(row.createdAt)}</b>
                {'  '}
                {row.restorable ? row.parts.map((part) => PART_WORDS[part]).join(', ') : 'Can’t be read — its contents list is missing'}
              </span>
              <span className="meta">{row.restorable ? formatDecimal(row.sizeBytes) : ''}</span>
              <Push className="push--row" disabled={!row.restorable || restore.busy || running} reason={!row.restorable ? 'This backup can’t be read, so it can’t be restored.' : null} onClick={() => void restoreArchive(row)}>
                Restore…
              </Push>
              <Remove label={`Delete the backup from ${dateTime(row.createdAt)}`} disabled={remove.busy || running} onClick={() => void removeArchive(row)} />
            </li>
          ))
        ) : (
          <EmptyRow>No backups yet.</EmptyRow>
        )}
      </Rows>
      <div className="barrow">
        <Push busy={restore.busy} disabled={running} onClick={restoreFile}>
          Restore from a File…
        </Push>
        <Push busy={exportPlaylists.busy} onClick={exportAll}>
          Export Playlists…
        </Push>
      </div>
      <p className="note">A file is a backup’s data.json, or a playlist export from any companion. Folders are never restored from a file: where they are is particular to each PC.</p>
    </fieldset>
  );
}

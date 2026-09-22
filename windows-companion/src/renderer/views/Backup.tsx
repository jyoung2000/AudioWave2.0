/**
 * Backup, as the mockup drew it and the main process now does it: where archives go, how much
 * room that has (used · this backup · free after it), what to include, how often, how many to keep,
 * and the archives that are there.
 *
 * Every number is measured by the main process with the same code the helper's estimate route
 * uses, so this pane and the player's Backup pane agree by construction. Back Up Now is disabled
 * with the reason whenever the backup could not run — no folder chosen, a folder that could not be
 * measured, or not enough room — rather than failing after the click. Sizes are decimal units
 * (1 GB = 10⁹ bytes), as the player shows them.
 */
import { useState } from 'react';
import { AquaTable, Button, Checkbox, EmptyState, Panel, PanelSection, PopUpMenu, ProgressBar, useToast } from '@now-playing/aqua-ui';
import type { BackupArchive, BackupProgress, BackupSettings } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { useAction, useChannel, useEvent } from '../hooks.js';

/** Decimal units, as the player's Backup pane shows them. */
export function formatDecimal(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

const INCLUDE: ReadonlyArray<{ key: keyof BackupSettings['include']; label: string; note?: string }> = [
  { key: 'music', label: 'Music', note: 'copies every music folder into the archive' },
  { key: 'tv', label: 'TV' },
  { key: 'movies', label: 'Movies' },
  { key: 'playlists', label: 'Playlists' },
  { key: 'presets', label: 'EQ presets' },
  { key: 'settings', label: 'These settings' },
];

export function BackupView() {
  const toast = useToast();
  const settings = useChannel('backup:settings:get', undefined);
  const estimate = useChannel('backup:estimate', undefined, { pollMs: 60_000 });
  const archives = useChannel('backup:list', undefined, { pollMs: 30_000 });
  const [progress, setProgress] = useState<BackupProgress | null>(null);

  useEvent('event:backup-progress', (p) => {
    setProgress(p);
    if (p.phase === 'done' || p.phase === 'failed') {
      archives.reload();
      estimate.reload();
      settings.reload();
    }
  });

  const update = useAction(async (patch: Parameters<typeof invoke<'backup:settings:set'>>[1]) => invoke('backup:settings:set', patch));
  const pick = useAction(async () => invoke('backup:pick-dir', undefined));
  const create = useAction(async () => invoke('backup:create', undefined));
  const restore = useAction(async (id?: string) => invoke('backup:restore', id ? { id } : {}));
  const remove = useAction(async (id: string) => invoke('backup:remove', { id }));
  const exportPlaylists = useAction(async () => invoke('backup:export-playlists', undefined));

  const s = settings.data;
  const e = estimate.data;
  const refresh = () => {
    settings.reload();
    estimate.reload();
    archives.reload();
  };
  const patch = (p: Parameters<typeof invoke<'backup:settings:set'>>[1]) => void update.run(p).then(refresh);

  const running = progress && progress.phase !== 'done' && progress.phase !== 'failed';
  const dest = e?.destination ?? null;
  const used = dest && dest.totalBytes !== null && dest.freeBytes !== null ? dest.totalBytes - dest.freeBytes : null;
  const fits = dest?.freeBytes === null || dest?.freeBytes === undefined || !e ? null : dest.freeBytes >= e.expectedBytes;
  const pct = (bytes: number) => (dest?.totalBytes ? `${Math.min(100, (bytes / dest.totalBytes) * 100)}%` : '0%');

  return (
    <Panel title="Backup">
      <PanelSection>
        <div className="companion-pref">
          <span className="companion-pref__k" id="backup-dir-k">
            Back up to:
          </span>
          <div className="companion-pref__v">
            {s?.dir ? <code className="companion-path" aria-labelledby="backup-dir-k">{s.dir}</code> : <span className="companion-hint">Not chosen yet.</span>}
            <Button size="small" busy={pick.busy} onClick={() => void pick.run().then(refresh)} ellipsis>
              Choose
            </Button>
            <span className="companion-hint companion-pref__sub">A folder on this PC or a drive you plug in. The hub keeps its own backups.</span>
          </div>

          <span className="companion-pref__k">Space:</span>
          <div className="companion-pref__v companion-pref__v--stack">
            {e && dest ? (
              <>
                <span>
                  {e.complete ? `This backup: ${formatDecimal(e.expectedBytes)}` : 'This backup: size unknown until every folder is measured'}
                  {dest.freeBytes !== null ? ` · ${formatDecimal(dest.freeBytes)} free of ${formatDecimal(dest.totalBytes)}` : ' · free space unknown'}
                </span>
                <div className={['companion-space', fits === false && 'companion-space--short'].filter(Boolean).join(' ')} role="img" aria-label={`${formatDecimal(used)} used, ${formatDecimal(e.expectedBytes)} for this backup, ${formatDecimal(dest.freeBytes !== null ? Math.max(0, dest.freeBytes - e.expectedBytes) : null)} free after it`}>
                  {used !== null ? <i className="companion-space__used" style={{ width: pct(used) }} /> : null}
                  {e.complete ? <i className="companion-space__this" style={{ width: pct(e.expectedBytes) }} /> : null}
                </div>
                <span className="companion-hint">
                  Used · this backup · free after it{fits === false ? ` — ${e.blocked}` : ''}
                </span>
              </>
            ) : (
              <span className="companion-hint">{s?.dir ? (estimate.error ?? 'Measuring…') : 'Choose a folder to see how much room it has.'}</span>
            )}
          </div>

          <span className="companion-pref__k">What:</span>
          <div className="companion-pref__v companion-pref__v--stack">
            {INCLUDE.map((item) => (
              <Checkbox key={item.key} checked={s?.include[item.key] ?? false} disabled={!s || Boolean(running)} onChange={(ev) => patch({ include: { [item.key]: ev.currentTarget.checked } })}>
                {item.label}
                {item.key === 'music' || item.key === 'tv' || item.key === 'movies' ? (
                  <span className="companion-hint"> {e?.parts[item.key] ? `— ${formatDecimal(e.parts[item.key]!.bytes)} in ${e.parts[item.key]!.files.toLocaleString()} files` : item.note ? `— ${item.note}` : ''}</span>
                ) : null}
              </Checkbox>
            ))}
          </div>

          <label className="companion-pref__k" htmlFor="backup-when">
            How often:
          </label>
          <div className="companion-pref__v">
            <PopUpMenu
              id="backup-when"
              label="How often"
              hideLabel
              value={s?.schedule ?? 'manual'}
              disabled={!s}
              onChange={(ev) => patch({ schedule: ev.currentTarget.value as BackupSettings['schedule'] })}
              options={[
                { value: 'manual', label: 'Only when I click Back Up Now' },
                { value: 'daily', label: 'Every day, while the companion is open' },
                { value: 'weekly', label: 'Every week, while the companion is open' },
              ]}
            />
          </div>

          <label className="companion-pref__k" htmlFor="backup-keep">
            Keep:
          </label>
          <div className="companion-pref__v">
            <PopUpMenu
              id="backup-keep"
              label="Keep"
              hideLabel
              value={String(s?.keep ?? 5)}
              disabled={!s}
              onChange={(ev) => patch({ keep: Number(ev.currentTarget.value) as BackupSettings['keep'] })}
              options={[
                { value: '3', label: 'The last 3 backups' },
                { value: '5', label: 'The last 5 backups' },
                { value: '10', label: 'The last 10 backups' },
                { value: '0', label: 'Every backup' },
              ]}
            />
          </div>

          <span className="companion-pref__k" />
          <div className="companion-pref__v">
            <Button
              variant="default"
              busy={create.busy || Boolean(running)}
              disabled={!e || Boolean(e.blocked) || Boolean(running)}
              title={e?.blocked ?? undefined}
              onClick={() =>
                void create.run().then((result) => {
                  if (result?.backup) toast.show(`Backed up ${formatDecimal(result.backup.sizeBytes)} to ${result.backup.path}`, { kind: 'success' });
                  else if (result?.reason) toast.show(result.reason, { kind: 'warning' });
                  refresh();
                })
              }
            >
              Back Up Now
            </Button>
            <span className="companion-hint" role="status">
              {running && progress
                ? `${progress.phase === 'copying' ? 'Copying' : progress.phase === 'measuring' ? 'Measuring' : progress.phase === 'pruning' ? 'Tidying old backups' : 'Writing'}${progress.currentName ? ` — ${progress.currentName}` : ''}`
                : e?.blocked
                  ? e.blocked
                  : s?.lastRunError
                    ? `Last attempt failed: ${s.lastRunError}`
                    : s?.lastRunAt
                      ? `Last backup ${new Date(s.lastRunAt).toLocaleString()}`
                      : 'No backup has been made yet.'}
            </span>
          </div>
        </div>
        {running && progress ? <ProgressBar value={progress.bytesTotal ? (progress.bytesDone / progress.bytesTotal) * 100 : null} label="Backing up" /> : null}
      </PanelSection>

      <PanelSection title="Backups">
        {archives.data?.items.length ? (
          <AquaTable
            label="Backups"
            rowKey={(row: BackupArchive) => row.id}
            rows={archives.data.items}
            columns={[
              { id: 'when', header: 'Archive', primary: true, cell: (row) => new Date(row.createdAt).toLocaleString(), stackText: (row) => row.id },
              { id: 'parts', header: 'Holds', cell: (row) => (row.restorable ? row.parts.join(', ') : 'unreadable — no manifest') },
              { id: 'size', header: 'Size', align: 'right', width: 88, cell: (row) => (row.restorable ? formatDecimal(row.sizeBytes) : '—') },
              {
                id: 'actions',
                header: '',
                headerLabel: 'Actions',
                width: 160,
                cell: (row) => (
                  <span className="companion-row-actions">
                    <Button
                      size="mini"
                      disabled={!row.restorable || restore.busy}
                      onClick={() => {
                        if (window.confirm('Restore playlists, presets and settings from this backup?\n\nNewer versions already on this PC are kept. Copied music stays in the backup folder.')) {
                          void restore.run(row.id).then((r) => {
                            if (r?.restored) toast.show('Restored.', { kind: 'success' });
                            else if (r?.reason) toast.show(r.reason, { kind: 'warning' });
                            refresh();
                          });
                        }
                      }}
                    >
                      Restore
                    </Button>
                    <Button
                      size="mini"
                      variant="destructive"
                      disabled={remove.busy}
                      onClick={() => {
                        if (window.confirm(`Delete this backup?\n\n${row.path}\n\nThis cannot be undone.`)) void remove.run(row.id).then(refresh);
                      }}
                    >
                      Delete
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        ) : (
          <EmptyState title="No backups here yet" text={s?.dir ? 'Back Up Now writes the first one into the folder above.' : 'Choose where backups go, then Back Up Now.'} />
        )}
      </PanelSection>

      <PanelSection title="Files from another companion">
        <div className="companion-actions">
          <Button
            busy={restore.busy}
            onClick={() =>
              void restore.run().then((result) => {
                if (result?.restored) toast.show('Restored.', { kind: 'success' });
                else if (result?.reason) toast.show(result.reason, { kind: 'warning' });
                refresh();
              })
            }
            ellipsis
          >
            Restore from a file
          </Button>
          <Button
            busy={exportPlaylists.busy}
            onClick={() =>
              void exportPlaylists.run().then((result) => {
                if (result?.path) toast.show(`Exported ${result.count} playlist${result.count === 1 ? '' : 's'}`, { kind: 'success' });
                else if (result?.reason) toast.show(result.reason, { kind: 'info' });
              })
            }
            ellipsis
          >
            Export playlists
          </Button>
        </div>
        <p className="companion-hint">A backup&rsquo;s data.json, or a playlist export from this or another companion. Folders are never restored from a file: their locations are specific to each computer.</p>
      </PanelSection>
    </Panel>
  );
}

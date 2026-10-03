/**
 * Backup, restore, export and import.
 *
 * The design's pane, with only what the hub really has: where backups go and how much room is
 * there (measured, never guessed), the archives, and Back Up Now. The design also draws a path
 * field, an Include list, a schedule and a per-archive Download; the hub has no settings or routes
 * for those, so they are not drawn. Restore and Import ask first and say what they will do, because
 * they are the two actions here that replace data.
 */
import { useCallback, useState } from 'react';
import type { BackupSpace } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, Ago, count, EmptyCells, formatBytes, Group, listState, Note, Push, useHubUi } from '../ui.js';

interface BackupEntry {
  id: string;
  createdAt: string;
  sizeBytes: number;
  relativePath: string;
}

interface ImportReport {
  dryRun: boolean;
  applied: Record<string, number>;
  errors: string[];
}

function saveFile(data: unknown, name: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function BackupView() {
  const backups = useResource('backupList', {}, { pollMs: 30_000 });
  const space = useResource('backupSpace', {}, { pollMs: 60_000 });
  const { say, confirm } = useHubUi();
  const create = useAction(async () => api('backupCreate'));
  const restore = useAction(async (backupId: string) => api('backupRestore', { params: { backupId }, body: { confirm: true } }));
  const importAll = useAction(async (payload: { schemaVersion: number; data: Record<string, unknown> }, dryRun: boolean) => api('importAll', { query: { dryRun }, body: payload }));
  const [report, setReport] = useState<ImportReport | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);

  const exportNow = useAction(async () => {
    const data = await api('exportAll');
    saveFile(data, `airwave-hub-export-${new Date().toISOString().slice(0, 10)}.json`);
    return data;
  });

  const pickFile = useCallback(
    (dryRun: boolean) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        setFileProblem(null);
        let parsed: { schemaVersion: number; data: Record<string, unknown> };
        try {
          parsed = JSON.parse(await file.text()) as typeof parsed;
          if (typeof parsed?.schemaVersion !== 'number' || typeof parsed.data !== 'object') throw new Error('not an export');
        } catch {
          setFileProblem('That file isn’t an Airwave Hub export. Choose a file made with Export.');
          return;
        }
        if (!dryRun && !(await confirm({ title: `Import ${file.name}?`, text: 'Its groups, history, playlists and presets are added to this hub. Devices are not imported and pair again.', verb: 'Import' }))) return;
        const result = (await importAll.run(parsed, dryRun)) as ImportReport | null;
        if (result) {
          setReport(result);
          say(dryRun ? 'Checked the file. Nothing was written.' : 'Import finished.');
        }
      };
      input.click();
    },
    [importAll, say, confirm],
  );

  const items = (backups.data as { items: BackupEntry[] } | null)?.items ?? [];
  const state = listState(backups, (d) => (d as { items: BackupEntry[] }).items.length === 0, 'No backups yet.');
  const sp = space.data as BackupSpace | null;
  const known = sp !== null && sp.freeBytes !== null && sp.totalBytes !== null && sp.totalBytes > 0;
  const next = sp?.lastArchiveBytes ?? 0;
  const used = known ? sp.totalBytes! - sp.freeBytes! : 0;
  const short = known && next > sp.freeBytes!;
  const usedPercent = known ? (used / sp.totalBytes!) * 100 : 0;
  const nextPercent = known ? Math.max(0.6, Math.min(100 - usedPercent, (next / sp.totalBytes!) * 100)) : 0;

  return (
    <Group title="Backup">
      <div className="pref">
        <span className="k">Backups go to:</span>
        <div className="v">
          <span className="path">{sp?.path ?? '…'}</span>
          <span className="sub">Inside the container’s data volume, so whatever backs up the volume backs these up too.</span>
        </div>
        <span className="k top">Space:</span>
        <div className="v stack">
          {known ? (
            <>
              <span>
                <b>{formatBytes(sp.freeBytes)} free</b> of {formatBytes(sp.totalBytes)} · {sp.lastArchiveBytes === null ? 'the size of a backup is known once one exists' : `each backup is about ${formatBytes(sp.lastArchiveBytes)}`}
              </span>
              <div className={`bar spacebar${short ? ' is-short' : ''}`} role="img" aria-label={`${formatBytes(used)} used, ${formatBytes(sp.freeBytes)} free${sp.lastArchiveBytes === null ? '' : `, the next backup about ${formatBytes(next)}`}`}>
                <i className="used" style={{ width: `${usedPercent}%` }} />
                {sp.lastArchiveBytes === null ? null : <i className="this" style={{ left: `${usedPercent}%`, width: `${nextPercent}%` }} />}
              </div>
              {short ? (
                <span className="note note--bad note--row" role="alert">
                  The next backup is not expected to fit. Free some space on the data volume first.
                </span>
              ) : null}
            </>
          ) : (
            <span className="sub">{sp ? 'The free space here could not be measured. The folder may not exist yet.' : space.error ? 'The free space could not be read.' : 'Measuring…'}</span>
          )}
        </div>
        {sp?.keep ? (
          <>
            <span className="k">Keep:</span>
            <div className="v">
              <span>The last {sp.keep} automatic backups</span>
              <span className="sub">Ones you make here are yours to keep or delete.</span>
            </div>
          </>
        ) : null}
      </div>

      <div className="well well--after">
        <table className="tbl" aria-label="Backups">
          <colgroup>
            <col />
            <col style={{ width: '18%' }} className="hide-sm" />
            <col style={{ width: '16%' }} />
            <col style={{ width: 98 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Archive</th>
              <th scope="col" className="hide-sm">
                Taken
              </th>
              <th scope="col" className="num">
                Size
              </th>
              <th scope="col">
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state ? <EmptyCells columns={4} {...state} /> : null}
            {state
              ? null
              : items.map((row) => (
                  <tr key={row.id}>
                    <td className="mono" title={row.relativePath}>
                      {row.relativePath}
                    </td>
                    <td className="hide-sm">
                      <Ago iso={row.createdAt} />
                    </td>
                    <td className="num">{formatBytes(row.sizeBytes)}</td>
                    <td className="acts">
                      <Push
                        busy={restore.busy}
                        aria-label={`Restore ${row.id}`}
                        onClick={() =>
                          void confirm({
                            title: 'Restore this backup?',
                            text: 'Everything on the hub goes back to how it was then. The current state is backed up first, then the hub restarts and is away for a few seconds.',
                            verb: 'Restore',
                          }).then((go) => {
                            if (!go) return;
                            void restore.run(row.id).then((r) => {
                              // No reload: the hub exits as soon as it has answered.
                              if (r) setRestarting((r as { safetyBackupId: string }).safetyBackupId);
                            });
                          })
                        }
                      >
                        Restore…
                      </Push>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      <div className="barrow">
        <Push
          busy={create.busy}
          busyLabel="Backing Up…"
          disabled={short}
          reason="There isn’t room for another backup."
          onClick={() =>
            void create.run().then((r) => {
              if (!r) return;
              backups.reload();
              space.reload();
              say('Backup written.');
            })
          }
        >
          Back Up Now
        </Push>
        <Push busy={exportNow.busy} onClick={() => void exportNow.run().then((r) => r && say('Exported. The file is in your downloads.'))}>
          Export…
        </Push>
        <Push busy={importAll.busy} onClick={() => pickFile(true)}>
          Check an Export…
        </Push>
        <Push busy={importAll.busy} onClick={() => pickFile(false)}>
          Import…
        </Push>
      </div>
      {restarting ? (
        <Note>
          Restored. What was here before is saved as <span className="mono">{restarting}</span>. The hub is restarting; reload this page in a few seconds.
        </Note>
      ) : null}
      {fileProblem ? <Note bad>{fileProblem}</Note> : <ActionError error={restore.error ?? create.error ?? importAll.error ?? exportNow.error} />}
      {report ? (
        <div className="well well--after" role="status">
          <ul className="rows" aria-label={report.dryRun ? 'What the file would import' : 'What was imported'}>
            <li>
              <span className="grow">
                <b>{report.dryRun ? 'This file would import' : 'Imported'}</b>:{' '}
                {Object.entries(report.applied)
                  .map(([key, n]) => count(n, key.replace(/s$/, ''), key))
                  .join(', ') || 'nothing'}
                .
              </span>
            </li>
            {report.errors.map((e, i) => (
              <li key={i}>
                <span className="grow">{e}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Note>A backup is the hub’s whole database, taken while it keeps running. An export is a portable copy with no passwords, tokens or provider credentials, so it is safe to move between machines.</Note>
    </Group>
  );
}

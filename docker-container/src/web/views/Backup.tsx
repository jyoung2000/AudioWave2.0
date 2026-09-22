/**
 * Backup, restore, export and import.
 *
 * Restore asks twice and says what it will do first, because it is the one action here that can
 * lose data. The export is described as what it is — a portable copy without secrets — rather than
 * being presented as an equivalent to a backup, because it is not one.
 */
import { useCallback, useState } from 'react';
import { AquaTable, Button, Panel, PanelSection, useToast } from '@now-playing/aqua-ui';
import { api } from '../lib/api.js';
import type { BackupSpace } from '@now-playing/contracts';
import { useAction, useResource } from '../lib/hooks.js';
import { Ago, AsyncPanel, Bytes, InlineError } from './common.js';

interface BackupEntry {
  id: string;
  createdAt: string;
  sizeBytes: number;
  relativePath: string;
}

export function BackupView() {
  const backups = useResource('backupList', {}, { pollMs: 30_000 });
  const toast = useToast();
  const create = useAction(async () => api('backupCreate'));
  const restore = useAction(async (backupId: string) => api('backupRestore', { params: { backupId }, body: { confirm: true } }));
  const importAll = useAction(async (payload: { schemaVersion: number; data: Record<string, unknown> }, dryRun: boolean) => api('importAll', { query: { dryRun }, body: payload }));
  const [importReport, setImportReport] = useState<{ dryRun: boolean; applied: Record<string, number>; errors: string[] } | null>(null);

  const exportNow = useAction(async () => {
    const data = await api('exportAll');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `now-playing-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
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
        try {
          const parsed = JSON.parse(await file.text()) as { schemaVersion: number; data: Record<string, unknown> };
          const report = await importAll.run(parsed, dryRun);
          if (report) {
            setImportReport(report as typeof importReport);
            toast.show(dryRun ? 'Checked the file; nothing was written.' : 'Import finished.', { kind: 'success' });
          }
        } catch (err) {
          toast.show(`That file is not a Now Playing export: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
        }
      };
      input.click();
    },
    [importAll, toast],
  );

  return (
    <>
      <BackupSpacePanel />
      <AsyncPanel
        resource={backups}
        title="Backups"
        actions={
          <>
            <Button
              variant="default"
              busy={create.busy}
              onClick={() =>
                void create.run().then((r) => {
                  if (r) {
                    backups.reload();
                    toast.show('Backup written to the data volume', { kind: 'success' });
                  }
                })
              }
            >
              Back up now
            </Button>
            <InlineError error={restore.error ?? create.error} />
          </>
        }
        emptyWhen={(d) => (d as { items: BackupEntry[] }).items.length === 0}
        emptyTitle="No backups yet"
        emptyText="A backup is a consistent copy of the database taken while the hub keeps running. It lands in the data volume, so whatever backs that up backs this up too."
      >
        {(raw) => (
          <AquaTable
            label="Backups"
            rowKey={(row: BackupEntry) => row.id}
            rows={(raw as { items: BackupEntry[] }).items}
            columns={[
              { id: 'id', header: 'Backup', primary: true, cell: (row) => row.id },
              { id: 'when', header: 'Taken', cell: (row) => <Ago iso={row.createdAt} /> },
              { id: 'size', header: 'Size', align: 'right', cell: (row) => <Bytes value={row.sizeBytes} /> },
              { id: 'path', header: 'Path', cell: (row) => <code>{row.relativePath}</code> },
              {
                id: 'actions',
                header: '',
                headerLabel: 'Actions',
                cell: (row) => (
                  <Button
                    size="small"
                    variant="destructive"
                    busy={restore.busy}
                    onClick={() => {
                      // A destructive, irreversible action deserves a blocking prompt.
                      if (!window.confirm(`Restore ${row.id}?\n\nA safety backup of the current database is taken first, then this file replaces it. The hub restarts itself immediately afterwards and is unreachable for a few seconds.`)) return;
                      void restore.run(row.id).then((r) => {
                        if (r) {
                          const result = r as { safetyBackupId: string };
                          // No reload: the hub exits as soon as this response is written, so any
                          // further request would fail until the supervisor has brought it back.
                          toast.show(`Restored. The current database was saved as ${result.safetyBackupId}. The hub is restarting — reload this page in a few seconds.`, { kind: 'warning', durationMs: 30_000 });
                        } else {
                          toast.show('The restore did not complete; the details are shown above the list.', { kind: 'error' });
                        }
                      });
                    }}
                  >
                    Restore
                  </Button>
                ),
              },
            ]}
          />
        )}
      </AsyncPanel>

      <Panel title="Export and import">
        <PanelSection>
          <p className="admin-hint">
            An export is a portable JSON copy of groups, history, playlists, presets and device metadata. It deliberately contains <strong>no secrets at all</strong>: no password hashes, no provider
            credentials, no device credentials, no tokens. That makes it safe to move between machines, and means devices must pair again after importing.
          </p>
          <div className="admin-actions">
            <Button busy={exportNow.busy} onClick={() => void exportNow.run()}>
              Export
            </Button>
            <Button busy={importAll.busy} onClick={() => pickFile(true)} ellipsis>
              Check an export
            </Button>
            <Button variant="destructive" busy={importAll.busy} onClick={() => pickFile(false)} ellipsis>
              Import
            </Button>
          </div>
          <InlineError error={importAll.error} />
          {importReport ? (
            <div className="admin-report">
              <h4 className="admin-subhead">{importReport.dryRun ? 'Would import' : 'Imported'}</h4>
              <ul className="admin-list">
                {Object.entries(importReport.applied).map(([key, count]) => (
                  <li key={key}>
                    {count} {key}
                  </li>
                ))}
              </ul>
              {importReport.errors.length ? (
                <ul className="admin-alerts">
                  {importReport.errors.map((e, i) => (
                    <li key={i} data-level="warning">
                      {e}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </PanelSection>
      </Panel>
    </>
  );
}

/**
 * Room at the backup location. The bar is drawn only from measured numbers: what is used, what the
 * next backup is expected to take (the size of the newest one — a backup is the whole database, so
 * the last is the best estimate of the next), and what would be left. With nothing to go on, it
 * says so instead of drawing a guess.
 */
function BackupSpacePanel() {
  const space = useResource('backupSpace', {}, { pollMs: 60_000 });
  const data = space.data as BackupSpace | null;
  if (!data) return null;
  const { freeBytes, totalBytes, lastArchiveBytes } = data;
  const known = freeBytes !== null && totalBytes !== null && totalBytes > 0;
  const next = lastArchiveBytes ?? 0;
  const fits = known && next <= freeBytes;
  const usedPercent = known ? ((totalBytes - freeBytes) / totalBytes) * 100 : 0;
  const nextPercent = known ? Math.min(100 - usedPercent, (next / totalBytes) * 100) : 0;
  return (
    <Panel title="Backup location">
      <PanelSection>
        <p className="admin-hint">
          <code>{data.path}</code>
          {data.keep ? ` · the newest ${data.keep} scheduled and safety backups are kept; ones you make here are yours to delete` : ''}
        </p>
        {known ? (
          <>
            <div className="admin-space" role="img" aria-label={`${Math.round(usedPercent)}% used, next backup about ${Math.round(nextPercent * 10) / 10}%, the rest free`}>
              <span className="admin-space__used" style={{ width: `${usedPercent}%` }} />
              <span className="admin-space__next" style={{ width: `${nextPercent}%` }} />
            </div>
            <p className="admin-hint">
              <Bytes value={totalBytes - freeBytes} /> used · next backup {lastArchiveBytes === null ? 'not known until one exists' : <>about <Bytes value={lastArchiveBytes} /></>} · <Bytes value={Math.max(0, freeBytes - next)} /> free after it
            </p>
            {fits ? null : (
              <p className="admin-hint admin-hint--warning" role="alert">
                The next backup is not expected to fit: only <Bytes value={freeBytes} /> is free here.
              </p>
            )}
          </>
        ) : (
          <p className="admin-hint admin-hint--warning">This location’s free space could not be measured — the folder may not exist yet, or the drive did not answer.</p>
        )}
      </PanelSection>
    </Panel>
  );
}

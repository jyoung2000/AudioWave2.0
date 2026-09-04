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
      <AsyncPanel
        resource={backups}
        title="Backups"
        actions={
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
                      if (!window.confirm(`Restore ${row.id}?\n\nA safety backup of the current database is taken first, then this file replaces it. The hub must be restarted afterwards.`)) return;
                      void restore.run(row.id).then((r) => {
                        if (r) {
                          const result = r as { safetyBackupId: string };
                          toast.show(`Restored. The current database was saved as ${result.safetyBackupId}. Restart the container now.`, { kind: 'warning', durationMs: 30_000 });
                          backups.reload();
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

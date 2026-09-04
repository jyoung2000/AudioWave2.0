/**
 * Music folders on this computer.
 *
 * A folder that has become unavailable — an unplugged drive, a disconnected share — is shown as
 * unavailable with its tracks still listed, because they are not gone, they are just not reachable
 * right now. Emptying the library on a temporary disconnection would be wrong and alarming.
 */
import { useState } from 'react';
import { AquaTable, Button, EmptyState, Panel, PanelSection, ProgressBar, StatusDot, useToast } from '@now-playing/aqua-ui';
import type { LibraryFolder, ScanProgress } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { useAction, useChannel, useEvent } from '../hooks.js';

export function FoldersView({ onFoldersChanged }: { onFoldersChanged: () => void }) {
  const folders = useChannel('library:folders', undefined, { pollMs: 4_000 });
  const toast = useToast();
  const [progress, setProgress] = useState<Record<string, ScanProgress>>({});

  useEvent('event:scan-progress', (payload) => setProgress((current) => ({ ...current, [payload.folderId]: payload })));

  const add = useAction(async () => invoke('library:add-folder', undefined));
  const remove = useAction(async (folderId: string) => invoke('library:remove-folder', { folderId }));
  const scan = useAction(async (folderId?: string) => invoke('library:scan', folderId ? { folderId } : {}));

  const items = folders.data?.items ?? [];

  return (
    <Panel title="Music folders">
      <PanelSection>
        <p className="companion-hint">
          The companion reads music where it already is. Nothing is copied or moved, and folder locations stay on this computer — a hub is told a folder's name and what is in it, never where it lives.
        </p>
        <div className="companion-actions">
          <Button
            variant="default"
            busy={add.busy}
            onClick={() =>
              void add.run().then((result) => {
                if (result?.folder) {
                  toast.show(`Added ${result.folder.displayName}. Scanning…`, { kind: 'success' });
                  folders.reload();
                  onFoldersChanged();
                } else if (result?.reason) {
                  toast.show(result.reason, { kind: 'warning' });
                }
              })
            }
            ellipsis
          >
            Add a folder
          </Button>
          <Button busy={scan.busy} disabled={!items.length} onClick={() => void scan.run().then((r) => r?.reason && toast.show(r.reason, { kind: 'info' }))}>
            Scan all folders
          </Button>
        </div>
        {add.error ? <p className="companion-hint companion-hint--error">{add.error}</p> : null}
      </PanelSection>

      {items.length ? (
        <AquaTable
          label="Music folders"
          rowKey={(row: LibraryFolder) => row.id}
          rows={items}
          columns={[
            { id: 'name', header: 'Folder', primary: true, cell: (row) => row.displayName, stackText: (row) => row.path },
            { id: 'path', header: 'Location', cell: (row) => <code className="companion-path">{row.path}</code> },
            {
              id: 'status',
              header: 'Status',
              width: 150,
              cell: (row) => {
                const live = progress[row.id];
                if (live && !live.done) return <ProgressBar value={live.found ? (live.indexed + live.skipped) / live.found * 100 : null} label={`Scanning — ${live.indexed + live.skipped} of ${live.found}`} />;
                if (!row.available) return <StatusDot kind="warning" label="Unavailable" />;
                if (row.lastScanError) return <StatusDot kind="error" label="Problem" />;
                return <StatusDot kind="ok" label="Ready" />;
              },
            },
            { id: 'tracks', header: 'Tracks', align: 'right', width: 72, cell: (row) => row.trackCount.toLocaleString() },
            { id: 'size', header: 'Size', align: 'right', width: 88, cell: (row) => formatBytes(row.sizeBytes) },
            { id: 'scanned', header: 'Last scanned', cell: (row) => (row.lastScanError ? row.lastScanError : row.lastScanAt ? new Date(row.lastScanAt).toLocaleString() : 'never') },
            {
              id: 'actions',
              header: '',
              headerLabel: 'Actions',
              width: 150,
              cell: (row) => (
                <span className="companion-row-actions">
                  <Button size="mini" disabled={!row.available} onClick={() => void scan.run(row.id)}>
                    Rescan
                  </Button>
                  <Button
                    size="mini"
                    variant="destructive"
                    onClick={() => {
                      if (window.confirm(`Stop using ${row.displayName}?\n\nYour files are not touched — only this app's index of them is removed.`)) {
                        void remove.run(row.id).then(() => {
                          folders.reload();
                          onFoldersChanged();
                        });
                      }
                    }}
                  >
                    Remove
                  </Button>
                </span>
              ),
            },
          ]}
        />
      ) : (
        <EmptyState title="No folders yet" text="Add the folder your music is in. The companion indexes it in place; your files are never copied or moved." actions={[{ id: 'add', label: 'Add a folder', variant: 'default', onSelect: () => void add.run().then(() => folders.reload()) }]} />
      )}

      {items.some((f) => !f.available) ? (
        <PanelSection>
          <p className="companion-hint companion-hint--warning">
            Some folders are not reachable right now. Their tracks are still listed, because they are not gone — reconnect the drive or the network share and rescan.
          </p>
        </PanelSection>
      ) : null}
    </Panel>
  );
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

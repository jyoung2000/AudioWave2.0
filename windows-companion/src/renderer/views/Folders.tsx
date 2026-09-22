/**
 * The folders on this computer: Saved Music, Saved TV and Saved Movies, as the mockup's Library tab
 * groups them. Music is indexed; TV and movie folders are kept, watched and backed up, not indexed.
 *
 * A folder that has become unavailable — an unplugged drive, a disconnected share — is shown as
 * unavailable with its tracks still listed, because they are not gone, they are just not reachable
 * right now. Emptying the library on a temporary disconnection would be wrong and alarming.
 */
import { useState } from 'react';
import { AquaTable, Button, EmptyState, Panel, PanelSection, ProgressBar, StatusDot, useToast } from '@now-playing/aqua-ui';
import type { FolderKind, LibraryFolder, ScanProgress } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { useAction, useChannel, useEvent } from '../hooks.js';

const KINDS: ReadonlyArray<{ kind: FolderKind; title: string; noun: string; empty: string }> = [
  { kind: 'music', title: 'Saved Music', noun: 'music', empty: 'Add the folder your music is in. The companion indexes it in place; your files are never copied or moved.' },
  { kind: 'tv', title: 'Saved TV', noun: 'TV', empty: 'A TV folder is kept for the backup and the Live TV tab. It is not indexed as music.' },
  { kind: 'movies', title: 'Saved Movies', noun: 'movie', empty: 'A movies folder is kept for the backup. It is not indexed as music.' },
];

export function FoldersView({ onFoldersChanged }: { onFoldersChanged: () => void }) {
  const folders = useChannel('library:folders', undefined, { pollMs: 4_000 });
  const toast = useToast();
  const [progress, setProgress] = useState<Record<string, ScanProgress>>({});

  useEvent('event:scan-progress', (payload) => setProgress((current) => ({ ...current, [payload.folderId]: payload })));

  const add = useAction(async (kind: FolderKind) => invoke('library:add-folder', { kind }));
  const remove = useAction(async (folderId: string) => invoke('library:remove-folder', { folderId }));
  const scan = useAction(async (folderId?: string) => invoke('library:scan', folderId ? { folderId } : {}));

  const items = folders.data?.items ?? [];
  const changed = () => {
    folders.reload();
    onFoldersChanged();
  };
  const addFolder = (kind: FolderKind) =>
    void add.run(kind).then((result) => {
      if (result?.folder) {
        toast.show(kind === 'music' ? `Added ${result.folder.displayName}. Scanning…` : `Added ${result.folder.displayName}.`, { kind: 'success' });
        changed();
      } else if (result?.reason) {
        toast.show(result.reason, { kind: 'warning' });
      }
    });

  return (
    <Panel title="Folders">
      <PanelSection>
        <p className="companion-hint">
          The folders on this PC that Now Playing plays from. The companion reads music where it already is — nothing is copied or moved — and folder locations stay on this computer: a hub is told a
          folder&rsquo;s name and what is in it, never where it lives.
        </p>
        <div className="companion-actions">
          <Button busy={scan.busy} disabled={!items.some((f) => f.kind === 'music')} onClick={() => void scan.run().then((r) => r?.reason && toast.show(r.reason, { kind: 'info' }))}>
            Scan all music folders
          </Button>
        </div>
        {add.error ? <p className="companion-hint companion-hint--error">{add.error}</p> : null}
      </PanelSection>

      {KINDS.map(({ kind, title, noun, empty }) => {
        const rows = items.filter((f) => f.kind === kind);
        return (
          <PanelSection key={kind} title={title}>
            {rows.length ? (
              <FolderTable label={`${title} folders`} rows={rows} progress={progress} indexed={kind === 'music'} onScan={(id) => void scan.run(id)} onRemove={(row) => void remove.run(row.id).then(changed)} />
            ) : (
              <EmptyState title={`No ${noun} folders yet`} text={empty} />
            )}
            <div className="companion-actions">
              <Button variant={kind === 'music' && !rows.length ? 'default' : 'neutral'} busy={add.busy} onClick={() => addFolder(kind)} ellipsis>
                Add Folder
              </Button>
            </div>
          </PanelSection>
        );
      })}

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

function FolderTable({ label, rows, progress, indexed, onScan, onRemove }: { label: string; rows: LibraryFolder[]; progress: Record<string, ScanProgress>; indexed: boolean; onScan: (id: string) => void; onRemove: (row: LibraryFolder) => void }) {
  return (
    <AquaTable
      label={label}
      rowKey={(row: LibraryFolder) => row.id}
      rows={rows}
      columns={[
        { id: 'name', header: 'Folder', primary: true, cell: (row) => row.displayName, stackText: (row) => row.path },
        { id: 'path', header: 'Location', cell: (row) => <code className="companion-path">{row.path}</code> },
        {
          id: 'status',
          header: 'Status',
          width: 150,
          cell: (row) => {
            const live = progress[row.id];
            if (live && !live.done) return <ProgressBar value={live.found ? ((live.indexed + live.skipped) / live.found) * 100 : null} label={`Scanning — ${live.indexed + live.skipped} of ${live.found}`} />;
            if (!row.available) return <StatusDot kind="warning" label="Unavailable" />;
            if (row.lastScanError) return <StatusDot kind="error" label="Problem" />;
            return <StatusDot kind="ok" label={indexed ? 'Ready' : 'Kept'} />;
          },
        },
        ...(indexed
          ? [
              { id: 'tracks', header: 'Tracks', align: 'right' as const, width: 72, cell: (row: LibraryFolder) => row.trackCount.toLocaleString() },
              { id: 'size', header: 'Size', align: 'right' as const, width: 88, cell: (row: LibraryFolder) => formatBytes(row.sizeBytes) },
              { id: 'scanned', header: 'Last scanned', cell: (row: LibraryFolder) => (row.lastScanError ? row.lastScanError : row.lastScanAt ? new Date(row.lastScanAt).toLocaleString() : 'never') },
            ]
          : []),
        {
          id: 'actions',
          header: '',
          headerLabel: 'Actions',
          width: 150,
          cell: (row) => (
            <span className="companion-row-actions">
              {indexed ? (
                <Button size="mini" disabled={!row.available} onClick={() => onScan(row.id)}>
                  Rescan
                </Button>
              ) : null}
              <Button
                size="mini"
                variant="destructive"
                onClick={() => {
                  if (window.confirm(`Stop using ${row.displayName}?\n\nYour files are not touched — only this app's record of the folder is removed.`)) onRemove(row);
                }}
              >
                Remove
              </Button>
            </span>
          ),
        },
      ]}
    />
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

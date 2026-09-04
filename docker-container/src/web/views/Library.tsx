/**
 * The hub's own library: directories inside the mounted data volume.
 *
 * Roots are relative paths under `/data`, never absolute ones — the hub cannot and must not reach
 * outside its volume, and the UI says so rather than offering a file picker that would lie.
 */
import { useState } from 'react';
import { AquaTable, Button, Panel, PanelSection, SearchField, StatusDot, TextField, useToast } from '@now-playing/aqua-ui';
import type { LibraryRoot, Track } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { Ago, AsyncPanel, ConfirmButton, Duration, InlineError } from './common.js';

export function LibraryView() {
  const roots = useResource('libraryRoots', {}, { pollMs: 15_000 });
  const [query, setQuery] = useState('');
  const tracks = useResource('libraryTracks', { query: { limit: 100, ...(query ? { q: query } : {}) } });
  const toast = useToast();

  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const addRoot = useAction(async () => api('libraryRootAdd', { body: { relativePath: path.trim(), displayName: name.trim() || path.trim() } }));
  const removeRoot = useAction(async (rootId: string) => api('libraryRootRemove', { params: { rootId } }));
  const scan = useAction(async () => api('libraryScan'));

  return (
    <>
      <Panel title="Library folders">
        <PanelSection title="Add a folder">
          <div className="admin-form">
            <TextField
              label="Path inside the data volume"
              value={path}
              onChange={(e) => setPath(e.currentTarget.value)}
              placeholder="library/Albums"
              hint="Relative to the mounted /data directory. The hub cannot read anything outside it."
              spellCheck={false}
            />
            <TextField label="Display name" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Albums" />
            <div className="admin-actions">
              <Button
                variant="default"
                busy={addRoot.busy}
                disabled={!path.trim()}
                onClick={() =>
                  void addRoot.run().then((r) => {
                    if (r) {
                      setPath('');
                      setName('');
                      roots.reload();
                      toast.show('Folder added. Scan it to index the files.');
                    }
                  })
                }
              >
                Add folder
              </Button>
              <Button busy={scan.busy} onClick={() => void scan.run().then((r) => r && toast.show(`Scanning ${(r as { roots: number }).roots} folder(s)`))}>
                Scan now
              </Button>
            </div>
            <InlineError error={addRoot.error} />
          </div>
        </PanelSection>

        <AsyncPanel resource={roots} emptyWhen={(d) => (d as { items: LibraryRoot[] }).items.length === 0} emptyTitle="No folders registered" emptyText="Put music under the data volume and add the folder above.">
          {(raw) => (
            <AquaTable
              label="Library folders"
              rowKey={(row: LibraryRoot) => row.id}
              rows={(raw as { items: LibraryRoot[] }).items}
              columns={[
                { id: 'name', header: 'Name', primary: true, cell: (row) => row.displayName },
                { id: 'path', header: 'Path', cell: (row) => <code>{row.handleId}</code> },
                { id: 'status', header: 'Status', cell: (row) => <StatusDot kind={row.status === 'connected' ? 'ok' : row.status === 'missing' ? 'error' : 'warning'} label={row.status} /> },
                { id: 'tracks', header: 'Tracks', align: 'right', cell: (row) => row.trackCount },
                { id: 'scan', header: 'Last scan', cell: (row) => (row.lastScanError ? row.lastScanError : <Ago iso={row.lastScanAt} />) },
                {
                  id: 'actions',
                  header: '',
                  headerLabel: 'Actions',
                  cell: (row) => (
                    <ConfirmButton
                      label="Remove"
                      confirmLabel={`Stop indexing ${row.displayName}? The files are left exactly where they are.`}
                      busy={removeRoot.busy}
                      onConfirm={() => void removeRoot.run(row.id).then(() => roots.reload())}
                    />
                  ),
                },
              ]}
            />
          )}
        </AsyncPanel>
      </Panel>

      <AsyncPanel
        resource={tracks}
        title="Tracks"
        actions={<SearchField label="Search the library" value={query} onChange={setQuery} />}
        emptyWhen={(d) => (d as { items: Track[] }).items.length === 0}
        emptyTitle={query ? 'Nothing matches that' : 'No tracks indexed yet'}
        emptyText={query ? 'Try a different search.' : 'Add a folder and scan it.'}
      >
        {(raw) => {
          const page = raw as { items: Track[]; total?: number };
          return (
            <>
              <AquaTable
                label="Tracks"
                rowKey={(row: Track) => row.id}
                rows={page.items}
                columns={[
                  { id: 'title', header: 'Title', primary: true, cell: (row) => row.title },
                  { id: 'artist', header: 'Artist', cell: (row) => row.artistName },
                  { id: 'album', header: 'Album', cell: (row) => row.albumName ?? '' },
                  { id: 'year', header: 'Year', align: 'right', cell: (row) => row.year ?? '' },
                  { id: 'time', header: 'Time', align: 'right', cell: (row) => <Duration ms={row.durationMs} /> },
                  { id: 'format', header: 'Format', cell: (row) => row.format?.codec ?? row.format?.container ?? '' },
                  { id: 'note', header: 'Note', cell: (row) => row.unsupportedReason ?? '' },
                ]}
              />
              {page.total !== undefined ? <p className="admin-hint">{page.total} tracks indexed.</p> : null}
            </>
          );
        }}
      </AsyncPanel>
    </>
  );
}

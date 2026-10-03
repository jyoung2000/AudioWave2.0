/**
 * The hub's own library: folders inside the mounted data volume.
 *
 * A folder is a path relative to the data volume, never an absolute one — the hub cannot and must
 * not reach outside its volume, and the form says so rather than offering a file picker that would
 * lie. Each folder's row has its own Scan, which indexes that folder alone; Scan Now under the table
 * does every folder.
 */
import { useState, type FormEvent } from 'react';
import type { LibraryRoot, Track } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, Ago, count, EmptyCells, Field, formatClock, Group, listState, Note, Push, Sdot, SubHead, useHubUi, type DotKind } from '../ui.js';

const ROOT_STATUS: Record<string, { dot: DotKind; word: string }> = {
  connected: { dot: 'ok', word: 'Ready' },
  scanning: { dot: 'busy', word: 'Scanning' },
  missing: { dot: 'bad', word: 'Folder not found' },
  error: { dot: 'bad', word: 'Could not be read' },
  'needs-permission': { dot: 'warn', word: 'Needs permission' },
  removed: { dot: 'off', word: 'Removed' },
};

export function LibraryView() {
  const roots = useResource('libraryRoots', {}, { pollMs: 15_000 });
  const [query, setQuery] = useState('');
  const tracks = useResource('libraryTracks', { query: { limit: 100, ...(query ? { q: query } : {}) } });
  // Where the data volume is mounted, so paths read as the container sees them (/data/library/…).
  const storage = useResource('downloadsStorage');
  const dataDir = ((storage.data as { dataDir: string } | null)?.dataDir ?? '/data').replaceAll('\\', '/').replace(/\/+$/, '');
  const base = `${dataDir}/library`;
  const { say, confirm } = useHubUi();

  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const addRoot = useAction(async (relativePath: string, displayName: string) => api('libraryRootAdd', { body: { relativePath, displayName } }));
  const removeRoot = useAction(async (rootId: string) => api('libraryRootRemove', { params: { rootId } }));
  const scan = useAction(async () => api('libraryScan'));
  const scanOne = useAction(async (rootId: string) => api('libraryScanRoot', { params: { rootId } }));
  const [scanningId, setScanningId] = useState<string | null>(null);
  const scanFolder = (row: LibraryRoot): void => {
    setScanningId(row.id);
    void scanOne.run(row.id).then((r) => {
      setScanningId(null);
      if (!r) return;
      say(`Scanning ${row.displayName}.`);
      roots.reload();
    });
  };

  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    // Typed as the container sees it ("/data/library/Albums") or relative to that folder
    // ("Albums"): the hub stores the relative form either way.
    const typed = path.trim().replaceAll('\\', '/');
    const inside = typed.toLowerCase().startsWith(`${base.toLowerCase()}/`);
    const relative = (inside ? typed.slice(base.length + 1) : typed).replace(/\/+$/, '');
    if (!relative || relative.split('/').includes('..') || /^(\/|[a-z]:)/i.test(relative)) {
      setProblem(`Use a folder inside the data volume, such as ${base}/Albums.`);
      return;
    }
    setProblem(null);
    const made = await addRoot.run(relative, name.trim() || relative.split('/').pop() || relative);
    if (made) {
      setPath('');
      setName('');
      roots.reload();
      say('Folder added. Scan to index its files.');
    }
  };

  const rootItems = (roots.data as { items: LibraryRoot[] } | null)?.items ?? [];
  const rootState = listState(roots, (d) => (d as { items: LibraryRoot[] }).items.length === 0, 'No folders yet. Put music in the data volume and add its folder below.');
  const page = tracks.data as { items: Track[]; total?: number } | null;
  const trackState = listState(tracks, (d) => (d as { items: Track[] }).items.length === 0, query ? 'Nothing matches that.' : 'No tracks yet. Add a folder and scan it.');

  return (
    <Group
      title="Library folders"
      hint={
        <>
          Folders inside the container’s data volume, under <code>{base}</code>. The Windows companion’s folders arrive through it, not here.
        </>
      }
    >
      <div className="well">
        <table className="tbl" aria-label="Library folders">
          <colgroup>
            <col style={{ width: '32%' }} />
            <col className="hide-sm" />
            <col style={{ width: 72 }} />
            <col style={{ width: 150 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="hide-sm">
                Path
              </th>
              <th scope="col" className="num">
                Tracks
              </th>
              <th scope="col">
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rootState ? <EmptyCells columns={4} {...rootState} /> : null}
            {rootState
              ? null
              : rootItems.map((row) => {
                  const status = ROOT_STATUS[row.status] ?? { dot: 'warn' as const, word: 'Needs attention' };
                  return (
                    <tr key={row.id}>
                      <td title={row.lastScanError ?? `${status.word}${row.lastScanAt ? '' : ' · not scanned yet'}`}>
                        <Sdot kind={status.dot} label={status.word} inline />
                        {row.displayName}
                        {row.lastScanError ? <span className="sub"> · {row.lastScanError}</span> : null}
                      </td>
                      <td className="mono hide-sm" title={row.kind === 'hub-directory' && !row.handleId.includes(':') ? `${base}/${row.handleId}` : undefined}>
                        {row.kind === 'hub-directory' && !row.handleId.includes(':') ? `${base}/${row.handleId}` : <span className="sub">Outside the data volume, read-only</span>}
                      </td>
                      <td className="num">{row.trackCount.toLocaleString('en-US')}</td>
                      <td className="acts">
                        <Push busy={scanningId === row.id || row.status === 'scanning'} busyLabel="Scanning…" aria-label={`Scan ${row.displayName}`} onClick={() => scanFolder(row)}>
                          Scan
                        </Push>
                        <Push
                          busy={removeRoot.busy}
                          aria-label={`Remove ${row.displayName}`}
                          onClick={() =>
                            void confirm({ title: `Remove ${row.displayName}?`, text: 'The hub stops indexing this folder. The files stay exactly where they are.', verb: 'Remove' }).then((go) => {
                              if (go) void removeRoot.run(row.id).then(() => roots.reload());
                            })
                          }
                        >
                          Remove
                        </Push>
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      <form className="barrow" onSubmit={(event) => void add(event)} noValidate>
        <Field className="field--name" placeholder="Display name" aria-label="Display name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Field mono placeholder={`${base}/…`} aria-label="Path inside the data volume" value={path} invalid={Boolean(problem)} onChange={(e) => setPath(e.currentTarget.value)} />
        <Push type="submit" busy={addRoot.busy}>
          Add Folder
        </Push>
        <Push
          busy={scan.busy}
          busyLabel="Scanning…"
          disabled={rootItems.length === 0}
          reason="Add a folder first."
          onClick={() =>
            void scan.run().then((r) => {
              if (r) {
                say(`Scanning ${count((r as { roots: number }).roots, 'folder')}.`);
                roots.reload();
              }
            })
          }
        >
          Scan Now
        </Push>
      </form>
      {problem ? <Note bad>{problem}</Note> : <ActionError error={addRoot.error ?? removeRoot.error ?? scan.error ?? scanOne.error} />}

      <SubHead>Tracks</SubHead>
      <div className="barrow barrow--above">
        <Field type="search" className="field--search" placeholder="Search the library" aria-label="Search the library" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
        {page?.total !== undefined ? <span className="note note--inline">{count(page.total, 'track')} indexed{page.total > page.items.length ? `, showing the first ${page.items.length}` : ''}.</span> : null}
      </div>
      {/* The list scrolls inside its box, so it takes the keyboard like any other scrolling region. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className="well well--scroll" tabIndex={0} role="group" aria-label="Tracks">
        <table className="tbl" aria-label="Tracks">
          <colgroup>
            <col />
            <col style={{ width: '26%' }} />
            <col style={{ width: '24%' }} className="hide-sm" />
            <col style={{ width: 54 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Artist</th>
              <th scope="col" className="hide-sm">
                Album
              </th>
              <th scope="col" className="num">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {trackState ? <EmptyCells columns={4} {...trackState} /> : null}
            {trackState
              ? null
              : (page?.items ?? []).map((row) => (
                  <tr key={row.id} title={row.unsupportedReason ?? undefined}>
                    <td>
                      {row.title}
                      {row.unsupportedReason ? <span className="sub"> · can’t be played</span> : null}
                    </td>
                    <td>{row.artistName}</td>
                    <td className="hide-sm">{row.albumName ?? ''}</td>
                    <td className="num">{row.durationMs ? formatClock(row.durationMs) : '—'}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {rootItems.some((r) => r.lastScanAt) ? (
        <Note>
          Last scanned <Ago iso={rootItems.map((r) => r.lastScanAt).filter((t): t is string => Boolean(t)).sort().at(-1) ?? null} />.
        </Note>
      ) : null}
    </Group>
  );
}

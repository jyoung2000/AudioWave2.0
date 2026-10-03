/**
 * The folders on this PC: Saved Music, Saved TV and Saved Movies, as the design's Library tab draws
 * them — a well of paths with a round minus on each, and Add Folder… beneath, which opens Windows'
 * own folder picker. Music is indexed; TV and movie folders are kept, watched and backed up.
 *
 * A folder that has become unavailable — an unplugged drive, a disconnected share — stays in the
 * list and says so, with its tracks still indexed, because they are not gone, only out of reach.
 * Emptying the library on a temporary disconnection would be wrong and alarming.
 */
import { useState } from 'react';
import type { FolderKind, LibraryFolder, ScanProgress } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { plural } from '../format.js';
import { useAction, useEvent, type Resource } from '../hooks.js';
import { FolderIcon } from '../icons.js';
import { EmptyRow, LoadingRow, Push, Remove, Rows, useConfirm } from '../ui.js';

const KINDS: ReadonlyArray<{ kind: FolderKind; legend: string; label: string }> = [
  { kind: 'music', legend: 'Saved Music', label: 'Music folders' },
  { kind: 'tv', legend: 'Saved TV', label: 'TV folders' },
  { kind: 'movies', legend: 'Saved Movies', label: 'Movie folders' },
];

/** The few words at the end of a folder's row. */
function rowState(folder: LibraryFolder, live: ScanProgress | undefined): { text: string; bad?: boolean } {
  if (live && !live.done) return { text: live.found ? `scanning ${(live.indexed + live.skipped).toLocaleString()} of ${live.found.toLocaleString()}` : 'scanning…' };
  if (!folder.available) return { text: 'not connected', bad: true };
  if (folder.lastScanError) return { text: 'couldn’t scan', bad: true };
  if (folder.kind === 'music' && folder.trackCount) return { text: plural(folder.trackCount, 'song') };
  return { text: folder.watch ? 'watched' : 'kept' };
}

export function FoldersView({ folders }: { folders: Resource<{ items: LibraryFolder[] }> }) {
  const confirm = useConfirm();
  const [progress, setProgress] = useState<Record<string, ScanProgress>>({});
  const [said, setSaid] = useState<Partial<Record<FolderKind, { text: string; bad?: boolean }>>>({});
  const [adding, setAdding] = useState<FolderKind | null>(null);

  useEvent('event:scan-progress', (payload) => {
    setProgress((current) => ({ ...current, [payload.folderId]: payload }));
    if (payload.done) folders.reload();
  });

  const remove = useAction(async (folderId: string) => invoke('library:remove-folder', { folderId }));
  const scan = useAction(async (folderId: string) => invoke('library:scan', { folderId }));

  const items = folders.data?.items ?? [];
  const say = (kind: FolderKind, text: string | null, bad = false) => setSaid((current) => ({ ...current, [kind]: text ? { text, bad } : undefined }));

  const add = async (kind: FolderKind) => {
    setAdding(kind);
    say(kind, null);
    try {
      const result = await invoke('library:add-folder', { kind });
      if (result.folder) say(kind, kind === 'music' ? `Added ${result.folder.displayName}. Scanning it now.` : `Added ${result.folder.displayName}.`);
      else if (result.reason) say(kind, result.reason, true);
      folders.reload();
    } catch (err) {
      say(kind, err instanceof Error ? err.message : String(err), true);
    } finally {
      setAdding(null);
    }
  };

  const ask = async (folder: LibraryFolder) => {
    const yes = await confirm({
      title: `Stop using “${folder.displayName}”?`,
      detail: 'Your files aren’t touched. Only Airwave’s record of the folder is removed, and its songs leave the library.',
      action: 'Remove Folder',
      destructive: true,
    });
    if (!yes) return;
    await remove.run(folder.id);
    say(folder.kind, `Removed ${folder.displayName}. Its files are where they were.`);
    folders.reload();
  };

  return (
    <>
      {KINDS.map(({ kind, legend, label }) => {
        const rows = items.filter((f) => f.kind === kind);
        const away = rows.filter((f) => !f.available);
        const failed = rows.filter((f) => f.available && f.lastScanError);
        const note = said[kind];
        return (
          <fieldset key={kind}>
            <legend>{legend}</legend>
            <Rows label={label}>
              {!folders.data ? (
                <LoadingRow />
              ) : rows.length ? (
                rows.map((folder) => {
                  const state = rowState(folder, progress[folder.id]);
                  return (
                    <li key={folder.id}>
                      <FolderIcon />
                      <span className="name" title={folder.path}>
                        {folder.path}
                      </span>
                      <span className={state.bad ? 'meta bad' : 'meta'}>{state.text}</span>
                      {kind === 'music' ? (
                        <button type="button" className="rm rm--again" aria-label={`Scan ${folder.path} again`} title={folder.available ? 'Scan Again' : 'Reconnect this folder’s drive to scan it'} disabled={!folder.available || scan.busy || Boolean(progress[folder.id] && !progress[folder.id]!.done)} onClick={() => void scan.run(folder.id)}>
                          ↻
                        </button>
                      ) : null}
                      <Remove label={`Remove ${folder.path}`} disabled={remove.busy} onClick={() => void ask(folder)} />
                    </li>
                  );
                })
              ) : (
                <EmptyRow>No folders yet — add the one this PC keeps these in.</EmptyRow>
              )}
            </Rows>
            <div className="barrow">
              <Push busy={adding === kind} disabled={adding !== null} onClick={() => void add(kind)}>
                Add Folder…
              </Push>
              {note ? (
                <span className={note.bad ? 'note note--bad' : 'note'} style={{ margin: 0 }} role="status">
                  {note.text}
                </span>
              ) : null}
            </div>
            {away.length ? <p className="note">{away.length === 1 ? 'One folder isn’t' : `${away.length} folders aren’t`} connected right now. What was found there stays listed — reconnect the drive and it is picked up again.</p> : null}
            {failed.map((folder) => (
              <p key={folder.id} className="note note--bad">
                {folder.displayName} couldn’t be scanned: {folder.lastScanError}
              </p>
            ))}
          </fieldset>
        );
      })}
    </>
  );
}

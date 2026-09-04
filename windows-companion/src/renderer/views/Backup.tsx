/**
 * Backup and export.
 *
 * A backup here holds playlists, presets and the shape of the library — not the music, and not the
 * folder paths. That is stated before the button, because a file called "backup" that turns out not
 * to contain the music would be a nasty surprise at exactly the wrong moment.
 */
import { Button, KeyValueList, Panel, PanelSection, useToast } from '@now-playing/aqua-ui';
import { invoke } from '../bridge.js';
import { useAction, useChannel } from '../hooks.js';

export function BackupView() {
  const info = useChannel('app:info', undefined);
  const toast = useToast();
  const create = useAction(async () => invoke('backup:create', undefined));
  const restore = useAction(async () => invoke('backup:restore', undefined));
  const exportPlaylists = useAction(async () => invoke('backup:export-playlists', undefined));

  return (
    <Panel title="Backup">
      <PanelSection>
        <p className="companion-hint">
          A backup holds your playlists, equaliser presets and a record of which folders you added. It deliberately does <strong>not</strong> hold your music — those files are already on your disk, and
          copying tens of gigabytes into a JSON file would help nobody. It also does not hold the folder paths, because a backup restored on another computer would name folders that do not exist there.
        </p>
        <div className="companion-actions">
          <Button
            variant="default"
            busy={create.busy}
            onClick={() =>
              void create.run().then((result) => {
                if (result?.backup) toast.show(`Backup written to ${result.backup.path}`, { kind: 'success' });
                else if (result?.reason) toast.show(result.reason, { kind: 'warning' });
              })
            }
            ellipsis
          >
            Save a backup
          </Button>
          <Button
            busy={restore.busy}
            onClick={() =>
              void restore.run().then((result) => {
                if (result?.restored) toast.show('Restored.', { kind: 'success' });
                else if (result?.reason) toast.show(result.reason, { kind: 'warning' });
              })
            }
            ellipsis
          >
            Restore from a backup
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
      </PanelSection>

      <PanelSection title="Where things are stored">
        <KeyValueList
          items={[
            { key: 'This app’s data', value: <code>{info.data?.dataDir ?? '—'}</code> },
            { key: 'What is there', value: 'The index of your music, your playlists, your presets and the hub credential — no audio.' },
            { key: 'Your music', value: 'Exactly where you put it. This app never moves or copies your files.' },
          ]}
        />
      </PanelSection>
    </Panel>
  );
}

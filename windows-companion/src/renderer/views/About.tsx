/**
 * Where the companion keeps its own data, what it never sends, and what build this is — with an
 * honest statement about signing and updates.
 *
 * An unsigned Windows build makes SmartScreen warn on first run. Saying so here, with what the
 * warning looks like, is better than a person deciding the app is malware.
 */
import { useState } from 'react';
import type { Preferences } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { formatDecimal } from '../format.js';
import { useAction, useChannel, type Resource } from '../hooks.js';
import { Check, Push, Status, useConfirm } from '../ui.js';

export function AboutView({ prefs, say }: { prefs?: Resource<Preferences>; say?: (text: string) => void } = {}) {
  const info = useChannel('app:info', undefined);
  const data = info.data;
  const storage = useChannel('app:storage', undefined, { pollMs: 60_000 });
  const confirm = useConfirm();
  const open = useAction(async () => invoke('app:open-data-folder', undefined));
  const clear = useAction(async () => invoke('app:clear-cache', undefined));
  const openLogs = useAction(async () => invoke('app:open-logs', undefined));
  const exportLogs = useAction(async () => invoke('app:export-logs', undefined));
  const setVerbose = useAction(async (verboseLogs: boolean) => invoke('app:preferences:set', { verboseLogs }));
  const [said, setSaid] = useState<string | null>(null);
  const tell = (text: string) => (say ? say(text) : setSaid(text));
  const cache = storage.data?.cache ?? null;

  const clearCache = async () => {
    const yes = await confirm({
      title: 'Clear the cache?',
      detail: 'The window’s cache, the Live TV playlists and guides as last read, and finished downloads waiting in the helper are removed. Live TV links are read again now, and artwork is fetched again as it is needed. Your music, folders, links, settings and saved downloads are not touched.',
      action: 'Clear Cache',
    });
    if (!yes) return;
    const result = await clear.run();
    storage.reload();
    if (result) tell(result.reason ?? 'Cache cleared. Artwork and guide data will be fetched again as needed.');
  };

  const saveLogs = () =>
    void exportLogs.run().then((result) => {
      if (result?.path) tell(result.reason ?? `Logs saved to ${result.path}, with tokens, keys and folder paths taken out.`);
      else if (result?.reason) tell(result.reason);
    });

  return (
    <>
      <fieldset>
        <legend>Storage and privacy</legend>
        <div className="pref">
          <span className="k top">Settings are kept in:</span>
          <div className="v">
            <span className="path">{data?.dataDir ?? ' '}</span>
            <span className="sub">The index of your music, your playlists and EQ presets, the hub pairing and the helper token. No audio.</span>
            <Push
              busy={open.busy}
              disabled={!data}
              onClick={() =>
                void open.run().then((result) => {
                  setSaid(result && !result.ok ? result.reason : null);
                })
              }
            >
              Show in Explorer
            </Push>
            {said ? (
              <span className="sub note--bad" role="alert">
                {said}
              </span>
            ) : null}
          </div>
          <span className="k top">Cache:</span>
          <div className="v">
            <span>{cache ? (cache.total ? formatDecimal(cache.total) : 'Empty') : storage.error ? 'Not known' : ' '}</span>
            <Push busy={clear.busy} disabled={!cache || cache.total === 0} reason={cache && cache.total === 0 ? 'There is nothing to clear.' : null} onClick={() => void clearCache()}>
              Clear Cache
            </Push>
            {cache && cache.total ? (
              <span className="sub">
                {[cache.app ? `window ${formatDecimal(cache.app)}` : null, cache.liveTv ? `Live TV lists ${formatDecimal(cache.liveTv)}` : null, cache.downloads ? `finished downloads ${formatDecimal(cache.downloads)}` : null].filter(Boolean).join(' · ')}
              </span>
            ) : null}
          </div>
          <span className="k top">Logs:</span>
          <div className="v">
            <Push busy={openLogs.busy} onClick={() => void openLogs.run().then((result) => result?.reason && tell(result.reason))}>
              Open Logs Folder
            </Push>
            <Push busy={exportLogs.busy} onClick={saveLogs}>
              Export Logs…
            </Push>
            <Check
              className="chk--row"
              checked={prefs?.data?.verboseLogs ?? false}
              disabled={!prefs?.data || setVerbose.busy}
              onChange={(event) => {
                const on = event.currentTarget.checked;
                void setVerbose.run(on).then((next) => {
                  if (!next) return;
                  prefs?.reload();
                  tell(on ? 'Detailed logs are on. Turn them off once the problem is found: they grow faster.' : 'Detailed logs are off.');
                });
              }}
              note="Adds what each part of the companion does, step by step. Useful when something goes wrong."
            >
              Keep detailed logs
            </Check>
            {storage.data?.logsDir ? <span className="sub path">{storage.data.logsDir}</span> : null}
          </div>
        </div>
        <p className="note">No telemetry, no analytics, no crash reports. Folder paths never leave this PC; the hub only gets what’s in them. Export Logs takes tokens, keys and folder paths out before it saves.</p>
      </fieldset>

      <fieldset>
        <legend>About</legend>
        <div className="pref">
          <span className="k">Version:</span>
          <div className="v">{data ? `Airwave Companion ${data.version}` : ' '}</div>
          <span className="k top">Built with:</span>
          <div className="v">
            {data ? `Electron ${data.electron} · Chromium ${data.chrome} · Node ${data.node}` : ' '}
            {data ? (
              <span className="sub">
                {data.platform} · contracts {data.contractsVersion}, protocol {data.protocolVersion}
              </span>
            ) : null}
          </div>
          <span className="k top">Code signing:</span>
          <div className="v">
            {data ? <Status kind={data.signed ? 'ok' : 'warn'}>{data.signed ? 'Signed' : 'Not signed'}</Status> : ' '}
            {data && !data.signed ? <span className="sub">Windows SmartScreen shows “Windows protected your PC” the first time an unsigned build runs. Choose More info, then Run anyway.</span> : null}
          </div>
          <span className="k top">Updates:</span>
          <div className="v">
            {data?.updateFeedUrl ? (
              <>
                <Push onClick={() => void invoke('app:open-external', { url: data.updateFeedUrl! })}>Open Release Page</Push>
                <span className="sub">This build checks the release page for a newer version. It never installs anything by itself.</span>
              </>
            ) : (
              <span>{data ? (prefs?.data?.checkForUpdates === false ? 'Not checked: “Check for new versions of the companion” is off, under General. Nothing is contacted about updates.' : 'Once a day this PC asks GitHub whether a newer version is out, and says so under General. Nothing is installed by itself.') :' '}</span>
            )}
          </div>
        </div>
      </fieldset>
    </>
  );
}

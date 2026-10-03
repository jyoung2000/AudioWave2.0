/**
 * Where the companion keeps its own data, what it never sends, and what build this is — with an
 * honest statement about signing and updates.
 *
 * An unsigned Windows build makes SmartScreen warn on first run. Saying so here, with what the
 * warning looks like, is better than a person deciding the app is malware.
 */
import { useState } from 'react';
import { invoke } from '../bridge.js';
import { useAction, useChannel } from '../hooks.js';
import { Push, Status } from '../ui.js';

export function AboutView() {
  const info = useChannel('app:info', undefined);
  const data = info.data;
  const open = useAction(async () => invoke('app:open-data-folder', undefined));
  const [said, setSaid] = useState<string | null>(null);

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
        </div>
        <p className="note">No telemetry, no analytics, no crash reports. Folder paths never leave this PC; the hub only gets what’s in them.</p>
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
              <span>{data ? 'This build doesn’t check for updates, so nothing is contacted. Get new versions from where you got this one.' : ' '}</span>
            )}
          </div>
        </div>
      </fieldset>
    </>
  );
}

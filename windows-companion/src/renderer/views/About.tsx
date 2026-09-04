/**
 * Versions, and an honest statement about signing and updates.
 *
 * An unsigned Windows build makes SmartScreen warn on first run. Saying so here, with what the
 * warning will look like, is better than a person deciding the app is malware.
 */
import { Button, KeyValueList, Panel, PanelSection, StatusDot } from '@now-playing/aqua-ui';
import { invoke } from '../bridge.js';
import { useChannel } from '../hooks.js';

export function AboutView() {
  const info = useChannel('app:info', undefined);
  const data = info.data;

  return (
    <Panel title="About">
      <PanelSection>
        <KeyValueList
          items={[
            { key: 'Version', value: data?.version ?? '—' },
            { key: 'Electron', value: data ? `${data.electron} (Chromium ${data.chrome}, Node ${data.node})` : '—' },
            { key: 'Platform', value: data?.platform ?? '—' },
            { key: 'Contracts', value: data ? `${data.contractsVersion}, protocol ${data.protocolVersion}` : '—' },
            { key: 'Code signing', value: <StatusDot kind={data?.signed ? 'ok' : 'warning'} label={data?.signed ? 'Signed' : 'Not signed'} /> },
          ]}
        />
        {data && !data.signed ? (
          <p className="companion-hint companion-hint--warning">
            This build is not code-signed, so Windows SmartScreen will show a blue “Windows protected your PC” warning the first time you run it. Choose “More info” and then “Run anyway”. Signing requires a
            certificate that costs money and is tied to an identity; a build from source will not have one.
          </p>
        ) : null}
      </PanelSection>

      <PanelSection title="Updates">
        <p className="companion-hint">
          {data?.updateFeedUrl
            ? 'This build checks the release feed below for a newer version. It never installs anything on its own.'
            : 'This build does not check for updates. There is no update server configured, so nothing is contacted and nothing is downloaded. Get new versions from wherever you got this one.'}
        </p>
        {data?.updateFeedUrl ? (
          <Button size="small" onClick={() => void invoke('app:open-external', { url: data.updateFeedUrl! })}>
            Open the release page
          </Button>
        ) : null}
      </PanelSection>

      <PanelSection title="What this app does and does not do">
        <ul className="companion-list">
          <li>Reads music files where they already are. It never moves, copies or modifies them.</li>
          <li>Sends nothing anywhere unless you pair a hub, and then only metadata until you send a file yourself.</li>
          <li>No analytics, no telemetry, no crash reporting.</li>
          <li>Folder paths never leave this computer.</li>
        </ul>
      </PanelSection>
    </Panel>
  );
}

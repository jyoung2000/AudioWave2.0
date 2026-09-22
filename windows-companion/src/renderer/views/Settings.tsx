/**
 * Settings: the downloaders on this PC, how the companion behaves, and the helper's port.
 *
 * Every row is read from the main process and written back through the bridge. The downloader
 * rows keep the mockup's honesty: a missing tool is amber and says what to install; nothing is
 * called ready that has not been found on this PC.
 */
import { useState } from 'react';
import { Button, Checkbox, KeyValueList, Panel, PanelSection, StatusDot, TextField, useToast } from '@now-playing/aqua-ui';
import type { HelperStatus, HelperTool, Preferences } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { useAction, useChannel, type Resource } from '../hooks.js';

const TOOL_ROLES: Record<HelperTool['id'], string> = {
  'yt-dlp': 'Downloads from sites that allow it',
  spotdl: 'Spotify playlists, through their public API',
  ffmpeg: 'Converts formats and adds tags',
};

export function SettingsView({ helper }: { helper: Resource<HelperStatus> }) {
  const toast = useToast();
  const prefs = useChannel('app:preferences:get', undefined);
  const info = useChannel('app:info', undefined);
  const save = useAction(async (patch: Partial<Preferences>) => invoke('app:preferences:set', patch));
  const check = useAction(async () => invoke('helper:check-tools', undefined));
  const [token, setToken] = useState<string | null>(null);
  const [port, setPort] = useState<string | null>(null);

  const data = prefs.data;
  const setPref = (patch: Partial<Preferences>) => void save.run(patch).then((next) => next && prefs.reload());
  const portValue = port ?? String(data?.helperPort ?? 17342);
  const portNumber = Number(portValue);
  const portBad = !Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535;

  return (
    <Panel title="Settings">
      <PanelSection title="Downloaders">
        <p className="companion-hint">The copies on this PC. The hub keeps its own; spotDL runs only here.</p>
        {helper.data ? (
          <ul className="companion-tools" aria-label="Downloaders" aria-live="polite">
            {helper.data.tools.map((tool) => (
              <li key={tool.id} className="companion-tool">
                <StatusDot kind={tool.present ? 'ok' : 'warning'} label={tool.present ? 'Found' : 'Missing'} />
                <span className="companion-tool__main">
                  <b>
                    {tool.id}
                    {tool.version ? <span className="companion-tool__version"> {tool.version}</span> : null}
                  </b>
                  <span className="companion-hint">{TOOL_ROLES[tool.id]}</span>
                  {tool.present && tool.path ? <code className="companion-path companion-tool__path">{tool.path}</code> : null}
                  {!tool.present && tool.advice ? <span className="companion-hint companion-hint--warning">{tool.advice}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="companion-hint">{helper.error ?? 'Looking for downloaders…'}</p>
        )}
        <div className="companion-actions">
          <Button busy={check.busy} onClick={() => void check.run().then(() => helper.reload())}>
            Check All
          </Button>
          <span className="companion-hint">{helper.data?.checkedAt ? `Last checked ${new Date(helper.data.checkedAt).toLocaleTimeString()}` : 'Not checked yet'}</span>
        </div>
        <p className="companion-hint">Downloaders fetch only what a site offers. The companion does not strip DRM, get round a provider&rsquo;s terms or read browser cookies.</p>
      </PanelSection>

      <PanelSection title="General">
        <div className="companion-options">
          <Checkbox checked={data?.launchAtLogin ?? false} disabled={!data} onChange={(e) => setPref({ launchAtLogin: e.currentTarget.checked })}>
            Start when Windows starts
          </Checkbox>
          <Checkbox checked={data?.minimizeToTray ?? true} disabled={!data} onChange={(e) => setPref({ minimizeToTray: e.currentTarget.checked })}>
            Keep running in the notification area when the window closes
          </Checkbox>
          <Checkbox checked={data?.watchFolders ?? true} disabled={!data} onChange={(e) => setPref({ watchFolders: e.currentTarget.checked })}>
            Watch folders for changes and rescan by themselves
          </Checkbox>
          <Checkbox checked={data?.autoSync ?? false} disabled={!data} onChange={(e) => setPref({ autoSync: e.currentTarget.checked })}>
            Sync with the hub when the companion starts
          </Checkbox>
        </div>
        {save.error ? <p className="companion-hint companion-hint--error">{save.error}</p> : null}
      </PanelSection>

      <PanelSection title="Network">
        <p className="companion-hint">The local helper is the part of this app a player on this PC talks to: it runs the downloaders and measures folders for a backup. It listens on loopback only.</p>
        <KeyValueList
          items={[
            {
              key: 'Helper',
              value: helper.data ? <StatusDot kind={helper.data.running ? 'ok' : 'warning'} label={helper.data.running ? `Running at ${helper.data.origin}` : (helper.data.reason ?? 'Not running')} /> : '—',
            },
            {
              key: 'Port',
              value: (
                <span className="companion-inline">
                  <code>127.0.0.1:</code>
                  <TextField
                    label="Local helper port"
                    hideLabel
                    inputMode="numeric"
                    value={portValue}
                    onChange={(e) => setPort(e.currentTarget.value)}
                    onBlur={() => {
                      if (!portBad && portNumber !== data?.helperPort) setPref({ helperPort: portNumber });
                    }}
                    {...(portBad ? { validation: { kind: 'error' as const, message: 'Use a port from 1024 to 65535.' } } : {})}
                  />
                  <span className="companion-hint">The player scans 17342–17345 to find it.</span>
                </span>
              ),
            },
            {
              key: 'Token',
              value: (
                <span className="companion-inline">
                  {token ? <code className="companion-token">{token}</code> : <span className="companion-hint">Shown here only, never logged.</span>}
                  <Button
                    size="small"
                    onClick={() =>
                      void invoke('helper:token', undefined).then((r) => {
                        if (!r.token) toast.show('Windows could not protect a token, so there is none.', { kind: 'warning' });
                        setToken(r.token);
                      })
                    }
                  >
                    {token ? 'Hide' : 'Show'}
                  </Button>
                  {token ? (
                    <Button size="small" onClick={() => void navigator.clipboard.writeText(token).then(() => toast.show('Copied', { kind: 'success' }))}>
                      Copy
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
        <p className="companion-hint">A player on another device reaches this PC only through a hub, or through the streaming server when that arrives. The companion never opens a port on its own.</p>
      </PanelSection>

      <PanelSection title="Storage and privacy">
        <KeyValueList
          items={[
            { key: 'Settings are kept in', value: <code className="companion-path">{info.data?.dataDir ?? '—'}</code> },
            { key: 'What is there', value: 'The index of your music, your playlists, your presets, the hub credential and the helper token — no audio.' },
            { key: 'Telemetry', value: 'None. Folder paths never leave this PC; a hub only gets what is in them.' },
          ]}
        />
      </PanelSection>
    </Panel>
  );
}

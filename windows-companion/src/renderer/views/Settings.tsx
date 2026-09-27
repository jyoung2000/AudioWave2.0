/**
 * Settings: the downloaders on this PC, how the companion behaves, and the helper's port.
 *
 * Every row is read from the main process and written back through the bridge. The downloader
 * rows keep the mockup's honesty (UX-SETUP-001): a tool being set up says how far along it is, one
 * that could not be set up is amber with the reason and a Try Again, and only a tool that cannot be
 * set up on this PC at all says what to install; nothing is called ready that has not been found.
 */
import { useState } from 'react';
import { Button, Checkbox, KeyValueList, Panel, PanelSection, ProgressBar, StatusDot, TextField, useToast } from '@now-playing/aqua-ui';
import type { HelperStatus, HelperTool, Preferences } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { useAction, useChannel, type Resource } from '../hooks.js';

const TOOL_ROLES: Record<HelperTool['id'], string> = {
  'yt-dlp': 'Downloads from sites that allow it',
  spotdl: 'Spotify playlists, through their public API',
  ffmpeg: 'Converts formats and adds tags',
};

/**
 * One downloader's light and words (UX-SETUP-001). Setup's state wins when there is one; without it
 * (the helper is not running) the row falls back to found or missing.
 */
export function toolLook(tool: HelperTool): { kind: 'ok' | 'warning' | 'info'; label: string } {
  switch (tool.setup?.state) {
    case 'installing':
      return { kind: 'info', label: tool.setup.progress !== undefined ? `Setting up… ${Math.round(tool.setup.progress * 100)}%` : 'Setting up…' };
    case 'failed':
      return { kind: 'warning', label: 'Couldn’t set up' };
    case 'unsupported':
      return tool.present ? { kind: 'ok', label: 'Ready' } : { kind: 'warning', label: 'Install it yourself' };
    case 'ready':
      return { kind: 'ok', label: 'Ready' };
    default:
      return tool.present ? { kind: 'ok', label: 'Ready' } : { kind: 'warning', label: 'Missing' };
  }
}

/** Failed or unsupported-and-absent: the downloaders that need the person, which is what the tab badge counts. */
export function needsAttention(tool: HelperTool): boolean {
  if (tool.setup) return tool.setup.state === 'failed' || (tool.setup.state === 'unsupported' && !tool.present);
  return !tool.present;
}

export function SettingsView({ helper }: { helper: Resource<HelperStatus> }) {
  const toast = useToast();
  const prefs = useChannel('app:preferences:get', undefined);
  const info = useChannel('app:info', undefined);
  const save = useAction(async (patch: Partial<Preferences>) => invoke('app:preferences:set', patch));
  const check = useAction(async () => invoke('helper:check-tools', undefined));
  const retry = useAction(async () => invoke('helper:install-tools', undefined));
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
        <p className="companion-hint">The copies on this PC. Missing ones are set up automatically and checked against the SHA-256 their projects publish. The hub keeps its own; spotDL runs only here.</p>
        {helper.data ? (
          <ul className="companion-tools" aria-label="Downloaders" aria-live="polite">
            {helper.data.tools.map((tool) => {
              const look = toolLook(tool);
              return (
                <li key={tool.id} className="companion-tool">
                  <StatusDot kind={look.kind} label={look.label} />
                  <span className="companion-tool__main">
                    <b>
                      {tool.id}
                      {tool.version ? <span className="companion-tool__version"> {tool.version}</span> : null}
                    </b>
                    <span className="companion-hint">{TOOL_ROLES[tool.id]}</span>
                    {tool.setup?.state === 'installing' ? <ProgressBar size="small" label={`Setting up ${tool.id}`} {...(tool.setup.progress !== undefined ? { value: tool.setup.progress * 100 } : {})} showValue={false} /> : null}
                    {tool.present && tool.origin === 'installed' ? <span className="companion-hint">Set up automatically</span> : null}
                    {tool.present && tool.path ? <code className="companion-path companion-tool__path">{tool.path}</code> : null}
                    {tool.setup?.state === 'failed' ? (
                      <span className="companion-inline">
                        <span className="companion-hint companion-hint--warning">Couldn&rsquo;t set up: {tool.setup.reason ?? 'the download did not finish.'}</span>
                        <Button size="small" busy={retry.busy} onClick={() => void retry.run().then(() => helper.reload())}>
                          Try Again
                        </Button>
                      </span>
                    ) : null}
                    {!tool.present && tool.setup?.state !== 'failed' && tool.setup?.state !== 'installing' && tool.advice ? <span className="companion-hint companion-hint--warning">{tool.setup?.reason ?? tool.advice}</span> : null}
                  </span>
                </li>
              );
            })}
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

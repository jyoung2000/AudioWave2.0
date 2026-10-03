/**
 * Settings: the downloaders on this PC, how the companion behaves, and the helper's port — drawn as
 * the design's Settings tab draws them: a well of downloader rows, then preference rows with their
 * labels in one column and their controls in the next.
 *
 * Every row is read from the main process and written back through the bridge as it changes. The
 * downloader rows keep the design's honesty (UX-SETUP-001): a tool being set up says how far along
 * it is, one that could not be set up is amber with the reason and Try Again beside it, and only a
 * tool that cannot be set up on this PC at all says what to install. Nothing is called ready that
 * has not been found.
 */
import { useState } from 'react';
import type { HelperStatus, HelperTool, Preferences } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { ago } from '../format.js';
import { useAction, type Resource } from '../hooks.js';
import { Check, LoadingRow, Progress, Push, Rows, type DotKind } from '../ui.js';

export const TOOL_NAMES: Record<HelperTool['id'], string> = { 'yt-dlp': 'yt-dlp', spotdl: 'spotDL', ffmpeg: 'FFmpeg' };

const TOOL_ROLES: Record<HelperTool['id'], string> = {
  'yt-dlp': 'Audio and video from the sites it supports',
  spotdl: 'Finds the audio for a playlist you link. Runs on this PC only.',
  ffmpeg: 'Converts, tags and joins what the others fetch',
};

/**
 * A tool's version as a person would say it. Tools answer `--version` in their own ways — FFmpeg
 * with a line of build and copyright — so only the number is shown: “9.0”, “2026.09.14”.
 */
export function shortVersion(version: string | null): string | null {
  if (!version) return null;
  const number = /\d+(?:\.\d+)+/.exec(version)?.[0];
  return number ?? version.trim().slice(0, 24);
}

/**
 * A missing tool that setup has not reached yet. Setup takes the tools one at a time, so for the
 * first seconds after start a tool can be absent with nothing said about it — it is in the queue,
 * not missing, and calling it missing (with advice to install it by hand, and a badge) would be
 * wrong for exactly as long as it took the one before it to download.
 */
function queued(tool: HelperTool, helperRunning: boolean): boolean {
  return helperRunning && !tool.setup && !tool.present;
}

/**
 * One downloader's light and words (UX-SETUP-001). Setup's state wins when there is one; a tool
 * setup has not reached yet is on its way; and with no helper running at all the row falls back to
 * found or missing.
 */
export function toolLook(tool: HelperTool, helperRunning = false): { kind: DotKind; label: string } {
  switch (tool.setup?.state) {
    case 'installing':
      return { kind: 'busy', label: tool.setup.progress !== undefined ? `Setting up… ${Math.round(tool.setup.progress * 100)}%` : 'Setting up…' };
    case 'failed':
      return { kind: 'warn', label: `Couldn’t set up: ${tool.setup.reason ?? 'the download did not finish.'}` };
    case 'unsupported':
      return tool.present ? { kind: 'ok', label: 'Ready' } : { kind: 'warn', label: 'Install it yourself' };
    case 'ready':
      return { kind: 'ok', label: 'Ready' };
    default:
      if (queued(tool, helperRunning)) return { kind: 'busy', label: 'Setting up…' };
      return tool.present ? { kind: 'ok', label: 'Ready' } : { kind: 'bad', label: 'Missing' };
  }
}

/** Failed or unsupported-and-absent: the downloaders that need the person, which is what the tab badge counts. */
export function needsAttention(tool: HelperTool, helperRunning = false): boolean {
  if (tool.setup) return tool.setup.state === 'failed' || (tool.setup.state === 'unsupported' && !tool.present);
  return !tool.present && !queued(tool, helperRunning);
}

export function SettingsView({ helper, prefs, say }: { helper: Resource<HelperStatus>; prefs: Resource<Preferences>; say: (text: string) => void }) {
  const save = useAction(async (patch: Partial<Preferences>) => invoke('app:preferences:set', patch));
  const check = useAction(async () => invoke('helper:check-tools', undefined));
  const retry = useAction(async () => invoke('helper:install-tools', undefined));
  const [token, setToken] = useState<string | null>(null);
  const [tokenNote, setTokenNote] = useState<string | null>(null);
  const [port, setPort] = useState<string | null>(null);

  const data = prefs.data;
  const setPref = (patch: Partial<Preferences>, said = 'Saved. Settings are kept on this PC.') =>
    void save.run(patch).then((next) => {
      if (!next) return;
      prefs.reload();
      say(said);
    });

  const portValue = port ?? String(data?.helperPort ?? 17342);
  const portNumber = Number(portValue);
  const portBad = !Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535;
  const commitPort = () => {
    if (portBad || !data || portNumber === data.helperPort) return;
    setPref({ helperPort: portNumber }, `The helper now listens on 127.0.0.1:${portNumber}. Players on this PC find it there.`);
    setPort(null);
  };

  const showToken = async () => {
    if (token) {
      setToken(null);
      setTokenNote(null);
      return;
    }
    const result = await invoke('helper:token', undefined);
    setToken(result.token);
    setTokenNote(result.token ? null : 'Windows couldn’t protect a token on this PC, so there isn’t one.');
  };

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setTokenNote('Copied.');
    } catch {
      setTokenNote('It couldn’t be copied. Select it and copy it yourself.');
    }
  };

  return (
    <>
      <fieldset>
        <legend>Downloaders</legend>
        <p className="hint">The copies on this PC, set up automatically and checked against what their projects publish. The hub keeps its own; spotDL runs only here.</p>
        <Rows label="Downloaders" live>
          {helper.data ? (
            helper.data.tools.map((tool) => {
              const look = toolLook(tool, helper.data?.running ?? false);
              const name = TOOL_NAMES[tool.id];
              const failed = tool.setup?.state === 'failed';
              const installing = tool.setup?.state === 'installing' || look.kind === 'busy';
              return (
                <li key={tool.id} className="dl">
                  <span className={`sdot sdot--${look.kind}`} aria-hidden="true" />
                  <span className="dl__main">
                    <span>
                      <b>{name}</b>
                      {tool.version ? (
                        <span className="ver" title={tool.version}>
                          {shortVersion(tool.version)}
                        </span>
                      ) : null}
                    </span>
                    <span className="dl__state">{look.label}</span>
                    {tool.setup?.state === 'installing' ? <Progress label={`Setting up ${name}`} value={tool.setup.progress !== undefined ? tool.setup.progress * 100 : null} /> : null}
                    <span className="dl__role">{TOOL_ROLES[tool.id]}</span>
                    {tool.present && tool.origin === 'installed' ? <span className="dl__role">Set up automatically</span> : null}
                    {tool.present && tool.path ? <span className="dl__path">{tool.path}</span> : null}
                    {/* The manual advice is only a fallback: a tool being set up, or that failed, does not show it. */}
                    {!tool.present && !failed && !installing && (tool.setup?.reason ?? tool.advice) ? <span className="dl__role dl__advice">{tool.setup?.reason ?? tool.advice}</span> : null}
                  </span>
                  {failed ? (
                    <span className="dl__acts">
                      <Push busy={retry.busy} onClick={() => void retry.run().then(() => helper.reload())}>
                        Try Again
                      </Push>
                    </span>
                  ) : null}
                </li>
              );
            })
          ) : helper.error ? (
            <li>
              <span className="empty">The downloaders couldn’t be looked up. Choose Check All to try again.</span>
            </li>
          ) : (
            <LoadingRow />
          )}
        </Rows>
        <div className="barrow">
          <Push busy={check.busy} onClick={() => void check.run().then(() => helper.reload())}>
            Check All
          </Push>
          <span className="note" style={{ margin: 0 }}>
            {helper.data?.checkedAt ? `Last checked ${ago(helper.data.checkedAt)}` : 'Not checked yet'}
          </span>
        </div>
        <p className="note">Downloaders fetch only what a site offers. The companion doesn’t strip DRM, get round a provider’s terms or read browser cookies.</p>
      </fieldset>

      <fieldset>
        <legend>General</legend>
        <div className="pref">
          <span className="k top">On this PC:</span>
          <div className="v stack">
            <Check checked={data?.launchAtLogin ?? false} disabled={!data} onChange={(event) => setPref({ launchAtLogin: event.currentTarget.checked })}>
              Start when Windows starts
            </Check>
            <Check checked={data?.minimizeToTray ?? true} disabled={!data} onChange={(event) => setPref({ minimizeToTray: event.currentTarget.checked })}>
              Keep running in the notification area when the window closes
            </Check>
            <Check checked={data?.watchFolders ?? true} disabled={!data} onChange={(event) => setPref({ watchFolders: event.currentTarget.checked })}>
              Watch folders and scan them when something changes
            </Check>
            <Check checked={data?.autoSync ?? false} disabled={!data} onChange={(event) => setPref({ autoSync: event.currentTarget.checked })}>
              Sync with the hub when the companion starts
            </Check>
          </div>
        </div>
        {save.error ? <p className="note note--bad">{save.error}</p> : null}
      </fieldset>

      <fieldset>
        <legend>Network</legend>
        <div className="pref">
          <label className="k top" htmlFor="helper-port">
            Local helper port:
          </label>
          <div className="v">
            <span className="path">127.0.0.1&thinsp;:</span>
            <input
              className={portBad ? 'field num bad-field' : 'field num'}
              type="number"
              id="helper-port"
              min={1024}
              max={65535}
              value={portValue}
              disabled={!data}
              aria-invalid={portBad || undefined}
              aria-describedby="helper-port-help"
              onChange={(event) => setPort(event.currentTarget.value)}
              onBlur={commitPort}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitPort();
              }}
            />
            <span className="sub" id="helper-port-help">
              {portBad ? <span className="note--bad">Use a port from 1024 to 65535. </span> : null}
              {!helper.data ? 'The player on this PC talks to the companion here.' : helper.data.running ? 'The player on this PC talks to the companion here. It is running.' : <span className="note--bad">{helper.data.reason ?? 'The helper isn’t running.'}</span>}
            </span>
          </div>
          <span className="k top">Helper token:</span>
          <div className="v">
            {token ? <span className="path token">{token}</span> : null}
            <Push onClick={() => void showToken()}>{token ? 'Hide' : 'Show'}</Push>
            {token ? <Push onClick={() => void copyToken()}>Copy</Push> : null}
            <span className="sub">{tokenNote ?? 'For a player this PC doesn’t serve. It is shown here only, and never written to a log.'}</span>
          </div>
        </div>
        <p className="note">The helper listens on this PC only. Other devices reach this PC through Remote.</p>
      </fieldset>
    </>
  );
}

/**
 * Settings: the downloaders on this PC, how the companion behaves, where downloads go and how they
 * run, and the helper's port — drawn as the design's Settings tab draws them: a well of downloader
 * rows with Check and Update beside each, then preference rows with their labels in one column and
 * their controls in the next.
 *
 * Every row is read from the main process and written back through the bridge as it changes. The
 * downloader rows keep the design's honesty (UX-SETUP-001): a tool being set up says how far along
 * it is, one that could not be set up is amber with the reason and Try Again beside it, one that a
 * Check found behind says which version is out, and only a tool that cannot be set up on this PC at
 * all says what to install. Nothing is called ready, or up to date, that has not been found so.
 */
import { useState } from 'react';
import type { OutputFormat } from '@now-playing/contracts';
import type { DownloadDone, HelperStatus, HelperTool, Preferences, PreferencesPatch } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { ago } from '../format.js';
import { useAction, useChannel, type Resource } from '../hooks.js';
import { Check, LoadingRow, Pop, Progress, Push, Rows, type DotKind } from '../ui.js';

export const TOOL_NAMES: Record<HelperTool['id'], string> = { 'yt-dlp': 'yt-dlp', spotdl: 'spotDL', ffmpeg: 'FFmpeg' };

const TOOL_ROLES: Record<HelperTool['id'], string> = {
  'yt-dlp': 'Audio and video from the sites it supports',
  spotdl: 'Finds the audio for a playlist you link. Runs on this PC only.',
  ffmpeg: 'Converts, tags and joins what the others fetch',
};

const FORMATS: ReadonlyArray<{ value: OutputFormat; label: string }> = [
  { value: 'original', label: 'Keep original' },
  { value: 'mp3', label: 'MP3' },
  { value: 'aac', label: 'AAC (M4A)' },
  { value: 'opus', label: 'Opus' },
  { value: 'flac', label: 'FLAC · lossless' },
];

const DONE: ReadonlyArray<{ value: DownloadDone; label: string }> = [
  { value: 'nothing', label: 'Just save it' },
  { value: 'notify', label: 'Show a notification' },
  { value: 'reveal', label: 'Show it in File Explorer' },
];

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
 * One downloader's light and words (UX-SETUP-001). A Check under way, then setup's state, win; a
 * present tool a Check found behind is amber with the version that is out; a tool setup has not
 * reached yet is on its way; and with no helper running at all the row falls back to found or
 * missing.
 */
export function toolLook(tool: HelperTool, helperRunning = false): { kind: DotKind; label: string } {
  if (tool.checking) return { kind: 'busy', label: 'Checking…' };
  switch (tool.setup?.state) {
    case 'installing': {
      const pct = tool.setup.progress !== undefined ? ` ${Math.round(tool.setup.progress * 100)}%` : '';
      return { kind: 'busy', label: tool.present ? `Updating…${pct}` : `Setting up…${pct}` };
    }
    case 'failed':
      return { kind: 'warn', label: `Couldn’t set up: ${tool.setup.reason ?? 'the download did not finish.'}` };
    case 'unsupported':
      if (!tool.present) return { kind: 'warn', label: 'Install it yourself' };
      break;
    default:
      if (!tool.setup && queued(tool, helperRunning)) return { kind: 'busy', label: 'Setting up…' };
      if (!tool.present) return { kind: 'bad', label: 'Missing' };
  }
  if (tool.latest?.updateAvailable === true) return { kind: 'warn', label: tool.latest.version ? `Update available · ${tool.latest.version}` : 'A newer build is available' };
  if (tool.latest?.updateAvailable === false) return { kind: 'ok', label: 'Up to date' };
  return { kind: 'ok', label: 'Ready' };
}

/** Failed, unsupported-and-absent, or found behind by a Check: the downloaders the tab badge counts. */
export function needsAttention(tool: HelperTool, helperRunning = false): boolean {
  if (tool.present && tool.latest?.updateAvailable === true && tool.setup?.state !== 'installing') return true;
  if (tool.setup) return tool.setup.state === 'failed' || (tool.setup.state === 'unsupported' && !tool.present);
  return !tool.present && !queued(tool, helperRunning);
}

/** Why Update or Install is off, in a sentence; null when it can run. */
export function updateReason(tool: HelperTool, status: HelperStatus): string | null {
  if (!status.running) return status.reason ?? 'The helper isn’t running, so nothing can be installed.';
  if (tool.setup?.state === 'installing') return tool.present ? 'It is being updated now.' : 'It is being set up now.';
  if (tool.setup?.state === 'unsupported' && !tool.present) return tool.setup.reason ?? tool.advice ?? 'There is no build of it for this PC to install.';
  if (tool.present && status.busy) return 'Downloads are running. Update when they finish.';
  if (tool.present && tool.latest?.updateAvailable === false) return 'It is up to date.';
  return null;
}

function DownloaderRow({ tool, status, onChanged, say }: { tool: HelperTool; status: HelperStatus; onChanged: () => void; say: (text: string) => void }) {
  const look = toolLook(tool, status.running);
  const name = TOOL_NAMES[tool.id];
  const failed = tool.setup?.state === 'failed';
  const installing = tool.setup?.state === 'installing' || look.kind === 'busy';
  const check = useAction(async () => invoke('helper:check-tool', { id: tool.id }));
  const update = useAction(async () => invoke('helper:update-tool', { id: tool.id }));
  const retry = useAction(async () => invoke('helper:install-tools', undefined));
  const checkReason = !tool.present ? 'Install it first.' : installing ? 'Wait for it to finish.' : null;
  const reason = updateReason(tool, status);
  const verb = tool.present ? 'Update' : 'Install';

  const run = () =>
    void update.run().then((result) => {
      if (result?.reason) say(result.reason);
      else if (result) say(tool.present ? `Updating ${name}. It is checked against its published SHA-256 before it is used.` : `Installing ${name}. It is checked against its published SHA-256 before it is used.`);
      onChanged();
    });

  return (
    <li className="dl">
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
        {tool.setup?.state === 'installing' ? <Progress label={`${tool.present ? 'Updating' : 'Setting up'} ${name}`} value={tool.setup.progress !== undefined ? tool.setup.progress * 100 : null} /> : null}
        <span className="dl__role">{TOOL_ROLES[tool.id]}</span>
        {tool.present && tool.origin === 'installed' ? <span className="dl__role">Set up automatically</span> : null}
        {tool.present && tool.latest?.updateAvailable === null && tool.latest.reason ? <span className="dl__role">{tool.latest.reason}</span> : null}
        {tool.present && tool.path ? <span className="dl__path">{tool.path}</span> : null}
        {/* The manual advice is only a fallback: a tool being set up, or that failed, does not show it. */}
        {!tool.present && !failed && !installing && (tool.setup?.reason ?? tool.advice) ? <span className="dl__role dl__advice">{tool.setup?.reason ?? tool.advice}</span> : null}
      </span>
      <span className="dl__acts">
        {failed ? (
          <Push busy={retry.busy} onClick={() => void retry.run().then(onChanged)}>
            Try Again
          </Push>
        ) : (
          <>
            <Push busy={check.busy || Boolean(tool.checking)} disabled={Boolean(checkReason)} reason={checkReason} aria-label={`Check ${name}`} onClick={() => void check.run().then(onChanged)}>
              Check
            </Push>
            <Push busy={update.busy} disabled={Boolean(reason)} reason={reason} aria-label={`${verb} ${name}`} onClick={run}>
              {verb}
            </Push>
          </>
        )}
      </span>
    </li>
  );
}

export function SettingsView({ helper, prefs, say }: { helper: Resource<HelperStatus>; prefs: Resource<Preferences>; say: (text: string) => void }) {
  const save = useAction(async (patch: PreferencesPatch) => invoke('app:preferences:set', patch));
  const checkAll = useAction(async () => invoke('helper:check-tools', undefined));
  const pickDir = useAction(async () => invoke('downloads:pick-dir', undefined));
  const update = useChannel('app:update-status', undefined, { pollMs: 10 * 60_000 });
  const checkUpdate = useAction(async () => invoke('app:check-update', undefined));
  const openRelease = useAction(async () => invoke('app:open-release', undefined));
  const [token, setToken] = useState<string | null>(null);
  const [tokenNote, setTokenNote] = useState<string | null>(null);
  const [port, setPort] = useState<string | null>(null);
  const [jobs, setJobs] = useState<string | null>(null);
  const [speed, setSpeed] = useState<string | null>(null);

  const data = prefs.data;
  const setPref = (patch: PreferencesPatch, said = 'Saved. Settings are kept on this PC.') =>
    void save.run(patch).then((next) => {
      if (!next) return;
      prefs.reload();
      helper.reload();
      update.reload();
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

  const jobsValue = jobs ?? String(data?.downloadConcurrency ?? 2);
  const jobsNumber = Number(jobsValue);
  const jobsBad = !Number.isInteger(jobsNumber) || jobsNumber < 1 || jobsNumber > 4;
  const commitJobs = () => {
    // A value out of range stays in the field with its complaint, as the port does; nothing is sent.
    if (jobsBad || !data) return;
    if (jobsNumber === data.downloadConcurrency) return setJobs(null);
    setPref({ downloadConcurrency: jobsNumber }, jobsNumber === 1 ? 'Downloads now run one at a time.' : `Up to ${jobsNumber} downloads now run at once.`);
    setJobs(null);
  };

  const speedValue = speed ?? (data?.downloadRateKBps ? String(data.downloadRateKBps) : '');
  const speedNumber = speedValue.trim() === '' ? null : Number(speedValue);
  const speedBad = speedNumber !== null && (!Number.isInteger(speedNumber) || speedNumber < 1 || speedNumber > 1_000_000);
  const commitSpeed = () => {
    if (speedBad || !data) return;
    if (speedNumber === (data.downloadRateKBps ?? null)) return setSpeed(null);
    setPref({ downloadRateKBps: speedNumber }, speedNumber === null ? 'Downloads now run as fast as the site allows.' : `Each download is now held to ${speedNumber.toLocaleString()} KB/s.`);
    setSpeed(null);
  };

  const chooseDir = () =>
    void pickDir.run().then((result) => {
      if (result?.reason) say(result.reason);
      else if (result && result.preferences.downloadDir !== data?.downloadDir) {
        prefs.reload();
        say(`Downloads now go to ${result.preferences.downloadDir ?? 'Downloads in your Music folder'}.`);
      }
    });

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

  const u = update.data;
  const checkingAll = checkAll.busy || Boolean(helper.data?.tools.some((t) => t.checking));
  const lanOn = data?.helperLan ?? false;

  return (
    <>
      <fieldset>
        <legend>Downloaders</legend>
        <p className="hint">The copies on this PC, set up automatically and checked against what their projects publish. The hub keeps its own; spotDL runs only here.</p>
        <Rows label="Downloaders" live>
          {helper.data ? (
            helper.data.tools.map((tool) => <DownloaderRow key={tool.id} tool={tool} status={helper.data!} onChanged={helper.reload} say={say} />)
          ) : helper.error ? (
            <li>
              <span className="empty">The downloaders couldn’t be looked up. Choose Check All to try again.</span>
            </li>
          ) : (
            <LoadingRow />
          )}
        </Rows>
        <div className="barrow">
          <Push busy={checkingAll} onClick={() => void checkAll.run().then(() => helper.reload())}>
            Check All
          </Push>
          <span className="note" style={{ margin: 0 }}>
            {checkingAll ? 'Checking…' : helper.data?.checkedAt ? `Last checked ${ago(helper.data.checkedAt)}` : 'Not checked yet'}
          </span>
        </div>
        <div className="pref" style={{ marginTop: 10 }}>
          <span className="k" />
          <div className="v">
            <Check checked={data?.autoUpdateTools ?? true} disabled={!data} onChange={(event) => setPref({ autoUpdateTools: event.currentTarget.checked }, event.currentTarget.checked ? 'Downloaders now update themselves.' : 'Downloaders now update only when you choose Update. Missing ones are still set up.')} note="Sites change often. An out-of-date yt-dlp is the usual reason a download fails.">
              Update downloaders automatically
            </Check>
          </div>
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
            <Check checked={data?.checkForUpdates ?? true} disabled={!data} onChange={(event) => setPref({ checkForUpdates: event.currentTarget.checked })}>
              Check for new versions of the companion
            </Check>
            <Check checked={(data?.downloadDone ?? 'nothing') === 'notify'} disabled={!data} onChange={(event) => setPref({ downloadDone: event.currentTarget.checked ? 'notify' : 'nothing' })}>
              Show a notification when a download finishes
            </Check>
          </div>
          <span className="k top">New versions:</span>
          <div className="v">
            {!u ? (
              <span className="dim">{update.error ? 'Not known.' : ' '}</span>
            ) : !u.enabled ? (
              <span className="dim">Not checked: the companion contacts nothing about updates while that is off.</span>
            ) : u.available ? (
              <>
                <b role="status">A new version is available: {u.latest}.</b>
                <Push busy={openRelease.busy} onClick={() => void openRelease.run()}>
                  Download…
                </Push>
                <span className="sub">This is version {u.current}. Download opens the release page on GitHub; nothing is installed by itself.</span>
              </>
            ) : (
              <>
                <span role="status">{u.reason ?? (u.checkedAt ? `Up to date · version ${u.current}` : `Version ${u.current}`)}</span>
                <Push busy={checkUpdate.busy} onClick={() => void checkUpdate.run().then(() => update.reload())}>
                  Check Now
                </Push>
                <span className="sub">{u.checkedAt ? `Asked GitHub ${ago(u.checkedAt)}. ` : ''}Asked at most once a day, without an account or key.</span>
              </>
            )}
          </div>
        </div>
        {save.error ? <p className="note note--bad">{save.error}</p> : null}
      </fieldset>

      <fieldset>
        <legend>Downloads</legend>
        <div className="pref">
          <span className="k top" id="downloads-dir-k">
            Save to:
          </span>
          <div className="v">
            {data?.downloadDir ? (
              <span className="path" id="downloads-dir" aria-labelledby="downloads-dir-k downloads-dir">
                {data.downloadDir}
              </span>
            ) : (
              <span className="dim">{data ? 'Downloads, in your Music folder' : ' '}</span>
            )}
            <Push busy={pickDir.busy} disabled={!data} onClick={chooseDir}>
              Choose…
            </Push>
            <span className="sub">A copy of each finished download is kept here, whichever player asked for it.</span>
          </div>

          <label className="k top" htmlFor="downloads-format">
            Format:
          </label>
          <div className="v">
            <Pop id="downloads-format" value={data?.downloadFormat ?? 'original'} disabled={!data} options={FORMATS} onChange={(event) => setPref({ downloadFormat: event.currentTarget.value as OutputFormat })} />
            <span className="sub">Used when the player doesn’t choose one. Anything but the original needs FFmpeg; without it the original is kept.</span>
          </div>

          <label className="k" htmlFor="downloads-jobs">
            At the same time:
          </label>
          <div className="v">
            <input
              className={jobsBad ? 'field num bad-field' : 'field num'}
              type="number"
              id="downloads-jobs"
              min={1}
              max={4}
              step={1}
              value={jobsValue}
              disabled={!data}
              aria-invalid={jobsBad || undefined}
              aria-describedby="downloads-jobs-help"
              onChange={(event) => setJobs(event.currentTarget.value)}
              onBlur={commitJobs}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitJobs();
              }}
            />
            <span id="downloads-jobs-help">{jobsBad ? <span className="note--bad">Choose from 1 to 4 downloads.</span> : 'downloads (1–4)'}</span>
          </div>

          <label className="k top" htmlFor="downloads-speed">
            Speed limit:
          </label>
          <div className="v">
            <input
              className={speedBad ? 'field num bad-field' : 'field num'}
              type="text"
              inputMode="numeric"
              id="downloads-speed"
              placeholder="None"
              value={speedValue}
              disabled={!data}
              aria-invalid={speedBad || undefined}
              aria-describedby="downloads-speed-help"
              onChange={(event) => setSpeed(event.currentTarget.value)}
              onBlur={commitSpeed}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitSpeed();
              }}
            />
            <span>KB/s</span>
            <span className="sub" id="downloads-speed-help">
              {speedBad ? <span className="note--bad">Use a whole number of KB/s, or leave it empty. </span> : null}
              For each download. Leave it empty for no limit.
            </span>
          </div>

          <label className="k" htmlFor="downloads-done">
            When one finishes:
          </label>
          <div className="v">
            <Pop id="downloads-done" value={data?.downloadDone ?? 'nothing'} disabled={!data} options={DONE} onChange={(event) => setPref({ downloadDone: event.currentTarget.value as DownloadDone })} />
          </div>
        </div>
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
          <span className="k top">Other devices:</span>
          <div className="v">
            <Check
              checked={lanOn}
              disabled={!data}
              onChange={(event) => setPref({ helperLan: event.currentTarget.checked }, event.currentTarget.checked ? 'Devices on this network can now read the guide and what is playing from this PC. Windows may ask whether to allow it through the firewall.' : 'The helper answers this PC only again.')}
              note={
                <>
                  Off is safer. When on, any device on this network can see that the companion is running and which downloaders it has, read the Live TV channels and guide, and ask what a radio station is playing — without pairing. Downloads, backups and the helper’s token stay on this PC. Paired devices connect through <b>Remote</b> either way.
                </>
              }
            >
              Let devices on this network use the helper without pairing
            </Check>
          </div>
          <span className="k top">Helper token:</span>
          <div className="v">
            {token ? <span className="path token">{token}</span> : null}
            <Push onClick={() => void showToken()}>{token ? 'Hide' : 'Show'}</Push>
            {token ? <Push onClick={() => void copyToken()}>Copy</Push> : null}
            <span className="sub">{tokenNote ?? 'For a player this PC doesn’t serve. It is shown here only, and never written to a log.'}</span>
          </div>
        </div>
        <p className="note">{lanOn ? (helper.data?.lan ? 'The helper is answering this network for the read-only routes above, and this PC for everything.' : 'The helper starts answering this network when it next starts.') : 'The helper listens on this PC only. Other devices reach this PC through Remote.'}</p>
      </fieldset>
    </>
  );
}

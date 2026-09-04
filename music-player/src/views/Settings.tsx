/**
 * Settings: folders, the hub connection, car and lock-screen integration, storage and privacy.
 *
 * The car panel is deliberately blunt about what a web app can and cannot do (docs/PWA_AND_CAR.md).
 * People install this expecting an Android Auto tile; telling them at the point of disappointment,
 * with what *does* work spelled out, is better than letting them hunt for a setting that does not
 * exist.
 */
import { useCallback, useEffect, useState } from 'react';
import { AquaTable, Button, ButtonLink, EmptyState, KeyValueList, Panel, PanelSection, StatusDot, TextField, useToast } from '@now-playing/aqua-ui';
import { useAppState, usePlayer } from '../state/context.js';
import { EqualizerView } from './Equalizer.js';
import { mediaIntegrationReport } from '../lib/media-session.js';
import { localFileReport } from '../lib/build-flags.js';
import type { ReleaseMetadata } from '@now-playing/contracts';
import type { StoredRoot } from '../lib/db.js';

export function SettingsView() {
  const { store, hub, hubStatus } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const media = mediaIntegrationReport();
  const localFile = localFileReport();

  return (
    <>
      <div className="np-section-head">
        <h2>Settings</h2>
        <p>What this app can do here, and what it cannot — with the reason in each case.</p>
      </div>
      {localFile.active ? (
        <Panel title="Running from a file">
          <PanelSection>
            <p className="player-hint">
              You opened this from your own disk rather than from a web address, so there is no server involved at all. Most of the player works exactly the same; a few things are decided by the browser
              rather than by this app, and they are listed here so you are not left guessing which.
            </p>
            <AquaTable
              label="What works when opened from a file"
              rowKey={(row) => row.name}
              rows={localFile.features}
              columns={[
                { id: 'name', header: 'Feature', primary: true, cell: (row) => row.name },
                { id: 'available', header: 'Works', width: 96, cell: (row) => <StatusDot kind={row.available ? 'ok' : 'neutral'} label={row.available ? 'Yes' : 'No'} /> },
                { id: 'note', header: 'Detail', cell: (row) => row.note },
              ]}
            />
          </PanelSection>
        </Panel>
      ) : null}

      <Panel title="Music folders">
        <PanelSection>
          {state.library.directoryHandleReason ? <p className="player-hint player-hint--warning">{state.library.directoryHandleReason}</p> : null}
          <div className="player-toolbar-row">
            <Button size="small" icon="add" onClick={() => void store.addDirectory()} ellipsis>
              Add a folder
            </Button>
          </div>
          {state.library.roots.length ? (
            <AquaTable
              label="Music folders"
              rowKey={(row: StoredRoot) => row.id}
              rows={state.library.roots}
              columns={[
                { id: 'name', header: 'Folder', primary: true, cell: (row) => row.displayName },
                { id: 'kind', header: 'Kind', cell: (row) => (row.kind === 'directory' ? 'Connected folder' : 'Files chosen once') },
                { id: 'tracks', header: 'Songs', align: 'right', width: 64, cell: (row) => row.trackCount },
                { id: 'scanned', header: 'Last scanned', cell: (row) => (row.lastScanError ? row.lastScanError : row.lastScanAt ? new Date(row.lastScanAt).toLocaleString() : 'never') },
                {
                  id: 'actions',
                  header: '',
                  headerLabel: 'Actions',
                  width: 160,
                  cell: (row) => (
                    <span className="player-row-actions">
                      <Button size="mini" disabled={row.kind !== 'directory'} onClick={() => void store.rescan(row.id)}>
                        Rescan
                      </Button>
                      <Button
                        size="mini"
                        variant="destructive"
                        onClick={() => {
                          if (window.confirm(`Stop using ${row.displayName}? Your files are not touched — only the player's index of them is removed.`)) void store.removeRoot(row.id);
                        }}
                      >
                        Remove
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          ) : (
            <EmptyState title="No folders yet" text="The player reads files where they already are. Nothing is copied, uploaded or moved." inline />
          )}
        </PanelSection>
      </Panel>

      <EqualizerView embedded />

      <HubPanel />

      <SharedListeningPanel />

      <WindowsCompanionPanel key={hubStatus.connected ? 'hub-connected' : 'no-hub'} />

      <Panel title="Car, lock screen and headset">
        <PanelSection>
          <p className="player-hint">
            While the player is open and audio is playing, this is what your phone, car and headphones can do with it.
          </p>
          <AquaTable
            label="Media integration"
            rowKey={(row) => row.name}
            rows={media.features}
            columns={[
              { id: 'name', header: 'Feature', primary: true, cell: (row) => row.name },
              { id: 'available', header: 'Works', width: 96, cell: (row) => <StatusDot kind={row.available ? 'ok' : 'neutral'} label={row.available ? 'Yes' : 'No'} /> },
              { id: 'note', header: 'Detail', cell: (row) => row.note },
            ]}
          />
          <h4 className="player-subhead">Using this in a car</h4>
          <ol className="player-list">
            <li>Install the player from your browser's menu ("Add to home screen" or "Install"), so it opens without browser chrome.</li>
            <li>Start playing before you connect, or from the phone once connected.</li>
            <li>Connect to the car by Bluetooth or USB. The car shows the song and its controls work.</li>
          </ol>
          <p className="player-hint">
            The player will not appear as an icon on the Android Auto or CarPlay home screen. Those launchers list only native apps built with the car app libraries and distributed through the app stores;
            no web app of any kind can appear there. Everything else above works.
          </p>
        </PanelSection>
      </Panel>

      <Panel title="Storage">
        <PanelSection>
          <KeyValueList
            items={[
              { key: 'Songs indexed', value: state.storage?.tracks ?? 0 },
              { key: 'Playlists', value: state.storage?.playlists ?? 0 },
              { key: 'Listening events', value: state.storage?.events ?? 0 },
              { key: 'Artwork cached', value: state.storage?.artwork ?? 0 },
              {
                key: 'Space used',
                value:
                  state.storage?.estimateBytes === null || state.storage?.estimateBytes === undefined
                    ? 'This browser will not report it'
                    : `${formatBytes(state.storage.estimateBytes)}${state.storage.quotaBytes ? ` of about ${formatBytes(state.storage.quotaBytes)} available` : ''}`,
              },
            ]}
          />
          <p className="player-hint">
            Your audio files are not counted here: the player never copies them. What it stores is the index — titles, artists, durations, artwork thumbnails, your playlists and your listening history.
          </p>
        </PanelSection>
      </Panel>

      <Panel title="Privacy">
        <PanelSection>
          <ul className="player-list">
            <li>Nothing leaves this device unless you pair a hub, and then only what you ask it to do.</li>
            <li>There is no analytics, no telemetry and no crash reporting. The player makes no network request of its own.</li>
            <li>Your listening history is stored here, append-only, and is used to compute the figures on the Listening screen.</li>
            <li>Folder paths never leave this device: what the player keeps is a browser handle, not a path.</li>
          </ul>
          <div className="player-toolbar-row">
            <Button
              variant="destructive"
              onClick={() => {
                if (window.confirm('Delete everything the player has stored on this device — the index, playlists, presets and listening history?\n\nYour music files are not touched.')) {
                  void store.deleteAllData().then(() => toast.show('Deleted.', { kind: 'success' }));
                }
              }}
            >
              Delete everything stored here
            </Button>
          </div>
        </PanelSection>
      </Panel>
      {hub ? null : null}
      {hubStatus.reason && !hubStatus.connected ? null : null}
    </>
  );
}

/** Pairing with a hub: enter the code, compare the fingerprint, confirm. */
/**
 * Whether shared listening can be used from this device, and why not when it cannot.
 *
 * The switch in the status bar reports the same sentence when it is pressed; this panel is where
 * someone goes to find out *before* pressing it. The two read the same value, so they cannot drift.
 */
function SharedListeningPanel() {
  const { shared, mode, group } = usePlayer();
  return (
    <Panel title="Shared listening">
      <PanelSection>
        <KeyValueList
          items={[
            { key: 'Available here', value: shared.unavailableReason ? <StatusDot kind="neutral" label="No" /> : <StatusDot kind="ok" label="Yes" /> },
            ...(shared.unavailableReason ? [{ key: 'Why not', value: shared.unavailableReason }] : []),
            { key: 'Mode', value: mode === 'shared' ? 'Shared — the hub keeps the queue' : 'Solo — everything stays on this device' },
            { key: 'Group', value: shared.group ? shared.group.name : 'Not in a group' },
            {
              key: 'Realtime connection',
              value:
                shared.connection === 'connected'
                  ? 'Connected'
                  : shared.connection === 'reconnecting'
                    ? 'Reconnecting — the queue you see may be behind the group'
                    : shared.connection === 'failed'
                      ? 'The hub refused the connection'
                      : 'Not connected',
            },
            { key: 'Listening with', value: shared.members.length ? shared.members.map((m) => `${m.displayName}${m.online ? '' : ' (offline)'}`).join(', ') : 'Nobody yet' },
          ]}
        />
        <p className="player-hint">
          In a group the queue lives on the hub: everyone hears the same order, and skipping is a request the hub grants or refuses rather than something one player does alone. Your library, your
          equalizer and your listening history stay on this device either way — joining a group does not upload your music.
        </p>
        {shared.group && group ? (
          <div className="player-toolbar-row">
            <Button size="small" onClick={() => void group.leave()}>
              Leave {shared.group.name}
            </Button>
          </div>
        ) : null}
      </PanelSection>
    </Panel>
  );
}

function HubPanel() {
  const { hub, hubStatus } = usePlayer();
  const toast = useToast();
  const [endpoint, setEndpoint] = useState('http://localhost:4546');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<{ sessionId: string; claimSecret: string; verificationFingerprint: string; hubFingerprint: string; hubName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claim = useCallback(async () => {
    if (!hub) return;
    setBusy(true);
    setError(null);
    try {
      const result = await hub.claim(endpoint, code, deviceName());
      setPending({ sessionId: result.sessionId, claimSecret: result.claimSecret, verificationFingerprint: result.verificationFingerprint, hubFingerprint: result.hubFingerprint, hubName: result.hubName });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [hub, endpoint, code]);

  // Poll for the confirmation the person performs at the hub. This is the step a stolen code cannot
  // get past on its own.
  useEffect(() => {
    if (!pending || !hub) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void hub
        .pairingStatus(endpoint, pending.sessionId, pending.claimSecret)
        .then(async (state) => {
          if (cancelled) return;
          if (state === 'confirmed') {
            clearInterval(timer);
            await hub.complete(endpoint, pending.sessionId, pending.claimSecret);
            setPending(null);
            setCode('');
            toast.show('Paired.', { kind: 'success' });
          } else if (state === 'expired' || state === 'revoked') {
            clearInterval(timer);
            setPending(null);
            setError(`The pairing was ${state}. Start again with a new code.`);
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pending, hub, endpoint, toast]);

  return (
    <Panel title="Hub">
      <PanelSection>
        {hubStatus.connected ? (
          <>
            <KeyValueList
              items={[
                { key: 'Connected to', value: `${hubStatus.hubName ?? 'a hub'} at ${hubStatus.endpoint}` },
                { key: 'Fingerprint', value: <code>{hubStatus.identity?.fingerprint ?? '—'}</code> },
                { key: 'This device may', value: hubStatus.scopes.join(', ') || 'nothing yet' },
              ]}
            />
            <div className="player-toolbar-row">
              <Button size="small" onClick={() => void hub?.refresh()}>
                Check connection
              </Button>
              <Button
                size="small"
                variant="destructive"
                onClick={() => {
                  if (window.confirm('Forget this hub? Your own music and playlists stay exactly as they are.')) void hub?.forget().then(() => toast.show('Hub forgotten'));
                }}
              >
                Forget this hub
              </Button>
            </div>
          </>
        ) : pending ? (
          <>
            <p className="player-hint">
              Compare this code with the one on the hub's screen. If they do not match, cancel — something else is answering at that address.
            </p>
            <p className="player-fingerprint">{pending.verificationFingerprint}</p>
            <p className="player-hint">
              {pending.hubName} · hub fingerprint <code>{pending.hubFingerprint}</code>
            </p>
            <p className="player-hint">Waiting for someone at the hub to confirm…</p>
            <Button size="small" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <p className="player-hint">
              A hub is optional. Pairing with one adds search across connected services, listening together with other people, and shareable links. The player keeps working exactly as it does now without
              one.
            </p>
            <div className="player-form">
              <TextField label="Hub address" value={endpoint} onChange={(e) => setEndpoint(e.currentTarget.value)} spellCheck={false} hint="For example http://192.168.1.20:4546" />
              <TextField label="Pairing code" value={code} onChange={(e) => setCode(e.currentTarget.value.toUpperCase())} spellCheck={false} hint="Create one in the hub's admin page under Devices." />
              <Button variant="default" busy={busy} disabled={!code.trim() || !endpoint.trim()} onClick={() => void claim()}>
                Pair
              </Button>
              {error ? <p className="player-hint player-hint--error">{error}</p> : null}
              {hubStatus.reason && hubStatus.endpoint ? <p className="player-hint player-hint--warning">{hubStatus.reason}</p> : null}
            </div>
          </>
        )}
      </PanelSection>
    </Panel>
  );
}

/**
 * The Windows companion, offered only when there is something real to offer.
 *
 * The hub answers 404 for "no release configured", and that is the common case — an operator has to
 * point the hub at the CI feed or paste the metadata first. Rather than a button that downloads
 * nothing, the panel says which of the two things is missing: a hub, or a release on it. The
 * checksum and the signing state ship with the metadata and are shown, because an unsigned
 * installer will make Windows SmartScreen object and people should know that before they click,
 * not after.
 */
function WindowsCompanionPanel() {
  const { hub, hubStatus } = usePlayer();
  // Remounted when the connection changes (see the `key` where this is rendered), so there is no
  // stale answer to clear and no state to reset on the way in.
  const [release, setRelease] = useState<ReleaseMetadata | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (!hub || !hubStatus.connected) return;
    let cancelled = false;
    void hub.windowsCompanionRelease().then((next) => {
      if (cancelled) return;
      setRelease(next);
      setAsked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hub, hubStatus.connected]);

  const installers = (release?.artifacts ?? []).filter((artifact) => artifact.kind === 'installer');

  return (
    <Panel title="Windows companion">
      <PanelSection>
        <p className="player-hint">
          A desktop app that indexes the music on a Windows PC and offers it to this player through the hub. It is optional: everything here works without it.
        </p>
        {!hubStatus.connected ? (
          <p className="player-hint">Pair a hub above to see whether it is offering a build. The installer is served by your hub, not by this page.</p>
        ) : !asked ? (
          <p className="player-hint">Asking the hub…</p>
        ) : !release || installers.length === 0 ? (
          <p className="player-hint">
            This hub is not offering a Windows build yet. An administrator sets one on the hub's admin page — either by pointing it at the release feed the Windows CI workflow publishes, or by pasting the
            details of a build by hand.
          </p>
        ) : (
          <>
            <KeyValueList
              items={[
                { key: 'Version', value: `${release.version} (${release.channel})` },
                { key: 'Released', value: new Date(release.releasedAt).toLocaleDateString() },
                { key: 'Needs', value: release.minimumWindows },
                {
                  key: 'Code-signed',
                  value: release.signed ? <StatusDot kind="ok" label="Yes" /> : <StatusDot kind="warning" label="No — Windows will warn before it runs" />,
                },
              ]}
            />
            <div className="player-toolbar-row">
              {installers.map((artifact) => (
                <ButtonLink key={artifact.url} size="small" icon="download" href={artifact.url} download={artifact.filename}>
                  {`Download for ${artifact.arch === 'arm64' ? 'ARM' : 'Intel/AMD'} · ${formatBytes(artifact.sizeBytes)}`}
                </ButtonLink>
              ))}
              {release.notesUrl ? (
                <ButtonLink size="small" href={release.notesUrl} target="_blank" rel="noreferrer noopener">
                  Release notes
                </ButtonLink>
              ) : null}
            </div>
            <p className="player-hint">
              {`SHA-256 ${installers[0]!.sha256}. Compare it after downloading with \`Get-FileHash\` in PowerShell if you want to check the file arrived intact.`}
            </p>
          </>
        )}
      </PanelSection>
    </Panel>
  );
}

function deviceName(): string {
  const agent = navigator.userAgent;
  const platform = /iPhone|iPad/.test(agent) ? 'iPhone' : /Android/.test(agent) ? 'Android' : /Mac/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows PC' : 'Browser';
  return `${platform} player`;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

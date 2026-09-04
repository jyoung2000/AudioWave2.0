/**
 * Settings: folders, the hub connection, car and lock-screen integration, storage and privacy.
 *
 * The car panel is deliberately blunt about what a web app can and cannot do (docs/PWA_AND_CAR.md).
 * People install this expecting an Android Auto tile; telling them at the point of disappointment,
 * with what *does* work spelled out, is better than letting them hunt for a setting that does not
 * exist.
 */
import { useCallback, useEffect, useState } from 'react';
import { AquaTable, Button, EmptyState, KeyValueList, Panel, PanelSection, StatusDot, TextField, useToast } from '@now-playing/aqua-ui';
import { useAppState, usePlayer } from '../state/context.js';
import { mediaIntegrationReport } from '../lib/media-session.js';
import type { StoredRoot } from '../lib/db.js';

export function SettingsView() {
  const { store, hub, hubStatus } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const media = mediaIntegrationReport();

  return (
    <>
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

      <HubPanel />

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

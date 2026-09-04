/**
 * Pairing with a hub, and what sharing actually means.
 *
 * The panel states the boundary before anyone opts in: metadata goes to the hub, audio does not
 * move unless a transfer is explicitly started, and the paths on this computer never leave it.
 * That sentence is the whole privacy model, and it belongs where the decision is made.
 */
import { useState } from 'react';
import { Button, Checkbox, KeyValueList, Panel, PanelSection, TextField, useToast } from '@now-playing/aqua-ui';
import type { HubConnection, PairingChallenge } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { useAction } from '../hooks.js';

export function HubView({ status, onChanged }: { status: HubConnection | null; onChanged: () => void }) {
  const toast = useToast();
  const [endpoint, setEndpoint] = useState('http://localhost:4546');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<PairingChallenge | null>(null);
  const [shareLibrary, setShareLibrary] = useState(false);

  const start = useAction(async () => invoke('hub:pair-start', { endpoint, code }));
  const complete = useAction(async (sessionId: string) => invoke('hub:pair-await', { sessionId }));
  const forget = useAction(async () => invoke('hub:forget', undefined));
  const sync = useAction(async () => invoke('hub:sync-now', undefined));
  const share = useAction(async (enabled: boolean) => invoke('hub:share-library', { enabled }));

  if (status?.connected || status?.endpoint) {
    return (
      <Panel title="Hub">
        <PanelSection>
          <KeyValueList
            items={[
              { key: 'Hub', value: `${status.hubName ?? 'a hub'} at ${status.endpoint}` },
              { key: 'Status', value: status.connected ? 'Connected' : (status.reason ?? 'Not reachable') },
              { key: 'Fingerprint', value: <code>{status.hubFingerprint ?? '—'}</code> },
              { key: 'This computer may', value: status.scopes.join(', ') || 'nothing yet' },
              { key: 'Last sync', value: status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'never' },
            ]}
          />
          {!status.connected && status.reason ? <p className="companion-hint companion-hint--warning">{status.reason}</p> : null}
          <div className="companion-actions">
            <Button busy={sync.busy} disabled={!status.connected} onClick={() => void sync.run().then((r) => r?.reason && toast.show(r.reason, { kind: 'warning' }))}>
              Sync now
            </Button>
            <Button
              variant="destructive"
              busy={forget.busy}
              onClick={() => {
                if (window.confirm('Forget this hub?\n\nYour music and folders on this computer stay exactly as they are.')) {
                  void forget.run().then(() => {
                    onChanged();
                    toast.show('Hub forgotten');
                  });
                }
              }}
            >
              Forget this hub
            </Button>
          </div>
        </PanelSection>

        <PanelSection title="What is shared">
          <Checkbox
            checked={shareLibrary}
            onChange={(e) => {
              const enabled = e.currentTarget.checked;
              void share.run(enabled).then((result) => {
                if (result?.reason) toast.show(result.reason, { kind: 'warning' });
                else setShareLibrary(enabled);
              });
            }}
          >
            Let the hub see what music is on this computer
          </Checkbox>
          <ul className="companion-list">
            <li>What is sent: titles, artists, albums, durations, formats and playlist contents.</li>
            <li>What is never sent: the folders on this computer, or any path within them.</li>
            <li>Audio files stay here until you explicitly send one, from the Music screen.</li>
            <li>Turning this off stops future syncs; ask the hub's administrator to delete what it already has.</li>
          </ul>
        </PanelSection>
      </Panel>
    );
  }

  return (
    <Panel title="Connect to a hub">
      <PanelSection>
        <p className="companion-hint">
          A hub is optional. Pairing with one lets this computer's library appear on your other devices, lets you send files to them, and keeps playlists in step. Nothing about this computer is shared
          until you pair, and even then only what the next screen lists.
        </p>
        {challenge ? (
          <>
            <p className="companion-hint">Check that this code matches the one on the hub's screen. If it does not, cancel — something else is answering at that address.</p>
            <p className="companion-fingerprint">{challenge.verificationFingerprint}</p>
            <p className="companion-hint">
              {challenge.hubName} · hub fingerprint <code>{challenge.hubFingerprint}</code>
            </p>
            <p className="companion-hint">Waiting for someone at the hub to confirm…</p>
            <Button
              onClick={() => {
                setChallenge(null);
                setCode('');
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <div className="companion-form">
            <TextField label="Hub address" value={endpoint} onChange={(e) => setEndpoint(e.currentTarget.value)} spellCheck={false} hint="For example http://192.168.1.20:4546" />
            <TextField label="Pairing code" value={code} onChange={(e) => setCode(e.currentTarget.value.toUpperCase())} spellCheck={false} hint="Create one in the hub's admin page, under Devices." />
            <Button
              variant="default"
              busy={start.busy}
              disabled={!code.trim() || !endpoint.trim()}
              onClick={() =>
                void start.run().then((result) => {
                  if (result?.reason) {
                    toast.show(result.reason, { kind: 'error' });
                    return;
                  }
                  if (result?.challenge) {
                    setChallenge(result.challenge);
                    void complete.run(result.challenge.sessionId).then((completed) => {
                      setChallenge(null);
                      if (completed?.reason) toast.show(completed.reason, { kind: 'warning' });
                      else toast.show('Paired.', { kind: 'success' });
                      onChanged();
                    });
                  }
                })
              }
            >
              Pair
            </Button>
            {start.error ? <p className="companion-hint companion-hint--error">{start.error}</p> : null}
          </div>
        )}
      </PanelSection>
    </Panel>
  );
}

/**
 * Paired devices and the pairing flow.
 *
 * The pairing panel shows the code, the QR and the hub fingerprint together, because all three are
 * part of one act: the person joining reads the code, and both sides compare the fingerprint before
 * the admin confirms. Confirming is a separate, explicit step here for the same reason it is on the
 * server — a code alone must never be enough.
 */
import { useCallback, useState } from 'react';
import { AquaTable, Button, Checkbox, Panel, PanelSection, PopUpMenu, StatusDot, useToast } from '@now-playing/aqua-ui';
import type { DeviceView, PairingSessionView, Scope } from '@now-playing/contracts';
import { Scope as ScopeEnum } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { Ago, AsyncPanel, ConfirmButton, InlineError } from './common.js';

const DEFAULT_SCOPES: Scope[] = ['library:read', 'search:use', 'group:member', 'history:events', 'shares:create'];

export function DevicesView() {
  const devices = useResource('devicesList', {}, { pollMs: 10_000 });
  const sessions = useResource('pairingList', {}, { pollMs: 5_000 });
  const toast = useToast();

  const [kind, setKind] = useState<'player' | 'companion'>('player');
  const [scopes, setScopes] = useState<Scope[]>(DEFAULT_SCOPES);
  const [created, setCreated] = useState<{ sessionId: string; code: string; qrSvg: string; hubFingerprint: string; expiresAt: string; note: string; endpointKnown: boolean } | null>(null);
  const [fingerprint, setFingerprint] = useState('');

  const createPairing = useAction(async () => api('pairingCreate', { body: { deviceKind: kind, scopes, ttlSeconds: 600 } }));
  const confirmPairing = useAction(async (sessionId: string, value: string) => api('pairingConfirm', { params: { sessionId }, body: { verificationFingerprint: value } }));
  const revokePairing = useAction(async (sessionId: string) => api('pairingRevoke', { params: { sessionId } }));
  const revokeDevice = useAction(async (deviceId: string) => api('devicesRevoke', { params: { deviceId } }));

  const start = useCallback(async () => {
    const result = await createPairing.run();
    if (result) {
      setCreated(result as typeof created);
      setFingerprint('');
      sessions.reload();
    }
  }, [createPairing, sessions]);

  const confirm = useCallback(async () => {
    if (!created) return;
    const ok = await confirmPairing.run(created.sessionId, fingerprint.trim().toUpperCase());
    if (ok) {
      toast.show('Device confirmed. It can finish pairing now.', { kind: 'success' });
      setCreated(null);
      sessions.reload();
      devices.reload();
    }
  }, [confirmPairing, created, fingerprint, sessions, devices, toast]);

  return (
    <>
      <Panel title="Pair a device">
        {created ? (
          <PanelSection title="Waiting for the device">
            <div className="admin-pairing">
              <div className="admin-pairing__qr" aria-hidden="true" dangerouslySetInnerHTML={{ __html: created.qrSvg }} />
              <div>
                <p className="admin-pairing__code" aria-label="Pairing code">
                  {created.code}
                </p>
                <p className="admin-hint">{created.note}</p>
                {!created.endpointKnown ? <p className="admin-hint admin-hint--warning">This hub has no public endpoint, so the device must be on the same network and enter the address itself.</p> : null}
                <p className="admin-hint">
                  Hub fingerprint: <code>{created.hubFingerprint}</code>
                </p>
                <p className="admin-hint">Once the device has entered the code it will show a six-character verification code. Type it here — if it does not match what the device shows, do not confirm.</p>
                <div className="admin-actions">
                  <label className="aqua-field aqua-field--inline">
                    <span className="aqua-field__label">Verification code</span>
                    <input className="aqua-input" value={fingerprint} onChange={(e) => setFingerprint(e.currentTarget.value)} maxLength={8} spellCheck={false} />
                  </label>
                  <Button variant="default" busy={confirmPairing.busy} disabled={fingerprint.trim().length < 4} onClick={() => void confirm()}>
                    Confirm
                  </Button>
                  <Button
                    busy={revokePairing.busy}
                    onClick={() => {
                      void revokePairing.run(created.sessionId).then(() => {
                        setCreated(null);
                        sessions.reload();
                      });
                    }}
                  >
                    Cancel
                  </Button>
                </div>
                <InlineError error={confirmPairing.error} />
              </div>
            </div>
          </PanelSection>
        ) : (
          <PanelSection title="New pairing">
            <div className="admin-form">
              <PopUpMenu
                label="Device type"
                value={kind}
                onChange={(e) => setKind(e.currentTarget.value as 'player' | 'companion')}
                options={[
                  { value: 'player', label: 'Music player (browser)' },
                  { value: 'companion', label: 'Windows companion' },
                ]}
              />
              <fieldset className="admin-scopes">
                <legend>What this device may do</legend>
                {ScopeEnum.options.map((scope) => (
                  <Checkbox
                    key={scope}
                    checked={scopes.includes(scope)}
                    onChange={(e) => setScopes((list) => (e.currentTarget.checked ? [...list, scope] : list.filter((s) => s !== scope)))}
                  >
                    {SCOPE_LABELS[scope] ?? scope}
                  </Checkbox>
                ))}
              </fieldset>
              <Button variant="default" busy={createPairing.busy} disabled={scopes.length === 0} onClick={() => void start()} ellipsis>
                Create pairing code
              </Button>
              <InlineError error={createPairing.error} />
            </div>
          </PanelSection>
        )}
      </Panel>

      <AsyncPanel
        resource={sessions}
        title="Pending pairings"
        emptyWhen={(d) => (d as { items: PairingSessionView[] }).items.length === 0}
        emptyTitle="No pairing is in progress"
        emptyText="Create a code above to add a device."
      >
        {(raw) => (
          <AquaTable
            label="Pending pairings"
            rowKey={(row: PairingSessionView) => row.id}
            rows={(raw as { items: PairingSessionView[] }).items}
            columns={[
              { id: 'device', header: 'Device', primary: true, cell: (row) => row.claimedDeviceName ?? `(${row.deviceKind})` },
              { id: 'state', header: 'State', cell: (row) => <StatusDot kind={row.state === 'confirmed' ? 'ok' : row.state === 'expired' || row.state === 'revoked' ? 'error' : 'info'} label={row.state} /> },
              { id: 'expires', header: 'Expires', cell: (row) => <Ago iso={row.expiresAt} /> },
              { id: 'attempts', header: 'Attempts', align: 'right', cell: (row) => `${row.attempts}/${row.maxAttempts}` },
              {
                id: 'actions',
                header: '',
                headerLabel: 'Actions',
                cell: (row) => <ConfirmButton label="Revoke" confirmLabel="Revoke this pairing session?" busy={revokePairing.busy} onConfirm={() => void revokePairing.run(row.id).then(() => sessions.reload())} />,
              },
            ]}
          />
        )}
      </AsyncPanel>

      <AsyncPanel
        resource={devices}
        title="Paired devices"
        emptyWhen={(d) => (d as { items: DeviceView[] }).items.length === 0}
        emptyTitle="No devices are paired"
        emptyText="A paired device can browse the library, join groups and sync — within the permissions you grant it."
      >
        {(raw) => (
          <AquaTable
            label="Paired devices"
            rowKey={(row: DeviceView) => row.id}
            rows={(raw as { items: DeviceView[] }).items}
            columns={[
              { id: 'name', header: 'Name', primary: true, cell: (row) => row.name },
              { id: 'kind', header: 'Type', cell: (row) => row.kind },
              { id: 'online', header: 'Status', cell: (row) => <StatusDot kind={row.revokedAt ? 'error' : row.online ? 'ok' : 'neutral'} label={row.revokedAt ? 'revoked' : row.online ? 'online' : 'offline'} /> },
              { id: 'seen', header: 'Last seen', cell: (row) => <Ago iso={row.lastSeenAt} /> },
              { id: 'scopes', header: 'Permissions', cell: (row) => row.scopes.length },
              { id: 'ip', header: 'Address', cell: (row) => row.ipDisplay ?? '—' },
              {
                id: 'actions',
                header: '',
                headerLabel: 'Actions',
                cell: (row) =>
                  row.revokedAt ? null : (
                    <ConfirmButton
                      label="Revoke"
                      confirmLabel={`Revoke ${row.name}? It will be disconnected immediately and must pair again.`}
                      busy={revokeDevice.busy}
                      onConfirm={() => void revokeDevice.run(row.id).then(() => devices.reload())}
                    />
                  ),
              },
            ]}
          />
        )}
      </AsyncPanel>
    </>
  );
}

const SCOPE_LABELS: Partial<Record<Scope, string>> = {
  'library:read': 'Browse and play the hub library',
  'library:share': 'Offer its own library to the hub',
  'playlists:sync': 'Sync playlists',
  'eq:sync': 'Sync equalizer presets',
  'history:aggregate': 'Share an aggregate taste profile (never raw history)',
  'history:events': 'Send listening events for personalization',
  'group:member': 'Join group listening',
  'group:admin': 'Manage groups',
  'downloads:request': 'Request downloads',
  'transfers:receive': 'Receive files from other devices',
  'files:serve': 'Serve files to other devices',
  'search:use': 'Search connected providers',
  'shares:create': 'Create shareable links',
};

/**
 * Paired devices and the pairing flow.
 *
 * Laid out as the design draws it: what the device may do on the left, the pairing-code plate and
 * the pairings in progress on the right, the paired devices underneath. The code, the QR and the
 * hub's fingerprint appear together because they are one act: the person joining reads the code,
 * the device answers with a verification code, and the operator types that back before the hub
 * issues anything. A code alone is never enough — here or on the server.
 */
import { useCallback, useState } from 'react';
import type { DeviceView, PairingSessionView, Scope } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { DEVICE_KINDS, SCOPE_LABELS } from '../lib/words.js';
import { ActionError, Ago, Check, count, EmptyCells, EmptyRow, Field, Group, listState, Pop, Push, Sdot, SubHead, useHubUi, useNow } from '../ui.js';

type Kind = 'player' | 'companion';

/** What a new device is offered unless the operator changes it. */
const DEFAULT_SCOPES: Scope[] = ['library:read', 'search:use', 'group:member', 'history:events', 'shares:create', 'profile:read', 'profile:write', 'backup:read', 'playlists:use', 'library:sync'];

interface Created {
  sessionId: string;
  code: string;
  qrSvg: string;
  hubFingerprint: string;
  expiresAt: string;
  endpointKnown: boolean;
}

const PENDING_WORDS: Record<string, string> = {
  pending: 'Waiting for the device',
  claimed: 'Waiting for you to confirm',
  confirmed: 'Confirmed; the device is finishing',
  consumed: 'Paired',
  expired: 'Expired',
  revoked: 'Refused',
};

export function DevicesView() {
  const devices = useResource('devicesList', {}, { pollMs: 10_000 });
  const sessions = useResource('pairingList', {}, { pollMs: 5_000 });
  const hub = useResource('hubIdentity');
  const { say, confirm } = useHubUi();
  const now = useNow(1000);

  const [kind, setKind] = useState<Kind>('player');
  const [scopes, setScopes] = useState<Scope[]>(DEFAULT_SCOPES);
  const [created, setCreated] = useState<Created | null>(null);
  /** The pairing the verification field answers: the one just made, or one picked from the list. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState('');
  const [plateNote, setPlateNote] = useState<string | null>(null);

  const createPairing = useAction(async () => api('pairingCreate', { body: { deviceKind: kind, scopes, ttlSeconds: 600 } }));
  const confirmPairing = useAction(async (sessionId: string, value: string) => api('pairingConfirm', { params: { sessionId }, body: { verificationFingerprint: value } }));
  const revokePairing = useAction(async (sessionId: string) => api('pairingRevoke', { params: { sessionId } }));
  const revokeDevice = useAction(async (deviceId: string) => api('devicesRevoke', { params: { deviceId } }));

  const start = useCallback(async () => {
    const result = (await createPairing.run()) as Created | null;
    if (result) {
      setCreated(result);
      setConfirming(result.sessionId);
      setFingerprint('');
      setPlateNote(null);
      sessions.reload();
    }
  }, [createPairing, sessions]);

  const finish = useCallback(async () => {
    if (!confirming) return;
    const ok = await confirmPairing.run(confirming, fingerprint.trim().toUpperCase());
    if (ok) {
      say('Device confirmed. It can finish pairing now.');
      setPlateNote('Paired. Start pairing to add another.');
      setCreated(null);
      setConfirming(null);
      setFingerprint('');
      sessions.reload();
      devices.reload();
    }
  }, [confirmPairing, confirming, fingerprint, sessions, devices, say]);

  const refuse = useCallback(
    async (sessionId: string) => {
      await revokePairing.run(sessionId);
      if (created?.sessionId === sessionId) {
        setCreated(null);
        setPlateNote('Cancelled. Start pairing to get a new code.');
      }
      if (confirming === sessionId) setConfirming(null);
      sessions.reload();
    },
    [revokePairing, created, confirming, sessions],
  );

  const all = (sessions.data as { items: PairingSessionView[] } | null)?.items ?? [];
  // Finished pairings are history, not something waiting on anyone.
  const waiting = all.filter((s) => s.state === 'pending' || s.state === 'claimed' || s.state === 'confirmed');
  const pendingState = listState(sessions, () => waiting.length === 0, 'None waiting.');
  const deviceItems = (devices.data as { items: DeviceView[] } | null)?.items ?? [];
  const deviceState = listState(devices, (d) => (d as { items: DeviceView[] }).items.length === 0, 'No devices are paired yet.');

  const secondsLeft = created ? Math.max(0, Math.round((Date.parse(created.expiresAt) - now) / 1000)) : 0;
  const expired = created !== null && secondsLeft === 0;
  const hubFingerprint = created?.hubFingerprint ?? (hub.data as { fingerprint?: string } | null)?.fingerprint ?? null;
  const typed = fingerprint.replace(/[^0-9A-Za-z]/g, '').length;
  const confirmingSession = all.find((s) => s.id === confirming) ?? null;

  return (
    <>
      <div className="split">
        <Group title="Pair a device" className="group--flush">
          <div className="pref pref--narrow">
            <label className="k" htmlFor="devKind">
              Device type:
            </label>
            <div className="v">
              <Pop id="devKind" value={kind} onChange={(e) => setKind(e.currentTarget.value as Kind)}>
                <option value="player">Player</option>
                <option value="companion">Windows companion</option>
              </Pop>
            </div>
          </div>
          <fieldset className="scopes">
            <legend className="hint">
              <b>What this device may do</b>
            </legend>
            {SCOPE_LABELS.map(([scope, label]) => (
              <Check key={scope} checked={scopes.includes(scope)} onChange={(on) => setScopes((list) => (on ? [...list.filter((s) => s !== scope), scope] : list.filter((s) => s !== scope)))}>
                {label} <span className="sub mono">{scope}</span>
              </Check>
            ))}
          </fieldset>
          <div className="barrow">
            <Push primary busy={createPairing.busy} disabled={scopes.length === 0} reason="Tick at least one thing the device may do." onClick={() => void start()}>
              Start Pairing…
            </Push>
            {scopes.length === 0 ? <span className="note note--inline">Tick at least one thing the device may do.</span> : null}
          </div>
          <ActionError error={createPairing.error} />
        </Group>

        <Group title="Pairing code" className="group--flush">
          <div className="lcd">
            <output className="lcd__code" aria-label="Pairing code">
              {created && !expired ? created.code : '— — —'}
            </output>
            <span className="lcd__sub">
              {created
                ? expired
                  ? 'Expired. Start again.'
                  : `Waiting for the device · ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
                : (plateNote ?? 'Start pairing to get a code')}
            </span>
          </div>
          <p className="note">Enter it on the device. A code works once, for ten minutes. The device then shows a verification code, which you type here before anything is issued.</p>
          {hubFingerprint ? (
            <p className="note">
              Hub fingerprint: <span className="mono">{hubFingerprint}</span>. The device shows the same one.
            </p>
          ) : null}
          {created && !expired ? (
            <div className="pairing-extra">
              <div className="pairing-qr" aria-hidden="true" dangerouslySetInnerHTML={{ __html: created.qrSvg }} />
              <p className="note">{created.endpointKnown ? 'Or scan this on the device.' : 'This hub has no public address, so the device must be on the same network and be given the hub’s address by hand.'}</p>
            </div>
          ) : null}
          {confirming ? (
            <form
              className="barrow"
              onSubmit={(event) => {
                event.preventDefault();
                void finish();
              }}
            >
              <Field
                mono
                aria-label="Verification code"
                placeholder="Verification code"
                value={fingerprint}
                maxLength={20}
                onChange={(e) => setFingerprint(e.currentTarget.value)}
              />
              <Push type="submit" primary busy={confirmPairing.busy} disabled={typed < 12} reason="Type the verification code the device is showing.">
                Confirm
              </Push>
              <Push busy={revokePairing.busy} onClick={() => void refuse(confirming)}>
                Cancel
              </Push>
            </form>
          ) : null}
          {confirming ? (
            <p className="note">
              {confirmingSession?.claimedDeviceName ? <>“{confirmingSession.claimedDeviceName}” is asking. </> : null}
              The code is grouped like AB12-CD34-EF56. If it does not match what the device shows, do not confirm.
            </p>
          ) : null}
          <ActionError error={confirmPairing.error ?? revokePairing.error} />

          <SubHead>Pending pairings</SubHead>
          <div className="well">
            <ul className="rows" aria-label="Pending pairings">
              {pendingState ? <EmptyRow {...pendingState} /> : null}
              {pendingState
                ? null
                : waiting.map((s) => (
                    <li key={s.id}>
                      <span className="name">
                        <b>{s.claimedDeviceName ?? DEVICE_KINDS[s.deviceKind] ?? 'Device'}</b>
                      </span>
                      <span className="meta">
                        {PENDING_WORDS[s.state] ?? s.state} · {count(s.requestedScopes.length, 'permission')}
                      </span>
                      {s.state === 'claimed' && confirming !== s.id ? (
                        <Push
                          onClick={() => {
                            setConfirming(s.id);
                            setFingerprint('');
                          }}
                        >
                          Confirm…
                        </Push>
                      ) : null}
                      <Push busy={revokePairing.busy} onClick={() => void refuse(s.id)} aria-label={`Refuse ${s.claimedDeviceName ?? 'this pairing'}`}>
                        Refuse
                      </Push>
                    </li>
                  ))}
            </ul>
          </div>
        </Group>
      </div>

      <Group title="Paired devices" className="group--after-split">
        <div className="well">
          <table className="tbl" aria-label="Paired devices">
            <colgroup>
              <col />
              <col style={{ width: '22%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '18%' }} className="hide-sm" />
              <col style={{ width: 74 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Permissions</th>
                <th scope="col" className="hide-sm">
                  Last seen
                </th>
                <th scope="col">
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {deviceState ? <EmptyCells columns={5} {...deviceState} /> : null}
              {deviceState
                ? null
                : deviceItems.map((d) => (
                    <tr key={d.id}>
                      <td title={[d.platform, d.ipDisplay].filter(Boolean).join(' · ') || undefined}>
                        <Sdot kind={d.revokedAt ? 'bad' : d.online ? 'ok' : 'off'} label={d.revokedAt ? 'Revoked' : d.online ? 'Online' : 'Offline'} inline />
                        {d.name}
                      </td>
                      <td>{DEVICE_KINDS[d.kind] ?? d.kind}</td>
                      <td title={d.scopes.map((s) => SCOPE_LABELS.find(([id]) => id === s)?.[1] ?? s).join(', ')}>
                        {d.scopes.length} of {SCOPE_LABELS.length}
                      </td>
                      <td className="hide-sm">{d.revokedAt ? 'revoked' : d.online ? 'now' : <Ago iso={d.lastSeenAt} />}</td>
                      <td className="acts">
                        {d.revokedAt ? null : (
                          <Push
                            busy={revokeDevice.busy}
                            aria-label={`Revoke ${d.name}`}
                            onClick={() =>
                              void confirm({ title: `Revoke ${d.name}?`, text: 'It is disconnected straight away and has to pair again to come back.', verb: 'Revoke' }).then((go) => {
                                if (go)
                                  void revokeDevice.run(d.id).then((ok) => {
                                    if (ok) say(`Revoked ${d.name}.`);
                                    devices.reload();
                                  });
                              })
                            }
                          >
                            Revoke
                          </Push>
                        )}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        <ActionError error={revokeDevice.error} />
      </Group>
    </>
  );
}

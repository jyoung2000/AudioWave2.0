/**
 * Stream to your devices (docs/AWSP.md): the Remote tab's “Pair a device”, as the design drew it —
 * the code on its LCD, New Code, three steps — with what makes it real beside it.
 *
 * Streaming is off until it is turned on here. When it is on, a one-time code pairs a device and
 * the ticket — this PC's address on the streaming network — is shown as a QR code and can be
 * copied; paired devices are listed with the most they may ask for and whether each is connected
 * directly or carried by a relay. Everything is the main process's; this view only asks.
 */
import { useEffect, useState } from 'react';
import type { AwspDevice, AwspStatus, AwspTier } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { countdown } from '../format.js';
import { useAction } from '../hooks.js';
import { DeviceIcon } from '../icons.js';
import { EmptyRow, LoadingRow, Option, Pop, Push, Remove, Rows, Status, useConfirm } from '../ui.js';

const TIERS: ReadonlyArray<{ value: AwspTier; label: string }> = [
  { value: 'lossless', label: 'Lossless' },
  { value: 'high', label: 'High · 256 kbps' },
  { value: 'saver', label: 'Data Saver · 128 kbps' },
];

/** The time, once a second, while something on screen is counting down. */
function useSeconds(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function connection(status: AwspStatus, device: AwspDevice): string {
  const live = status.connections.find((c) => c.peer === device.id);
  const kind = device.clientKind === 'android' ? 'Android' : 'browser';
  if (!live) return `${kind} · not connected`;
  const how = live.type === 'direct' ? 'direct' : live.type === 'relay' ? 'through a relay' : 'through a bridge';
  return `${kind} · ${how}${live.rttMs !== null ? ` · ${live.rttMs} ms` : ''}`;
}

export function StreamingView({ status, onChanged }: { status: AwspStatus | null; onChanged: (status: AwspStatus) => void }) {
  const confirm = useConfirm();
  const [port, setPort] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const enable = useAction(async (enabled: boolean) => invoke('awsp:set-enabled', { enabled }));
  const code = useAction(async () => invoke('awsp:new-code', undefined));
  const revoke = useAction(async (id: string) => invoke('awsp:revoke', { id }));
  const tier = useAction(async (id: string, value: AwspTier) => invoke('awsp:set-tier', { id, tier: value }));
  const pin = useAction(async (value: number | null) => invoke('awsp:set-port', { port: value }));

  const apply = (next: AwspStatus | null) => {
    if (next) onChanged(next);
  };

  const now = useSeconds(Boolean(status?.pairingCode));
  const left = status?.pairingCode ? countdown(status.pairingCode.expiresAt, now) : null;
  const running = status?.running ?? false;

  const portValue = port ?? (status?.port ? String(status.port) : '');
  const portNumber = portValue.trim() === '' ? null : Number(portValue);
  const portBad = portNumber !== null && (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535);

  const lcdCode = left && status?.pairingCode ? status.pairingCode.code.replace(/^(\d{3})(\d{3})$/, '$1 $2') : '– – –';
  const lcdSub = !status
    ? ' '
    : !status.enabled
      ? 'Turn on streaming to pair a device'
      : !running
        ? (status.reason ?? 'Starting…')
        : left
          ? `Code expires in ${left}`
          : status.pairingCode
            ? 'That code has expired'
            : 'Choose New Code to pair a device';
  const codeReason = !status?.enabled ? 'Turn on streaming first.' : !running ? 'Streaming is still starting.' : null;

  const ask = async (device: AwspDevice) => {
    const yes = await confirm({ title: `Stop “${device.name}” streaming from this PC?`, detail: 'It is disconnected now, and has to be paired again before it can connect.', action: 'Revoke', destructive: true });
    if (yes) apply(await revoke.run(device.id));
  };

  const copyTicket = async () => {
    if (!status?.ticket) return;
    try {
      await navigator.clipboard.writeText(status.ticket);
      setSaid('Ticket copied.');
    } catch {
      setSaid('The ticket couldn’t be copied. Scan the QR code instead.');
    }
  };

  return (
    <>
      <div className="remote-grid">
        <fieldset style={{ margin: 0 }}>
          <legend>Pair a device</legend>
          <div className="lcd" role="status">
            <span className="lcd__code" aria-label={left && status?.pairingCode ? `Pairing code ${status.pairingCode.code.split('').join(' ')}` : 'No pairing code'}>
              {lcdCode}
            </span>
            <span className="lcd__sub">{lcdSub}</span>
          </div>
          <div className="barrow">
            <Push busy={code.busy} disabled={Boolean(codeReason)} reason={codeReason} onClick={() => void code.run().then(apply)}>
              New Code
            </Push>
            <Push disabled={!status?.ticket} reason={status?.ticket ? null : 'The ticket appears once streaming is on.'} onClick={() => void copyTicket()}>
              Copy Ticket
            </Push>
          </div>
          {said ? (
            <p className="note" role="status">
              {said}
            </p>
          ) : null}
          <div className="pairhow">
            {running && status?.ticketQrSvg ? <div className="pairhow__qr" role="img" aria-label="QR code of this PC’s ticket" dangerouslySetInnerHTML={{ __html: status.ticketQrSvg }} /> : null}
            <ol className="steps">
              <li>
                Open the player and choose <b>Settings&nbsp;▸ Sources&nbsp;▸ Connections</b>.
              </li>
              <li>Scan the QR code or paste the ticket, then enter this code.</li>
              <li>The device appears below — that’s it.</li>
            </ol>
          </div>
        </fieldset>

        <fieldset style={{ margin: 0 }}>
          <legend>How devices may connect</legend>
          <div className="opts">
            <Option title="Let paired devices stream from this PC" checked={status?.enabled ?? false} disabled={!status || enable.busy} onChange={(event) => void enable.run(event.currentTarget.checked).then(apply)}>
              On your home network they connect directly. Away from home they connect directly where the network allows, or through an encrypted relay where it doesn’t.
            </Option>
          </div>
          <p className="note" role="status">
            {status ? <Status kind={running ? 'ok' : status.enabled ? (status.reason ? 'warn' : 'busy') : 'off'}>{running ? 'Streaming is on' : status.enabled ? (status.reason ?? 'Starting…') : 'Streaming is off'}</Status> : ' '}
          </p>
          {enable.error ? <p className="note note--bad">{enable.error}</p> : null}
          <p className="note">Every connection is encrypted. A pairing code works once, and only devices paired here can connect.</p>
        </fieldset>
      </div>

      <fieldset style={{ marginTop: 16 }}>
        <legend>Paired devices</legend>
        <Rows label="Paired devices">
          {!status ? (
            <LoadingRow />
          ) : status.devices.length ? (
            status.devices.map((device) => (
              <li key={device.id}>
                <DeviceIcon />
                <span className="name">
                  <b>{device.name || 'Unnamed device'}</b>
                </span>
                <span className="meta">{connection(status, device)}</span>
                <Pop className="pop--row" aria-label={`Best quality ${device.name || 'this device'} may ask for`} value={device.tierCap} disabled={tier.busy} onChange={(event) => void tier.run(device.id, event.currentTarget.value as AwspTier).then(apply)} options={TIERS} />
                <Remove label={`Revoke ${device.name || 'this device'}`} disabled={revoke.busy} onClick={() => void ask(device)} />
              </li>
            ))
          ) : (
            <EmptyRow>Nothing paired yet — enter the code on a device to pair it.</EmptyRow>
          )}
        </Rows>
      </fieldset>

      <fieldset>
        <legend>Streaming network</legend>
        <div className="pref">
          <span className="k">This PC:</span>
          <div className="v">{status?.endpointId ? <span className="path">{status.endpointId}</span> : <span className="dim">Shown once streaming is on.</span>}</div>
          <span className="k">Relay:</span>
          <div className="v">{status?.relayUrl ? <span className="path">{status.relayUrl}</span> : <span className="dim">{running ? 'None reachable yet.' : 'Shown once streaming is on.'}</span>}</div>
          <label className="k top" htmlFor="awsp-port">
            Fixed port:
          </label>
          <div className="v">
            <input
              className={portBad ? 'field num bad-field' : 'field num'}
              id="awsp-port"
              type="text"
              inputMode="numeric"
              value={portValue}
              placeholder="Any"
              aria-invalid={portBad || undefined}
              aria-describedby="awsp-port-help"
              onChange={(event) => setPort(event.currentTarget.value)}
              onBlur={() => {
                if (!portBad && portNumber !== (status?.port ?? null)) void pin.run(portNumber).then(apply);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
            <span className="sub" id="awsp-port-help">
              {portBad ? <span className="note--bad">Use a port from 1024 to 65535, or leave it empty. </span> : null}
              Leave it empty to let Windows choose. Set one only if your router forwards a UDP port to this PC.
            </span>
          </div>
        </div>
      </fieldset>
    </>
  );
}

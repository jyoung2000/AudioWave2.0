/**
 * The Remote tab presents one Player pairing address and one single-use code. That pairing creates
 * the per-device AWSP identity used for encrypted streaming and the allowlisted Companion bridge;
 * the helper token remains inside Companion for local server-side calls. Older direct-helper
 * credentials stay available under Advanced for backwards-compatible local workflows.
 */
import { useEffect, useState } from 'react';
import type { AwspDevice, AwspStatus, AwspTier, HelperStatus, Preferences } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { PlayerPairing } from './PlayerPairing.js';
import { ago, countdown } from '../format.js';
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

/**
 * A paired device's line: how it is connected and how quickly when it is, and when it was last seen
 * when it is not — “Android · direct · 23 ms”, “browser · last seen 5 minutes ago”.
 */
export function connection(status: AwspStatus, device: AwspDevice, now: number = Date.now()): string {
  const live = status.connections.find((c) => c.peer === device.id);
  const kind = device.clientKind === 'android' ? 'Android' : 'browser';
  if (!live) return `${kind} · ${device.lastSeenAt ? `last seen ${ago(device.lastSeenAt, now)}` : 'not seen yet'}`;
  const how = live.type === 'direct' ? 'direct' : live.type === 'relay' ? 'through a relay' : 'through a bridge';
  return `${kind} · ${how}${live.rttMs !== null ? ` · ${live.rttMs} ms` : ''}`;
}

const CONNECTION_WORDS: Record<AwspStatus['network']['connection'], string> = {
  unmetered: 'This PC is on Wi-Fi or Ethernet.',
  metered: 'This PC is on a metered connection.',
  offline: 'This PC has no connection right now.',
  unknown: 'Windows hasn’t said what this connection costs; it is treated as Wi-Fi or Ethernet.',
};

export function StreamingView({ status, onChanged, helper = null, preferences = null }: { status: AwspStatus | null; onChanged: (status: AwspStatus) => void; helper?: HelperStatus | null; preferences?: Preferences | null }) {
  const confirm = useConfirm();
  const [port, setPort] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const enable = useAction(async (enabled: boolean) => invoke('awsp:set-enabled', { enabled }));
  const code = useAction(async () => invoke('awsp:new-code', undefined));
  const revoke = useAction(async (id: string) => invoke('awsp:revoke', { id }));
  const tier = useAction(async (id: string, value: AwspTier) => invoke('awsp:set-tier', { id, tier: value }));
  const pin = useAction(async (value: number | null) => invoke('awsp:set-port', { port: value }));
  const networks = useAction(async (patch: { unmetered?: boolean; metered?: boolean }) => invoke('awsp:set-networks', patch));
  // The device list's "last seen" moves on by itself, a minute at a time.
  const minute = useSeconds(Boolean(status?.devices.length));

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
  const codeReason = !status?.enabled ? 'Allow Player access first.' : !running ? 'The Companion connection is still starting.' : null;

  const ask = async (device: AwspDevice) => {
    const yes = await confirm({ title: `Revoke “${device.name}” Companion access?`, detail: 'This disconnects the device and revokes its per-device identity. It must be paired again before reconnecting.', action: 'Revoke access', destructive: true });
    if (yes) apply(await revoke.run(device.id));
  };

  const copyTicket = async () => {
    if (!status?.ticket) return;
    try {
      await navigator.clipboard.writeText(status.ticket);
      setSaid('Companion pairing address copied.');
    } catch {
      setSaid('The pairing address couldn’t be copied. Scan the QR code instead.');
    }
  };

  return (
    <>
      <div className="remote-grid">
        <fieldset style={{ margin: 0 }}>
          <legend>Pair Music Player with this Companion</legend>
          <p className="note">Use this single address and one-time code in the Player. It creates a per-device encrypted connection for music streaming and supported Companion features; no helper token is entered in the Player.</p>
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
            <Push disabled={!status?.ticket} reason={status?.ticket ? null : 'The pairing address appears once the connection is on.'} onClick={() => void copyTicket()}>
              Copy address
            </Push>
          </div>
          {said ? (
            <p className="note" role="status">
              {said}
            </p>
          ) : null}
          <div className="pairhow">
            {running && status?.ticketQrSvg ? <div className="pairhow__qr" role="img" aria-label="QR code of this Companion’s pairing address" dangerouslySetInnerHTML={{ __html: status.ticketQrSvg }} /> : null}
            <ol className="steps">
              <li>
                Open Music Player and choose <b>Settings&nbsp;▸ Sources&nbsp;▸ Pair Companion</b>.
              </li>
              <li>Scan the QR code or paste this address, then enter the one-time code.</li>
              <li>The paired device appears below. It uses one revocable identity for streaming and Companion access.</li>
            </ol>
          </div>
        </fieldset>

        <fieldset style={{ margin: 0 }}>
          <legend>How devices may connect</legend>
          <div className="opts">
            <Option title="Allow paired Player devices to connect" checked={status?.enabled ?? false} disabled={!status || enable.busy} onChange={(event) => void enable.run(event.currentTarget.checked).then(apply)}>
              Enables the shared encrypted Companion connection and music streaming. Devices connect directly where possible, or through an encrypted relay when needed.
            </Option>
            <Option title="On Wi-Fi and Ethernet" checked={status?.network.unmetered ?? true} disabled={!status?.enabled || networks.busy} onChange={(event) => void networks.run({ unmetered: event.currentTarget.checked }).then(apply)}>
              Stream while this PC is on Wi-Fi or a cable.
            </Option>
            <Option title="On metered connections (mobile data, hotspots)" checked={status?.network.metered ?? true} disabled={!status?.enabled || networks.busy} onChange={(event) => void networks.run({ metered: event.currentTarget.checked }).then(apply)}>
              Stream while this PC itself is on mobile data, a phone’s hotspot or a network Windows marks as metered. Streaming uses that allowance.
            </Option>
          </div>
          <p className="note" role="status">
            {status ? <Status kind={running ? 'ok' : status.enabled ? (status.reason ? 'warn' : 'busy') : 'off'}>{running ? 'Player access is on' : status.enabled ? (status.reason ?? 'Starting…') : 'Player access is off'}</Status> : ' '}
          </p>
          {status?.enabled ? <p className="note">{CONNECTION_WORDS[status.network.connection]}</p> : null}
          {enable.error ? <p className="note note--bad">{enable.error}</p> : null}
          {networks.error ? <p className="note note--bad">{networks.error}</p> : null}
          <p className="note">Every connection is encrypted. A pairing code works once, and only devices paired here can connect.</p>
        </fieldset>
      </div>

      <details className="legacy-player-pairing" style={{ marginTop: 16 }}>
        <summary>Advanced — legacy local helper credentials</summary>
        <div style={{ marginTop: 12 }}>
          <PlayerPairing helper={helper} preferences={preferences} />
        </div>
      </details>

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
                <span className="meta">{connection(status, device, minute)}</span>
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

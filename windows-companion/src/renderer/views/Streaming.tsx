/**
 * Stream to your devices (docs/AWSP.md): the Remote tab's "Pair a device" as the mockup drew it,
 * made real.
 *
 * Streaming is off until it is turned on here. When it is on, the ticket — this PC's address on the
 * streaming network — is shown as text and as a QR code, with a one-time code that pairs a device;
 * paired devices are listed with the most they may ask for, and each live connection says whether
 * it is direct or carried by a relay. Everything is the main process's; this view only asks.
 */
import { useState } from 'react';
import { AquaTable, Button, Checkbox, EmptyState, KeyValueList, Panel, PanelSection, PopUpMenu, StatusDot, TextField, useToast } from '@now-playing/aqua-ui';
import type { AwspDevice, AwspStatus, AwspTier } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { useAction, useChannel, useEvent } from '../hooks.js';

const TIERS: ReadonlyArray<{ value: AwspTier; label: string }> = [
  { value: 'lossless', label: 'Lossless — the file as it is' },
  { value: 'high', label: 'High — Opus 256 kb/s' },
  { value: 'saver', label: 'Data saver — Opus 128 kb/s' },
];

export function StreamingView() {
  const toast = useToast();
  const initial = useChannel('awsp:status', undefined);
  const [live, setLive] = useState<AwspStatus | null>(null);
  const [port, setPort] = useState<string | null>(null);
  useEvent('event:awsp-status', setLive);
  const status = live ?? initial.data ?? null;

  const enable = useAction(async (enabled: boolean) => invoke('awsp:set-enabled', { enabled }));
  const code = useAction(async () => invoke('awsp:new-code', undefined));
  const revoke = useAction(async (id: string) => invoke('awsp:revoke', { id }));
  const tier = useAction(async (id: string, value: AwspTier) => invoke('awsp:set-tier', { id, tier: value }));
  const pin = useAction(async (value: number | null) => invoke('awsp:set-port', { port: value }));

  const apply = (next: AwspStatus | null) => next && setLive(next);
  const portValue = port ?? (status?.port ? String(status.port) : '');
  const portNumber = portValue === '' ? null : Number(portValue);
  const portBad = portNumber !== null && (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535);

  return (
    <Panel title="Stream to your devices">
      <PanelSection>
        <p className="companion-hint">
          Play this PC&rsquo;s music on your phone, anywhere. Devices connect to this PC directly where the network allows, or through an encrypted relay where it does not; the hub is never in the way,
          and only devices you pair here can connect.
        </p>
        <Checkbox checked={status?.enabled ?? false} disabled={!status || enable.busy} onChange={(e) => void enable.run(e.currentTarget.checked).then(apply)}>
          Let paired devices stream from this PC
        </Checkbox>
        {status ? (
          <p className={status.reason ? 'companion-hint companion-hint--warning' : 'companion-hint'} role="status">
            <StatusDot kind={status.running ? 'ok' : status.enabled ? 'warning' : 'neutral'} label={status.running ? 'Streaming server running' : status.enabled ? 'Starting…' : 'Off'} />
            {status.reason ? ` ${status.reason}` : ''}
          </p>
        ) : null}
      </PanelSection>

      {status?.running ? (
        <PanelSection title="Pair a device">
          <div className="companion-pair">
            {status.ticketQrSvg ? <div className="companion-pair__qr" role="img" aria-label="QR code of this PC's ticket" dangerouslySetInnerHTML={{ __html: status.ticketQrSvg }} /> : null}
            <div className="companion-pair__text">
              <div className="companion-lcd" role="status" aria-live="polite">
                <span className="companion-lcd__code" aria-label="Pairing code">
                  {status.pairingCode ? status.pairingCode.code.replace(/(\d{3})(\d{3})/, '$1 $2') : '— — —'}
                </span>
                <span className="companion-lcd__sub">{status.pairingCode ? `Works once, until ${new Date(status.pairingCode.expiresAt).toLocaleTimeString()}` : 'Make a code to pair a device'}</span>
              </div>
              <div className="companion-actions">
                <Button variant="default" busy={code.busy} onClick={() => void code.run().then(apply)}>
                  New Code
                </Button>
                <Button onClick={() => status.ticket && void navigator.clipboard.writeText(status.ticket).then(() => toast.show('Ticket copied', { kind: 'success' }))}>Copy Ticket</Button>
              </div>
              <ol className="companion-steps">
                <li>
                  In the player, open <b>Settings ▸ Sources ▸ Connections</b> and choose <b>Stream from a PC</b>.
                </li>
                <li>Scan the QR code or paste the ticket, then enter the code.</li>
                <li>The device appears below.</li>
              </ol>
            </div>
          </div>
          <KeyValueList items={[{ key: 'This PC', value: <code className="companion-path">{status.endpointId ?? '—'}</code> }, { key: 'Relay', value: status.relayUrl ?? 'none reachable yet' }]} />
        </PanelSection>
      ) : null}

      <PanelSection title="Paired devices">
        {status?.devices.length ? (
          <AquaTable
            label="Paired devices"
            rowKey={(row: AwspDevice) => row.id}
            rows={status.devices}
            columns={[
              { id: 'name', header: 'Device', primary: true, cell: (row) => row.name, stackText: (row) => (row.clientKind === 'android' ? 'Android' : 'Browser') },
              {
                id: 'conn',
                header: 'Now',
                width: 150,
                cell: (row) => {
                  const c = status.connections.find((x) => x.peer === row.id);
                  if (!c) return <StatusDot kind="neutral" label="Not connected" />;
                  return <StatusDot kind="ok" label={`${c.type === 'direct' ? 'Direct' : c.type === 'relay' ? 'Relay-carried' : 'Bridge'}${c.rttMs !== null ? ` · ${c.rttMs} ms` : ''}`} />;
                },
              },
              {
                id: 'tier',
                header: 'At most',
                width: 230,
                cell: (row) => (
                  <PopUpMenu label={`Most ${row.name} may ask for`} hideLabel size="small" value={row.tierCap} onChange={(e) => void tier.run(row.id, e.currentTarget.value as AwspTier).then(apply)} options={TIERS.map((t) => ({ value: t.value, label: t.label }))} />
                ),
              },
              { id: 'paired', header: 'Paired', width: 120, cell: (row) => new Date(row.pairedAt).toLocaleDateString() },
              {
                id: 'actions',
                header: '',
                headerLabel: 'Actions',
                width: 90,
                cell: (row) => (
                  <Button
                    size="mini"
                    variant="destructive"
                    onClick={() => {
                      if (window.confirm(`Stop ${row.name} streaming from this PC?\n\nIt is disconnected now and must be paired again.`)) void revoke.run(row.id).then(apply);
                    }}
                  >
                    Revoke
                  </Button>
                ),
              },
            ]}
          />
        ) : (
          <EmptyState title="No devices paired" text="A paired device can play this PC's music from anywhere. Pair one above." />
        )}
      </PanelSection>

      <PanelSection title="Network">
        <TextField
          label="Fixed port (optional)"
          inputMode="numeric"
          value={portValue}
          hint="Leave empty to let Windows choose. Fix it only if your router forwards a UDP port to this PC."
          onChange={(e) => setPort(e.currentTarget.value)}
          onBlur={() => {
            if (!portBad) void pin.run(portNumber).then(apply);
          }}
          {...(portBad ? { validation: { kind: 'error' as const, message: 'Use a port from 1024 to 65535, or leave it empty.' } } : {})}
        />
      </PanelSection>
    </Panel>
  );
}

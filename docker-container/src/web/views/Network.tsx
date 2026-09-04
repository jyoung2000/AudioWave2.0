/**
 * Network and remote access.
 *
 * The truth table at the bottom is the same one in docs/REMOTE_ACCESS.md, rendered against the
 * hub's *current* settings so an operator can see which row they are on. It says plainly what the
 * hub does not do — no UPnP, no hole punching, no relay service — because the alternative is
 * someone assuming remote access works and finding out it does not.
 */
import { useState } from 'react';
import { AquaTable, Button, Checkbox, KeyValueList, Panel, PanelSection, PopUpMenu, StatusDot, TextField, useToast } from '@now-playing/aqua-ui';
import type { NetworkConfig } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { AsyncPanel, InlineError } from './common.js';

interface Row {
  id: string;
  scenario: string;
  works: string;
  requires: string;
}

export function NetworkView() {
  const network = useResource('networkGet', {}, { pollMs: 30_000 });
  const hub = useResource('hubIdentity', {}, { pollMs: 30_000 });
  const toast = useToast();
  const update = useAction(async (body: Record<string, unknown>) => api('networkPut', { body }));

  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [proxies, setProxies] = useState<string | null>(null);

  const identity = hub.data as { setupComplete: boolean; codeOnlyPairingAvailable: boolean } | null;

  const rows: Row[] = [
    { id: 'lan', scenario: 'Player and hub on the same network', works: 'Yes', requires: 'Bind mode "lan" and the container port published beyond 127.0.0.1' },
    { id: 'same-machine', scenario: 'Player in a browser on the hub machine', works: 'Yes', requires: 'Nothing; this is the default' },
    { id: 'remote-proxy', scenario: 'Player somewhere else, through your own reverse proxy', works: 'Yes', requires: 'Bind mode "remote", a public endpoint over HTTPS, and the proxy CIDR listed as trusted' },
    { id: 'remote-direct', scenario: 'Player somewhere else, no proxy, no port forwarding', works: 'No', requires: 'The hub never opens a port for you: no UPnP, no NAT hole punching, no relay service. Forward a port or run a proxy yourself.' },
    { id: 'offline', scenario: 'Player offline, no hub at all', works: 'Yes', requires: 'The player works standalone; hub features are simply unavailable and say so' },
  ];

  return (
    <>
      <AsyncPanel resource={network} title="Network">
        {(raw) => {
          const c = raw as NetworkConfig;
          return (
            <div className="admin-form">
              {!identity?.setupComplete ? (
                <p className="admin-hint admin-hint--warning">
                  The hub is bound to localhost and will stay there until the admin password is changed, whatever is set here.
                </p>
              ) : null}
              <PopUpMenu
                label="Bind mode"
                value={c.bindMode}
                onChange={(e) =>
                  void update.run({ bindMode: e.currentTarget.value }).then((r) => {
                    if (r) {
                      network.reload();
                      toast.show('Bind mode saved. Restart the container for it to take effect.', { kind: 'warning' });
                    }
                  })
                }
                options={[
                  { value: 'localhost', label: 'localhost — this machine only' },
                  { value: 'lan', label: 'lan — reachable on your local network' },
                  { value: 'remote', label: 'remote — behind a reverse proxy you control' },
                ]}
              />
              <TextField
                label="Public endpoint"
                value={endpoint ?? c.publicEndpoint ?? ''}
                placeholder="https://music.example.com"
                onChange={(e) => setEndpoint(e.currentTarget.value)}
                onBlur={() => {
                  if (endpoint !== null && endpoint !== (c.publicEndpoint ?? '')) {
                    void update.run({ publicEndpoint: endpoint.trim() || null }).then((r) => r && network.reload());
                  }
                }}
                hint="The address other people use. Pairing links, share links and OAuth redirects are unreachable without it."
              />
              <TextField
                label="Trusted proxy CIDRs"
                value={proxies ?? c.trustedProxyCidrs.join(', ')}
                placeholder="172.18.0.0/16"
                onChange={(e) => setProxies(e.currentTarget.value)}
                onBlur={() => {
                  if (proxies !== null) {
                    void update.run({ trustedProxyCidrs: proxies.split(',').map((s) => s.trim()).filter(Boolean) }).then((r) => r && network.reload());
                  }
                }}
                hint="Only list a proxy you control. Trusting an untrusted one lets a caller forge its own address in your logs and rate limits."
              />
              <PopUpMenu
                label="IP addresses in logs"
                value={c.ipLogging.mode}
                onChange={(e) => void update.run({ ipLogging: { mode: e.currentTarget.value, retentionDays: c.ipLogging.retentionDays } }).then((r) => r && network.reload())}
                options={[
                  { value: 'truncated', label: 'Truncated (default) — 192.168.1.x' },
                  { value: 'hashed', label: 'Hashed — a stable identifier, not an address' },
                  { value: 'full', label: 'Full — the complete address' },
                ]}
              />
              {c.warnings.length ? (
                <ul className="admin-alerts">
                  {c.warnings.map((w, i) => (
                    <li key={i} data-level="warning">
                      {w}
                    </li>
                  ))}
                </ul>
              ) : null}
              {c.restartRequired ? <p className="admin-hint admin-hint--warning">Restart the container to apply the bind change.</p> : null}
              <InlineError error={update.error} />
              <KeyValueList
                items={[
                  { key: 'Listening on', value: `${c.bindAddress}:${c.port}` },
                  { key: 'TLS', value: c.tlsTerminatedByProxy ? 'terminated by your proxy' : 'none — plain HTTP' },
                  { key: 'Code-only pairing', value: identity?.codeOnlyPairingAvailable ? 'available' : 'unavailable without a reachable public endpoint' },
                ]}
              />
            </div>
          );
        }}
      </AsyncPanel>

      <Panel title="What works where">
        <PanelSection>
          <AquaTable
            label="Remote access"
            rowKey={(row: Row) => row.id}
            rows={rows}
            columns={[
              { id: 'scenario', header: 'Scenario', primary: true, cell: (row) => row.scenario },
              { id: 'works', header: 'Works', cell: (row) => <StatusDot kind={row.works === 'Yes' ? 'ok' : 'error'} label={row.works} /> },
              { id: 'requires', header: 'What it takes', cell: (row) => row.requires },
            ]}
          />
          <p className="admin-hint">
            This hub does not configure your router and never will. There is no built-in tunnel, relay or discovery service — nothing about your setup is sent anywhere.
          </p>
        </PanelSection>
      </Panel>
    </>
  );
}

export { Button, Checkbox };

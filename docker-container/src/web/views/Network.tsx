/**
 * Network and remote access.
 *
 * The design's preference pane, then "What works where" drawn against the hub's current settings so
 * an operator can see which column they are in. It says plainly what the hub does not do — no UPnP,
 * no hole punching, no relay service — because the alternative is someone assuming remote access
 * works and finding out it does not.
 */
import { useState } from 'react';
import type { NetworkConfig } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, errorSentence, Field, Group, Note, Pop, SubHead, useHubUi } from '../ui.js';

type Need = 'yes' | 'lan' | 'remote' | 'endpoint';
const WHERE: ReadonlyArray<readonly [string, readonly [Need, Need, Need]]> = [
  ['Player and companion', ['yes', 'lan', 'remote']],
  ['Pairing', ['yes', 'lan', 'remote']],
  ['Group listening', ['yes', 'lan', 'remote']],
  ['Shared links', ['yes', 'lan', 'endpoint']],
  ['Admin (this page)', ['yes', 'lan', 'remote']],
];
const BIND_NOTES = {
  localhost: 'Only this computer can reach the hub.',
  lan: 'Devices on your home network can reach it. Also publish the port in compose.yaml.',
  remote: 'Needs a public https address and a proxy or tunnel you run.',
} as const;

export function NetworkView() {
  const network = useResource('networkGet', {}, { pollMs: 30_000 });
  const hub = useResource('hubIdentity', {}, { pollMs: 30_000 });
  const { say } = useHubUi();
  const update = useAction(async (body: Record<string, unknown>) => api('networkPut', { body }));

  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [proxies, setProxies] = useState<string | null>(null);
  const [endpointBad, setEndpointBad] = useState(false);

  const c = network.data as NetworkConfig | null;
  const identity = hub.data as { codeOnlyPairingAvailable: boolean } | null;

  const put = (body: Record<string, unknown>, done: string): void =>
    void update.run(body).then((r) => {
      if (!r) return;
      network.reload();
      hub.reload();
      say(done);
    });

  if (!c) {
    return (
      <Group title="Network">
        <Note bad={Boolean(network.error)}>{network.error ? errorSentence(network.error) : 'Loading…'}</Note>
      </Group>
    );
  }

  const level = { localhost: 0, lan: 1, remote: 2 }[c.bindMode];
  const hasEndpoint = Boolean(c.publicEndpoint);
  const works = (need: Need): boolean => need === 'yes' || (need === 'lan' && level >= 1) || (need === 'remote' && level >= 2) || (need === 'endpoint' && level >= 2 && hasEndpoint);

  return (
    <Group title="Network">
      <div className="pref">
        <label className="k" htmlFor="bind">
          Reachable from:
        </label>
        <div className="v">
          <Pop id="bind" value={c.bindMode} disabled={update.busy} onChange={(e) => put({ bindMode: e.currentTarget.value }, 'Saved. Restart the container for it to take effect.')}>
            <option value="localhost">This machine only</option>
            <option value="lan">Your network</option>
            <option value="remote">The internet</option>
          </Pop>
          <span className="sub">
            {BIND_NOTES[c.bindMode]}
            {c.restartRequired ? ' Restart the container to apply the change.' : ''}
          </span>
        </div>
        <label className="k" htmlFor="endpoint">
          Public address:
        </label>
        <div className="v">
          <Field
            id="endpoint"
            mono
            placeholder="https://music.example.com"
            value={endpoint ?? c.publicEndpoint ?? ''}
            invalid={endpointBad}
            onChange={(e) => setEndpoint(e.currentTarget.value)}
            onBlur={() => {
              if (endpoint === null) return;
              const next = endpoint.trim();
              if (next === (c.publicEndpoint ?? '')) return;
              const bad = next !== '' && !/^https:\/\/\S+$/.test(next);
              setEndpointBad(bad);
              if (!bad) put({ publicEndpoint: next || null }, next ? 'Saved the public address.' : 'Removed the public address.');
            }}
          />
          {endpointBad ? (
            <span className="note note--bad note--row" role="alert">
              Use an https address.
            </span>
          ) : (
            <span className="sub">The address other people use. Pairing links and shared links can’t be reached from outside without it.</span>
          )}
        </div>
        <label className="k" htmlFor="proxies">
          Trusted proxies:
        </label>
        <div className="v">
          <Field
            id="proxies"
            mono
            placeholder="Leave empty unless a proxy you run sits in front"
            value={proxies ?? c.trustedProxyCidrs.join(', ')}
            onChange={(e) => setProxies(e.currentTarget.value)}
            onBlur={() => {
              if (proxies === null) return;
              const list = proxies
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              if (list.join(',') !== c.trustedProxyCidrs.join(',')) put({ trustedProxyCidrs: list }, 'Saved the trusted proxies.');
            }}
          />
          <span className="sub">Address ranges such as 172.18.0.0/16. Only list a proxy you control: a trusted proxy can say a request came from anywhere.</span>
        </div>
        <label className="k" htmlFor="iplog">
          IPs in logs:
        </label>
        <div className="v">
          <Pop id="iplog" value={c.ipLogging.mode} disabled={update.busy} onChange={(e) => put({ ipLogging: { mode: e.currentTarget.value, retentionDays: c.ipLogging.retentionDays } }, 'Saved how addresses are logged.')}>
            <option value="truncated">Truncated</option>
            <option value="hashed">Hashed</option>
            <option value="full">Full</option>
          </Pop>
        </div>
      </div>
      <ActionError error={update.error} />
      {c.warnings.map((w, i) => (
        <Note key={i}>{w}</Note>
      ))}

      <SubHead>What works where</SubHead>
      <div className="well">
        <table className="tbl" aria-label="What works where">
          <colgroup>
            <col />
            <col style={{ width: '20%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '20%' }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr">Feature</span>
              </th>
              <th scope="col">This machine</th>
              <th scope="col">Your network</th>
              <th scope="col">Internet</th>
            </tr>
          </thead>
          <tbody>
            {WHERE.map(([feature, needs]) => (
              <tr key={feature}>
                <th scope="row" className="rowhead">
                  {feature}
                </th>
                {needs.map((need, i) => (
                  <td key={i} className={works(need) ? 'ok' : 'sub'}>
                    <span aria-hidden="true">{works(need) ? '✓' : '—'}</span>
                    <span className="sr">{works(need) ? 'Works' : 'Does not work'}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>
        The hub never opens a port for you: no UPnP, no NAT hole punching, no relay service. Changing the published port in <span className="mono">compose.yaml</span> is up to you.
      </Note>
      <dl className="kv kv--after">
        <dt>Listening on</dt>
        <dd className="mono">
          {c.bindAddress}:{c.port}
        </dd>
        <dt>Encryption</dt>
        <dd>{c.tlsTerminatedByProxy ? 'https, handled by your proxy' : 'None: plain http'}</dd>
        <dt>Pairing with a code alone</dt>
        <dd>{identity?.codeOnlyPairingAvailable ? 'Works' : 'Needs a public address the device can reach'}</dd>
      </dl>
    </Group>
  );
}

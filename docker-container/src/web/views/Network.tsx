/**
 * Network and remote access.
 *
 * The design's preference pane, then "What works where" drawn against the hub's current settings so
 * an operator can see which column they are in. It says plainly what the hub does not do — no UPnP,
 * no hole punching, no relay service — because the alternative is someone assuming remote access
 * works and finding out it does not.
 *
 * Nothing is sent while typing or choosing: Save sends what changed, Revert puts back what the hub
 * has, and each field says what is wrong with it before anything is sent.
 */
import { useState } from 'react';
import type { NetworkConfig } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, errorSentence, Field, Group, Note, Pop, Push, SubHead, useHubUi } from '../ui.js';

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

interface NetworkDraft {
  bindMode: NetworkConfig['bindMode'];
  publicEndpoint: string;
  proxies: string;
  ipLogging: NetworkConfig['ipLogging']['mode'];
}

function draftOf(c: NetworkConfig): NetworkDraft {
  return { bindMode: c.bindMode, publicEndpoint: c.publicEndpoint ?? '', proxies: c.trustedProxyCidrs.join(', '), ipLogging: c.ipLogging.mode };
}

function proxyList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const CIDR = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f:]+:[0-9a-f:.]*)(?:\/\d{1,3})?$/i;

/** What is wrong with each field, by field; empty when the draft can be saved. */
export function networkProblems(draft: NetworkDraft): Partial<Record<'publicEndpoint' | 'proxies', string>> {
  const problems: Partial<Record<'publicEndpoint' | 'proxies', string>> = {};
  const endpoint = draft.publicEndpoint.trim();
  if (endpoint && !/^https:\/\/[^\s/]+/i.test(endpoint)) problems.publicEndpoint = 'Use an https address, such as https://music.example.com.';
  const bad = proxyList(draft.proxies).filter((p) => !CIDR.test(p));
  if (bad.length) problems.proxies = `${bad[0]} isn’t an address range. Use one such as 172.18.0.0/16.`;
  return problems;
}

export function NetworkView() {
  const network = useResource('networkGet', {}, { pollMs: 30_000 });
  const hub = useResource('hubIdentity', {}, { pollMs: 30_000 });
  const { say } = useHubUi();
  const update = useAction(async (body: Record<string, unknown>) => api('networkPut', { body }));
  const [draft, setDraft] = useState<NetworkDraft | null>(null);
  const [checked, setChecked] = useState(false);

  const c = network.data as NetworkConfig | null;
  const identity = hub.data as { codeOnlyPairingAvailable: boolean } | null;

  if (!c) {
    return (
      <Group title="Network">
        <Note bad={Boolean(network.error)}>{network.error ? errorSentence(network.error) : 'Loading…'}</Note>
      </Group>
    );
  }

  const stored = draftOf(c);
  const value = draft ?? stored;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored);
  const problems = networkProblems(value);
  const edit = (patch: Partial<NetworkDraft>): void => {
    setDraft({ ...value, ...patch });
    update.clearError();
  };

  const save = async (): Promise<void> => {
    setChecked(true);
    if (!draft || Object.keys(problems).length) return;
    const body: Record<string, unknown> = {};
    if (draft.bindMode !== stored.bindMode) body['bindMode'] = draft.bindMode;
    if (draft.publicEndpoint.trim() !== stored.publicEndpoint) body['publicEndpoint'] = draft.publicEndpoint.trim() || null;
    if (proxyList(draft.proxies).join(',') !== c.trustedProxyCidrs.join(',')) body['trustedProxyCidrs'] = proxyList(draft.proxies);
    if (draft.ipLogging !== stored.ipLogging) body['ipLogging'] = { mode: draft.ipLogging, retentionDays: c.ipLogging.retentionDays };
    const saved = (await update.run(body)) as NetworkConfig | null;
    if (!saved) return;
    setDraft(null);
    setChecked(false);
    network.reload();
    hub.reload();
    say(saved.restartRequired ? 'Saved. Restart the container for it to take effect.' : 'Saved.');
  };
  const revert = (): void => {
    setDraft(null);
    setChecked(false);
    update.clearError();
  };
  const show = (field: 'publicEndpoint' | 'proxies'): string | null => (checked || (draft !== null && value[field] !== stored[field]) ? (problems[field] ?? null) : null);

  // The table shows what the saved settings allow, not the unsaved draft.
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
          <Pop id="bind" value={value.bindMode} disabled={update.busy} onChange={(e) => edit({ bindMode: e.currentTarget.value as NetworkDraft['bindMode'] })}>
            <option value="localhost">This machine only</option>
            <option value="lan">Your network</option>
            <option value="remote">The internet</option>
          </Pop>
          <span className="sub">
            {BIND_NOTES[value.bindMode]}
            {c.restartRequired ? ' Restart the container to apply the change.' : ''}
          </span>
        </div>
        <label className="k" htmlFor="endpoint">
          Public address:
        </label>
        <div className="v">
          <Field id="endpoint" mono placeholder="https://music.example.com" value={value.publicEndpoint} invalid={Boolean(show('publicEndpoint'))} aria-describedby="endpoint-help" onChange={(e) => edit({ publicEndpoint: e.currentTarget.value })} />
          {show('publicEndpoint') ? (
            <span className="note note--bad note--row" role="alert" id="endpoint-help">
              {show('publicEndpoint')}
            </span>
          ) : (
            <span className="sub" id="endpoint-help">
              The address other people use. Pairing links and shared links can’t be reached from outside without it.
            </span>
          )}
        </div>
        <label className="k" htmlFor="proxies">
          Trusted proxies:
        </label>
        <div className="v">
          <Field id="proxies" mono placeholder="Leave empty unless a proxy you run sits in front" value={value.proxies} invalid={Boolean(show('proxies'))} aria-describedby="proxies-help" onChange={(e) => edit({ proxies: e.currentTarget.value })} />
          {show('proxies') ? (
            <span className="note note--bad note--row" role="alert" id="proxies-help">
              {show('proxies')}
            </span>
          ) : (
            <span className="sub" id="proxies-help">
              Address ranges such as 172.18.0.0/16, separated by commas. Only list a proxy you control: a trusted proxy can say a request came from anywhere.
            </span>
          )}
        </div>
        <label className="k" htmlFor="iplog">
          IPs in logs:
        </label>
        <div className="v">
          <Pop id="iplog" value={value.ipLogging} disabled={update.busy} onChange={(e) => edit({ ipLogging: e.currentTarget.value as NetworkDraft['ipLogging'] })}>
            <option value="truncated">Truncated</option>
            <option value="hashed">Hashed</option>
            <option value="full">Full</option>
          </Pop>
        </div>
        <span className="k" />
        <div className="v">
          <Push primary busy={update.busy} busyLabel="Saving…" disabled={!dirty} reason="Nothing has changed." onClick={() => void save()}>
            Save
          </Push>
          <Push disabled={!dirty} reason="Nothing has changed." onClick={revert}>
            Revert
          </Push>
          {dirty ? <span className="note note--inline">Not saved yet.</span> : null}
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

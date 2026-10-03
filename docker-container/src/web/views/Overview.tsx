/**
 * The overview: what an operator needs to see in five seconds.
 *
 * Six tiles, then what needs attention, then every provider's health as a word. Alerts are the
 * only part that ever demands action, and each one is a sentence with the remedy in it. Everything
 * is read from the hub; while the first-run gate is up the tiles that depend on gated routes say
 * that they are off, rather than showing a number nobody can vouch for.
 */
import type { ReactNode } from 'react';
import type { DeviceView, LibraryRoot, OverviewMetrics, ProviderDescriptor } from '@now-playing/contracts';
import { useResource } from '../lib/hooks.js';
import { PROVIDER_STATUS } from '../lib/words.js';
import { Ago, count, EmptyRow, errorSentence, formatBytes, formatUptime, Group, Sdot, useHubUi, type DotKind } from '../ui.js';

const REACH = { localhost: 'this machine only', lan: 'your network', remote: 'the internet' } as const;
const ALERT_DOT: Record<string, DotKind> = { error: 'bad', warning: 'warn', info: 'off' };
const GATEWAY: Record<string, string> = { connected: 'Online', connecting: 'Connecting', reconnecting: 'Reconnecting', disconnected: 'Not connected', stopped: 'Not running', error: 'Stopped by an error' };

export function OverviewView() {
  const { gated } = useHubUi();
  const overview = useResource('metricsOverview', {}, { pollMs: 5_000 });
  // The provider list is one of the few routes the server answers before setup; it carries the names.
  const providers = useResource('providersList', {}, { pollMs: 60_000 });
  const devices = useResource('devicesList', {}, { pollMs: 15_000, enabled: !gated });
  const roots = useResource('libraryRoots', {}, { pollMs: 30_000, enabled: !gated });

  const data = overview.data as OverviewMetrics | null;
  const names = new Map(((providers.data as { items: ProviderDescriptor[] } | null)?.items ?? []).map((p) => [p.provider, p.displayName]));
  const nameOf = (id: string): string => names.get(id) ?? id;
  const paired = ((devices.data as { items: DeviceView[] } | null)?.items ?? null)?.filter((d) => !d.revokedAt) ?? null;
  const folders = (roots.data as { items: LibraryRoot[] } | null)?.items ?? null;

  if (!data) {
    return (
      <>
        <div className="tiles" aria-busy={!overview.error}>
          {['Hub', 'Devices', 'Groups', 'Library', 'Providers', 'Storage'].map((heading) => (
            <Tile key={heading} heading={heading} big="—" small={overview.error ? 'Not available' : 'Loading…'} />
          ))}
        </div>
        <Group title="Needs attention" last>
          <div className="well">
            <ul className="rows" aria-label="Needs attention">
              <EmptyRow text={overview.error ? errorSentence(overview.error) : 'Loading…'} retry={overview.error ? overview.reload : undefined} />
            </ul>
          </div>
        </Group>
      </>
    );
  }

  const good = data.providers.filter((p) => p.status === 'ok');
  const playing = data.groups.filter((g) => g.status === 'playing').length;
  const online = paired?.filter((d) => d.online).length ?? 0;
  const tracks = folders?.reduce((sum, f) => sum + f.trackCount, 0) ?? 0;
  const lastScan = folders?.map((f) => f.lastScanAt).filter((t): t is string => Boolean(t)).sort().at(-1) ?? null;
  const workingNames = good.map((p) => nameOf(p.provider));

  return (
    <>
      <div className="tiles">
        <Tile heading="Hub" dot="ok" big={`v${data.hub.version}`} small={`Up ${formatUptime(data.uptimeSeconds)} · ${REACH[data.hub.bindMode]}`} />
        {gated ? (
          <Tile heading="Devices" big="Off" small="Pairing starts once a password is set" />
        ) : (
          <Tile heading="Devices" dot={online ? 'ok' : undefined} big={paired ? `${paired.length} paired` : '—'} small={paired ? `${online} online now` : 'Loading…'} />
        )}
        {gated ? (
          <Tile heading="Groups" big="Off" small="Starts once a password is set" />
        ) : (
          <Tile heading="Groups" dot={playing ? 'ok' : undefined} big={`${playing} playing`} small={data.groups.length ? count(data.groups.length, 'group') : 'No groups yet'} />
        )}
        {gated ? (
          <Tile heading="Library" big="Off" small="Shown once a password is set" />
        ) : (
          <Tile
            heading="Library"
            big={folders ? count(tracks, 'track') : '—'}
            small={
              !folders ? (
                'Loading…'
              ) : folders.length === 0 ? (
                'No folders yet'
              ) : (
                <>
                  {count(folders.length, 'folder')} · {lastScan ? <>scanned <Ago iso={lastScan} /></> : 'not scanned yet'}
                </>
              )
            }
          />
        )}
        <Tile
          heading="Providers"
          dot={data.providers.length === 0 ? undefined : good.length < data.providers.length ? 'warn' : 'ok'}
          big={`${good.length} of ${data.providers.length} working`}
          small={workingNames.length === 0 ? 'None working yet' : workingNames.length <= 2 ? workingNames.join(' and ') : `${workingNames.slice(0, 2).join(', ')} and more`}
        />
        <Tile
          heading="Storage"
          big={data.storage.freeBytes === null ? 'Unknown' : `${formatBytes(data.storage.freeBytes)} free`}
          small={data.database.lastBackupAt ? <>Last backup <Ago iso={data.database.lastBackupAt} /></> : 'Never backed up'}
        />
      </div>

      <Group title="Needs attention">
        <div className="well">
          <ul className="rows" aria-label="Needs attention">
            {data.alerts.length === 0 ? <EmptyRow text="Nothing needs you." /> : null}
            {data.alerts.map((alert, i) => (
              <li key={i}>
                <Sdot kind={ALERT_DOT[alert.level] ?? 'off'} />
                <span className="grow">{alert.message}</span>
              </li>
            ))}
          </ul>
        </div>
      </Group>

      <Group title="Provider health">
        <div className="well">
          <ul className="rows" aria-label="Provider health">
            {data.providers.length === 0 ? <EmptyRow text="No providers yet." /> : null}
            {data.providers.map((p) => {
              const status = PROVIDER_STATUS[p.status] ?? PROVIDER_STATUS.down;
              return (
                <li key={p.provider} title={p.lastError}>
                  <Sdot kind={status.dot} />
                  <span className="name">
                    <b>{nameOf(p.provider)}</b>
                  </span>
                  <span className="meta">{status.word}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </Group>

      <Group title="This hub" last>
        <dl className="kv">
          <dt>Name</dt>
          <dd>{data.hub.name}</dd>
          <dt>Fingerprint</dt>
          <dd>
            <span className="mono">{data.hub.fingerprint}</span>
            <span className="sub"> · compare it with what a device shows while pairing</span>
          </dd>
          <dt>Public address</dt>
          <dd>{data.hub.publicEndpoint ? <span className="mono">{data.hub.publicEndpoint}</span> : 'None, so pairing and shared links only work on your network'}</dd>
          <dt>Connected now</dt>
          <dd>
            {count(data.connections.players, 'player')} and {count(data.connections.companions, 'companion')}
            {data.pairing.pending ? ` · ${count(data.pairing.pending, 'pairing')} waiting` : ''}
          </dd>
          <dt>Jobs</dt>
          <dd>
            {data.jobs.running} running · {data.jobs.queued} waiting · {data.jobs.failed} failed · {data.jobs.completed} done
          </dd>
          <dt>Database</dt>
          <dd>
            {formatBytes(data.database.sizeBytes)} in <span className="mono">{data.storage.dataDir}</span>
          </dd>
          <dt>Memory</dt>
          <dd>{formatBytes(data.memoryRssBytes)}</dd>
          <dt>Discord bot</dt>
          <dd>{!data.discord.configured ? 'No token yet' : !data.discord.enabled ? 'Has a token, switched off' : (GATEWAY[data.discord.gateway] ?? 'Not running')}</dd>
          <dt>Versions</dt>
          <dd>
            Hub {data.hub.version} · contracts {data.hub.contractsVersion} · protocol {data.hub.protocolVersion}
          </dd>
        </dl>
      </Group>
    </>
  );
}

/** One of the design's overview tiles: a heading with an optional status lamp, a large figure, a line under it. */
function Tile({ heading, dot, big, small }: { heading: string; dot?: DotKind | undefined; big: ReactNode; small: ReactNode }) {
  return (
    <div className="tile">
      <h3>
        {dot ? <Sdot kind={dot} inline /> : null}
        {heading}
      </h3>
      <span className="big">{big}</span>
      <span className="sm">{small}</span>
    </div>
  );
}

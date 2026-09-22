/**
 * The overview: what an operator needs to see in five seconds.
 *
 * Alerts come first because they are the only part that ever demands action, and each one is
 * phrased as a sentence with the remedy in it rather than a status code.
 */
import type { ReactNode } from 'react';
import { AquaTable, Panel, PanelSection, KeyValueList } from '@now-playing/aqua-ui';
import type { OverviewMetrics, ProviderHealth } from '@now-playing/contracts';
import { useResource } from '../lib/hooks.js';
import { Ago, AsyncPanel, Bytes, Health } from './common.js';

export function OverviewView() {
  const overview = useResource('metricsOverview', {}, { pollMs: 5_000 });

  return (
    <AsyncPanel resource={overview} title="Overview">
      {(raw) => {
        const data = raw as OverviewMetrics;
        const good = data.providers.filter((p) => p.status === 'ok').length;
        const playing = data.groups.filter((g) => g.status === 'playing').length;
        return (
          <>
            <div className="admin-tiles">
              <Tile heading="Hub" dot="ok" big={data.hub.version} small={`Up ${formatUptime(data.uptimeSeconds)} · ${data.hub.bindMode}`} />
              <Tile heading="Connections" dot={data.connections.active ? 'ok' : null} big={String(data.connections.active)} small={`${data.connections.players} players · ${data.connections.companions} companions`} />
              <Tile
                heading="Groups"
                dot={playing ? 'ok' : null}
                big={data.groups.length ? `${playing} playing` : 'None'}
                small={data.groups.length ? `${data.groups.length} ${data.groups.length === 1 ? 'group' : 'groups'}` : 'No group has been made yet'}
              />
              <Tile heading="Providers" dot={data.providers.length === 0 ? null : good < data.providers.length ? 'warning' : 'ok'} big={`${good} of ${data.providers.length} working`} small={data.providers.map((p) => p.provider).join(', ') || 'None configured'} />
              <Tile
                heading="Storage"
                dot={null}
                big={data.storage.freeBytes === null ? 'Unknown' : <><Bytes value={data.storage.freeBytes} /> free</>}
                small={data.database.lastBackupAt ? <>Last backup <Ago iso={data.database.lastBackupAt} /></> : 'Never backed up'}
              />
              <Tile heading="Jobs" dot={data.jobs.failed ? 'error' : data.jobs.running ? 'ok' : null} big={`${data.jobs.running} running`} small={`${data.jobs.queued} queued · ${data.jobs.failed} failed`} />
            </div>
            {data.alerts.length ? (
              <PanelSection title="Attention">
                <ul className="admin-alerts">
                  {data.alerts.map((alert, i) => (
                    <li key={i} data-level={alert.level}>
                      {alert.message}
                    </li>
                  ))}
                </ul>
              </PanelSection>
            ) : null}

            <PanelSection title="Hub">
              <KeyValueList
                items={[
                  { key: 'Version', value: `${data.hub.version} (contracts ${data.hub.contractsVersion}, protocol ${data.hub.protocolVersion})` },
                  { key: 'Uptime', value: formatUptime(data.uptimeSeconds) },
                  { key: 'Bind mode', value: data.hub.bindMode },
                  { key: 'Public endpoint', value: data.hub.publicEndpoint ?? 'none — pairing and share links only work locally' },
                  { key: 'Fingerprint', value: <code>{data.hub.fingerprint}</code> },
                  { key: 'Memory', value: <Bytes value={data.memoryRssBytes} /> },
                ]}
              />
            </PanelSection>

            <PanelSection title="Connections">
              <KeyValueList
                items={[
                  { key: 'Active', value: `${data.connections.active} (${data.connections.players} players, ${data.connections.companions} companions)` },
                  { key: 'Reconnects', value: data.connections.reconnects },
                  { key: 'Realtime errors', value: data.connections.wsErrors },
                  { key: 'Pending pairings', value: data.pairing.pending },
                ]}
              />
            </PanelSection>

            <PanelSection title="Providers">
              <AquaTable
                label="Provider health"
                rowKey={(row: ProviderHealth) => row.provider}
                rows={data.providers}
                columns={[
                  { id: 'provider', header: 'Provider', primary: true, cell: (row) => row.provider },
                  { id: 'status', header: 'Status', cell: (row) => <Health status={row.status} /> },
                  { id: 'circuit', header: 'Circuit', cell: (row) => row.circuit },
                  { id: 'quota', header: 'Quota', cell: (row) => (row.quota ? `${row.quota.used} / ${row.quota.budget} ${row.quota.unit}` : '—') },
                  { id: 'latency', header: 'Latency', align: 'right', cell: (row) => (row.latencyMs === undefined ? '—' : `${Math.round(row.latencyMs)} ms`) },
                  { id: 'reason', header: 'Note', cell: (row) => row.lastError ?? '' },
                ]}
              />
            </PanelSection>

            {data.groups.length ? (
              <PanelSection title="Groups">
                <AquaTable
                  label="Groups"
                  rowKey={(row) => row.groupId}
                  rows={data.groups}
                  columns={[
                    { id: 'name', header: 'Name', primary: true, cell: (row) => row.name },
                    { id: 'status', header: 'Status', cell: (row) => row.status },
                    { id: 'queue', header: 'Queue', align: 'right', cell: (row) => row.queueLength },
                    { id: 'listeners', header: 'Listeners', align: 'right', cell: (row) => row.listeners },
                  ]}
                />
              </PanelSection>
            ) : null}

            <PanelSection title="Storage and jobs">
              <KeyValueList
                items={[
                  { key: 'Data directory', value: <code>{data.storage.dataDir}</code> },
                  { key: 'Free space', value: data.storage.freeBytes === null ? 'unknown on this filesystem' : <><Bytes value={data.storage.freeBytes} /> of <Bytes value={data.storage.totalBytes} /></> },
                  { key: 'Database', value: <><Bytes value={data.database.sizeBytes} /> · schema v{data.database.migrationVersion}{data.database.walMode ? ' · WAL' : ''}</> },
                  { key: 'Last backup', value: <Ago iso={data.database.lastBackupAt} /> },
                  { key: 'Jobs', value: `${data.jobs.running} running, ${data.jobs.queued} queued, ${data.jobs.failed} failed, ${data.jobs.completed} completed` },
                ]}
              />
            </PanelSection>

            <PanelSection title="Discord">
              <KeyValueList
                items={[
                  { key: 'Bot', value: data.discord.configured ? (data.discord.enabled ? data.discord.gateway : 'configured but disabled') : 'no token installed' },
                  { key: 'Commands', value: data.discord.commandsRegistered ? `registered ${data.discord.commandsRegisteredAt ? new Date(data.discord.commandsRegisteredAt).toLocaleString() : ''}` : 'not registered' },
                  { key: 'Message Content intent', value: data.discord.messageContentIntent },
                ]}
              />
            </PanelSection>
          </>
        );
      }}
    </AsyncPanel>
  );
}

/** One of the mockup's overview tiles: a heading with an optional status dot, a large figure, a line under it. */
function Tile({ heading, dot, big, small }: { heading: string; dot: 'ok' | 'warning' | 'error' | null; big: ReactNode; small: ReactNode }) {
  return (
    <div className="admin-tile">
      <h3 className="admin-tile__heading">
        {dot ? <span className="aqua-status-dot" data-kind={dot} aria-hidden="true" /> : null}
        {heading}
      </h3>
      <span className="admin-tile__big">{big}</span>
      <span className="admin-tile__small">{small}</span>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days}d` : null, hours ? `${hours}h` : null, `${minutes}m`].filter(Boolean).join(' ');
}

export { Panel };

/**
 * Groups: who is listening together, what is queued, and what the hub can honestly sync.
 *
 * The sync grade shown per group is the reviewed provider capability, not a guess: "exact" only
 * when everyone plays the same seekable file, down to "not synchronised" for sources that cannot
 * be aligned at all. An operator seeing "best effort" knows why the timing drifts.
 */
import { useState } from 'react';
import { AquaTable, Button, KeyValueList, Panel, PanelSection, StatusDot, useToast } from '@now-playing/aqua-ui';
import type { GroupHistoryEntry, GroupView } from '@now-playing/contracts';
import { api, apiUrl } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { Ago, AsyncPanel, ConfirmButton, Duration } from './common.js';

export function GroupsView() {
  const groups = useResource('groupsList', {}, { pollMs: 8_000 });
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <AsyncPanel
        resource={groups}
        title="Groups"
        emptyWhen={(d) => (d as { items: GroupView[] }).items.length === 0}
        emptyTitle="No groups yet"
        emptyText="A group is created from a player or the Discord bot; the hub keeps its queue and timeline."
      >
        {(raw) => (
          <AquaTable
            label="Groups"
            rowKey={(row: GroupView) => row.id}
            rows={(raw as { items: GroupView[] }).items}
            onActivate={(row) => setSelected(row.id)}
            columns={[
              { id: 'name', header: 'Name', primary: true, cell: (row) => row.name },
              { id: 'status', header: 'Status', cell: (row) => <StatusDot kind={row.status === 'active' ? 'ok' : 'neutral'} label={row.status} /> },
              { id: 'playing', header: 'Now playing', cell: (row) => row.currentTrackTitle ?? '—' },
              { id: 'queue', header: 'Queue', align: 'right', cell: (row) => row.queueLength },
              { id: 'listeners', header: 'Listeners', align: 'right', cell: (row) => row.listenerCount },
              { id: 'sync', header: 'Sync', cell: (row) => row.playback?.syncGrade ?? '—' },
              { id: 'open', header: '', headerLabel: 'Open', cell: (row) => <Button size="small" onClick={() => setSelected(row.id)}>Open</Button> },
            ]}
          />
        )}
      </AsyncPanel>

      {selected ? <GroupDetail groupId={selected} onClose={() => setSelected(null)} onChanged={groups.reload} /> : null}
    </>
  );
}

function GroupDetail({ groupId, onClose, onChanged }: { groupId: string; onClose: () => void; onChanged: () => void }) {
  const group = useResource('groupsGet', { params: { groupId } }, { pollMs: 5_000 });
  const sync = useResource('groupsSync', { params: { groupId } }, { pollMs: 3_000 });
  const queue = useResource('groupsQueueGet', { params: { groupId } }, { pollMs: 3_000 });
  const history = useResource('groupsHistoryList', { params: { groupId }, query: { limit: 25 } }, { pollMs: 15_000 });
  const archive = useAction(async () => api('groupsArchive', { params: { groupId } }));
  const toast = useToast();

  const data = group.data as GroupView | null;
  const syncInfo = sync.data as { serverTime: string; members: Array<{ memberId: string; driftMs: number | null; dspLatencyMs: number | null; online: boolean }> } | null;

  return (
    <Panel title={data?.name ?? 'Group'}>
      <PanelSection title="State">
        <KeyValueList
          items={[
            { key: 'Status', value: data?.status ?? '—' },
            { key: 'Playback', value: data?.playback?.status ?? 'idle' },
            { key: 'Sync grade', value: data?.playback?.syncGrade ?? '—' },
            ...(data?.playback?.syncReason ? [{ key: 'Why', value: data.playback.syncReason }] : []),
            { key: 'Queue length', value: data?.queueLength ?? 0 },
            { key: 'Listeners', value: data?.listenerCount ?? 0 },
          ]}
        />
        <div className="admin-actions">
          <a className="aqua-button aqua-button--small" href={apiUrl('groupsHistoryExportCsv', { groupId })} download>
            Export history (CSV)
          </a>
          <a className="aqua-button aqua-button--small" href={apiUrl('groupsHistoryExportJson', { groupId })} download>
            Export history (JSON)
          </a>
          <ConfirmButton
            label="Archive"
            confirmLabel={`Archive ${data?.name ?? 'this group'}? Its history is kept; nobody can queue to it again.`}
            busy={archive.busy}
            onConfirm={() =>
              void archive.run().then(() => {
                toast.show('Group archived');
                onChanged();
                onClose();
              })
            }
          />
          <Button size="small" onClick={onClose}>
            Close
          </Button>
        </div>
      </PanelSection>

      <PanelSection title="Members and drift">
        <AquaTable
          label="Members"
          rowKey={(row: { memberId: string }) => row.memberId}
          rows={(data?.members ?? []).map((m) => ({ ...m, drift: syncInfo?.members.find((s) => s.memberId === m.memberId) ?? null }))}
          columns={[
            { id: 'name', header: 'Member', primary: true, cell: (row) => row.displayName },
            { id: 'role', header: 'Role', cell: (row) => row.role },
            { id: 'online', header: 'Status', cell: (row) => <StatusDot kind={row.online ? 'ok' : 'neutral'} label={row.online ? 'online' : 'offline'} /> },
            { id: 'latency', header: 'Latency', align: 'right', cell: (row) => (row.latencyMs === null ? '—' : `${Math.round(row.latencyMs)} ms`) },
            { id: 'drift', header: 'Drift', align: 'right', cell: (row) => (row.drift?.driftMs === null || row.drift?.driftMs === undefined ? '—' : `${row.drift.driftMs > 0 ? '+' : ''}${Math.round(row.drift.driftMs)} ms`) },
            { id: 'dsp', header: 'DSP latency', align: 'right', cell: (row) => (row.drift?.dspLatencyMs === null || row.drift?.dspLatencyMs === undefined ? '—' : `${Math.round(row.drift.dspLatencyMs)} ms`) },
            { id: 'share', header: 'Shares profile', cell: (row) => (row.shareAggregate ? 'yes' : 'no') },
          ]}
        />
      </PanelSection>

      <AsyncPanel resource={queue} title="Queue" emptyWhen={(d) => (d as { queue: { items: unknown[] } }).queue.items.length === 0} emptyTitle="The queue is empty">
        {(raw) => {
          const q = raw as { queue: { items: Array<{ id: string; track: { title: string; artistName: string; durationMs: number | null; provider: string } ; addedBy: { displayName: string } | null }>; currentIndex: number } };
          return (
            <AquaTable
              label="Queue"
              rowKey={(row) => row.id}
              rows={q.queue.items}
              currentKey={q.queue.items[q.queue.currentIndex]?.id ?? null}
              columns={[
                { id: 'title', header: 'Title', primary: true, cell: (row) => row.track.title },
                { id: 'artist', header: 'Artist', cell: (row) => row.track.artistName },
                { id: 'source', header: 'Source', cell: (row) => row.track.provider },
                { id: 'by', header: 'Requested by', cell: (row) => row.addedBy?.displayName ?? 'hub' },
                { id: 'time', header: 'Time', align: 'right', cell: (row) => <Duration ms={row.track.durationMs} /> },
              ]}
            />
          );
        }}
      </AsyncPanel>

      <AsyncPanel resource={history} title="Recent history" emptyWhen={(d) => (d as { items: unknown[] }).items.length === 0} emptyTitle="Nothing has played yet">
        {(raw) => (
          <AquaTable
            label="History"
            rowKey={(row: GroupHistoryEntry) => row.id}
            rows={(raw as { items: GroupHistoryEntry[] }).items}
            columns={[
              { id: 'title', header: 'Title', primary: true, cell: (row) => row.track.title },
              { id: 'artist', header: 'Artist', cell: (row) => row.track.artistName },
              { id: 'by', header: 'Requested by', cell: (row) => row.requesterDisplayName },
              { id: 'outcome', header: 'Outcome', cell: (row) => (row.skipReason ? `${row.outcome} (${row.skipReason})` : row.outcome) },
              { id: 'when', header: 'Started', cell: (row) => <Ago iso={row.startedAt} /> },
            ]}
          />
        )}
      </AsyncPanel>
    </Panel>
  );
}

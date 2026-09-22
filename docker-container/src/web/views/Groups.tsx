/**
 * Groups: who is listening together, what is queued, and what the hub can honestly sync.
 *
 * The sync grade shown per group is the reviewed provider capability, not a guess: "exact" only
 * when everyone plays the same seekable file, down to "not synchronised" for sources that cannot
 * be aligned at all. An operator seeing "best effort" knows why the timing drifts.
 */
import { useState } from 'react';
import { AquaTable, Button, KeyValueList, Panel, PanelSection, PopUpMenu, StatusDot, TextField, useToast } from '@now-playing/aqua-ui';
import type { GroupHistoryEntry, GroupView, InviteView } from '@now-playing/contracts';
import { api, apiUrl } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { Ago, AsyncPanel, ConfirmButton, Duration } from './common.js';

export function GroupsView() {
  const groups = useResource('groupsList', {}, { pollMs: 8_000 });
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <NewGroup
        onCreated={(id) => {
          groups.reload();
          setSelected(id);
        }}
      />
      <AsyncPanel
        resource={groups}
        title="Groups"
        emptyWhen={(d) => (d as { items: GroupView[] }).items.length === 0}
        emptyTitle="No groups yet"
        emptyText="Name a group above, or create one from a player or the Discord bot; the hub keeps its queue and timeline."
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

function NewGroup({ onCreated }: { onCreated: (groupId: string) => void }) {
  const [name, setName] = useState('');
  const toast = useToast();
  const create = useAction(async (groupName: string) => api('groupsCreate', { body: { name: groupName } }));

  const submit = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void create.run(trimmed).then((made) => {
      if (!made) return;
      setName('');
      toast.show(`Created “${trimmed}”. Make an invite link below to bring people in.`);
      onCreated((made as GroupView).id);
    });
  };

  return (
    <Panel title="New group">
      <form
        className="admin-actions"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField label="New group’s name" hideLabel placeholder="New group’s name" maxLength={80} value={name} onChange={(event) => setName(event.currentTarget.value)} />
        <Button type="submit" variant="default" busy={create.busy} disabled={!name.trim()}>
          New Group
        </Button>
      </form>
      {create.error ? (
        <p className="admin-hint admin-hint--warning" role="alert">
          The group was not created: {create.error.message}
        </p>
      ) : null}
    </Panel>
  );
}

const INVITE_TTLS = [
  { value: '3600', label: '1 hour' },
  { value: '21600', label: '6 hours' },
  { value: '86400', label: '24 hours' },
] as const;
const INVITE_ROLES = [
  { value: 'member', label: 'Member — can add to the queue' },
  { value: 'guest', label: 'Guest — listens only' },
  { value: 'admin', label: 'Admin — can invite and remove people' },
] as const;
type InviteRole = (typeof INVITE_ROLES)[number]['value'];
const PLAYER_ADDRESS_KEY = 'np-admin-player-address';

/**
 * The link a player understands. Everything after `#` stays in the browser — none of it reaches any
 * server — and the player strips it from the address bar as soon as it has read it.
 */
export function inviteLink(playerAddress: string, code: string, hubBaseUrl: string, groupName: string, from: string, role: string, expiresAt: string): string {
  const query = new URLSearchParams({ hub: hubBaseUrl, g: groupName, from });
  if (role !== 'member') query.set('r', role);
  query.set('x', expiresAt);
  return `${playerAddress}#invite/${code}?${query.toString()}`;
}

function inviteStateLabel(invite: InviteView, now: number): string {
  switch (invite.state) {
    case 'used':
      return `Used by ${invite.usedBy ?? 'someone'}`;
    case 'declined':
      return `Declined${invite.toName ? ` by ${invite.toName}` : ''}`;
    case 'withdrawn':
      return 'Withdrawn';
    case 'expired':
      return 'Expired';
    default: {
      const hours = (Date.parse(invite.expiresAt) - now) / 3_600_000;
      return `Open · ${hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${Math.round(hours * 10) / 10} h`} left`;
    }
  }
}

function GroupInvites({ groupId, groupName }: { groupId: string; groupName: string }) {
  const invites = useResource('groupsInvitesList', { params: { groupId } }, { pollMs: 10_000 });
  const hub = useResource('hubIdentity', {});
  const [ttl, setTtl] = useState<string>('86400');
  const [role, setRole] = useState<InviteRole>('member');
  const [made, setMade] = useState<{ code: string; expiresAt: string; role: InviteRole; ttlLabel: string } | null>(null);
  // The hub does not serve the player, so it cannot know where people open it. Remembered per browser.
  const [playerAddress, setPlayerAddress] = useState<string>(() => {
    try {
      return window.localStorage.getItem(PLAYER_ADDRESS_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const rememberPlayerAddress = (value: string): void => {
    setPlayerAddress(value);
    try {
      window.localStorage.setItem(PLAYER_ADDRESS_KEY, value);
    } catch {
      // private window: the field still works for this visit
    }
  };
  const toast = useToast();
  const make = useAction(async () => api('groupsInvite', { params: { groupId }, body: { ttlSeconds: Number(ttl), role } }));
  const withdraw = useAction(async (inviteId: string) => api('groupsInviteWithdraw', { params: { groupId, inviteId } }));

  const hubBase = (hub.data as { publicEndpoint: string | null } | null)?.publicEndpoint ?? window.location.origin;
  const items = (invites.data as { items: InviteView[] } | null)?.items ?? [];
  const link = made && playerAddress.trim() ? inviteLink(playerAddress.trim(), made.code, hubBase, groupName, 'admin', made.role, made.expiresAt) : null;

  return (
    <PanelSection title={`Invites to ${groupName}`}>
      <p className="admin-hint">
        Each invite lets one person join, then stops working. Send the link: it opens the invite page in Now Playing, where they join or decline. Someone who isn’t paired yet is asked to pair first.
      </p>
      <div className="admin-actions">
        <PopUpMenu label="Works for:" size="small" options={INVITE_TTLS} value={ttl} onChange={(event) => setTtl(event.currentTarget.value)} />
        <PopUpMenu label="Joins as:" size="small" options={INVITE_ROLES} value={role} onChange={(event) => setRole(event.currentTarget.value as InviteRole)} />
        <Button
          variant="default"
          size="small"
          busy={make.busy}
          onClick={() =>
            void make.run().then((result) => {
              if (!result) return;
              const r = result as { inviteCode: string; expiresAt: string };
              setMade({ code: r.inviteCode, expiresAt: r.expiresAt, role, ttlLabel: INVITE_TTLS.find((t) => t.value === ttl)?.label ?? '' });
              invites.reload();
            })
          }
        >
          Make Invite Link
        </Button>
      </div>
      {make.error ? (
        <p className="admin-hint admin-hint--warning" role="alert">
          No invite was made: {make.error.message}
        </p>
      ) : null}
      {made ? (
        <div className="admin-invite-new">
          <p className="admin-hint">
            New invite · works once · {made.ttlLabel}. The code is shown here only: the hub keeps its hash, so it cannot be looked up again.
          </p>
          <p className="admin-invite-code">{made.code}</p>
          <TextField
            label="Players open Now Playing at:"
            inline
            placeholder="https://music.example/now-playing.html"
            value={playerAddress}
            onChange={(event) => rememberPlayerAddress(event.currentTarget.value)}
            hint={link ? undefined : 'Enter the address to get a link. Without one, send the code: it can be typed into the player’s Profile tab.'}
          />
          <div className="admin-actions">
            <TextField label="Invite link" hideLabel readOnly value={link ?? ''} onFocus={(event) => event.currentTarget.select()} />
            <Button
              size="small"
              variant="default"
              disabled={!link}
              onClick={() =>
                void navigator.clipboard.writeText(link ?? '').then(
                  () => toast.show(`Copied the invite link for ${groupName}.`),
                  () => toast.show('The browser would not copy it. Select the link and copy it by hand.'),
                )
              }
            >
              Copy Link
            </Button>
          </div>
        </div>
      ) : null}
      <AquaTable
        label={`Invites to ${groupName}`}
        rowKey={(row: InviteView) => row.inviteId}
        rows={items}
        columns={[
          { id: 'to', header: 'For', primary: true, cell: (row) => row.toName ?? (row.toProfileId ? 'a removed profile' : 'anyone with the link') },
          { id: 'role', header: 'Role', cell: (row) => row.role.charAt(0).toUpperCase() + row.role.slice(1) },
          { id: 'state', header: 'State', cell: (row) => `${inviteStateLabel(row, Date.now())} · made by ${row.createdBy}` },
          {
            id: 'actions',
            header: '',
            headerLabel: 'Actions',
            cell: (row) =>
              row.state === 'open' ? (
                <ConfirmButton
                  label="Withdraw"
                  confirmLabel="Withdraw this invite? Its link stops working immediately."
                  busy={withdraw.busy}
                  onConfirm={() => void withdraw.run(row.inviteId).then(() => invites.reload())}
                />
              ) : null,
          },
        ]}
      />
    </PanelSection>
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

      {data?.status === 'active' ? <GroupInvites groupId={groupId} groupName={data.name} /> : null}

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

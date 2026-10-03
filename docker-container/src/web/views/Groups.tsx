/**
 * Groups: who is listening together, what is queued, and how closely the hub can keep them in step.
 *
 * Laid out as the design draws it: the groups table with its New Group row, then the open group —
 * state and transport on the left with members and drift under it, queue and recent history on the
 * right — and its invites below. The grade beside each group is the reviewed capability of what is
 * playing, not a guess: an operator who reads "best effort" knows why the timing drifts.
 *
 * One thing differs from the design on purpose (design/decisions.md DEC-017): the invites table
 * shows who an invite is for and its state, not its code. The hub keeps only a code's hash, so the
 * code is shown once, when made.
 */
import { useState, type FormEvent } from 'react';
import type { GroupHistoryEntry, GroupView, InviteView } from '@now-playing/contracts';
import { api, apiUrl } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { capitalise, GROUP_ROLES, SYNC_GRADES } from '../lib/words.js';
import { ActionError, agoText, EmptyCells, EmptyRow, Field, formatClock, Group, listState, Note, Pop, Push, SubHead, useHubUi, useNow } from '../ui.js';

const PLAYBACK_WORDS: Record<string, string> = { idle: 'Nothing playing', preparing: 'Getting ready', playing: 'Playing', paused: 'Paused', ended: 'Finished' };
const OUTCOMES: Record<string, string> = { completed: 'played', skipped: 'skipped', failed: 'failed', stopped: 'stopped', unavailable: 'could not be played', playing: 'playing now' };

function Eqz() {
  return (
    <span className="eqz" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export function GroupsView() {
  const groups = useResource('groupsList', {}, { pollMs: 8_000 });
  const [selected, setSelected] = useState<string | null>(null);

  const items = (groups.data as { items: GroupView[] } | null)?.items ?? [];
  const state = listState(groups, (d) => (d as { items: GroupView[] }).items.length === 0, 'No groups yet. Name one below.');
  // The design opens the first group; so does this, once there is one.
  const open = items.find((g) => g.id === selected) ?? null;

  return (
    <>
      <Group title="Groups">
        <div className="well">
          <table className="tbl" aria-label="Groups">
            <colgroup>
              <col />
              <col style={{ width: '30%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: 74 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">State</th>
                <th scope="col" className="num">
                  Members
                </th>
                <th scope="col">
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state ? <EmptyCells columns={4} {...state} /> : null}
              {state
                ? null
                : items.map((g) => {
                    const playing = g.playback?.status === 'playing';
                    return (
                      <tr key={g.id}>
                        <td title={g.currentTrackTitle ?? undefined}>{g.name}</td>
                        <td>
                          {g.status === 'archived' ? (
                            'Archived'
                          ) : playing ? (
                            <>
                              <Eqz />
                              Playing
                            </>
                          ) : (
                            (PLAYBACK_WORDS[g.playback?.status ?? 'idle'] ?? 'Paused')
                          )}
                        </td>
                        <td className="num">{g.members.filter((m) => !m.revokedAt).length}</td>
                        <td className="acts">
                          <Push aria-label={`${selected === g.id ? 'Close' : 'Open'} ${g.name}`} aria-expanded={selected === g.id} onClick={() => setSelected(selected === g.id ? null : g.id)}>
                            {selected === g.id ? 'Close' : 'Open'}
                          </Push>
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
        <NewGroup
          onCreated={(id) => {
            groups.reload();
            setSelected(id);
          }}
        />
      </Group>
      {open ? (
        <GroupDetail
          key={open.id}
          summary={open}
          onArchived={() => {
            setSelected(null);
            groups.reload();
          }}
        />
      ) : null}
    </>
  );
}

function NewGroup({ onCreated }: { onCreated: (groupId: string) => void }) {
  const [name, setName] = useState('');
  const { say } = useHubUi();
  const create = useAction(async (groupName: string) => api('groupsCreate', { body: { name: groupName } }));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      say('Name the group first.');
      return;
    }
    void create.run(trimmed).then((made) => {
      if (!made) return;
      setName('');
      say(`Created “${trimmed}”. Make an invite link below to bring people in.`);
      onCreated((made as GroupView).id);
    });
  };

  return (
    <>
      <form className="barrow" onSubmit={submit}>
        <Field className="field--group" placeholder="New group’s name" aria-label="New group’s name" maxLength={80} value={name} onChange={(event) => setName(event.currentTarget.value)} />
        <Push type="submit" busy={create.busy}>
          New Group
        </Push>
      </form>
      <ActionError error={create.error} />
    </>
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
  const now = useNow();
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
  const { say, confirm } = useHubUi();
  const make = useAction(async () => api('groupsInvite', { params: { groupId }, body: { ttlSeconds: Number(ttl), role } }));
  const withdraw = useAction(async (inviteId: string) => api('groupsInviteWithdraw', { params: { groupId, inviteId } }));

  const hubBase = (hub.data as { publicEndpoint: string | null } | null)?.publicEndpoint ?? window.location.origin;
  const items = (invites.data as { items: InviteView[] } | null)?.items ?? [];
  const state = listState(invites, (d) => (d as { items: InviteView[] }).items.length === 0, 'No invites yet.');
  const link = made && playerAddress.trim() ? inviteLink(playerAddress.trim(), made.code, hubBase, groupName, 'admin', made.role, made.expiresAt) : null;

  return (
    <fieldset className="group--last">
      <legend>
        <h3 className="legend-h">Invites to {groupName}</h3>
      </legend>
      <p className="hint">Each invite lets one person join, then stops working. Send the link: it opens the invite page in the player, where they join or decline. Someone who isn’t paired yet is asked to pair first.</p>
      <div className="pref">
        <label className="k" htmlFor="invTtl">
          Works for:
        </label>
        <div className="v">
          <Pop id="invTtl" value={ttl} onChange={(event) => setTtl(event.currentTarget.value)}>
            {INVITE_TTLS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Pop>
        </div>
        <label className="k" htmlFor="invRole">
          Joins as:
        </label>
        <div className="v">
          <Pop id="invRole" value={role} onChange={(event) => setRole(event.currentTarget.value as InviteRole)}>
            {INVITE_ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Pop>
        </div>
        <span className="k" />
        <div className="v">
          <Push
            primary
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
          </Push>
        </div>
      </div>
      <ActionError error={make.error} />
      {made ? (
        <div className="tile detail">
          <span className="sm">New invite · works once · {made.ttlLabel}. The code is shown here only; the hub can’t look it up again.</span>
          <span className="invcode">{made.code}</span>
          <div className="pref detail__form">
            <label className="k" htmlFor="invPlayer">
              Players open Airwave at:
            </label>
            <div className="v">
              <Field id="invPlayer" mono placeholder="https://music.example.com/" value={playerAddress} onChange={(event) => rememberPlayerAddress(event.currentTarget.value)} />
              {link ? null : <span className="sub">Enter the address to get a link. Without one, send the code: it can be typed into the player’s Profile tab.</span>}
            </div>
          </div>
          <div className="barrow">
            <Field mono readOnly aria-label="Invite link" value={link ?? ''} onFocus={(event) => event.currentTarget.select()} />
            <Push
              primary
              disabled={!link}
              reason="Enter where players open Airwave first."
              onClick={() =>
                void navigator.clipboard.writeText(link ?? '').then(
                  () => say(`Copied the invite link for ${groupName}.`),
                  () => say('The browser would not copy it. Select the link and copy it by hand.'),
                )
              }
            >
              Copy Link
            </Push>
          </div>
        </div>
      ) : null}
      <div className="well well--after">
        <table className="tbl" aria-label={`Invites to ${groupName}`}>
          <colgroup>
            <col style={{ width: '28%' }} />
            <col style={{ width: '14%' }} />
            <col />
            <col style={{ width: 98 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">For</th>
              <th scope="col">Role</th>
              <th scope="col">State</th>
              <th scope="col">
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state ? <EmptyCells columns={4} {...state} /> : null}
            {state
              ? null
              : items.map((row) => (
                  <tr key={row.inviteId}>
                    <td>{row.toName ?? (row.toProfileId ? 'A removed profile' : 'Anyone with the link')}</td>
                    <td>{GROUP_ROLES[row.role] ?? capitalise(row.role)}</td>
                    <td>
                      {inviteStateLabel(row, now)} · made by {row.createdBy}
                    </td>
                    <td className="acts">
                      {row.state === 'open' ? (
                        <Push
                          busy={withdraw.busy}
                          onClick={() =>
                            void confirm({ title: 'Withdraw this invite?', text: 'Its link stops working straight away.', verb: 'Withdraw' }).then((go) => {
                              if (go) void withdraw.run(row.inviteId).then(() => invites.reload());
                            })
                          }
                        >
                          Withdraw
                        </Push>
                      ) : null}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      <ActionError error={withdraw.error} />
    </fieldset>
  );
}

interface QueueData {
  queue: { revision: number; currentIndex: number; items: Array<{ id: string; track: { title: string; artistName: string; durationMs: number | null }; addedBy: { displayName: string } | null }> };
}

function GroupDetail({ summary, onArchived }: { summary: GroupView; onArchived: () => void }) {
  const groupId = summary.id;
  const group = useResource('groupsGet', { params: { groupId } }, { pollMs: 5_000 });
  const sync = useResource('groupsSync', { params: { groupId } }, { pollMs: 3_000 });
  const queue = useResource('groupsQueueGet', { params: { groupId } }, { pollMs: 3_000 });
  const playing = useResource('groupNowPlayingAdmin', { params: { groupId } }, { pollMs: 2_000 });
  const history = useResource('groupsHistoryList', { params: { groupId }, query: { limit: 25 } }, { pollMs: 15_000 });
  const archive = useAction(async () => api('groupsArchive', { params: { groupId } }));
  const command = useAction(async (type: 'play' | 'pause' | 'resume' | 'skip', baseRevision: number) =>
    api('groupsQueueCommand', { params: { groupId }, body: { idempotencyKey: `admin-${type}-${baseRevision}-${Date.now()}`, baseRevision, command: { type } } }),
  );
  const { say, confirm } = useHubUi();
  const now = useNow();
  const [refused, setRefused] = useState<string | null>(null);

  const data = (group.data as GroupView | null) ?? summary;
  const syncInfo = sync.data as { members: Array<{ memberId: string; driftMs: number | null; online: boolean }> } | null;
  const q = queue.data as QueueData | null;
  const np = playing.data as { title: string | null; artistName: string | null; durationMs: number | null; positionMs: number } | null;
  const status = data.playback?.status ?? 'idle';
  const isPlaying = status === 'playing';
  const grade = SYNC_GRADES[data.playback?.syncGrade ?? ''] ?? null;
  const members = data.members.filter((m) => !m.revokedAt);
  const upcoming = q ? q.queue.items.slice(Math.max(0, q.queue.currentIndex + 1)) : [];
  const queueState = listState(queue, () => upcoming.length === 0, 'Empty.');
  const historyItems = (history.data as { items: GroupHistoryEntry[] } | null)?.items ?? [];
  const historyState = listState(history, (d) => (d as { items: GroupHistoryEntry[] }).items.length === 0, 'Nothing played yet.');
  const hasQueue = (q?.queue.items.length ?? 0) > 0;

  const send = (type: 'play' | 'pause' | 'resume' | 'skip'): void => {
    if (!q) return;
    setRefused(null);
    void command.run(type, q.queue.revision).then((result) => {
      const r = result as { accepted: boolean; rejection: { reason: string } | null } | null;
      if (r && !r.accepted) setRefused(r.rejection?.reason ?? 'The group did not take that. Try again.');
      queue.reload();
      group.reload();
      playing.reload();
    });
  };

  const track = np?.title ? [np.title, np.artistName].filter(Boolean).join(' — ') : (data.currentTrackTitle ?? 'Nothing playing');
  const length = np?.durationMs ?? 0;
  const position = Math.min(np?.positionMs ?? 0, length || Infinity);

  return (
    <>
      <fieldset>
        <legend>
          <h3 className="legend-h">{data.name}</h3>
        </legend>
        <div className="split">
          <div>
            <SubHead first>State</SubHead>
            <div className="tile">
              <span className="sm">
                {status === 'idle' ? 'Waiting for music' : `${PLAYBACK_WORDS[status] ?? 'Paused'}${grade ? ` · kept in step: ${grade.word}` : ''}`}
              </span>
              <span className="big big--track">{track}</span>
              {length ? (
                <>
                  <div className="bar bar--track" role="img" aria-label={`${formatClock(position)} of ${formatClock(length)}`}>
                    <i style={{ width: `${(position / length) * 100}%` }} />
                  </div>
                  <span className="sm mono">
                    {formatClock(position)} / {formatClock(length)}
                  </span>
                </>
              ) : null}
            </div>
            {data.playback?.syncReason ? <Note>{data.playback.syncReason}</Note> : null}
            {data.status === 'active' ? (
              <div className="barrow">
                <Push busy={command.busy} disabled={!q || (!isPlaying && !hasQueue)} reason="The queue is empty. A member adds music from a player." onClick={() => send(isPlaying ? 'pause' : status === 'paused' ? 'resume' : 'play')}>
                  {isPlaying ? 'Pause' : 'Play'}
                </Push>
                <Push busy={command.busy} disabled={!q || upcoming.length === 0} reason="Nothing is waiting in the queue." onClick={() => send('skip')}>
                  Skip
                </Push>
              </div>
            ) : (
              <Note>This group is archived. Its history is kept; nobody can queue to it.</Note>
            )}
            {refused ? <Note bad>{refused}</Note> : <ActionError error={command.error} />}

            <SubHead>Members and drift</SubHead>
            <div className="well">
              <ul className="rows" aria-label="Members and drift">
                {members.length === 0 ? <EmptyRow text="Nobody has joined." /> : null}
                {members.map((m) => {
                  const drift = syncInfo?.members.find((s) => s.memberId === m.memberId)?.driftMs ?? null;
                  const far = drift !== null && Math.abs(drift) > 100;
                  return (
                    <li key={m.memberId} title={`${GROUP_ROLES[m.role] ?? m.role} · ${m.online ? 'online' : 'offline'}`}>
                      <span className="name">
                        <b>{m.displayName}</b>
                      </span>
                      {drift === null ? null : (
                        <span className={`drift ${far ? 'warn' : 'ok'}`}>
                          {drift >= 0 ? '+' : '−'}
                          {Math.abs(Math.round(drift))} ms
                        </span>
                      )}
                      <span className="meta">{m.online ? (GROUP_ROLES[m.role] ?? m.role).toLowerCase() : 'offline'}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
          <div>
            <SubHead first>Queue</SubHead>
            <div className="well">
              <ul className="rows" aria-label="Queue">
                {queueState ? <EmptyRow {...queueState} /> : null}
                {queueState
                  ? null
                  : upcoming.map((item, i) => (
                      <li key={item.id} title={item.addedBy ? `Added by ${item.addedBy.displayName}` : undefined}>
                        <span className="meta">{i + 1}</span>
                        <span className="name">
                          <b>
                            {item.track.title} — {item.track.artistName}
                          </b>
                        </span>
                      </li>
                    ))}
              </ul>
            </div>
            <SubHead>Recent history</SubHead>
            <div className="well">
              <ul className="rows plain" aria-label="Recent history">
                {historyState ? <EmptyRow {...historyState} /> : null}
                {historyState
                  ? null
                  : historyItems.slice(0, 8).map((h) => (
                      <li key={h.id} title={`Asked for by ${h.requesterDisplayName} · ${OUTCOMES[h.outcome] ?? h.outcome}`}>
                        <span className="name">
                          {h.track.title} — {h.track.artistName} · {agoText(h.startedAt, now)}
                        </span>
                      </li>
                    ))}
              </ul>
            </div>
          </div>
        </div>
        <p className="note">Discord members follow at best effort: the bot gets the same queue, but a voice channel can’t be timed to the millisecond.</p>
        <div className="barrow">
          <a className="push push--link" href={apiUrl('groupsHistoryExportCsv', { groupId })} download>
            Export History (CSV)
          </a>
          <a className="push push--link" href={apiUrl('groupsHistoryExportJson', { groupId })} download>
            Export History (JSON)
          </a>
          {data.status === 'active' ? (
            <Push
              busy={archive.busy}
              onClick={() =>
                void confirm({ title: `Archive ${data.name}?`, text: 'Its history is kept, but nobody can queue to it again.', verb: 'Archive' }).then((go) => {
                  if (go)
                    void archive.run().then((ok) => {
                      if (!ok) return;
                      say(`Archived ${data.name}.`);
                      onArchived();
                    });
                })
              }
            >
              Archive…
            </Push>
          ) : null}
        </div>
        <ActionError error={archive.error} />
      </fieldset>
      {data.status === 'active' ? <GroupInvites groupId={groupId} groupName={data.name} /> : null}
    </>
  );
}

/**
 * Shared listening, on screen.
 *
 * Two pieces: a strip under the hero saying who you are listening with and who is driving, and a
 * panel for the case where shared mode is on but you are not in a group yet.
 *
 * The strip is deliberately factual. It does not say "connected" when the socket is reconnecting,
 * and it does not hide a refused command — a shared queue where your skip quietly did nothing is
 * worse than one that tells you someone else got there first.
 */
import { useState } from 'react';
import { Button, InlineValidation, Panel, PanelSection, TextField, useToast } from '@now-playing/aqua-ui';
import type { GroupView } from '@now-playing/contracts';
import { usePlayer } from '../state/context.js';

export function SharedStrip() {
  const { shared } = usePlayer();
  if (!shared.group) return null;
  const online = shared.members.filter((m) => m.online);
  return (
    <div className="np-share-strip">
      <div className="np-share-strip__who">
        <span className="np-share-strip__name">{shared.group.name}</span>
        {shared.members.length === 0 ? (
          <span>Just you, so far.</span>
        ) : (
          shared.members.map((member) => (
            <span key={member.memberId} className="np-share-strip__member" data-online={member.online ? 'true' : 'false'}>
              <span className="np-share-strip__dot" aria-hidden="true" />
              {member.displayName}
              {member.role === 'owner' ? ' (host)' : ''}
            </span>
          ))
        )}
      </div>
      <span>{online.length === 1 ? '1 listening' : `${online.length} listening`}</span>
      {shared.connection !== 'connected' ? (
        <p className="np-share-strip__note">
          {shared.connection === 'connecting'
            ? 'Connecting to the hub…'
            : shared.connection === 'reconnecting'
              ? `Reconnecting${shared.staleSince ? ' — what you see may be behind the group until it comes back' : ''}.`
              : shared.connection === 'failed'
                ? 'The hub refused the realtime connection, so this queue is not live.'
                : 'Not connected.'}
        </p>
      ) : null}
      {shared.rejection ? <p className="np-share-strip__note">The hub refused that: {shared.rejection}</p> : null}
    </div>
  );
}

/** Create or join, shown in the Now playing section while shared mode has no group. */
export function SharedSetup() {
  const { group, shared } = usePlayer();
  const [name, setName] = useState('Listening together');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupView[] | null>(null);

  if (!group) return null;
  if (shared.unavailableReason) {
    return (
      <Panel title="Shared listening">
        <PanelSection>
          <p className="player-hint">{shared.unavailableReason}</p>
        </PanelSection>
      </Panel>
    );
  }
  if (shared.group) return null;

  const run = async (kind: 'create' | 'join', action: () => Promise<unknown>): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Shared listening">
      <PanelSection>
        <p className="player-hint">Everyone in a group hears the same queue, and anyone can add to it. The hub keeps the order; your library stays on your own device.</p>
        <div className="player-toolbar-row">
          <TextField label="Group name" value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={80} />
          <Button size="small" onClick={() => void run('create', () => group.create(name.trim() || 'Listening together'))} disabled={busy !== null}>
            {busy === 'create' ? 'Creating…' : 'Create a group'}
          </Button>
        </div>
        <div className="player-toolbar-row">
          <TextField label="Invite code" value={code} onChange={(event) => setCode(event.currentTarget.value)} placeholder="From whoever set it up" />
          <Button size="small" onClick={() => void run('join', () => group.join(code))} disabled={busy !== null || !code.trim()}>
            {busy === 'join' ? 'Joining…' : 'Join'}
          </Button>
        </div>
        <div className="player-toolbar-row">
          <Button
            size="small"
            onClick={() =>
              void (async () => {
                try {
                  setGroups(await group.list());
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              })()
            }
          >
            Show groups on this hub
          </Button>
        </div>
        {groups ? (
          groups.length ? (
            <ul className="player-plain-list">
              {groups.map((item) => (
                <li key={item.id}>
                  <Button size="small" onClick={() => void group.open(item)}>
                    {item.name}
                  </Button>
                  <span className="player-hint">
                    {item.listenerCount} listening · {item.queueLength} queued
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="player-hint">This hub has no groups you are a member of yet.</p>
          )
        ) : null}
        {error ? <InlineValidation kind="error">{error}</InlineValidation> : null}
      </PanelSection>
    </Panel>
  );
}

/** The invite control, shown once you are in a group. */
export function SharedInvite() {
  const { group, shared } = usePlayer();
  const toast = useToast();
  const [invite, setInvite] = useState<{ inviteCode: string; expiresAt: string } | null>(null);
  if (!group || !shared.group) return null;
  return (
    <Panel title={shared.group.name}>
      <PanelSection>
        <p className="player-hint">An invite code lets someone else join this group from their own player. It expires on its own; nothing else about your library is shared by handing it over.</p>
        <div className="player-toolbar-row">
          <Button
            size="small"
            onClick={() =>
              void (async () => {
                try {
                  setInvite(await group.invite());
                } catch (err) {
                  toast.show(err instanceof Error ? err.message : String(err), { kind: 'error' });
                }
              })()
            }
          >
            Create an invite code
          </Button>
          <Button size="small" onClick={() => void group.leave()}>
            Leave the group
          </Button>
        </div>
        {invite ? (
          <p className="player-hint">
            Code <strong>{invite.inviteCode}</strong> — valid until {new Date(invite.expiresAt).toLocaleTimeString()}.
          </p>
        ) : null}
      </PanelSection>
    </Panel>
  );
}

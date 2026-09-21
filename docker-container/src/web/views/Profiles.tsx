/**
 * Profiles, for moderation.
 *
 * A profile is what a paired person keeps here — a username, a picture, shared playlists — and every
 * other paired device can see it. This view is the operator's two levers over that: rename a profile
 * and remove its picture. It cannot read anyone's playlists and does not try to; the count is enough
 * to know what a profile holds.
 */
import { useState } from 'react';
import { AquaTable, Button, StatusDot, TextField } from '@now-playing/aqua-ui';
import type { ProfileAdminView } from '@now-playing/contracts';
import { api, ApiError } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { Ago, AsyncPanel, ConfirmButton } from './common.js';

export function ProfilesView() {
  const profiles = useResource('profilesAdminList', {}, { pollMs: 30_000 });
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rename = useAction(async (id: string, displayName: string) => api('profilesAdminRename', { params: { id }, body: { displayName } }));
  const removePicture = useAction(async (id: string) => api('profilesAdminAvatarDelete', { params: { id } }));

  const save = async (): Promise<void> => {
    if (!editing) return;
    setProblem(null);
    try {
      await api('profilesAdminRename', { params: { id: editing.id }, body: { displayName: editing.name } });
      setEditing(null);
      profiles.reload();
    } catch (err) {
      // Said as it is: the hub refused, and this is why. Nothing was renamed.
      setProblem(err instanceof ApiError ? err.message : 'The name was not saved.');
    }
  };

  return (
    <AsyncPanel
      resource={profiles}
      title="Profiles"
      emptyWhen={(d) => (d as { items: ProfileAdminView[] }).items.length === 0}
      emptyTitle="Nobody has a profile yet"
      emptyText="A profile appears when a device is paired. Its owner picks a username, a picture and the playlists to share from the player's Settings ▸ Profile."
    >
      {(raw) => (
        <>
          <AquaTable
            label="Profiles"
            rowKey={(row: ProfileAdminView) => row.id}
            rows={(raw as { items: ProfileAdminView[] }).items}
            columns={[
              {
                id: 'name',
                header: 'Name',
                primary: true,
                cell: (row) =>
                  editing?.id === row.id ? (
                    <TextField
                      label={`New name for ${row.displayName}`}
                      hideLabel
                      value={editing.name}
                      maxLength={40}
                      onChange={(event) => setEditing({ id: row.id, name: event.currentTarget.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void save();
                        if (event.key === 'Escape') setEditing(null);
                      }}
                    />
                  ) : (
                    row.displayName
                  ),
              },
              { id: 'claimed', header: 'Username', cell: (row) => <StatusDot kind={row.claimed ? 'ok' : 'neutral'} label={row.claimed ? 'chosen' : 'device name'} /> },
              { id: 'picture', header: 'Picture', cell: (row) => (row.avatarUrl ? 'yes' : 'none') },
              { id: 'playlists', header: 'Playlists', align: 'right', cell: (row) => row.playlistCount },
              { id: 'changed', header: 'Last change', cell: (row) => <Ago iso={row.updatedAt} /> },
              {
                id: 'actions',
                header: '',
                headerLabel: 'Actions',
                cell: (row) =>
                  editing?.id === row.id ? (
                    <>
                      <Button size="small" variant="default" busy={rename.busy} onClick={() => void save()}>
                        Save
                      </Button>{' '}
                      <Button size="small" onClick={() => (setEditing(null), setProblem(null))}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="small" onClick={() => (setEditing({ id: row.id, name: row.displayName }), setProblem(null))}>
                        Rename
                      </Button>{' '}
                      {row.avatarUrl ? (
                        <ConfirmButton
                          label="Remove picture"
                          confirmLabel={`Remove the picture from "${row.displayName}"? Its owner can upload another.`}
                          busy={removePicture.busy}
                          onConfirm={() => void removePicture.run(row.id).then(() => profiles.reload())}
                        />
                      ) : null}
                    </>
                  ),
              },
            ]}
          />
          {problem ? (
            <p className="admin-hint admin-hint--warning" role="alert">
              {problem}
            </p>
          ) : null}
          <p className="admin-hint">Every device paired with this hub can see these names, pictures and shared playlists. Nobody outside it can.</p>
        </>
      )}
    </AsyncPanel>
  );
}

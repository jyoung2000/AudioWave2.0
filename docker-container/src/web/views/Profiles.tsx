/**
 * Profiles, for moderation.
 *
 * A profile is what a paired person keeps here — a username, a picture, shared playlists — and every
 * other paired device can see it. This view is the operator's two levers over that: rename a profile
 * and remove its picture. It cannot read anyone's playlists and does not try to; the count is enough
 * to know what a profile holds.
 */
import { useState } from 'react';
import type { ProfileAdminView } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, Ago, EmptyCells, Field, Group, listState, Note, Push, useHubUi } from '../ui.js';

export function ProfilesView() {
  const profiles = useResource('profilesAdminList', {}, { pollMs: 30_000 });
  const { say, confirm } = useHubUi();
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const rename = useAction(async (id: string, displayName: string) => api('profilesAdminRename', { params: { id }, body: { displayName } }));
  const removePicture = useAction(async (id: string) => api('profilesAdminAvatarDelete', { params: { id } }));

  const save = async (): Promise<void> => {
    if (!editing) return;
    const done = await rename.run(editing.id, editing.name);
    if (done) {
      say(`Renamed to “${editing.name.trim()}”.`);
      setEditing(null);
      profiles.reload();
    }
  };

  const items = (profiles.data as { items: ProfileAdminView[] } | null)?.items ?? [];
  const state = listState(profiles, (d) => (d as { items: ProfileAdminView[] }).items.length === 0, 'Nobody has a profile yet. One appears when a device is paired.');

  return (
    <Group title="Profiles" hint="What each paired person is called here. You can rename a profile or remove its picture; its playlists stay its owner’s." last>
      <div className="well">
        <table className="tbl" aria-label="Profiles">
          <colgroup>
            <col />
            <col style={{ width: '18%' }} className="hide-sm" />
            <col style={{ width: '12%' }} />
            <col style={{ width: '16%' }} className="hide-sm" />
            <col style={{ width: 196 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="hide-sm">
                Username
              </th>
              <th scope="col" className="num">
                Playlists
              </th>
              <th scope="col" className="hide-sm">
                Changed
              </th>
              <th scope="col">
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state ? <EmptyCells columns={5} {...state} /> : null}
            {state
              ? null
              : items.map((row) => {
                  const isEditing = editing?.id === row.id;
                  return (
                    <tr key={row.id}>
                      <td>
                        {isEditing ? (
                          <Field
                            className="field--cell"
                            aria-label={`New name for ${row.displayName}`}
                            value={editing.name}
                            maxLength={40}
                            // The row just turned into a field because Rename was pressed.
                            // eslint-disable-next-line jsx-a11y/no-autofocus
                            autoFocus
                            onChange={(event) => setEditing({ id: row.id, name: event.currentTarget.value })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void save();
                              if (event.key === 'Escape') setEditing(null);
                            }}
                          />
                        ) : (
                          row.displayName
                        )}
                      </td>
                      <td className="hide-sm">{row.claimed ? 'Chosen' : 'From the device'}</td>
                      <td className="num">{row.playlistCount}</td>
                      <td className="hide-sm">
                        <Ago iso={row.updatedAt} />
                      </td>
                      <td className="acts">
                        {isEditing ? (
                          <>
                            <Push primary busy={rename.busy} disabled={editing.name.trim().length < 3} reason="A name has at least 3 characters." onClick={() => void save()}>
                              Save
                            </Push>
                            <Push
                              onClick={() => {
                                setEditing(null);
                                rename.clearError();
                              }}
                            >
                              Cancel
                            </Push>
                          </>
                        ) : (
                          <>
                            <Push
                              aria-label={`Rename ${row.displayName}`}
                              onClick={() => {
                                setEditing({ id: row.id, name: row.displayName });
                                rename.clearError();
                              }}
                            >
                              Rename
                            </Push>
                            {row.avatarUrl ? (
                              <Push
                                busy={removePicture.busy}
                                aria-label={`Remove the picture from ${row.displayName}`}
                                onClick={() =>
                                  void confirm({ title: `Remove the picture from “${row.displayName}”?`, text: 'Its owner can upload another one.', verb: 'Remove Picture' }).then((go) => {
                                    if (go) void removePicture.run(row.id).then(() => profiles.reload());
                                  })
                                }
                              >
                                Remove Picture
                              </Push>
                            ) : null}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      <ActionError error={rename.error ?? removePicture.error} />
      <Note>Every device paired with this hub can see these names, pictures and shared playlists. Nobody outside it can.</Note>
    </Group>
  );
}

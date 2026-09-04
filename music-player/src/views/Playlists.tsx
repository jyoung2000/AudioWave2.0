/**
 * Playlists, including their per-playlist equalizer default and per-song override.
 *
 * The EQ precedence is not hidden: the row for a song in a playlist shows which preset actually
 * applies and where it came from, so "why does this sound different here" has a visible answer.
 */
import { useState } from 'react';
import { AquaTable, Button, EmptyState, IconButton, Panel, PanelSection, PopUpMenu, TextField, useToast } from '@now-playing/aqua-ui';
import { resolveEq } from '@now-playing/domain';
import { uuidv7 } from '@now-playing/domain';
import type { PlaylistItem } from '@now-playing/contracts';
import { useAppState, usePlayer } from '../state/context.js';
import { ShareSheet } from '../components/ShareSheet.js';
import { formatDuration } from './Library.js';

export function PlaylistsView() {
  const { store, hubStatus } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [shareOpen, setShareOpen] = useState(false);

  const playlist = state.playlists.find((p) => p.id === selectedId) ?? null;
  const items = state.playlistItems.filter((i) => i.playlistId === selectedId).sort((a, b) => a.position - b.position);

  return (
    <>
      <div className="np-section-head">
        <h2>Playlists</h2>
        <p>Lists you made, stored on this device.</p>
      </div>
      <Panel title="Playlists">
        <form
          className="player-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newName.trim();
            if (!name) return;
            void store.createPlaylist(name).then((created) => {
              setSelectedId(created.id);
              setNewName('');
            });
          }}
        >
          <TextField label="New playlist" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} placeholder="Sunday morning" />
          <Button type="submit" disabled={!newName.trim()}>
            Create
          </Button>
        </form>

        {state.playlists.length ? (
          <AquaTable
            variant="page"
            label="Playlists"
            rowKey={(row) => row.id}
            rows={state.playlists}
            currentKey={selectedId}
            onActivate={(row) => setSelectedId(row.id)}
            columns={[
              { id: 'name', header: 'Name', primary: true, cell: (row) => row.name },
              { id: 'count', header: 'Songs', align: 'right', width: 64, cell: (row) => state.playlistItems.filter((i) => i.playlistId === row.id).length },
              { id: 'eq', header: 'Equalizer', cell: (row) => state.bindings.find((b) => b.scope === 'playlist' && b.playlistId === row.id)?.presetId ?? '—' },
              {
                id: 'open',
                header: '',
                headerLabel: 'Open',
                width: 90,
                cell: (row) => (
                  <Button size="mini" onClick={() => setSelectedId(row.id)}>
                    Open
                  </Button>
                ),
              },
            ]}
          />
        ) : (
          <EmptyState title="No playlists yet" text="Create one above, or add songs to a new playlist from the library." />
        )}
      </Panel>

      {playlist ? (
        <Panel title={playlist.name}>
          <PanelSection>
            <div className="player-toolbar-row">
              <Button
                size="small"
                icon="play"
                disabled={!items.length}
                onClick={() =>
                  store.setQueue(
                    items.map((item) => ({ id: uuidv7(), track: item.track, context: { kind: 'playlist' as const, id: playlist.id, name: playlist.name } })),
                    0,
                  )
                }
              >
                Play
              </Button>
              <Button size="small" icon="share" disabled={!hubStatus.connected} onClick={() => setShareOpen(true)} ellipsis title={hubStatus.connected ? undefined : 'Sharing needs a paired hub'}>
                Share playlist
              </Button>
              <PopUpMenu
                label="Equalizer for this playlist"
                size="small"
                value={state.bindings.find((b) => b.scope === 'playlist' && b.playlistId === playlist.id)?.presetId ?? ''}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  const existing = state.bindings.find((b) => b.scope === 'playlist' && b.playlistId === playlist.id);
                  if (!value && existing) void store.unbindPreset(existing.id);
                  else if (value) void store.bindPreset('playlist', value, { playlistId: playlist.id });
                }}
                options={[{ value: '', label: 'No playlist default' }, ...state.presets.map((p) => ({ value: p.id, label: p.name }))]}
              />
              <Button
                size="small"
                variant="destructive"
                onClick={() => {
                  if (window.confirm(`Delete “${playlist.name}”? The songs stay in your library.`)) {
                    void store.deletePlaylist(playlist.id);
                    setSelectedId(null);
                    toast.show('Playlist deleted');
                  }
                }}
              >
                Delete
              </Button>
            </div>

            {items.length ? (
              <AquaTable
                variant="page"
                label={`Songs in ${playlist.name}`}
                rowKey={(row: PlaylistItem) => row.id}
                rows={items}
                onActivate={(row) =>
                  store.setQueue(
                    items.map((item) => ({ id: uuidv7(), track: item.track, context: { kind: 'playlist' as const, id: playlist.id, name: playlist.name } })),
                    items.indexOf(row),
                  )
                }
                columns={[
                  { id: 'position', header: '#', align: 'right', width: 36, cell: (_row, index) => index + 1 },
                  { id: 'title', header: 'Title', primary: true, cell: (row) => row.track.title, stackText: (row) => row.track.artistName },
                  { id: 'artist', header: 'Artist', cell: (row) => row.track.artistName },
                  { id: 'time', header: 'Time', align: 'right', width: 56, cell: (row) => formatDuration(row.track.durationMs) },
                  {
                    id: 'eq',
                    header: 'Equalizer',
                    cell: (row) => {
                      const resolved = resolveEq(state.bindings, { playlistId: playlist.id, trackId: row.track.trackId }, state.presets, { playlistName: playlist.name, trackTitle: row.track.title });
                      return <span title={resolved.explanation}>{resolved.presetName}</span>;
                    },
                  },
                  {
                    id: 'override',
                    header: 'Override here',
                    width: 160,
                    cell: (row) => (
                      <PopUpMenu
                        label={`Equalizer override for ${row.track.title} in ${playlist.name}`}
                        hideLabel
                        size="small"
                        value={state.bindings.find((b) => b.scope === 'playlist-track' && b.playlistId === playlist.id && b.trackId === row.track.trackId)?.presetId ?? ''}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          const existing = state.bindings.find((b) => b.scope === 'playlist-track' && b.playlistId === playlist.id && b.trackId === row.track.trackId);
                          if (!value && existing) void store.unbindPreset(existing.id);
                          else if (value) void store.bindPreset('playlist-track', value, { playlistId: playlist.id, trackId: row.track.trackId });
                        }}
                        options={[{ value: '', label: 'Inherit' }, ...state.presets.map((p) => ({ value: p.id, label: p.name }))]}
                      />
                    ),
                  },
                  {
                    id: 'remove',
                    header: <span className="aqua-visually-hidden">Remove</span>,
                    headerLabel: 'Remove',
                    width: 32,
                    cell: (row) => <IconButton icon="remove" variant="plain" label={`Remove ${row.track.title} from ${playlist.name}`} onClick={() => void store.removeFromPlaylist(row.id)} />,
                  },
                ]}
              />
            ) : (
              <EmptyState title="This playlist is empty" text="Add songs from your library with the ✚ button beside the play controls." />
            )}
          </PanelSection>
          <ShareSheet open={shareOpen} onClose={() => setShareOpen(false)} kind="playlist" tracks={items.map((i) => i.track)} title={playlist.name} />
        </Panel>
      ) : null}
    </>
  );
}

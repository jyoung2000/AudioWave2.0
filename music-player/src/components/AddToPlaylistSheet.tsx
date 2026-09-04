/**
 * "Add to playlist", reachable from the transport row so it applies to what is playing without
 * leaving the current view.
 */
import { useState } from 'react';
import { Button, Sheet, TextField, useToast } from '@now-playing/aqua-ui';
import type { TrackRef } from '@now-playing/contracts';
import { useAppState, usePlayer } from '../state/context.js';

export function AddToPlaylistSheet({ open, onClose, tracks }: { open: boolean; onClose: () => void; tracks: readonly TrackRef[] }) {
  const { store } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const [newName, setNewName] = useState('');

  const addTo = async (playlistId: string, name: string): Promise<void> => {
    await store.addToPlaylist(playlistId, tracks);
    toast.show(`Added ${tracks.length === 1 ? `“${tracks[0]!.title}”` : `${tracks.length} songs`} to ${name}`, { kind: 'success' });
    onClose();
  };

  return (
    <Sheet
      open={open}
      title={tracks.length === 1 ? `Add “${tracks[0]?.title ?? ''}” to a playlist` : `Add ${tracks.length} songs to a playlist`}
      onCancel={onClose}
      actions={[{ id: 'close', label: 'Done', variant: 'default', onSelect: onClose }]}
    >
      {state.playlists.length ? (
        <ul className="player-playlist-picker">
          {state.playlists.map((playlist) => (
            <li key={playlist.id}>
              <Button wide onClick={() => void addTo(playlist.id, playlist.name)}>
                {playlist.name}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="player-hint">You have no playlists yet. Name one below and it will be created with this song in it.</p>
      )}
      <form
        className="player-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          const name = newName.trim();
          if (!name) return;
          void store.createPlaylist(name, tracks).then(() => {
            toast.show(`Created “${name}”`, { kind: 'success' });
            setNewName('');
            onClose();
          });
        }}
      >
        <TextField label="New playlist" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} placeholder="Late night" />
        <Button type="submit" disabled={!newName.trim()}>
          Create
        </Button>
      </form>
    </Sheet>
  );
}

import { AquaTable, Button, EmptyState, Panel } from '@now-playing/aqua-ui';
import type { SavedTrack } from '@now-playing/contracts';

export function SharedSavedSongsPanel({ hubName, tracks, onUnstar }: { hubName: string; tracks: readonly SavedTrack[]; onUnstar: (identityKey: string) => void }) {
  return (
    <Panel title={`Starred on ${hubName}`}>
      {tracks.length ? (
        <AquaTable
          variant="page"
          label={`Songs starred on ${hubName}`}
          rowKey={(row: SavedTrack) => row.identityKey}
          rows={[...tracks]}
          columns={[
            { id: 'title', header: 'Title', primary: true, cell: (row) => row.track.title, stackText: (row) => row.track.artist },
            { id: 'artist', header: 'Artist', cell: (row) => row.track.artist },
            { id: 'album', header: 'Album', cell: (row) => row.track.album ?? '' },
            {
              id: 'action',
              header: 'Star',
              align: 'right',
              cell: (row) => (
                <Button
                  size="mini"
                  aria-label={`Unstar “${row.track.title}”`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onUnstar(row.identityKey);
                  }}
                >
                  ★
                </Button>
              ),
            },
          ]}
        />
      ) : (
        <EmptyState title="No shared songs starred yet" text="Star a song from Search or like a local song in Music to share its metadata with your hub." inline />
      )}
    </Panel>
  );
}

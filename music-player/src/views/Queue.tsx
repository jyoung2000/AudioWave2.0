/**
 * Up next.
 *
 * The queue is shown as it is, including what has already played, because "where am I in this
 * album" is the question people actually have. Reordering is keyboard-accessible: no drag-and-drop
 * that cannot be done from a keyboard.
 */
import { AquaTable, Button, EmptyState, IconButton, Panel } from '@now-playing/aqua-ui';
import { useAppState, usePlayer } from '../state/context.js';
import type { QueueEntry } from '../state/store.js';
import { formatDuration } from './Library.js';

export function QueueView() {
  const { store } = usePlayer();
  const state = useAppState();

  if (!state.queue.length) {
    return (
      <Panel>
        <EmptyState title="Nothing queued" text="Play something from your library and it will appear here." />
      </Panel>
    );
  }

  return (
    <>
      <div className="np-section-head">
        <h2>Up next</h2>
        <p>What plays after this, in order. Drag or use the arrows to change it.</p>
      </div>
      <Panel>
        <div className="player-toolbar-row">
          <Button size="small" onClick={() => store.clearQueue()}>
            Clear queue
          </Button>
          <span className="player-hint">Playing from {state.queue[state.queueIndex]?.context.name ?? 'your library'}</span>
        </div>
        <AquaTable
          variant="page"
          label="Queue"
          rowKey={(row: QueueEntry) => row.id}
          rows={state.queue}
          currentKey={state.queue[state.queueIndex]?.id ?? null}
          onActivate={(row) => void store.jumpTo(state.queue.indexOf(row))}
          columns={[
            { id: 'position', header: '#', align: 'right', width: 36, cell: (_row, index) => index + 1 },
            { id: 'title', header: 'Title', primary: true, cell: (row) => row.track.title, stackText: (row) => row.track.artistName },
            { id: 'artist', header: 'Artist', cell: (row) => row.track.artistName },
            { id: 'time', header: 'Time', align: 'right', width: 56, cell: (row) => formatDuration(row.track.durationMs) },
            {
              id: 'move',
              header: <span className="aqua-visually-hidden">Reorder</span>,
              headerLabel: 'Reorder',
              width: 72,
              cell: (row, index) => (
                <span className="player-reorder">
                  <IconButton icon="sort" variant="plain" label={`Move ${row.track.title} up`} disabled={index === 0} onClick={() => store.moveInQueue(index, index - 1)} />
                  <IconButton icon="sort" variant="plain" label={`Move ${row.track.title} down`} disabled={index === state.queue.length - 1} onClick={() => store.moveInQueue(index, index + 1)} />
                </span>
              ),
            },
            {
              id: 'remove',
              header: <span className="aqua-visually-hidden">Remove</span>,
              headerLabel: 'Remove',
              width: 32,
              cell: (row) => <IconButton icon="remove" variant="plain" label={`Remove ${row.track.title} from the queue`} onClick={() => store.removeFromQueue(row.id)} />,
            },
          ]}
        />
      </Panel>
    </>
  );
}

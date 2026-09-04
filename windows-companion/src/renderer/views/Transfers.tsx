/** Files moving between this computer and the hub. */
import { useState } from 'react';
import { AquaTable, Button, EmptyState, Panel, PanelSection, ProgressBar, StatusDot } from '@now-playing/aqua-ui';
import type { TransferProgress } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { useAction, useChannel, useEvent } from '../hooks.js';
import { formatBytes } from './Folders.js';

export function TransfersView({ hubConnected }: { hubConnected: boolean }) {
  const transfers = useChannel('transfers:list', undefined, { pollMs: 3_000 });
  const [live, setLive] = useState<Record<string, TransferProgress>>({});
  const cancel = useAction(async (id: string) => invoke('transfers:cancel', { id }));

  useEvent('event:transfer-progress', (payload) => setLive((current) => ({ ...current, [payload.id]: payload })));

  const items = Object.values({ ...Object.fromEntries((transfers.data?.items ?? []).map((t) => [t.id, t])), ...live });

  if (!items.length) {
    return (
      <Panel title="Transfers">
        <EmptyState
          title="Nothing is transferring"
          text={hubConnected ? 'Select tracks on the Music screen and send them to the hub. Files move only when you ask; nothing is uploaded in the background.' : 'Pair a hub to send files to your other devices.'}
        />
      </Panel>
    );
  }

  return (
    <Panel title="Transfers">
      <PanelSection>
        <p className="companion-hint">Files move through the hub rather than device to device: one place to authorise, one audit trail, and a transfer that resumes when either side reconnects.</p>
      </PanelSection>
      <AquaTable
        label="Transfers"
        rowKey={(row: TransferProgress) => row.id}
        rows={items}
        columns={[
          { id: 'title', header: 'Track', primary: true, cell: (row) => row.trackTitle },
          { id: 'kind', header: 'Direction', width: 90, cell: (row) => (row.kind === 'upload' ? 'To hub' : 'From hub') },
          {
            id: 'progress',
            header: 'Progress',
            cell: (row) =>
              row.state === 'running' ? <ProgressBar value={row.bytesTotal ? (row.bytesDone / row.bytesTotal) * 100 : null} label={`${formatBytes(row.bytesDone)} of ${formatBytes(row.bytesTotal)}`} /> : <StatusDot kind={row.state === 'completed' ? 'ok' : row.state === 'failed' ? 'error' : 'neutral'} label={row.state} />,
          },
          { id: 'error', header: 'Note', cell: (row) => row.error ?? '' },
          {
            id: 'actions',
            header: '',
            headerLabel: 'Actions',
            width: 90,
            cell: (row) =>
              row.state === 'running' || row.state === 'queued' ? (
                <Button size="mini" busy={cancel.busy} onClick={() => void cancel.run(row.id).then(() => transfers.reload())}>
                  Cancel
                </Button>
              ) : null,
          },
        ]}
      />
    </Panel>
  );
}

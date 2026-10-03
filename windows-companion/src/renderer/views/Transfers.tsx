/**
 * Files moving between this PC and the hub: one well, a row per file. A file moves only when
 * someone sends it (Library ▸ Send to Hub); nothing is uploaded in the background.
 */
import { useState } from 'react';
import type { TransferProgress } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { formatBytes } from '../format.js';
import { useAction, useChannel, useEvent } from '../hooks.js';
import { EmptyRow, LoadingRow, Progress, Push, Rows } from '../ui.js';

const STATE_WORDS: Record<TransferProgress['state'], string> = { queued: 'waiting', running: 'sending', paused: 'paused', completed: 'sent', failed: 'didn’t send', cancelled: 'cancelled' };

export function TransfersView({ hubConnected }: { hubConnected: boolean }) {
  const transfers = useChannel('transfers:list', undefined, { pollMs: 3_000 });
  const [live, setLive] = useState<Record<string, TransferProgress>>({});
  const cancel = useAction(async (id: string) => invoke('transfers:cancel', { id }));

  useEvent('event:transfer-progress', (payload) => setLive((current) => ({ ...current, [payload.id]: payload })));

  const items = Object.values({ ...Object.fromEntries((transfers.data?.items ?? []).map((t) => [t.id, t])), ...live });
  const failed = items.filter((t) => t.state === 'failed' && t.error);

  return (
    <fieldset>
      <legend>Transfers</legend>
      <p className="hint">Songs you send to the hub. Files go through the hub rather than device to device, and a transfer picks up where it stopped when either side reconnects.</p>
      <Rows label="Transfers" live>
        {!transfers.data ? (
          <LoadingRow />
        ) : items.length ? (
          items.map((row) => (
            <li key={row.id}>
              <span className="name" title={row.trackTitle}>
                <b>{row.trackTitle}</b>
              </span>
              {row.state === 'running' ? <Progress label={`Sending ${row.trackTitle}`} value={row.bytesTotal ? (row.bytesDone / row.bytesTotal) * 100 : null} /> : null}
              <span className={row.state === 'failed' ? 'meta bad' : row.state === 'completed' ? 'meta ok' : 'meta'}>
                {row.state === 'running' ? `${formatBytes(row.bytesDone)} of ${formatBytes(row.bytesTotal)}` : `${row.kind === 'upload' ? 'to hub' : 'from hub'} · ${STATE_WORDS[row.state]}`}
              </span>
              {row.state === 'running' || row.state === 'queued' ? (
                <Push className="push--row" busy={cancel.busy} onClick={() => void cancel.run(row.id).then(() => transfers.reload())}>
                  Cancel
                </Push>
              ) : null}
            </li>
          ))
        ) : (
          <EmptyRow>{hubConnected ? 'Nothing is moving. Choose songs in Library and use Send to Hub.' : 'Nothing is moving. Pair a hub above to send songs to your other devices.'}</EmptyRow>
        )}
      </Rows>
      {failed.map((row) => (
        <p key={row.id} className="note note--bad">
          {row.trackTitle} didn’t send: {row.error}
        </p>
      ))}
    </fieldset>
  );
}

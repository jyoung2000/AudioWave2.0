/**
 * Logs and the support bundle.
 *
 * The bundle is downloadable because handing one to someone else is the point — so it lists its own
 * redactions above the download button, and an operator can read exactly what is and is not in it
 * before sending it anywhere.
 */
import { useState } from 'react';
import { AquaTable, Button, Panel, PanelSection, PopUpMenu, useToast } from '@now-playing/aqua-ui';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { Ago, AsyncPanel } from './common.js';

interface LogLine {
  time: string;
  level: string;
  msg: string;
  correlationId: string | null;
  module: string | null;
  data: Record<string, unknown>;
}

export function DiagnosticsView() {
  const [level, setLevel] = useState<'debug' | 'info' | 'warn' | 'error'>('info');
  const logs = useResource('logsList', { query: { level, limit: 300 } }, { pollMs: 5_000 });
  const bundle = useResource('diagnosticsBundle');
  const toast = useToast();

  const download = useAction(async () => {
    const data = await api('diagnosticsBundle');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `now-playing-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
    return data;
  });

  return (
    <>
      <AsyncPanel resource={bundle} title="Support bundle">
        {(raw) => {
          const data = raw as { redactions: string[]; generatedAt: string };
          return (
            <PanelSection>
              <p className="admin-hint">A JSON file describing this hub's versions, configuration state, provider health and counters. Safe to send to someone else: it never contains any of the following.</p>
              <ul className="admin-list">
                {data.redactions.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              <div className="admin-actions">
                <Button variant="default" busy={download.busy} onClick={() => void download.run().then(() => toast.show('Bundle downloaded'))}>
                  Download bundle
                </Button>
              </div>
            </PanelSection>
          );
        }}
      </AsyncPanel>

      <AsyncPanel
        resource={logs}
        title="Logs"
        actions={
          <PopUpMenu
            label="Level"
            size="small"
            value={level}
            onChange={(e) => setLevel(e.currentTarget.value as typeof level)}
            options={[
              { value: 'debug', label: 'Debug and above' },
              { value: 'info', label: 'Info and above' },
              { value: 'warn', label: 'Warnings and errors' },
              { value: 'error', label: 'Errors only' },
            ]}
          />
        }
        emptyWhen={(d) => (d as { items: LogLine[] }).items.length === 0}
        emptyTitle="Nothing logged at this level"
      >
        {(raw) => (
          <AquaTable
            label="Log lines"
            rowHeight={22}
            rowKey={(row: LogLine, ) => `${row.time}-${row.msg}`}
            rows={[...(raw as { items: LogLine[] }).items].reverse()}
            columns={[
              { id: 'time', header: 'When', width: 96, cell: (row) => <Ago iso={row.time} /> },
              { id: 'level', header: 'Level', width: 64, cell: (row) => row.level },
              { id: 'module', header: 'Module', width: 96, cell: (row) => row.module ?? '' },
              { id: 'msg', header: 'Message', primary: true, cell: (row) => row.msg },
              { id: 'cid', header: 'Correlation', width: 110, cell: (row) => (row.correlationId ? <code>{row.correlationId.slice(0, 8)}</code> : '') },
            ]}
          />
        )}
      </AsyncPanel>
    </>
  );
}

export { Panel };

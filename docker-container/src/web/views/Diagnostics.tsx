/**
 * Logs and the support bundle.
 *
 * The design's pane: a log level, Support Bundle…, and the log. The bundle is made to be handed to
 * someone else, so what it leaves out is said beside the button, before anything is downloaded.
 */
import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, errorSentence, Group, Note, Pop, Push, useHubUi } from '../ui.js';

interface LogLine {
  time: string;
  level: string;
  msg: string;
  correlationId: string | null;
  module: string | null;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('en-GB', { hour12: false });
}

export function DiagnosticsView() {
  const [level, setLevel] = useState<Level>('info');
  const logs = useResource('logsList', { query: { level, limit: 300 } }, { pollMs: 5_000 });
  const bundle = useResource('diagnosticsBundle');
  const { say } = useHubUi();

  const download = useAction(async () => {
    const data = await api('diagnosticsBundle');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `airwave-hub-support-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
    return data;
  });

  const lines = (logs.data as { items: LogLine[] } | null)?.items ?? null;
  const redactions = (bundle.data as { redactions: string[] } | null)?.redactions ?? [];

  return (
    <Group title="Diagnostics" last>
      <div className="pref">
        <label className="k" htmlFor="lvl">
          Log level:
        </label>
        <div className="v">
          <Pop id="lvl" value={level} onChange={(e) => setLevel(e.currentTarget.value as Level)}>
            <option value="error">Errors only</option>
            <option value="warn">Warnings and errors</option>
            <option value="info">Info and above</option>
            <option value="debug">Everything</option>
          </Pop>
          <Push busy={download.busy} onClick={() => void download.run().then((r) => r && say('Saved the support bundle to your downloads.'))}>
            Support Bundle…
          </Push>
          <span className="sub">The bundle describes this hub’s versions, settings and provider health for a bug report.{redactions.length ? ` It never contains: ${redactions.join('; ')}.` : ''}</span>
        </div>
      </div>
      <ActionError error={download.error} />
      <div className="well well--after">
        {/* The log scrolls inside its box, so it takes the keyboard like any other scrolling region. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <pre className="log" aria-label="Log lines" tabIndex={0}>
          {lines === null ? (
            <span className="quiet">{logs.error ? errorSentence(logs.error) : 'Loading…'}</span>
          ) : lines.length === 0 ? (
            <span className="quiet">Nothing logged at this level.</span>
          ) : (
            lines.map((line, i) => (
              <span key={`${line.time}-${i}`} className={line.level === 'warn' ? 'w' : line.level === 'error' || line.level === 'fatal' ? 'e' : undefined} title={line.correlationId ? `Request ${line.correlationId}` : undefined}>
                {clock(line.time)} {line.level.toUpperCase().padEnd(5)} {line.module ? `${line.module}: ` : ''}
                {line.msg}
                {'\n'}
              </span>
            ))
          )}
        </pre>
      </div>
      <Note>The newest lines are at the bottom. Addresses in them are shortened as set under Network.</Note>
    </Group>
  );
}

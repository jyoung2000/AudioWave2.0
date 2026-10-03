/**
 * Notices pushed by the main process — a folder that vanished, files that could not be read, a sync
 * that finished. Each is one line at the top of the pane with the design's status light, and a
 * round button that dismisses it.
 */
import { useCallback, useRef, useState } from 'react';
import { useEvent } from '../hooks.js';

export interface Notice {
  id: number;
  kind: 'info' | 'warning' | 'error';
  message: string;
}

export function useNotices(): { items: Notice[]; dismiss: (id: number) => void } {
  const [items, setItems] = useState<Notice[]>([]);
  const counter = useRef(0);
  useEvent('event:notice', (payload) => {
    counter.current += 1;
    const id = counter.current;
    setItems((list) => [{ id, kind: payload.kind, message: payload.message }, ...list].slice(0, 10));
  });
  return { items, dismiss: useCallback((id: number) => setItems((list) => list.filter((n) => n.id !== id)), []) };
}

export function NoticeBar({ notices, onDismiss }: { notices: readonly Notice[]; onDismiss: (id: number) => void }) {
  if (!notices.length) return null;
  return (
    <ul className="notices" aria-label="Notices">
      {notices.slice(0, 3).map((notice) => (
        <li key={notice.id} data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <span className={notice.kind === 'error' ? 'sdot sdot--bad' : notice.kind === 'warning' ? 'sdot sdot--warn' : 'sdot sdot--ok'} aria-hidden="true" />
          <span className="notices__text">{notice.message}</span>
          <button type="button" className="rm" aria-label="Dismiss" title="Dismiss" onClick={() => onDismiss(notice.id)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

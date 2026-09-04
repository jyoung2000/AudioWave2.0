/** Notices pushed by the main process — a folder that vanished, a file that could not be read. */
import { useCallback, useState } from 'react';
import { Button, Glyph } from '@now-playing/aqua-ui';
import { useEvent } from '../hooks.js';

export interface Notice {
  id: number;
  kind: 'info' | 'warning' | 'error';
  message: string;
}

export function useNotices(): { items: Notice[]; dismiss: (id: number) => void } {
  const [items, setItems] = useState<Notice[]>([]);
  const [counter, setCounter] = useState(0);
  useEvent('event:notice', (payload) => {
    setCounter((n) => {
      setItems((list) => [{ id: n + 1, kind: payload.kind, message: payload.message }, ...list].slice(0, 10));
      return n + 1;
    });
  });
  void counter;
  return { items, dismiss: useCallback((id: number) => setItems((list) => list.filter((n) => n.id !== id)), []) };
}

export function NoticeBar({ notices, onDismiss }: { notices: readonly Notice[]; onDismiss: (id: number) => void }) {
  if (!notices.length) return null;
  return (
    <ul className="companion-notices">
      {notices.slice(0, 3).map((notice) => (
        <li key={notice.id} data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <Glyph name={notice.kind === 'error' ? 'error' : notice.kind === 'warning' ? 'warning' : 'info'} />
          <span>{notice.message}</span>
          <Button size="mini" onClick={() => onDismiss(notice.id)}>
            Dismiss
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Notices the player owes the listener: a folder that lost permission, a file it could not read, a
 * format the browser cannot decode. Each one is dismissible and none of them block the interface —
 * the music that *does* work keeps playing.
 */
import { Button, Glyph } from '@now-playing/aqua-ui';
import { useAppState, usePlayer } from '../state/context.js';

export function NoticeBar() {
  const { store } = usePlayer();
  const state = useAppState();
  if (!state.notices.length) return null;
  return (
    <ul className="player-notices">
      {state.notices.slice(0, 3).map((notice) => (
        <li key={notice.id} data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <Glyph name={notice.kind === 'error' ? 'error' : notice.kind === 'warning' ? 'warning' : 'info'} />
          <span>{notice.message}</span>
          <Button size="mini" onClick={() => store.dismissNotice(notice.id)}>
            Dismiss
          </Button>
        </li>
      ))}
    </ul>
  );
}

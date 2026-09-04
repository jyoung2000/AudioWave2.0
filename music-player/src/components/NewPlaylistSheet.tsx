/**
 * "New Playlist" — the reference's iOS alert, with its markup and its keys.
 *
 * Enter creates, Escape cancels, a click on the backdrop cancels, and focus starts in the field.
 * It exists alongside the richer `AddToPlaylistSheet` rather than replacing it: this one answers a
 * single question asked from the row menu, and an alert that asks one question should not grow a
 * second control.
 */
import { useEffect, useRef } from 'react';

export interface NewPlaylistSheetProps {
  open: boolean;
  /** The song the new list should start with, when it was asked for from a row. */
  seedTitle?: string | null;
  onCancel: () => void;
  onCreate: (name: string) => void;
}

export function NewPlaylistSheet({ open, seedTitle, onCancel, onCreate }: NewPlaylistSheetProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // The field is the only thing to do here, so it starts focused.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  if (!open) return null;

  // Uncontrolled: the sheet unmounts when it closes, so the field starts empty again on its own and
  // there is no name to keep in sync with anything.
  const settle = (): void => {
    const trimmed = inputRef.current?.value.trim() ?? '';
    if (trimmed) onCreate(trimmed);
    else onCancel();
  };

  return (
    <div
      className="sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          settle();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      role="presentation"
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="np-sheet-title">
        <div className="sheet__body">
          <p className="sheet__title" id="np-sheet-title">
            New Playlist
          </p>
          <p className="sheet__msg">{seedTitle ? `Enter a name. “${seedTitle}” goes in it.` : 'Enter a name for this playlist.'}</p>
          <input ref={inputRef} className="sheet__input" type="text" placeholder="Playlist" maxLength={60} autoComplete="off" aria-label="Playlist name" defaultValue="" />
        </div>
        <div className="sheet__actions">
          <button className="sheet__btn" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="sheet__btn" type="button" onClick={settle}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

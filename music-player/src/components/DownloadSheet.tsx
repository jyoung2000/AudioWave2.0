/**
 * "Download…", with every format and the truth about each.
 *
 * The list is not filtered down to what works. A format that cannot be
 * produced is still shown, greyed, with the reason underneath — because
 * "where is MP3?" is a worse question to leave someone with than a line
 * explaining that making one needs an encoder this app does not carry.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Sheet, Spinner, useToast } from '@now-playing/aqua-ui';
import type { Track } from '@now-playing/contracts';
import { usePlayer } from '../state/context.js';
import { toTrackRef } from '../state/store.js';
import { exportOptionsFor, exportTrack, saveFile, type ExportFormat, type ExportOption } from '../lib/export.js';

export function DownloadSheet({ track, onClose }: { track: Track | null; onClose: () => void }) {
  const { store } = usePlayer();
  const toast = useToast();
  /**
   * The lookup is keyed by track id, so a sheet opened on a different song
   * never shows the previous one's file while the new one is being found.
   */
  const [found, setFound] = useState<{ trackId: string; file: File | null } | null>(null);
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  useEffect(() => {
    if (!track) return;
    let cancelled = false;
    void (async () => {
      const file = await store.fileFor(track.id);
      if (!cancelled) setFound({ trackId: track.id, file });
    })();
    return () => {
      cancelled = true;
    };
  }, [track, store]);

  const file = track && found?.trackId === track.id ? found.file : null;
  const options = useMemo(() => (track && found?.trackId === track.id ? exportOptionsFor(track, found.file) : null), [track, found]);

  const save = async (option: ExportOption): Promise<void> => {
    if (!track || !file) return;
    setBusy(option.format);
    try {
      const result = await exportTrack(track, file, option.format);
      const outcome = await saveFile(result);
      if (outcome === 'cancelled') return;
      toast.show(`Saved ${result.filename}`, { kind: 'success' });
      store.recordEvent('download-completed', toTrackRef(track), { contextKind: 'manual' });
      onClose();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { kind: 'warning' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      open={track !== null}
      title={track ? `Download “${track.title}”` : 'Download'}
      onCancel={onClose}
      actions={[{ id: 'close', label: 'Close', onSelect: onClose }]}
    >
      {options === null ? (
        <p className="player-hint">
          <Spinner /> Looking for the file…
        </p>
      ) : (
        <ul className="player-formats">
          {options.map((option) => (
            <li key={option.format} data-available={option.available ? 'true' : 'false'}>
              <div className="player-formats__row">
                <Button disabled={!option.available || busy !== null} busy={busy === option.format} onClick={() => void save(option)}>
                  {option.label}
                </Button>
                <span className="player-formats__tag">{option.lossless ? 'lossless' : 'lossy'}</span>
              </div>
              <p className="player-hint">{option.reason}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="player-hint">
        These are your own files, copied or re-encoded on this device. Nothing is uploaded and nothing is fetched to do it.
      </p>
    </Sheet>
  );
}

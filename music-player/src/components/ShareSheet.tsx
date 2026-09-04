/**
 * Creating a shareable link.
 *
 * A link is served by the hub, so sharing needs one: the player has no address anyone else can
 * reach. The sheet says that plainly instead of offering a button that produces nothing.
 *
 * What the recipient gets is stated before the link is created, not after: whether they can play
 * the songs (only for music the hub actually hosts) or only see the list with links to each song's
 * source. Promising playback for files that live on this laptop would be a lie.
 */
import { useState } from 'react';
import { Checkbox, PopUpMenu, Sheet, TextField, useToast } from '@now-playing/aqua-ui';
import type { TrackRef } from '@now-playing/contracts';
import { usePlayer } from '../state/context.js';

export type ShareKind = 'track' | 'album' | 'playlist' | 'library';

const EXPIRY_OPTIONS = [
  { value: '0', label: 'Never expires' },
  { value: '3600', label: 'One hour' },
  { value: '86400', label: 'One day' },
  { value: '604800', label: 'One week' },
  { value: '2592000', label: 'Thirty days' },
];

export function ShareSheet({ open, onClose, kind, track, tracks, title }: { open: boolean; onClose: () => void; kind: ShareKind; track?: TrackRef | null; tracks?: readonly TrackRef[]; title?: string }) {
  const { hub, hubStatus } = usePlayer();
  const toast = useToast();
  const [expiry, setExpiry] = useState('604800');
  const [maxAccesses, setMaxAccesses] = useState('');
  const [allowDownload, setAllowDownload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string | null; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items = tracks ?? (track ? [track] : []);
  // Only content the hub holds can be streamed to whoever opens the link.
  const hubHosted = items.filter((t) => t.locators.some((l) => l.kind === 'hub-blob')).length;
  const canStream = hubHosted > 0;

  const create = async (): Promise<void> => {
    if (!hub) return;
    setBusy(true);
    setError(null);
    try {
      const created = await hub.createShare({
        kind,
        targetId: kind === 'track' ? (track?.trackId ?? '') : (title ?? 'shared'),
        title: title ?? track?.title,
        allowStream: canStream,
        allowDownload: allowDownload && canStream,
        expiresInSeconds: expiry === '0' ? null : Number(expiry),
        maxAccesses: maxAccesses.trim() ? Number(maxAccesses) : null,
        items: items.map((t) => ({
          trackId: t.trackId,
          title: t.title,
          artistName: t.artistName,
          albumName: t.albumName,
          durationMs: t.durationMs,
          contentHash: t.identity.contentHash,
          openAtSourceUrl: t.locators.find((l) => l.kind === 'provider')?.canonicalUrl ?? null,
        })),
      });
      setResult({ url: created.url, token: created.token });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!result?.url) return;
    try {
      await navigator.clipboard.writeText(result.url);
      toast.show('Link copied', { kind: 'success' });
    } catch {
      toast.show('Your browser would not let the player use the clipboard. Select the link and copy it.', { kind: 'warning' });
    }
  };

  return (
    <Sheet
      open={open}
      title={result ? 'Your link is ready' : `Share ${kind === 'track' ? `“${track?.title ?? ''}”` : (title ?? kind)}`}
      onCancel={() => {
        setResult(null);
        setError(null);
        onClose();
      }}
      actions={
        result
          ? [
              { id: 'copy', label: 'Copy link', variant: 'default', onSelect: () => void copy() },
              { id: 'done', label: 'Done', onSelect: () => { setResult(null); onClose(); } },
            ]
          : [
              { id: 'create', label: 'Create link', variant: 'default', onSelect: () => void create(), busy },
              { id: 'cancel', label: 'Cancel', onSelect: onClose },
            ]
      }
    >
      {!hubStatus.connected ? (
        <p className="player-hint player-hint--warning">
          Sharing needs a hub. A link has to point at something other people can reach, and this player runs only on your device. Pair a hub in Settings to share.
        </p>
      ) : result ? (
        <div className="player-share-result">
          {result.url ? (
            <>
              <TextField label="Link" value={result.url} readOnly onFocus={(e) => e.currentTarget.select()} />
              <p className="player-hint">This is the only time the link is shown — the hub stores only a hash of it. You can revoke it at any time from the hub's admin page.</p>
            </>
          ) : (
            <p className="player-hint player-hint--warning">
              The link was created, but the hub has no address others can reach, so there is nothing to send. Set a public endpoint on the hub (Admin → Network) and create the link again.
            </p>
          )}
        </div>
      ) : (
        <div className="player-form">
          <p className="player-hint">
            {canStream
              ? `Whoever opens this link can play ${hubHosted} of ${items.length} song${items.length === 1 ? '' : 's'} — the ones your hub hosts.`
              : `Whoever opens this link will see the song list. They cannot play it: this music is on your device, and the hub has no copy. Each song links to its original source where one exists.`}
          </p>
          <PopUpMenu label="Expires" value={expiry} onChange={(e) => setExpiry(e.currentTarget.value)} options={EXPIRY_OPTIONS} />
          <TextField label="Maximum opens" value={maxAccesses} onChange={(e) => setMaxAccesses(e.currentTarget.value.replace(/\D/g, ''))} placeholder="Unlimited" inputMode="numeric" hint="After this many opens the link stops working." />
          <Checkbox checked={allowDownload} disabled={!canStream} onChange={(e) => setAllowDownload(e.currentTarget.checked)}>
            Also allow downloading {canStream ? '' : '(only possible for music the hub hosts)'}
          </Checkbox>
          {error ? <p className="player-hint player-hint--error">{error}</p> : null}
        </div>
      )}
    </Sheet>
  );
}

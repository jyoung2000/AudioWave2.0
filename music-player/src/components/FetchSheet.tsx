/**
 * "Add from a link…", which exists only while a helper is running.
 *
 * The rights basis is the reason this is a sheet rather than a button. The helper refuses a request
 * without one, so something has to ask — and asking properly, with the options written out, is
 * better than a checkbox saying "I have the rights" that everybody ticks without reading. Whichever
 * one is chosen travels with the request and is what the helper records.
 *
 * The sheet is also where the app is most tempted to overclaim, so it does the opposite: it says
 * which tool will run, that the app does not know whether you are entitled to the file, and — for
 * Spotify links — that what arrives is a match from elsewhere rather than Spotify's own audio.
 */
import { useMemo, useState } from 'react';
import { Button, Sheet, TextField } from '@now-playing/aqua-ui';
import type { DownloadAuthorizationBasis, OutputFormat } from '@now-playing/contracts';
import { useAppState, usePlayer } from '../state/context.js';

/** The bases the helper accepts, in the words of the person who would be choosing one. */
const BASES: Array<{ id: DownloadAuthorizationBasis; label: string; detail: string }> = [
  { id: 'user-owned', label: 'It is mine', detail: 'Something you made or uploaded yourself — your own channel, your own recordings.' },
  { id: 'creator-download', label: 'The creator offers it', detail: 'The uploader turned downloads on, or says in plain words that it may be downloaded.' },
  { id: 'public-domain', label: 'Public domain', detail: 'Old enough, or released deliberately into the public domain.' },
  { id: 'licensed', label: 'Licensed to me', detail: 'A Creative Commons licence that permits it, or a licence you hold.' },
  { id: 'purchased-export', label: 'I bought it', detail: 'You paid for this and are fetching your own copy.' },
];

/**
 * Mounted only while it is open, which is what keeps it honest: a rights basis chosen for one link
 * is not a claim about the next, so every opening starts from nothing rather than from whatever was
 * left behind.
 */
export function FetchSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store } = usePlayer();
  const state = useAppState();
  const [url, setUrl] = useState('');
  const [basis, setBasis] = useState<DownloadAuthorizationBasis | null>(null);
  const [format, setFormat] = useState<OutputFormat>('original');
  const [busy, setBusy] = useState(false);

  const helper = state.helper;
  const formats = helper?.health.formats ?? ['original'];
  const target = useMemo(() => describeTarget(url), [url]);
  const tool = target.spotify ? 'spotdl' : 'yt-dlp';
  const toolState = helper?.health.tools.find((entry) => entry.id === tool);
  const ready = Boolean(helper && toolState?.present && target.valid && basis && !busy);

  const go = async (): Promise<void> => {
    if (!basis || !target.valid) return;
    setBusy(true);
    try {
      await store.fetchLink(url.trim(), { basis, format });
      onClose();
    } catch {
      // The store has already put the reason in the notice bar; leave the sheet open so the link
      // and the choice are still there to change.
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      title="Add from a link"
      onCancel={onClose}
      actions={[
        { id: 'fetch', label: 'Fetch', variant: 'default', disabled: !ready, busy, onSelect: () => void go() },
        { id: 'cancel', label: 'Cancel', onSelect: onClose },
      ]}
    >
      {!helper ? (
        <p className="player-hint player-hint--warning">No helper is running, so nothing can be fetched. Settings → Platforms explains how to start one.</p>
      ) : null}

      <TextField label="Link" value={url} onChange={(event) => setUrl(event.currentTarget.value)} placeholder="https://…" autoComplete="off" spellCheck={false} />
      {url.trim() && !target.valid ? <p className="player-hint player-hint--warning">{target.reason}</p> : null}
      {target.valid && helper && !toolState?.present ? <p className="player-hint player-hint--warning">{toolState?.installHint ?? `${tool} is not installed where the helper can see it.`}</p> : null}
      {target.valid && target.spotify ? (
        <p className="player-hint">
          spotDL never takes Spotify’s audio. It reads Spotify for the track list and fetches a match from YouTube Music, so what lands in your library is another recording of the same song.
        </p>
      ) : null}

      <fieldset className="player-fieldset">
        <legend>What entitles you to this?</legend>
        {BASES.map((option) => (
          <label key={option.id} className="player-choice">
            <input type="radio" name="np-fetch-basis" checked={basis === option.id} onChange={() => setBasis(option.id)} />
            <strong>{option.label}</strong>
            <span className="player-choice__detail">{option.detail}</span>
          </label>
        ))}
      </fieldset>
      <p className="player-hint">
        This app cannot tell whether any of that is true — only you can. It is sent with the request and recorded, and nothing is fetched without one. If none of them fits, none of them fits.
      </p>

      <fieldset className="player-fieldset">
        <legend>Format</legend>
        <div className="player-toolbar-row">
          {(['original', 'flac', 'mp3', 'opus', 'aac'] as const).map((option) => (
            <Button key={option} size="small" aria-pressed={format === option} disabled={!formats.includes(option)} onClick={() => setFormat(option)}>
              {option === 'original' ? 'As it comes' : option.toUpperCase()}
            </Button>
          ))}
        </div>
        <p className="player-hint">
          {formats.length === 1
            ? 'Your helper found no FFmpeg, so nothing can be converted and you get whichever single audio stream the site offers.'
            : 'Converting re-encodes: choosing MP3 for something that arrived as Opus loses a little on the way. “As it comes” loses nothing.'}
        </p>
      </fieldset>
    </Sheet>
  );
}

/** What can be said about a pasted link before anything is asked of the helper. */
function describeTarget(input: string): { valid: boolean; spotify: boolean; reason: string } {
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, spotify: false, reason: '' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { valid: false, spotify: false, reason: 'That is not a web address. Paste the whole link, starting with https://.' };
  }
  if (url.protocol !== 'https:') return { valid: false, spotify: false, reason: 'The helper only fetches over https.' };
  return { valid: true, spotify: /(^|\.)spotify\.com$/.test(url.hostname), reason: '' };
}

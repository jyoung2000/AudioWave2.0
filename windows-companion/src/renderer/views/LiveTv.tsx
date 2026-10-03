/**
 * Live TV: channel playlists (M3U) and programme guides (XMLTV), as the design drew the tab — a
 * well of links, a field to paste one into, Add.
 *
 * A link is not kept on the strength of how it is spelled. Add hands it to the main process, which
 * reads it (public addresses only, with a size cap and a deadline) and keeps it only if a playlist
 * holds channels or a guide holds programmes; until that answer arrives the row reads “checking…”.
 * What it finds is what the Airwave player on this PC is given, through the local helper.
 */
import { useState, type FormEvent } from 'react';
import type { TvLink, TvLinkKind, TvLinks } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { LinkIcon } from '../icons.js';
import { EmptyRow, LoadingRow, Push, Remove, Rows } from '../ui.js';

const KINDS: ReadonlyArray<{ kind: TvLinkKind; legend: string; label: string; field: string; placeholder: string; empty: string }> = [
  { kind: 'm3u', legend: 'Channel playlists (M3U)', label: 'M3U links', field: 'M3U link', placeholder: 'https://example.com/channels.m3u8', empty: 'No playlists yet.' },
  { kind: 'epg', legend: 'Programme guides (EPG)', label: 'EPG links', field: 'EPG link', placeholder: 'https://example.com/guide.xml', empty: 'No guides yet — the guide will list channels without programmes.' },
];

function LinkList({ kind, legend, label, field, placeholder, empty, links, onChanged }: (typeof KINDS)[number] & { links: TvLink[] | null; onChanged: (links: TvLinks) => void }) {
  const [typed, setTyped] = useState('');
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState<string | null>(null);
  const errorId = `tv-${kind}-error`;

  const refresh = async () => onChanged(await invoke('tv:links', undefined));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const url = typed.trim();
    if (!url || checking) return;
    setError(null);
    setChecking(url);
    try {
      const result = await invoke('tv:add', { kind, url });
      if (result.link) setTyped('');
      else setError(result.reason ?? 'That link could not be added. Try again in a moment.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(null);
    }
  };

  const remove = async (link: TvLink) => {
    await invoke('tv:remove', { id: link.id });
    setError(null);
    await refresh();
  };

  const checkAgain = async (link: TvLink) => {
    setAgain(link.id);
    try {
      await invoke('tv:refresh', { id: link.id });
      await refresh();
    } finally {
      setAgain(null);
    }
  };

  const failed = (links ?? []).filter((link) => link.state === 'failed');

  return (
    <fieldset>
      <legend>{legend}</legend>
      {kind === 'm3u' ? (
        <p className="hint">
          One or more <code>.m3u</code> / <code>.m3u8</code> links. Every channel they list appears in the guide.
        </p>
      ) : (
        <p className="hint">
          XMLTV links. The guide fills the <b>Now</b>, <b>Next</b> and <b>Until</b> columns.
        </p>
      )}
      <Rows label={label} live>
        {!links ? (
          <LoadingRow />
        ) : links.length || checking ? (
          <>
            {links.map((link) => {
              const busy = link.state === 'checking' || again === link.id;
              return (
                <li key={link.id}>
                  <LinkIcon />
                  <span className="name" title={link.url}>
                    {link.url}
                  </span>
                  {busy ? <span className="meta">checking…</span> : link.state === 'ok' ? <span className="meta ok">✓ {link.summary}</span> : <span className="meta bad">{link.summary ?? 'unreachable'}</span>}
                  {link.state === 'failed' && !busy ? (
                    <Push className="push--row" onClick={() => void checkAgain(link)}>
                      Check Again
                    </Push>
                  ) : null}
                  <Remove label={`Remove ${link.url}`} onClick={() => void remove(link)} />
                </li>
              );
            })}
            {checking ? (
              <li>
                <LinkIcon />
                <span className="name" title={checking}>
                  {checking}
                </span>
                <span className="meta">checking…</span>
              </li>
            ) : null}
          </>
        ) : (
          <EmptyRow>{empty}</EmptyRow>
        )}
      </Rows>
      <form className="barrow" noValidate onSubmit={(event) => void submit(event)}>
        <input
          className={error ? 'field bad-field' : 'field'}
          type="url"
          inputMode="url"
          value={typed}
          readOnly={checking !== null}
          onChange={(event) => {
            setTyped(event.currentTarget.value);
            if (error) setError(null);
          }}
          placeholder={placeholder}
          aria-label={field}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          spellCheck={false}
          autoComplete="off"
        />
        <Push type="submit" isDefault busy={checking !== null} disabled={!typed.trim()} reason={typed.trim() ? null : 'Paste a link first.'}>
          Add
        </Push>
      </form>
      {error ? (
        <p className="note note--bad" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      {failed.length ? <p className="note">A link that doesn’t answer keeps what it last held, and is tried again by itself.</p> : null}
    </fieldset>
  );
}

export function LiveTvView({ links, onChanged }: { links: TvLinks | null; onChanged: (links: TvLinks) => void }) {
  return (
    <>
      {KINDS.map((kind) => (
        <LinkList key={kind.kind} {...kind} links={links ? links[kind.kind] : null} onChanged={onChanged} />
      ))}
    </>
  );
}

/**
 * Shared links.
 *
 * Every link the hub has made, what it grants, how often it has been opened, and Revoke. Under the
 * table, the design's Create row: a pop-up of what the hub itself can share — the playlists devices
 * have synced to it and the albums in its own library — and how long the link works. A player or the
 * companion still makes links from its own library, where its music is chosen.
 *
 * The hub keeps only a link's hash, so the full address exists once, in the answer to Create. This
 * window keeps the ones it made for as long as it is open, with Copy; anything older shows how it
 * ends.
 */
import { useState, type FormEvent } from 'react';
import type { ShareLinkView, ShareSources } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { capitalise } from '../lib/words.js';
import { ActionError, count, EmptyCells, Group, inText, listState, Note, Pop, Push, Sdot, useHubUi, useNow } from '../ui.js';

const EXPIRY: ReadonlyArray<{ value: string; label: string; seconds: number | null }> = [
  { value: '1', label: '1 day', seconds: 86_400 },
  { value: '7', label: '7 days', seconds: 7 * 86_400 },
  { value: '30', label: '30 days', seconds: 30 * 86_400 },
  { value: '0', label: 'Never', seconds: null },
];

/** "playlist:<id>" or "album:<id>": one pop-up value per thing that can be shared. */
function parseChoice(value: string): { kind: 'playlist' | 'album'; targetId: string } | null {
  const at = value.indexOf(':');
  const kind = value.slice(0, at);
  if (at < 0 || (kind !== 'playlist' && kind !== 'album')) return null;
  return { kind, targetId: value.slice(at + 1) };
}

export function SharesView() {
  const shares = useResource('sharesList', {}, { pollMs: 20_000 });
  const sources = useResource('sharesSources', {}, { pollMs: 60_000 });
  const revoke = useAction(async (shareId: string) => api('sharesRevoke', { params: { shareId } }));
  const create = useAction(async (body: { kind: 'playlist' | 'album'; targetId: string; expiresInSeconds: number | null }) => api('sharesCreate', { body: { ...body, allowStream: true, allowDownload: false, maxAccesses: null } }));
  const { say, confirm } = useHubUi();
  const now = useNow();

  const [choice, setChoice] = useState('');
  const [expiry, setExpiry] = useState('7');
  const [problem, setProblem] = useState<string | null>(null);
  // The full addresses of links made in this window, by link id. The hub cannot give them again.
  const [made, setMade] = useState<Record<string, string>>({});

  const items = (shares.data as { items: ShareLinkView[] } | null)?.items ?? [];
  const state = listState(shares, (d) => (d as { items: ShareLinkView[] }).items.length === 0, 'No shared links yet. Make one below, or from a player or the companion.');
  const what = sources.data as ShareSources | null;
  const nothing = what !== null && what.playlists.length === 0 && what.albums.length === 0;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const picked = parseChoice(choice);
    if (!picked) {
      setProblem(nothing ? 'There is nothing on the hub to share yet.' : 'Choose what to share first.');
      return;
    }
    setProblem(null);
    const result = (await create.run({ ...picked, expiresInSeconds: EXPIRY.find((e) => e.value === expiry)?.seconds ?? null })) as { share: ShareLinkView; token: string } | null;
    if (!result) return;
    // Without a public address the hub gives no URL; this window's own address still opens it.
    const url = result.share.url ?? `${window.location.origin}/s/${result.token}`;
    setMade((m) => ({ ...m, [result.share.id]: url }));
    setChoice('');
    shares.reload();
    say(`Made a link to ${result.share.title}. Copy it from the table.`);
  };

  const copy = (url: string, title: string): void =>
    void navigator.clipboard.writeText(url).then(
      () => say(`Copied the link to ${title}.`),
      () => say('The browser would not copy it. Select the link and copy it by hand.'),
    );

  return (
    <Group title="Shared links" hint="Links that let someone without an account open a track, album, playlist or library. Unreachable to others until the hub has a public https address (System ▸ Network).">
      <div className="well">
        <table className="tbl" aria-label="Shared links">
          <colgroup>
            <col style={{ width: '28%' }} />
            <col />
            <col className="hide-sm" style={{ width: '16%' }} />
            <col style={{ width: 140 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Link</th>
              <th scope="col" className="hide-sm">
                Expires
              </th>
              <th scope="col">
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state ? <EmptyCells columns={4} {...state} /> : null}
            {state
              ? null
              : items.map((row) => {
                  const grants = row.allowDownload ? 'Listen and download' : row.allowStream ? 'Listen' : 'Track list only';
                  const opened = row.maxAccesses === null ? `opened ${count(row.accessCount, 'time')}` : `opened ${row.accessCount} of ${row.maxAccesses} times`;
                  const url = row.revokedAt ? null : (made[row.id] ?? row.url);
                  return (
                    <tr key={row.id}>
                      <td title={`${grants} · ${opened} · played ${count(row.playCount, 'time')}`}>
                        <Sdot kind={row.revokedAt ? 'bad' : row.reachable ? 'ok' : 'warn'} label={row.revokedAt ? 'Revoked' : row.reachable ? 'Live' : 'Only works on your network'} inline />
                        {row.title} <span className="sub">({capitalise(row.kind)})</span>
                      </td>
                      <td className="mono" title={row.warning ?? url ?? undefined}>
                        {url ?? `ends with …${row.tokenHint}`}
                      </td>
                      <td className="hide-sm">{row.revokedAt ? 'revoked' : row.expiresAt === null ? 'never' : inText(row.expiresAt, now)}</td>
                      <td className="acts">
                        {url ? (
                          <Push aria-label={`Copy the link to ${row.title}`} onClick={() => copy(url, row.title)}>
                            Copy
                          </Push>
                        ) : null}
                        {row.revokedAt ? null : (
                          <Push
                            busy={revoke.busy}
                            aria-label={`Revoke the link to ${row.title}`}
                            onClick={() =>
                              void confirm({ title: `Revoke the link to “${row.title}”?`, text: 'Anyone holding it loses access straight away.', verb: 'Revoke' }).then((go) => {
                                if (go)
                                  void revoke.run(row.id).then((ok) => {
                                    if (ok) say(`Revoked the link to ${row.title}.`);
                                    shares.reload();
                                  });
                              })
                            }
                          >
                            Revoke
                          </Push>
                        )}
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      <form className="barrow" onSubmit={(event) => void submit(event)} noValidate>
        <Pop aria-label="What to share" value={choice} disabled={!what || nothing} aria-invalid={Boolean(problem) || undefined} onChange={(e) => setChoice(e.currentTarget.value)}>
          <option value="">{!what ? (sources.error ? 'Couldn’t read the playlists and albums' : 'Loading…') : nothing ? 'Nothing on the hub to share yet' : 'Choose a playlist or album…'}</option>
          {what?.playlists.length ? (
            <optgroup label="Playlists">
              {what.playlists.map((p) => (
                <option key={p.id} value={`playlist:${p.id}`}>
                  {p.name} ({count(p.trackCount, 'track')})
                </option>
              ))}
            </optgroup>
          ) : null}
          {what?.albums.length ? (
            <optgroup label="Albums">
              {what.albums.map((a) => (
                <option key={a.id} value={`album:${a.id}`}>
                  {a.title}
                  {a.artistName ? ` — ${a.artistName}` : ''} ({count(a.trackCount, 'track')})
                </option>
              ))}
            </optgroup>
          ) : null}
        </Pop>
        <Pop aria-label="Expires" value={expiry} onChange={(e) => setExpiry(e.currentTarget.value)}>
          {EXPIRY.map((e) => (
            <option key={e.value} value={e.value}>
              {e.value === '0' ? 'Never expires' : `Works for ${e.label}`}
            </option>
          ))}
        </Pop>
        <Push type="submit" busy={create.busy} busyLabel="Making…">
          Create Link
        </Push>
      </form>
      {problem ? <Note bad>{problem}</Note> : <ActionError error={create.error ?? revoke.error} />}
      {nothing ? <Note>Playlists appear here once a player or the companion syncs them to the hub, and albums once the hub’s library has music in it (Music ▸ Library folders).</Note> : null}
      {items.some((s) => !s.reachable && !s.revokedAt) ? <Note>Some links only open on your network. Set a public address in System ▸ Network so others can reach them.</Note> : null}
      <Note>A link lets people listen to what the hub holds; anything else opens at its source. Nobody can download through it. The full link is shown once, here, when you make it.</Note>
    </Group>
  );
}

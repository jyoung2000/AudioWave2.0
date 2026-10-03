/**
 * Shared links.
 *
 * A link is made where the music is chosen — in a player or the companion — so this table has no
 * Create row: the hub's admin has no playlist or album picker to make one from, and a form that
 * could only guess would be a picture of a feature. What the operator does here is see every link,
 * what it grants, how often it has been opened, and revoke it. The hub keeps only a link's hash, so
 * where no full address is known the table shows how the link ends.
 */
import type { ShareLinkView } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { capitalise } from '../lib/words.js';
import { ActionError, count, EmptyCells, Group, inText, listState, Note, Push, Sdot, useHubUi, useNow } from '../ui.js';

export function SharesView() {
  const shares = useResource('sharesList', {}, { pollMs: 20_000 });
  const revoke = useAction(async (shareId: string) => api('sharesRevoke', { params: { shareId } }));
  const { say, confirm } = useHubUi();
  const now = useNow();

  const items = (shares.data as { items: ShareLinkView[] } | null)?.items ?? [];
  const state = listState(shares, (d) => (d as { items: ShareLinkView[] }).items.length === 0, 'No shared links. A player or the companion makes one.');

  return (
    <Group title="Shared links" hint="Links that let someone without an account open a track, album, playlist or library. Unreachable to others until the hub has a public https address (System ▸ Network).">
      <div className="well">
        <table className="tbl" aria-label="Shared links">
          <colgroup>
            <col style={{ width: '28%' }} />
            <col />
            <col className="hide-sm" style={{ width: '16%' }} />
            <col style={{ width: 74 }} />
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
                  return (
                    <tr key={row.id}>
                      <td title={`${grants} · ${opened} · played ${count(row.playCount, 'time')}`}>
                        <Sdot kind={row.revokedAt ? 'bad' : row.reachable ? 'ok' : 'warn'} label={row.revokedAt ? 'Revoked' : row.reachable ? 'Live' : 'Only works on this machine'} inline />
                        {row.title} <span className="sub">({capitalise(row.kind)})</span>
                      </td>
                      <td className="mono" title={row.warning ?? row.url ?? undefined}>
                        {row.url ?? `ends with …${row.tokenHint}`}
                      </td>
                      <td className="hide-sm">{row.revokedAt ? 'revoked' : row.expiresAt === null ? 'never' : inText(row.expiresAt, now)}</td>
                      <td className="acts">
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
      <ActionError error={revoke.error} />
      {items.some((s) => !s.reachable && !s.revokedAt) ? <Note>Some links only open on this machine. Set a public address in System ▸ Network so others can reach them.</Note> : null}
      <Note>Links are made in a player or the companion, where the music is chosen. Here you can see and revoke them.</Note>
    </Group>
  );
}

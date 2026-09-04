/**
 * Shared links.
 *
 * The link itself is not shown here and cannot be: the hub keeps only the token's hash, so the full
 * URL exists once, in the response to whoever created it. The table says what each link grants,
 * how often it has been opened, and when it stops working — which is what a person revoking one
 * actually needs to know.
 */
import { AquaTable, Panel, StatusDot } from '@now-playing/aqua-ui';
import type { ShareLinkView } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { Ago, AsyncPanel, ConfirmButton } from './common.js';

export function SharesView() {
  const shares = useResource('sharesList', {}, { pollMs: 20_000 });
  const revoke = useAction(async (shareId: string) => api('sharesRevoke', { params: { shareId } }));

  return (
    <AsyncPanel
      resource={shares}
      title="Shared links"
      emptyWhen={(d) => (d as { items: ShareLinkView[] }).items.length === 0}
      emptyTitle="No links have been created"
      emptyText="A player or companion creates a link for a track, album, playlist or library. The hub stores only the link's hash, so a link cannot be recovered here — only revoked."
    >
      {(raw) => (
        <>
          <AquaTable
            label="Shared links"
            rowKey={(row: ShareLinkView) => row.id}
            rows={(raw as { items: ShareLinkView[] }).items}
            columns={[
              { id: 'title', header: 'Title', primary: true, cell: (row) => row.title },
              { id: 'kind', header: 'Kind', cell: (row) => row.kind },
              { id: 'hint', header: 'Link ends with', cell: (row) => <code>…{row.tokenHint}</code> },
              {
                id: 'grants',
                header: 'Grants',
                cell: (row) => (row.allowDownload ? 'stream + download' : row.allowStream ? 'stream' : 'track list only'),
              },
              { id: 'accesses', header: 'Opened', align: 'right', cell: (row) => (row.maxAccesses === null ? String(row.accessCount) : `${row.accessCount} / ${row.maxAccesses}`) },
              { id: 'plays', header: 'Played', align: 'right', cell: (row) => row.playCount },
              { id: 'expires', header: 'Expires', cell: (row) => (row.expiresAt === null ? 'never' : <Ago iso={row.expiresAt} />) },
              {
                id: 'state',
                header: 'State',
                cell: (row) => <StatusDot kind={row.revokedAt ? 'error' : row.warning ? 'warning' : 'ok'} label={row.revokedAt ? 'revoked' : row.warning ? 'limited' : 'live'} />,
              },
              {
                id: 'actions',
                header: '',
                headerLabel: 'Actions',
                cell: (row) =>
                  row.revokedAt ? null : (
                    <ConfirmButton
                      label="Revoke"
                      confirmLabel={`Revoke "${row.title}"? Anyone holding the link loses access immediately.`}
                      busy={revoke.busy}
                      onConfirm={() => void revoke.run(row.id).then(() => shares.reload())}
                    />
                  ),
              },
            ]}
          />
          {(raw as { items: ShareLinkView[] }).items.some((s) => s.warning && !s.revokedAt) ? (
            <p className="admin-hint admin-hint--warning">
              Some links cannot be opened by anyone outside this machine: set a public endpoint under Network so shared links resolve to a reachable address.
            </p>
          ) : null}
        </>
      )}
    </AsyncPanel>
  );
}

export { Panel };

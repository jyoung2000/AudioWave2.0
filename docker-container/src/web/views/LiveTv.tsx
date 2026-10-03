/**
 * Live TV from the companion.
 *
 * Read-only: the channel playlists and guides are added in the companion's Live TV tab, and the
 * companion sends the hub a copy so players on other machines get the same channels. The hub only
 * says where its copy came from, how big it is and how fresh, and can drop it.
 */
import type { HubLiveTvSummary } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, Ago, count, EmptyRow, errorSentence, Group, Push, Sdot, useHubUi } from '../ui.js';

export function LiveTvView() {
  const summary = useResource('liveTvSummary', {}, { pollMs: 60_000 });
  const remove = useAction(async () => api('liveTvDelete'));
  const { say, confirm } = useHubUi();
  const tv = summary.data as HubLiveTvSummary | null;
  const has = Boolean(tv && tv.sourceDevice);

  return (
    <Group title="Live TV from the companion" hint="The companion’s Live TV tab sends its channel playlists and guides here, so players that aren’t on that PC get the same channels. Add or remove channels in the companion.">
      <div className="well">
        <ul className="rows" aria-label="Live TV from the companion">
          {!tv ? (
            <EmptyRow text={summary.error ? errorSentence(summary.error) : 'Loading…'} retry={summary.error ? summary.reload : undefined} />
          ) : !has ? (
            <EmptyRow text="Nothing yet. A companion with Live TV channels sends them here when it syncs, if it shares with this hub." />
          ) : (
            <li>
              <Sdot kind="ok" />
              <span className="name">
                <b>{tv.sourceDevice!.name}</b>
              </span>
              <span className="grow">
                {count(tv.channelCount, 'channel')} · {tv.guideCount ? `guide for ${count(tv.guideCount, 'channel')}` : 'no guide'}
              </span>
              <span className="meta">
                Updated <Ago iso={tv.updatedAt} />
              </span>
              <Push
                busy={remove.busy}
                aria-label={`Remove the Live TV sent by ${tv.sourceDevice!.name}`}
                onClick={() =>
                  void confirm({ title: 'Remove these channels from the hub?', text: 'Players that aren’t on the companion’s PC lose them until the companion syncs again.', verb: 'Remove' }).then((go) => {
                    if (!go) return;
                    void remove.run().then((ok) => {
                      summary.reload();
                      if (ok) say('Removed the Live TV channels from the hub.');
                    });
                  })
                }
              >
                Remove
              </Push>
            </li>
          )}
        </ul>
      </div>
      <ActionError error={remove.error} />
    </Group>
  );
}

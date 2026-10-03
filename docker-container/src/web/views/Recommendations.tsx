/**
 * Recommendation settings.
 *
 * The three numbers the design shows, and under them what the hub also lets an operator change:
 * what each listening action is worth. Nothing takes effect until Save, and Revert puts back what
 * the hub has. The notes say plainly what the recommender is not — no model, no outside service —
 * because "recommendations" usually implies otherwise.
 */
import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, errorSentence, Field, Group, Note, Push, SubHead, useHubUi } from '../ui.js';

const ACTION_LABELS: Record<string, string> = {
  immediateSkip: 'Skipped within a few seconds',
  earlySkip: 'Skipped early',
  partial: 'Played in part',
  partialPlay: 'Played in part',
  majority: 'Played more than half',
  halfPlay: 'Played more than half',
  completed: 'Played to the end',
  replay: 'Played again soon after',
  like: 'Liked',
  liked: 'Liked',
  unlike: 'Un-liked',
  playlistAdd: 'Added to a playlist',
  playlistRemove: 'Removed from a playlist',
  favorite: 'Favourited',
  favorited: 'Favourited',
  dislike: 'Disliked',
  save: 'Saved',
  download: 'Downloaded',
  recommendationAccepted: 'Picked from recommendations',
  recommendationDismissed: 'Dismissed from recommendations',
};

/** An action this page has no words for yet still reads as words: "queueJump" → "Queue jump". */
function actionLabel(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return ACTION_LABELS[key] ?? spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function RecommendationsView() {
  const config = useResource('recommendationsConfigGet');
  const { say } = useHubUi();
  const save = useAction(async (body: Record<string, unknown>) => api('recommendationsConfigPut', { body }));
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);

  const stored = config.data as Record<string, unknown> | null;
  const current = draft ?? stored;
  const weights = (current?.['actionWeights'] ?? {}) as Record<string, number>;
  const set = (key: string, value: number): void => setDraft({ ...(current ?? {}), [key]: value });
  const number = (key: string, fallback: number): string => String(current?.[key] ?? fallback);

  return (
    <Group title="Recommendations" hint="The same engine, names and limits as the player’s Settings ▸ Recommendations; these are the hub’s defaults for everyone." last>
      {!current ? (
        <Note bad={Boolean(config.error)}>{config.error ? errorSentence(config.error) : 'Loading…'}</Note>
      ) : (
        <>
          <div className="pref">
            <label className="k" htmlFor="rExp">
              Exploration (0–1):
            </label>
            <div className="v">
              <Field id="rExp" numeric type="number" min={0} max={1} step={0.05} value={number('exploration', 0.2)} onChange={(e) => set('exploration', Number(e.currentTarget.value))} />
              <span className="sub">How much of each list is deliberately unfamiliar.</span>
            </div>
            <label className="k" htmlFor="rHalf">
              Half-life (days):
            </label>
            <div className="v">
              <Field id="rHalf" numeric type="number" min={1} max={365} value={number('halfLifeDays', 45)} onChange={(e) => set('halfLifeDays', Number(e.currentTarget.value))} />
              <span className="sub">How quickly older listening fades: after this many days it counts half as much.</span>
            </div>
            <label className="k" htmlFor="rMax">
              Most tracks per artist:
            </label>
            <div className="v">
              <Field id="rMax" numeric type="number" min={1} max={20} value={number('maxPerArtist', 2)} onChange={(e) => set('maxPerArtist', Number(e.currentTarget.value))} />
              <span className="sub">Stops one artist filling a list.</span>
            </div>
          </div>

          {Object.keys(weights).length ? (
            <>
              <SubHead>What each listening action is worth</SubHead>
              <div className="well">
                <table className="tbl" aria-label="What each listening action is worth">
                  <colgroup>
                    <col />
                    <col style={{ width: 92 }} />
                    <col style={{ width: '34%' }} className="hide-sm" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">When a track is…</th>
                      <th scope="col" className="num">
                        Weight
                      </th>
                      <th scope="col" className="hide-sm">
                        Effect
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(weights).map(([key, value]) => (
                      <tr key={key}>
                        <td>{actionLabel(key)}</td>
                        <td className="num">
                          <Field
                            numeric
                            className="field--cell"
                            type="number"
                            step={0.5}
                            value={String(value)}
                            aria-label={`Weight for ${actionLabel(key)}`}
                            onChange={(e) => setDraft({ ...current, actionWeights: { ...weights, [key]: Number(e.currentTarget.value) } })}
                          />
                        </td>
                        <td className="hide-sm">{value < 0 ? 'Fewer tracks like it' : value === 0 ? 'No effect' : 'More music like it'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          <div className="barrow">
            <Push
              primary
              busy={save.busy}
              disabled={draft === null}
              reason="Nothing has changed."
              onClick={() =>
                void save.run(current).then((r) => {
                  if (r) {
                    setDraft(null);
                    config.reload();
                    say('Saved the recommendation settings.');
                  }
                })
              }
            >
              Save
            </Push>
            <Push disabled={draft === null} reason="Nothing has changed." onClick={() => setDraft(null)}>
              Revert
            </Push>
          </div>
          <ActionError error={save.error} />
          <Note>
            Everything runs on this hub: no model is downloaded and no listening leaves it. A single skip lowers only that track, never its artist. Personal picks need the “Send each play” permission on a device; without
            it people still get recommendations, from the catalogue and what they choose.
          </Note>
        </>
      )}
    </Group>
  );
}

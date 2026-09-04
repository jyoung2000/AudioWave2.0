/**
 * Recommendation configuration.
 *
 * The weights are shown as what they are: numbers an operator can change, with the behaviour each
 * one produces spelled out. The panel also states plainly what the recommender is not — no model,
 * no GPU, no external service — because "recommendations" usually implies otherwise.
 */
import { useState } from 'react';
import { AquaTable, Button, Panel, PanelSection, TextField, useToast } from '@now-playing/aqua-ui';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { AsyncPanel, InlineError } from './common.js';

const ACTION_LABELS: Record<string, string> = {
  immediateSkip: 'Skipped within a few seconds',
  earlySkip: 'Skipped early',
  partialPlay: 'Played part of the track',
  halfPlay: 'Played more than half',
  completed: 'Played to the end',
  replay: 'Played again soon after',
  liked: 'Liked',
  playlistAdd: 'Added to a playlist',
  favorited: 'Favourited',
};

export function RecommendationsView() {
  const config = useResource('recommendationsConfigGet');
  const toast = useToast();
  const save = useAction(async (body: Record<string, unknown>) => api('recommendationsConfigPut', { body }));
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);

  return (
    <>
      <Panel title="How recommendations work here">
        <PanelSection>
          <ul className="admin-list">
            <li>Everything runs on this hub. No model is downloaded, no GPU is used, and no listening data is sent anywhere.</li>
            <li>Personalization needs the <code>history:events</code> permission on a device. Without it, a person still gets recommendations — from the catalogue and their explicit seeds, not their history.</li>
            <li>Group taste comparison uses aggregate profiles only, shared by opt-in, and needs at least three participants before it shows anything.</li>
            <li>Availability is checked against the providers this hub is actually configured for, so a recommendation is never something nobody here can play.</li>
          </ul>
        </PanelSection>
      </Panel>

      <AsyncPanel resource={config} title="Weights and behaviour">
        {(raw) => {
          const current = (draft ?? raw) as Record<string, unknown>;
          const weights = (current['actionWeights'] ?? {}) as Record<string, number>;
          const setWeight = (key: string, value: number) => setDraft({ ...current, actionWeights: { ...weights, [key]: value } });
          return (
            <>
              <PanelSection title="What each listening action is worth">
                <AquaTable
                  label="Action weights"
                  rowKey={(row: { key: string }) => row.key}
                  rows={Object.entries(weights).map(([key, value]) => ({ key, value }))}
                  columns={[
                    { id: 'action', header: 'Action', primary: true, cell: (row) => ACTION_LABELS[row.key] ?? row.key },
                    {
                      id: 'weight',
                      header: 'Weight',
                      align: 'right',
                      width: 120,
                      cell: (row) => (
                        <input
                          className="aqua-input aqua-input--number"
                          type="number"
                          step="0.5"
                          value={row.value}
                          aria-label={`Weight for ${ACTION_LABELS[row.key] ?? row.key}`}
                          onChange={(e) => setWeight(row.key, Number(e.currentTarget.value))}
                        />
                      ),
                    },
                    { id: 'effect', header: 'Effect', cell: (row) => (row.value < 0 ? 'Discourages this track' : row.value === 0 ? 'No effect' : 'Encourages similar music') },
                  ]}
                />
                <p className="admin-hint">
                  A single skip lowers only that track, never the artist or the genre — one bad night for one song should not remove a favourite artist from someone's recommendations.
                </p>
              </PanelSection>

              <PanelSection title="Decay and diversity">
                <div className="admin-form">
                  <TextField
                    label="Half-life (days)"
                    type="number"
                    value={String(current['halfLifeDays'] ?? 45)}
                    onChange={(e) => setDraft({ ...current, halfLifeDays: Number(e.currentTarget.value) })}
                    hint="How quickly older listening fades. At 45 days, music from six weeks ago counts half as much as today's."
                  />
                  <TextField
                    label="Maximum tracks per artist"
                    type="number"
                    value={String(current['maxPerArtist'] ?? 2)}
                    onChange={(e) => setDraft({ ...current, maxPerArtist: Number(e.currentTarget.value) })}
                    hint="Stops one artist filling a list."
                  />
                  <TextField
                    label="Exploration (0–1)"
                    type="number"
                    step="0.05"
                    value={String(current['exploration'] ?? 0.2)}
                    onChange={(e) => setDraft({ ...current, exploration: Number(e.currentTarget.value) })}
                    hint="How much of each list is deliberately unfamiliar."
                  />
                </div>
              </PanelSection>

              <div className="admin-actions">
                <Button
                  variant="default"
                  busy={save.busy}
                  disabled={draft === null}
                  onClick={() =>
                    void save.run(current).then((r) => {
                      if (r) {
                        setDraft(null);
                        config.reload();
                        toast.show('Saved', { kind: 'success' });
                      }
                    })
                  }
                >
                  Save
                </Button>
                <Button disabled={draft === null} onClick={() => setDraft(null)}>
                  Discard changes
                </Button>
              </div>
              <InlineError error={save.error} />
            </>
          );
        }}
      </AsyncPanel>
    </>
  );
}

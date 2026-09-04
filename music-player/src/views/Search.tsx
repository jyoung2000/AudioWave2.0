/**
 * Search.
 *
 * Local results always come first and always work — that is what the player is. Hub results are
 * added when a hub is paired, and each one carries the capability state the hub reported: a result
 * that cannot be played here says so *before* someone clicks it, rather than failing afterwards.
 */
import { useEffect, useMemo, useState } from 'react';
import { AquaTable, Button, EmptyState, LoadingState, Panel, PanelSection, SourceBadge, StatusDot, useToast } from '@now-playing/aqua-ui';
import type { SearchResponse, SearchResult, Track } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import { useAppState, usePlayer } from '../state/context.js';
import { toTrackRef } from '../state/store.js';
import { formatDuration } from './Library.js';

export function SearchView({ query, onQueryChange }: { query: string; onQueryChange: (value: string) => void }) {
  const { store, hub, hubStatus } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const [hubResults, setHubResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);

  const local = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return state.library.tracks
      .filter((t) => t.title.toLowerCase().includes(needle) || t.artistName.toLowerCase().includes(needle) || (t.albumName ?? '').toLowerCase().includes(needle))
      .slice(0, 200);
  }, [query, state.library.tracks]);

  // Debounced so typing does not fire a request per keystroke against the hub's rate limit.
  // Clearing results is deferred into the timer rather than done synchronously in the effect body:
  // a synchronous setState during an effect cascades an extra render for every keystroke.
  useEffect(() => {
    if (!hub || !hubStatus.connected || !query.trim()) {
      const clear = setTimeout(() => setHubResults(null), 0);
      return () => clearTimeout(clear);
    }
    const timer = setTimeout(() => {
      setSearching(true);
      setHubError(null);
      hub
        .search(query.trim())
        .then(setHubResults)
        .catch((err: unknown) => setHubError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [query, hub, hubStatus.connected]);

  if (!query.trim()) {
    return (
      <Panel>
        <EmptyState title="Search your music" text={hubStatus.connected ? `Searches this device and ${hubStatus.hubName ?? 'your hub'}.` : 'Searches the music on this device. Pair a hub in Settings to search connected services too.'} />
      </Panel>
    );
  }

  return (
    <>
      <div className="np-section-head">
        <h2>Search</h2>
        <p>{hubStatus.connected ? `This device and ${hubStatus.hubName ?? 'your hub'}.` : 'This device only, until a hub is paired.'}</p>
      </div>
      <Panel title={`On this device (${local.length})`}>
        {local.length ? (
          <AquaTable
            variant="page"
            label="Local results"
            rowKey={(row: Track) => row.id}
            rows={local}
            onActivate={(row) =>
              store.setQueue(
                local.map((track) => ({ id: uuidv7(), track: toTrackRef(track), context: { kind: 'search' as const, id: query, name: `search for “${query}”` } })),
                local.indexOf(row),
              )
            }
            columns={[
              { id: 'title', header: 'Title', primary: true, cell: (row) => row.title, stackText: (row) => row.artistName },
              { id: 'artist', header: 'Artist', cell: (row) => row.artistName },
              { id: 'album', header: 'Album', cell: (row) => row.albumName ?? '' },
              { id: 'time', header: 'Time', align: 'right', width: 56, cell: (row) => formatDuration(row.durationMs) },
            ]}
          />
        ) : (
          <EmptyState title="Nothing on this device matches" text="Try fewer words, or a different spelling." inline />
        )}
      </Panel>

      {hubStatus.connected ? (
        <Panel title={`From ${hubStatus.hubName ?? 'your hub'}`}>
          {searching && !hubResults ? (
            <LoadingState title="Searching" />
          ) : hubError ? (
            <PanelSection>
              <p className="player-hint player-hint--warning">The hub could not be searched: {hubError}. Your own music is unaffected.</p>
            </PanelSection>
          ) : hubResults ? (
            <>
              {hubResults.partialFailures.length ? (
                <PanelSection>
                  <ul className="player-partials">
                    {hubResults.partialFailures.map((failure) => (
                      <li key={failure.provider}>
                        <StatusDot kind="warning" label={failure.provider} /> {failure.error}
                        {failure.retryAfterSeconds ? ` — try again in ${failure.retryAfterSeconds}s` : ''}
                      </li>
                    ))}
                  </ul>
                </PanelSection>
              ) : null}
              <AquaTable
                variant="page"
                label="Hub results"
                rowKey={(row: SearchResult) => `${row.provider}:${row.providerId}`}
                rows={hubResults.results}
                onActivate={(row) => {
                  if (row.capabilities.playback !== 'available') {
                    toast.show(row.capabilities.reason ?? `${row.provider} cannot play that here.`, { kind: 'warning' });
                    return;
                  }
                  store.enqueue([{ id: uuidv7(), track: { trackId: row.trackId ?? uuidv7(), title: row.title, artistName: row.artistName ?? 'Unknown Artist', albumName: row.albumName, durationMs: row.durationMs, artworkId: null, identity: row.identity, locators: [], provider: row.provider, genre: row.genre, year: row.year }, context: { kind: 'hub' as const, id: query, name: hubStatus.hubName } }], 'next');
                  toast.show(`Added “${row.title}” to play next`);
                }}
                columns={[
                  { id: 'title', header: 'Title', primary: true, cell: (row) => row.title, stackText: (row) => row.artistName ?? '' },
                  { id: 'artist', header: 'Artist', cell: (row) => row.artistName ?? '' },
                  { id: 'source', header: 'Source', width: 120, cell: (row) => <SourceBadge provider={row.provider} /> },
                  { id: 'time', header: 'Time', align: 'right', width: 56, cell: (row) => formatDuration(row.durationMs) },
                  {
                    id: 'playable',
                    header: 'Available',
                    cell: (row) =>
                      row.capabilities.playback === 'available' ? (
                        <StatusDot kind="ok" label="Playable" />
                      ) : (
                        <span title={row.capabilities.reason ?? undefined}>
                          <StatusDot kind="neutral" label={row.capabilities.playback.replace('_', ' ')} />
                        </span>
                      ),
                  },
                ]}
              />
              <PanelSection>
                <p className="player-hint">
                  Searched {hubResults.sources.length} source{hubResults.sources.length === 1 ? '' : 's'} in {hubResults.tookMs} ms:{' '}
                  {hubResults.sources.map((s) => `${s.provider} (${s.state}${s.count ? `, ${s.count}` : ''})`).join(', ')}.
                </p>
              </PanelSection>
            </>
          ) : null}
        </Panel>
      ) : (
        <Panel>
          <PanelSection>
            <p className="player-hint">
              No hub is paired, so this searched only the music on this device. A hub adds search across the services its administrator has configured.{' '}
              <Button size="mini" onClick={() => onQueryChange(query)}>
                Keep searching locally
              </Button>
            </p>
          </PanelSection>
        </Panel>
      )}
    </>
  );
}

/**
 * Live TV.
 *
 * The mockup drew channel playlists (M3U) and programme guides (EPG) kept here and passed to the
 * hub. This repository has no store for either yet — no route, no table, no contract — and a tab
 * that showed sample channels would be claiming a feature that does not exist. So the tab says
 * what is missing, in the mockup's own amber voice, and what the companion does keep today: the TV
 * folders on this PC, which the Backup includes when asked.
 */
import { Panel, PanelSection, StatusDot } from '@now-playing/aqua-ui';
import { useChannel } from '../hooks.js';

export function LiveTvView() {
  const folders = useChannel('library:folders', undefined, { pollMs: 10_000 });
  const tv = (folders.data?.items ?? []).filter((f) => f.kind === 'tv');

  return (
    <Panel title="Live TV">
      <PanelSection>
        <div className="companion-gate" role="status">
          <StatusDot kind="warning" label="Not available yet" />
          <p className="companion-hint companion-hint--warning">
            Channel playlists (M3U) and programme guides (EPG) are not kept anywhere yet: neither this app nor the hub has a place to store them, so there is nothing to add a link to. When that arrives it
            will be here. Nothing on this tab is a sample.
          </p>
        </div>
      </PanelSection>
      <PanelSection title="TV folders on this PC">
        {tv.length ? (
          <ul className="companion-list">
            {tv.map((f) => (
              <li key={f.id}>
                <code className="companion-path">{f.path}</code>
                {f.available ? '' : ' — not available right now'}
              </li>
            ))}
          </ul>
        ) : (
          <p className="companion-hint">No TV folder has been added. Add one under Library ▸ Saved TV; a TV folder is kept and backed up, not indexed.</p>
        )}
      </PanelSection>
    </Panel>
  );
}

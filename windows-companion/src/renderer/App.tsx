/**
 * The companion's interface.
 *
 * Same Aqua window model as the player and the hub GUI, so someone using two of them is not
 * learning two interfaces. What differs is what this app *can* do — reach the filesystem — and the
 * screens are organised around exactly that: folders, what was found in them, what is shared with a
 * hub, and what is stored where.
 */
import { useMemo, useState } from 'react';
import { AquaWindow, BottomBar, Button, Content, Glyph, SourceList, StatusDot, Toolbar, WorkArea, type SourceGroup } from '@now-playing/aqua-ui';
import { bridgeAvailable, invoke } from './bridge.js';
import { useChannel, useEvent } from './hooks.js';
import { LibraryView } from './views/Library.js';
import { FoldersView } from './views/Folders.js';
import { HubView } from './views/Hub.js';
import { TransfersView } from './views/Transfers.js';
import { BackupView } from './views/Backup.js';
import { AboutView } from './views/About.js';
import { NoticeBar, useNotices } from './views/NoticeBar.js';
import type { HubConnection } from '../shared/ipc.js';

export type ViewId = 'library' | 'folders' | 'hub' | 'transfers' | 'backup' | 'about';

export function App() {
  const [view, setView] = useState<ViewId>('folders');
  const info = useChannel('app:info', undefined);
  const folders = useChannel('library:folders', undefined, { pollMs: 5_000 });
  const hubStatus = useChannel('hub:status', undefined, { pollMs: 10_000 });
  const [liveHub, setLiveHub] = useState<HubConnection | null>(null);
  const notices = useNotices();

  useEvent('event:hub-status', setLiveHub);

  const hub = liveHub ?? hubStatus.data ?? null;
  const trackCount = (folders.data?.items ?? []).reduce((sum, folder) => sum + folder.trackCount, 0);
  const unavailable = (folders.data?.items ?? []).filter((folder) => !folder.available).length;

  const groups = useMemo<SourceGroup<ViewId>[]>(
    () => [
      {
        id: 'library',
        label: 'Library',
        items: [
          { id: 'folders', label: 'Folders', icon: <Glyph name="folder" />, count: folders.data?.items.length ?? 0, status: unavailable ? `${unavailable} unavailable` : null },
          { id: 'library', label: 'Music', icon: <Glyph name="note" />, count: trackCount },
        ],
      },
      {
        id: 'hub',
        label: 'Hub',
        items: [
          { id: 'hub', label: 'Connection', icon: <Glyph name="link" />, status: hub?.connected ? (hub.hubName ?? 'connected') : 'not paired' },
          { id: 'transfers', label: 'Transfers', icon: <Glyph name="upload" /> },
        ],
      },
      {
        id: 'system',
        label: 'This computer',
        items: [
          { id: 'backup', label: 'Backup', icon: <Glyph name="download" /> },
          { id: 'about', label: 'About', icon: <Glyph name="info" /> },
        ],
      },
    ],
    [folders.data?.items.length, trackCount, unavailable, hub?.connected, hub?.hubName],
  );

  if (!bridgeAvailable()) {
    return (
      <AquaWindow active title="Now Playing Companion" flush>
        <Content>
          <div className="companion-blocked">
            <h1>This window is not running inside the companion</h1>
            <p>
              The interface is loaded, but it has no connection to the app that can read your files. This happens when the page is opened in a normal browser. Start the companion from its own shortcut.
            </p>
          </div>
        </Content>
      </AquaWindow>
    );
  }

  const body = (() => {
    switch (view) {
      case 'folders':
        return <FoldersView onFoldersChanged={folders.reload} />;
      case 'library':
        return <LibraryView />;
      case 'hub':
        return <HubView status={hub} onChanged={hubStatus.reload} />;
      case 'transfers':
        return <TransfersView hubConnected={hub?.connected ?? false} />;
      case 'backup':
        return <BackupView />;
      case 'about':
        return <AboutView />;
      default:
        return null;
    }
  })();

  return (
    <AquaWindow active title="Now Playing Companion" flush>
      <Toolbar
        display={<div className="companion-title">Now Playing Companion</div>}
        secondary={
          <>
            <Button size="small" icon="refresh" onClick={() => void invoke('library:scan', {})}>
              Scan
            </Button>
            <Button size="small" icon="reconnect" disabled={!hub?.connected} onClick={() => void invoke('hub:sync-now', undefined)}>
              Sync
            </Button>
          </>
        }
      />
      <WorkArea sidebar={<SourceList groups={groups} selectedId={view} onSelect={setView} label="Sections" dimUnfocused />} currentSourceName={groups.flatMap((g) => g.items).find((i) => i.id === view)?.label ?? 'Folders'}>
        <Content>
          <NoticeBar notices={notices.items} onDismiss={notices.dismiss} />
          {body}
        </Content>
      </WorkArea>
      <BottomBar
        left={<StatusDot kind={hub?.connected ? 'ok' : 'neutral'} label={hub?.connected ? `Connected to ${hub.hubName ?? 'a hub'}` : 'No hub paired'} />}
        status={`${trackCount.toLocaleString()} tracks in ${folders.data?.items.length ?? 0} folder${folders.data?.items.length === 1 ? '' : 's'}${unavailable ? ` · ${unavailable} folder${unavailable === 1 ? '' : 's'} unavailable` : ''}`}
        right={<span className="companion-version">{info.data ? `v${info.data.version}` : ''}</span>}
      />
    </AquaWindow>
  );
}

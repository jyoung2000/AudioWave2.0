/**
 * The companion's interface.
 *
 * The window is the one `design/frontends/airwave-companion.html` drew: a title bar and four icon
 * tabs on one chrome sheet — Library, Live TV, Remote, Settings — the pane scrolling beneath, a
 * status line at the foot. What differs from the hub's window is what this app *can* do: reach the
 * filesystem. The sections are organised around exactly that. Every figure on screen comes through
 * the preload bridge from the main process; the renderer has no way to read a folder itself.
 */
import { useMemo, useState } from 'react';
import { AquaWindow, BottomBar, Button, Content, StatusDot, Toolbar, ToolTabs, type ToolTabItem } from '@now-playing/aqua-ui';
import { bridgeAvailable, invoke } from './bridge.js';
import { useChannel, useEvent } from './hooks.js';
import { LibraryView } from './views/Library.js';
import { FoldersView } from './views/Folders.js';
import { LiveTvView } from './views/LiveTv.js';
import { HubView } from './views/Hub.js';
import { TransfersView } from './views/Transfers.js';
import { SettingsView } from './views/Settings.js';
import { StreamingView } from './views/Streaming.js';
import { BackupView } from './views/Backup.js';
import { AboutView } from './views/About.js';
import { NoticeBar, useNotices } from './views/NoticeBar.js';
import type { HubConnection } from '../shared/ipc.js';

/** The sections. Each is a screen in design/coverage.json; the tab it lives in is below. */
export type ViewId = 'folders' | 'library' | 'live-tv' | 'streaming' | 'hub' | 'transfers' | 'settings' | 'backup' | 'about';

export type TabId = 'library' | 'live-tv' | 'remote' | 'settings';

const TABS: ReadonlyArray<ToolTabItem<TabId> & { sections: ViewId[] }> = [
  { id: 'library', label: 'Library', icon: 'folder', sections: ['folders', 'library'] },
  { id: 'live-tv', label: 'Live TV', icon: 'device', sections: ['live-tv'] },
  { id: 'remote', label: 'Remote', icon: 'link', sections: ['streaming', 'hub', 'transfers'] },
  { id: 'settings', label: 'Settings', icon: 'gear', sections: ['settings', 'backup', 'about'] },
];

const SECTION_TITLES: Record<ViewId, string> = {
  folders: 'Folders',
  library: 'Music',
  'live-tv': 'Live TV',
  streaming: 'Stream to your devices',
  hub: 'Hub connection',
  transfers: 'Transfers',
  settings: 'Settings',
  backup: 'Backup',
  about: 'About',
};

export function App() {
  const [tab, setTab] = useState<TabId>('library');
  const info = useChannel('app:info', undefined);
  const folders = useChannel('library:folders', undefined, { pollMs: 5_000 });
  const hubStatus = useChannel('hub:status', undefined, { pollMs: 10_000 });
  const helper = useChannel('helper:status', undefined, { pollMs: 30_000 });
  const [liveHub, setLiveHub] = useState<HubConnection | null>(null);
  const notices = useNotices();

  useEvent('event:hub-status', setLiveHub);

  const hub = liveHub ?? hubStatus.data ?? null;
  const items = folders.data?.items ?? [];
  const trackCount = items.reduce((sum, folder) => sum + folder.trackCount, 0);
  const unavailable = items.filter((folder) => !folder.available).length;
  // A missing downloader is worth a badge on Settings, as the mockup's gear wore one.
  const missingTools = helper.data?.tools.filter((t) => !t.present).length ?? 0;

  const tabItems = useMemo(
    () => TABS.map((t) => (t.id === 'settings' && missingTools ? { id: t.id, label: t.label, icon: t.icon, badge: missingTools, badgeLabel: `${missingTools} downloader${missingTools === 1 ? '' : 's'} missing` } : { id: t.id, label: t.label, icon: t.icon })),
    [missingTools],
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

  const section = (id: ViewId) => {
    switch (id) {
      case 'folders':
        return <FoldersView onFoldersChanged={folders.reload} />;
      case 'library':
        return <LibraryView />;
      case 'live-tv':
        return <LiveTvView />;
      case 'streaming':
        return <StreamingView />;
      case 'hub':
        return <HubView status={hub} onChanged={hubStatus.reload} />;
      case 'transfers':
        return <TransfersView hubConnected={hub?.connected ?? false} />;
      case 'settings':
        return <SettingsView helper={helper} />;
      case 'backup':
        return <BackupView />;
      case 'about':
        return <AboutView />;
    }
  };

  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;
  const statusLine = hub?.connected ? `Connected to ${hub.hubName ?? 'a hub'}${hub.lastSyncAt ? ` · synced ${new Date(hub.lastSyncAt).toLocaleTimeString()}` : ''}` : 'No hub paired';
  const helperLine = helper.data ? (helper.data.running ? `helper on 127.0.0.1:${helper.data.port}` : 'helper not running') : null;

  return (
    <AquaWindow active title="Now Playing Companion" flush className="companion-window">
      <div className="companion-chrome">
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
        <ToolTabs tabs={tabItems} value={tab} onChange={setTab} label="Sections" idPrefix="companion" />
      </div>
      <Content className="companion-pane" id={`companion-pane-${current.id}`} role="tabpanel" aria-labelledby={`companion-tab-${current.id}`}>
        <NoticeBar notices={notices.items} onDismiss={notices.dismiss} />
        {current.sections.map((id) => (
          <section key={id} className="companion-section" id={id} aria-label={SECTION_TITLES[id]}>
            {section(id)}
          </section>
        ))}
      </Content>
      <BottomBar
        left={<StatusDot kind={hub?.connected ? 'ok' : 'neutral'} label={statusLine} />}
        status={`${trackCount.toLocaleString()} tracks in ${items.length} folder${items.length === 1 ? '' : 's'}${unavailable ? ` · ${unavailable} folder${unavailable === 1 ? '' : 's'} unavailable` : ''}${helperLine ? ` · ${helperLine}` : ''}`}
        right={<span className="companion-version">{info.data ? `v${info.data.version}` : ''}</span>}
      />
    </AquaWindow>
  );
}

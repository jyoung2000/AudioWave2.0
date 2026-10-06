/**
 * The companion's window.
 *
 * It is the window `design/frontends/origin/airwave-companion.html` drew, on this PC's own data: a title
 * and four tools on one sheet of chrome — Library, Live TV, Remote, Settings — the pane scrolling
 * beneath, a status line at the foot. The markup and class names are the design's, styled by the
 * design's stylesheet; what this file adds is where the mockup had sample data: every figure on
 * screen comes through the preload bridge from the main process, which is the only part of the app
 * that can read a folder or reach the network.
 *
 * The chrome is also the window's title bar: the operating system's own is hidden, the page draws
 * the title, and Windows draws its minimise, maximise and close over the top-right corner
 * (`src/main/index.ts`, createWindow). The chrome is the drag region; the tools are not.
 */
import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { bridgeAvailable, invoke } from './bridge.js';
import { ago, plural } from './format.js';
import { useChannel, useEvent, type Resource } from './hooks.js';
import { LibraryToolIcon, LiveTvToolIcon, RemoteToolIcon, SettingsToolIcon } from './icons.js';
import { ConfirmProvider, Push, useConfirm } from './ui.js';
import { AboutView } from './views/About.js';
import { BackupView } from './views/Backup.js';
import { FoldersView } from './views/Folders.js';
import { HubView } from './views/Hub.js';
import { LibraryView } from './views/Library.js';
import { LiveTvView } from './views/LiveTv.js';
import { NoticeBar, useNotices } from './views/NoticeBar.js';
import { needsAttention, SettingsView } from './views/Settings.js';
import { StreamingView } from './views/Streaming.js';
import { TransfersView } from './views/Transfers.js';
import { PRODUCT_NAME } from '../shared/identity.js';
import type { AwspStatus, HelperStatus, HubConnection, TvLinks } from '../shared/ipc.js';

/** The sections. Each is a screen in design/coverage.json; the tab it lives in is below. */
export type ViewId = 'folders' | 'library' | 'live-tv' | 'streaming' | 'hub' | 'transfers' | 'settings' | 'backup' | 'about';

export type TabId = 'library' | 'live-tv' | 'remote' | 'settings';

const PRODUCT = PRODUCT_NAME;

const TABS: ReadonlyArray<{ id: TabId; label: string; icon: () => ReactNode; sections: ViewId[]; lead: string }> = [
  {
    id: 'library',
    label: 'Library',
    icon: LibraryToolIcon,
    sections: ['folders', 'library'],
    lead: 'The folders on this PC that Airwave plays from. The companion watches them and, once sharing is on, passes what it finds to your Airwave Hub so every device sees the same library.',
  },
  {
    id: 'live-tv',
    label: 'Live TV',
    icon: LiveTvToolIcon,
    sections: ['live-tv'],
    lead: 'Channel playlists and programme guides for the Live TV tab. Paste a link and it is checked, kept here, and passed to the Airwave player on this PC.',
  },
  {
    id: 'remote',
    label: 'Remote',
    icon: RemoteToolIcon,
    sections: ['streaming', 'hub', 'transfers'],
    lead: 'Reach this PC from the Airwave player wherever you are. Every connection is encrypted, and only devices you pair here can connect.',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: SettingsToolIcon,
    sections: ['settings', 'backup', 'about'],
    lead: 'The tools this PC downloads with, and how the companion behaves on this PC. Changes take effect as you make them.',
  },
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

/** While a downloader is being set up its progress is worth watching; otherwise every 30 s is plenty. */
export function helperPollMs(status: HelperStatus | null): number {
  return status?.tools.some((t) => t.setup?.state === 'installing') ? 1_500 : 30_000;
}

/** A channel's answer, replaced by whatever the main process pushes after it. */
function useLive<T>(resource: Resource<T>, pushed: T | null): T | null {
  return pushed ?? resource.data;
}

export function App() {
  if (!bridgeAvailable()) return <Outside />;
  return (
    <ConfirmProvider>
      <Companion />
    </ConfirmProvider>
  );
}

/** Opened in a browser, the page has no way to reach the app. It says so and offers nothing. */
function Outside() {
  return (
    <div className="win">
      <div className="chrome">
        <div className="titlebar">{PRODUCT}</div>
      </div>
      <section className="pane">
        <h1 className="blocked__title">This window is not running inside the companion</h1>
        <p className="lead">The page is loaded, but it has no connection to the app that can read your files. That happens when it is opened in a web browser. Open Airwave Companion from the Start menu instead.</p>
      </section>
    </div>
  );
}

function Companion() {
  const [tab, setTab] = useState<TabId>('library');
  /** A pane is built the first time its tool is chosen and then kept, so coming back to it is instant. */
  const [opened, setOpened] = useState<ReadonlySet<TabId>>(() => new Set<TabId>(['library']));
  const tools = useRef(new Map<TabId, HTMLButtonElement>());

  const folders = useChannel('library:folders', undefined, { pollMs: 5_000 });
  const hubStatus = useChannel('hub:status', undefined, { pollMs: 10_000 });
  const helper = useChannel('helper:status', undefined, { pollMs: helperPollMs });
  const tvLinks = useChannel('tv:links', undefined, { pollMs: 60_000 });
  const awspStatus = useChannel('awsp:status', undefined, { pollMs: 30_000 });
  const [pushedHub, setPushedHub] = useState<HubConnection | null>(null);
  const [pushedTv, setPushedTv] = useState<TvLinks | null>(null);
  const [pushedAwsp, setPushedAwsp] = useState<AwspStatus | null>(null);
  const prefs = useChannel('app:preferences:get', undefined);
  const notices = useNotices();
  const confirm = useConfirm();
  /** The Settings tab's one line of feedback, at its foot, as the design's `say()` wrote it. */
  const [settingsNote, setSettingsNote] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const restoreDefaults = async () => {
    const yes = await confirm({ title: 'Restore the default settings?', detail: 'Start-up, the notification area, folder watching, syncing, update checks, how downloads run and where they are saved, the helper’s port and network setting, and detailed logs go back to how a new install has them. Downloaders, folders, links, backups and pairings are unchanged.', action: 'Restore Defaults' });
    if (!yes) return;
    setRestoring(true);
    try {
      await invoke('app:preferences:reset', undefined);
      prefs.reload();
      setSettingsNote('Defaults restored. Downloaders and folders are unchanged.');
    } catch (err) {
      setSettingsNote(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(false);
    }
  };

  useEvent('event:hub-status', setPushedHub);
  useEvent('event:tv-links', setPushedTv);
  useEvent('event:awsp-status', setPushedAwsp);

  const hub = useLive(hubStatus, pushedHub);
  const tv = useLive(tvLinks, pushedTv);
  const awsp = useLive(awspStatus, pushedAwsp);
  const items = folders.data?.items ?? [];
  // A downloader that needs the person — missing, failed, or found behind by a Check — is worth a
  // badge on Settings, as the design's gear wore one. One still being set up does not: it is on its
  // way (UX-SETUP-001).
  const attention = helper.data?.tools.filter((t) => needsAttention(t, helper.data?.running ?? false)).length ?? 0;

  const show = useCallback((id: TabId) => {
    setTab(id);
    setOpened((current) => (current.has(id) ? current : new Set(current).add(id)));
  }, []);

  /** Arrow keys move along the tools and choose as they go, as the design's toolbar does. */
  const onToolKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : step ? (index + step + TABS.length) % TABS.length : null;
    if (target === null) return;
    event.preventDefault();
    const next = TABS[target]!;
    show(next.id);
    tools.current.get(next.id)?.focus();
  };

  const refreshHub = () => {
    setPushedHub(null);
    hubStatus.reload();
  };

  const section = (id: ViewId) => {
    switch (id) {
      case 'folders':
        return <FoldersView folders={folders} />;
      case 'library':
        return <LibraryView helper={helper} hubConnected={hub?.connected ?? false} hasMusicFolder={items.some((f) => f.kind === 'music')} />;
      case 'live-tv':
        return <LiveTvView links={tv} onChanged={setPushedTv} />;
      case 'streaming':
        return <StreamingView status={awsp} onChanged={setPushedAwsp} />;
      case 'hub':
        return <HubView status={hub} onChanged={refreshHub} />;
      case 'transfers':
        return <TransfersView hubConnected={hub?.connected ?? false} />;
      case 'settings':
        return <SettingsView helper={helper} prefs={prefs} say={setSettingsNote} />;
      case 'backup':
        return <BackupView say={setSettingsNote} />;
      case 'about':
        return <AboutView prefs={prefs} say={setSettingsNote} />;
    }
  };

  const paired = Boolean(hub?.endpoint);
  const hubName = hub?.hubName ?? 'your Airwave Hub';
  const hubLine = !hub ? '' : hub.connected ? `Connected to ${hubName}${hub.lastSyncAt ? ` · synced ${ago(hub.lastSyncAt)}` : ''}` : paired ? `Can’t reach ${hubName}` : 'No hub paired';
  const countLine = [plural(items.length, 'folder'), plural(tv?.m3u.length ?? 0, 'playlist'), plural(tv?.epg.length ?? 0, 'guide'), plural(awsp?.devices.length ?? 0, 'device')].join(' · ');

  return (
    <div className="win">
      <div className="chrome">
        <div className="titlebar" role="heading" aria-level={1}>
          {PRODUCT}
        </div>
        <div className="toolbar" role="tablist" aria-label="Sections">
          {TABS.map((t, index) => {
            const selected = t.id === tab;
            const Icon = t.icon;
            const badge = t.id === 'settings' ? attention : 0;
            return (
              <button
                key={t.id}
                ref={(node) => {
                  if (node) tools.current.set(t.id, node);
                  else tools.current.delete(t.id);
                }}
                type="button"
                className="tool"
                role="tab"
                id={`companion-tab-${t.id}`}
                aria-selected={selected}
                aria-controls={`companion-pane-${t.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => show(t.id)}
                onKeyDown={(event) => onToolKey(event, index)}
              >
                <Icon />
                {t.label}
                {badge ? (
                  <>
                    <span className="gear-badge" aria-hidden="true">
                      {badge}
                    </span>
                    <span className="sr">, {badge === 1 ? '1 downloader needs attention' : `${badge} downloaders need attention`}</span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {TABS.map((t) =>
        opened.has(t.id) ? (
          <section key={t.id} className="pane" id={`companion-pane-${t.id}`} role="tabpanel" aria-labelledby={`companion-tab-${t.id}`} hidden={t.id !== tab}>
            {t.id === tab ? <NoticeBar notices={notices.items} onDismiss={notices.dismiss} /> : null}
            <p className="lead">{t.lead}</p>
            {t.sections.map((id) => (
              <section key={id} className="sect" id={id} aria-label={SECTION_TITLES[id]}>
                {section(id)}
              </section>
            ))}
            {t.id === 'settings' ? (
              <div className="panefoot">
                <p className="note" role="status">
                  {settingsNote ?? 'Settings are kept on this PC.'}
                </p>
                <Push busy={restoring} onClick={() => void restoreDefaults()}>
                  Restore Defaults
                </Push>
              </div>
            ) : null}
          </section>
        ) : null,
      )}

      <div className="status">
        <span className={hub?.connected ? 'dot' : paired ? 'dot dot--warn' : 'dot dot--off'} aria-hidden="true" />
        <span className="status__hub">{hubLine}</span>
        <span className="spacer" />
        <span className="status__counts">{countLine}</span>
      </div>
    </div>
  );
}

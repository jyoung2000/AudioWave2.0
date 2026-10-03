/**
 * The Airwave Hub window.
 *
 * One window, always: the centred Snow Leopard window `design/frontends/airwave-hub.html` draws — a
 * title bar and six icon tabs on one chrome sheet, the pane scrolling under it, a status strip at
 * the foot. What changes with the session is what the window lets through:
 *
 * 1. **Not signed in** — the same window with its tabs locked and the sign-in form in the pane.
 * 2. **Signed in, bootstrap password still in place** — the Overview pane with the design's amber
 *    gate asking for a real password. The other five tabs are visible but locked, with the reason:
 *    the server refuses every gated route until the password is changed, so there is nothing true
 *    to show behind them. Overview itself reads only routes the server allows before setup.
 * 3. **Signed in and set up** — everything.
 *
 * The thirteen sections the hub has always had live inside the six tabs (design/decisions.md
 * DEC-017); each keeps its own data flow, its own `#section-id` anchor and its own ledger entry. The
 * tab strip is a roving-tabindex group (UX-KEY-001): one tab stop, arrows and Home/End move the
 * selection, locked tabs are skipped.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { BRANDING, type NetworkConfig, type OverviewMetrics, type SessionInfo } from '@now-playing/contracts';
import { api, setCsrfToken } from './lib/api.js';
import { useAction, useResource, useStoredState, type Resource } from './lib/hooks.js';
import { OVERVIEW_POLL_MS, OverviewProvider } from './lib/overview.js';
import { ActionError, count, errorSentence, Field, HubUiProvider, Note, Push } from './ui.js';
import { TAB_ICONS } from './icons.js';
import { ViewBoundary } from './ViewBoundary.js';
import { OverviewView } from './views/Overview.js';
import { DevicesView } from './views/Devices.js';
import { GroupsView } from './views/Groups.js';
import { ProvidersView } from './views/Providers.js';
import { LibraryView } from './views/Library.js';
import { DownloadsView } from './views/Downloads.js';
import { LiveTvView } from './views/LiveTv.js';
import { ProfilesView } from './views/Profiles.js';
import { SharesView } from './views/Shares.js';
import { DiscordView } from './views/Discord.js';
import { NetworkView } from './views/Network.js';
import { DiagnosticsView } from './views/Diagnostics.js';
import { BackupView } from './views/Backup.js';
import { RecommendationsView } from './views/Recommendations.js';

const PRODUCT = BRANDING.products.hub;

/** The sections. Each is a screen in design/coverage.json; the tab it lives in is below. */
export type ViewId = 'overview' | 'devices' | 'groups' | 'profiles' | 'providers' | 'library' | 'downloads' | 'shares' | 'recommendations' | 'discord' | 'network' | 'diagnostics' | 'backup';

export type TabId = 'overview' | 'devices' | 'music' | 'groups' | 'sharing' | 'system';

interface TabSpec {
  id: TabId;
  label: string;
  icon: ReactNode;
  /** The sentence under the toolbar, where the design has one. */
  lead?: string;
  /** In the order they stack down the pane. */
  sections: ViewId[];
}

/* The six toolbar icons, as drawn in the design file, are in ./icons.tsx. */
const ICONS: Record<TabId, ReactNode> = TAB_ICONS;

/**
 * Profiles sit with Devices: a profile is what a paired device's person looks like to other
 * devices, and moderation is a per-device concern. Recommendations sit with Music: they are the
 * hub's defaults for the same engine the player's Settings ▸ Recommendations edits.
 */
const TABS: readonly TabSpec[] = [
  { id: 'overview', label: 'Overview', icon: ICONS.overview, sections: ['overview'] },
  {
    id: 'devices',
    label: 'Devices',
    icon: ICONS.devices,
    lead: 'Players and companion apps that may use this hub. Each gets only the permissions you tick when you pair it.',
    sections: ['devices', 'profiles'],
  },
  {
    id: 'music',
    label: 'Music',
    icon: ICONS.music,
    lead: 'What the hub plays from, where it looks things up, and what it may save. Everything here is shared by every paired device.',
    sections: ['library', 'providers', 'downloads', 'recommendations'],
  },
  {
    id: 'groups',
    label: 'Groups',
    icon: ICONS.groups,
    lead: 'Listening together: one queue, one clock, every member kept in step. Drift is how far each device is from the group’s clock.',
    sections: ['groups'],
  },
  { id: 'sharing', label: 'Sharing', icon: ICONS.sharing, sections: ['shares', 'discord'] },
  { id: 'system', label: 'System', icon: ICONS.system, sections: ['network', 'backup', 'diagnostics'] },
];

const TAB_IDS: ReadonlySet<string> = new Set(TABS.map((t) => t.id));

const SECTION_TAB: Record<ViewId, TabId> = Object.fromEntries(TABS.flatMap((t) => t.sections.map((s) => [s, t.id]))) as Record<ViewId, TabId>;

/** What each section is called: the landmark a screen reader lists. */
const SECTION_TITLES: Record<ViewId, string> = {
  overview: 'Overview',
  devices: 'Devices',
  profiles: 'Profiles',
  library: 'Library',
  providers: 'Providers',
  downloads: 'Downloads',
  recommendations: 'Recommendations',
  groups: 'Groups',
  shares: 'Shared links',
  discord: 'Discord',
  network: 'Network',
  backup: 'Backup',
  diagnostics: 'Diagnostics',
};

/** A stored id from an older build (a section id from the source-list days, or a hand edit) is
 * mapped onto its tab rather than rendering an empty pane. */
function isTabId(value: unknown): value is TabId {
  return typeof value === 'string' && TAB_IDS.has(value);
}

function tabFor(value: unknown): TabId | null {
  if (isTabId(value)) return value;
  if (typeof value === 'string' && value in SECTION_TAB) return SECTION_TAB[value as ViewId];
  return null;
}

function hashId(): string {
  return window.location.hash.replace(/^#/, '');
}

/** `#system` or `#diagnostics` in the address opens that tab, so a log message can point at one. */
function tabFromHash(): TabId | null {
  return tabFor(hashId());
}

/**
 * The password typed at sign-in, kept in memory only while the first-run gate is up, so the gate
 * can ask for the new password alone (as the design does) and still send the current one the
 * server requires. It is never stored, and it is dropped the moment the password changes.
 */
let passwordJustTyped: string | null = null;

export function App() {
  const session = useResource('authSession', {}, { pollMs: 60_000 });
  const info = session.data as SessionInfo | null;

  useEffect(() => {
    setCsrfToken(info?.csrfToken ?? null);
  }, [info?.csrfToken]);

  if (!info) {
    return (
      <Window locked="Connecting to the hub." status={<StatusLine kind="off" text="Connecting to the hub…" />}>
        <div className="pane" aria-busy={!session.error}>
          {session.error ? (
            <>
              <Note bad>{errorSentence(session.error)}</Note>
              <div className="barrow">
                <Push onClick={session.reload}>Try Again</Push>
              </div>
            </>
          ) : (
            <p className="lead">Connecting to the hub…</p>
          )}
        </div>
      </Window>
    );
  }
  if (!info.authenticated) return <LoginScreen onSignedIn={session.reload} setupComplete={info.setupComplete} />;
  return <AdminShell session={info} onSessionChanged={session.reload} />;
}

/* ------------------------------------------------------------------ the window */

interface ToolState {
  selected: TabId | null;
  onSelect: (tab: TabId) => void;
  /** Tabs that are shown but cannot be opened. */
  lockedTabs: ReadonlySet<TabId>;
  lockedReason: string;
  badges: Partial<Record<TabId, { count: number; label: string }>>;
}

function Window({ tools, locked, status, sheet, sheetOpen, children }: { tools?: ToolState; locked?: string; status: ReactNode; sheet?: ReactNode; sheetOpen?: boolean; children: ReactNode }) {
  const state: ToolState = tools ?? { selected: null, onSelect: () => undefined, lockedTabs: new Set(TABS.map((t) => t.id)), lockedReason: locked ?? '', badges: {} };
  const open = TABS.filter((t) => !state.lockedTabs.has(t.id));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open.length) return;
    // From the tab that has the focus, which is the selected one unless a script moved it.
    const focused = event.target instanceof HTMLElement ? event.target.id.replace(/^tab-/, '') : '';
    const from = open.findIndex((t) => t.id === focused);
    const at = from >= 0 ? from : open.findIndex((t) => t.id === state.selected);
    const next = { ArrowRight: open[(at + 1) % open.length], ArrowLeft: open[(at - 1 + open.length) % open.length], Home: open[0], End: open[open.length - 1] }[event.key];
    if (!next) return;
    event.preventDefault();
    state.onSelect(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  return (
    <div className="frame">
      <main className="win" aria-label={PRODUCT}>
        <div className="chrome" inert={sheetOpen}>
          <h1 className="titlebar">{PRODUCT}</h1>
          {/* The arrow keys belong to the tab strip, not to a control inside it. */}
          {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus */}
          <div className="toolbar" role="tablist" aria-label="Sections" onKeyDown={onKeyDown}>
            {TABS.map((tab) => {
              const isLocked = state.lockedTabs.has(tab.id);
              const isSelected = state.selected === tab.id;
              const badge = state.badges[tab.id];
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`tool${isLocked ? ' locked' : ''}`}
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-selected={isSelected}
                  aria-controls={isSelected ? `pane-${tab.id}` : undefined}
                  aria-disabled={isLocked || undefined}
                  aria-describedby={isLocked ? 'tools-locked' : undefined}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => {
                    if (!isLocked) state.onSelect(tab.id);
                  }}
                >
                  {tab.icon}
                  {tab.label}
                  {badge ? (
                    <>
                      <span className="gear-badge" aria-hidden="true">
                        {badge.count}
                      </span>
                      <span className="sr">, {badge.label}</span>
                    </>
                  ) : null}
                </button>
              );
            })}
          </div>
          {state.lockedTabs.size ? (
            <span className="sr" id="tools-locked">
              {state.lockedReason}
            </span>
          ) : null}
        </div>
        <div className="pane-host">
          <div className="pane-body" inert={sheetOpen}>
            {children}
          </div>
          {sheet}
        </div>
        <div className="status" inert={sheetOpen}>
          {status}
        </div>
      </main>
    </div>
  );
}

function StatusLine({ kind, text, right, message }: { kind: 'ok' | 'warn' | 'bad' | 'off'; text: string; right?: string | null; message?: string | null }) {
  return (
    <>
      <span className={`dot${kind === 'ok' ? '' : ` dot--${kind}`}`} aria-hidden="true" />
      {/* One live region: what the window just did replaces the standing line for a few seconds. */}
      <span id="hubLine" role="status" aria-live="polite">
        {message ?? text}
      </span>
      <span className="spacer" />
      {right ? <span id="countLine">{right}</span> : null}
    </>
  );
}

/* ------------------------------------------------------------------ sign-in */

function LoginScreen({ onSignedIn, setupComplete }: { onSignedIn: () => void; setupComplete: boolean }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const login = useAction(async (u: string, p: string) => api('authLogin', { body: { username: u, password: p } }));

  const [missing, setMissing] = useState(false);
  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setMissing(!username || !password);
      if (!username || !password) return;
      const result = (await login.run(username, password)) as SessionInfo | null;
      if (result) {
        setCsrfToken(result.csrfToken ?? null);
        passwordJustTyped = result.mustChangePassword ? password : null;
        onSignedIn();
      }
    },
    [login, username, password, onSignedIn],
  );

  return (
    <Window locked="Sign in first." status={<StatusLine kind="off" text="Not signed in" />}>
      <div className="pane">
        <form className="signin" onSubmit={submit} noValidate>
          <fieldset className="group--last">
            <legend>
              <h2 className="legend-h">Sign in</h2>
            </legend>
            <p className="hint">
              {setupComplete ? (
                'Sign in with the admin password to manage this hub.'
              ) : (
                <>
                  First run: sign in with <b>admin</b> / <b>admin</b>. You’ll choose a real password before anything else is switched on.
                </>
              )}
            </p>
            <div className="pref signin__pref">
              <label className="k" htmlFor="signin-user">
                Username:
              </label>
              <div className="v">
                <Field id="signin-user" value={username} autoComplete="username" onChange={(e) => setUsername(e.currentTarget.value)} />
              </div>
              <label className="k" htmlFor="signin-pass">
                Password:
              </label>
              <div className="v">
                {/* The form is the whole pane and exists to be typed into, so the caret starts in it. */}
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <Field id="signin-pass" type="password" value={password} autoComplete="current-password" autoFocus invalid={Boolean(login.error) || missing} onChange={(e) => setPassword(e.currentTarget.value)} />
              </div>
            </div>
            {missing ? <Note bad>Type the username and password first.</Note> : <ActionError error={login.error} />}
          </fieldset>
          <Push type="submit" primary busy={login.busy}>
            Sign In
          </Push>
        </form>
      </div>
    </Window>
  );
}

/* ------------------------------------------------------------------ the first-run gate */

/**
 * The design's amber gate. It asks for the new password twice; the current one is what was just
 * typed at sign-in, and is asked for here only when the page was reloaded in between.
 */
function ChangePasswordScreen({ onDone }: { onDone: () => void }) {
  const remembered = passwordJustTyped;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const change = useAction(async (c: string, n: string) => api('authChangePassword', { body: { currentPassword: c, newPassword: n } }));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const currentPassword = remembered ?? current;
    const why = !currentPassword ? 'Type the current password too.' : next.length < 12 ? 'Use at least 12 characters.' : next !== again ? 'The two don’t match.' : null;
    setProblem(why);
    if (why) return;
    const result = (await change.run(currentPassword, next)) as SessionInfo | null;
    if (result) {
      passwordJustTyped = null;
      setCsrfToken(result.csrfToken ?? null);
      onDone();
    }
  };

  return (
    <div className="gate" role="region" aria-labelledby="gateH">
      <svg className="gate__icon" viewBox="0 0 26 26" aria-hidden="true">
        <path d="M13 2.5 24 22H2z" fill="#f2c14e" stroke="#9a6a08" strokeLinejoin="round" />
        <path d="M13 9v6.5" stroke="#3b2a05" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="13" cy="18.8" r="1.3" fill="#3b2a05" />
      </svg>
      <div className="gate__body">
        <h2 id="gateH">Choose a real password</h2>
        <p>
          You’re signed in as <b>admin / admin</b>. Until you change it, the hub stays on this machine: no pairing, no providers, no group listening, no Discord bot and no remote access. The server enforces this, not
          this page.
        </p>
        <form className="barrow" onSubmit={(event) => void submit(event)} noValidate>
          {remembered ? null : <Field type="password" placeholder="Current password" aria-label="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.currentTarget.value)} />}
          <Field type="password" placeholder="New password" aria-label="New password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.currentTarget.value)} />
          <Field type="password" placeholder="Again" aria-label="New password again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.currentTarget.value)} />
          <Push type="submit" primary busy={change.busy}>
            Set Password
          </Push>
        </form>
        {problem ? <Note bad>{problem}</Note> : <ActionError error={change.error} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ signed in */

function sectionBody(id: ViewId): ReactNode {
  switch (id) {
    case 'overview':
      return <OverviewView />;
    case 'devices':
      return <DevicesView />;
    case 'groups':
      return <GroupsView />;
    case 'providers':
      return <ProvidersView />;
    case 'library':
      return <LibraryView />;
    case 'downloads':
      // The design draws "Live TV from the companion" straight after Downloads, in the same tab. It
      // is part of this section (and its ledger entry) until the coverage ledger gives it its own.
      return (
        <>
          <DownloadsView />
          <LiveTvView />
        </>
      );
    case 'shares':
      return <SharesView />;
    case 'profiles':
      return <ProfilesView />;
    case 'recommendations':
      return <RecommendationsView />;
    case 'discord':
      return <DiscordView />;
    case 'network':
      return <NetworkView />;
    case 'backup':
      return <BackupView />;
    case 'diagnostics':
      return <DiagnosticsView />;
  }
}

const GATED_TABS: ReadonlySet<TabId> = new Set(TABS.filter((t) => t.id !== 'overview').map((t) => t.id));
const NO_TABS: ReadonlySet<TabId> = new Set();
const REACH = { localhost: 'this machine only', lan: 'your network', remote: 'the internet' } as const;

function AdminShell({ session, onSessionChanged }: { session: SessionInfo; onSessionChanged: () => void }) {
  const gated = Boolean(session.mustChangePassword);
  const [storedTab, setStoredTab] = useStoredState<TabId>('np.admin.tab', 'overview', isTabId);
  const [chosen, setTabState] = useState<TabId>(() => tabFromHash() ?? storedTab);
  const tab: TabId = gated ? 'overview' : chosen;
  // A link to `#diagnostics` opens System and brings that section into view.
  const [target, setTarget] = useState<string | null>(() => (hashId() in SECTION_TAB ? hashId() : null));

  const setTab = useCallback(
    (next: TabId) => {
      setTabState(next);
      setStoredTab(next);
      setTarget(null);
      if (window.location.hash && window.location.hash !== `#${next}`) history.replaceState(null, '', window.location.pathname + window.location.search);
    },
    [setStoredTab],
  );
  useEffect(() => {
    const onHash = (): void => {
      const next = tabFromHash();
      if (!next) return;
      setTabState(next);
      setStoredTab(next);
      setTarget(hashId() in SECTION_TAB ? hashId() : null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [setStoredTab]);

  const pane = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = pane.current;
    const node = target ? document.getElementById(target) : null;
    if (!host || !node) return;
    // The sections above it grow as their data arrives, so the target is kept at the top until the
    // pane has settled or the person scrolls for themselves.
    const align = (): void => {
      host.scrollTop = Math.max(0, host.scrollTop + node.getBoundingClientRect().top - host.getBoundingClientRect().top - 12);
      // The browser's own jump to `#section` also scrolls the window's clipped parts, which would
      // push the title bar and tabs out of the frame. Only the pane scrolls.
      for (let el = host.parentElement; el; el = el.parentElement) if (el.scrollTop) el.scrollTop = 0;
    };
    align();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(align);
    for (const child of Array.from(host.children)) observer.observe(child);
    const stop = (): void => {
      observer.disconnect();
      clearTimeout(timer);
      for (const type of ['wheel', 'pointerdown', 'keydown'] as const) host.removeEventListener(type, stop);
    };
    const timer = setTimeout(stop, 3000);
    for (const type of ['wheel', 'pointerdown', 'keydown'] as const) host.addEventListener(type, stop, { passive: true });
    return stop;
  }, [target, tab]);

  const hub = useResource('hubIdentity');
  // The one reading of the overview: the badge, the lamp and the Overview tab's lists all use it.
  const overview = useResource('metricsOverview', {}, { pollMs: OVERVIEW_POLL_MS }) as Resource<OverviewMetrics>;
  const network = useResource('networkGet', {}, { pollMs: 30_000 });

  // The moment the password is set, what the overview says about setup is out of date.
  // Only on that change: at first sight the overview is being read already.
  const reloadOverview = overview.reload;
  const wasGated = useRef(gated);
  useEffect(() => {
    if (wasGated.current && !gated) reloadOverview();
    wasGated.current = gated;
  }, [gated, reloadOverview]);

  const logout = useAction(async () => api('authLogout'));
  const signOut = useCallback(async () => {
    await logout.run();
    passwordJustTyped = null;
    setCsrfToken(null);
    onSessionChanged();
  }, [logout, onSessionChanged]);

  const metrics = overview.data;
  const net = network.data as NetworkConfig | null;
  const identity = hub.data as { name?: string; version?: string } | null;
  const alerts = useMemo(() => metrics?.alerts ?? [], [metrics]);
  const worst: 'ok' | 'warn' | 'bad' = overview.error && !metrics ? 'bad' : alerts.some((a) => a.level === 'error') ? 'bad' : alerts.some((a) => a.level === 'warning') || gated ? 'warn' : 'ok';
  const attention = alerts.length;

  const tools: ToolState = {
    selected: tab,
    onSelect: setTab,
    lockedTabs: gated ? GATED_TABS : NO_TABS,
    lockedReason: 'Choose a real password first.',
    badges: attention ? { overview: { count: attention, label: `${count(attention, 'thing')} ${attention === 1 ? 'needs' : 'need'} attention` } } : {},
  };

  // The status line reads the real bind address and port, never a constant: "Hub running ·
  // 127.0.0.1:4546 · reachable from this machine only". Until the hub has answered it says only
  // what it knows.
  const statusText = overview.error && !metrics ? errorSentence(overview.error) : [`${identity?.name ?? 'Hub'} running`, net ? `${net.bindAddress}:${net.port}` : null, net ? `reachable from ${REACH[net.bindMode]}` : null].filter(Boolean).join(' · ');
  const counts = metrics ? `${metrics.connections.active} connected · ${metrics.groups.filter((g) => g.status === 'playing').length} playing` : null;
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  return (
    <OverviewProvider value={overview}>
    <HubUiProvider gated={gated}>
      {({ message, sheet, sheetOpen }) => (
        <Window tools={tools} sheet={sheet} sheetOpen={sheetOpen} status={<StatusLine kind={worst} text={statusText} right={counts} message={message} />}>
          <div className="pane" ref={pane} key={current.id} id={`pane-${current.id}`} role="tabpanel" aria-labelledby={`tab-${current.id}`}>
            {gated ? <ChangePasswordScreen onDone={onSessionChanged} /> : null}
            {current.lead ? <p className="lead">{current.lead}</p> : null}
            {current.sections.map((section) => (
              <section key={section} id={section} aria-label={SECTION_TITLES[section]}>
                <ViewBoundary resetKey={section}>{sectionBody(section)}</ViewBoundary>
              </section>
            ))}
            {current.id === 'overview' ? (
              <div className="panefoot">
                <p className="note">
                  Signed in as <b>{session.username ?? 'admin'}</b>.
                </p>
                <Push busy={logout.busy} onClick={() => void signOut()}>
                  Sign Out
                </Push>
              </div>
            ) : null}
          </div>
        </Window>
      )}
    </HubUiProvider>
    </OverviewProvider>
  );
}

/**
 * The admin GUI shell.
 *
 * Three states, in order of precedence:
 *
 * 1. **Not signed in** — the login screen, which also explains the first-run credentials rather
 *    than leaving someone guessing.
 * 2. **Signed in but the bootstrap password is still in place** — the password gate, with no way
 *    past it. Nothing else is reachable, mirroring the server's own gate rather than duplicating a
 *    rule the API might not enforce.
 * 3. **Signed in and set up** — the full interface.
 *
 * The window is the one `design/frontends/airwave-hub.html` drew: a title bar and a row of six
 * icon tabs on one chrome sheet, the pane scrolling under it, a status strip at the foot. The
 * thirteen sections the hub had as a source list now live inside those tabs (Overview · Devices ·
 * Music · Groups · Sharing · System); each keeps its own data flow and its own ledger entry, and a
 * link to a section still lands on the right tab. The tab strip is a roving-tabindex group
 * (UX-KEY-001), the same contract the source list honoured.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AquaWindow, BottomBar, Button, Content, Glyph, LoadingState, StatusDot, TextField, Toolbar, ToolTabs, useToast, type GlyphName } from '@now-playing/aqua-ui';
import type { NetworkConfig, OverviewMetrics, SessionInfo } from '@now-playing/contracts';
import { api, setCsrfToken } from './lib/api.js';
import { useAction, useResource, useStoredState } from './lib/hooks.js';
import { ViewBoundary } from './ViewBoundary.js';
import { OverviewView } from './views/Overview.js';
import { DevicesView } from './views/Devices.js';
import { GroupsView } from './views/Groups.js';
import { ProvidersView } from './views/Providers.js';
import { LibraryView } from './views/Library.js';
import { DownloadsView } from './views/Downloads.js';
import { ProfilesView } from './views/Profiles.js';
import { SharesView } from './views/Shares.js';
import { DiscordView } from './views/Discord.js';
import { NetworkView } from './views/Network.js';
import { DiagnosticsView } from './views/Diagnostics.js';
import { BackupView } from './views/Backup.js';
import { RecommendationsView } from './views/Recommendations.js';

/** The sections. Each is a screen in design/coverage.json; the tab it lives in is below. */
export type ViewId = 'overview' | 'devices' | 'groups' | 'profiles' | 'providers' | 'library' | 'downloads' | 'shares' | 'recommendations' | 'discord' | 'network' | 'diagnostics' | 'backup';

export type TabId = 'overview' | 'devices' | 'music' | 'groups' | 'sharing' | 'system';

interface TabSpec {
  id: TabId;
  label: string;
  icon: GlyphName;
  /** In the order they stack down the pane. */
  sections: ViewId[];
}

/**
 * Profiles sit with Devices: a profile is what a paired device's person looks like to other
 * devices, and moderation is a per-device concern. Recommendations sit with Music: they are the
 * hub's defaults for the same engine the player's Settings ▸ Recommendations edits.
 */
const TABS: readonly TabSpec[] = [
  { id: 'overview', label: 'Overview', icon: 'info', sections: ['overview'] },
  { id: 'devices', label: 'Devices', icon: 'device', sections: ['devices', 'profiles'] },
  { id: 'music', label: 'Music', icon: 'note', sections: ['library', 'providers', 'downloads', 'recommendations'] },
  { id: 'groups', label: 'Groups', icon: 'group', sections: ['groups'] },
  { id: 'sharing', label: 'Sharing', icon: 'link', sections: ['shares', 'discord'] },
  { id: 'system', label: 'System', icon: 'gear', sections: ['network', 'backup', 'diagnostics'] },
];

const TAB_IDS: ReadonlySet<string> = new Set(TABS.map((t) => t.id));

const SECTION_TAB: Record<ViewId, TabId> = Object.fromEntries(TABS.flatMap((t) => t.sections.map((s) => [s, t.id]))) as Record<ViewId, TabId>;

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

/** `#system` or `#diagnostics` in the address opens that tab, so a log message can point at one. */
function tabFromHash(): TabId | null {
  return tabFor(window.location.hash.replace(/^#/, ''));
}

export function App() {
  const session = useResource('authSession', {}, { pollMs: 60_000 });
  const info = session.data as SessionInfo | null;

  useEffect(() => {
    setCsrfToken(info?.csrfToken ?? null);
  }, [info?.csrfToken]);

  if (session.initial && session.loading) return <Centred><LoadingState title="Connecting to the hub" /></Centred>;
  if (!info?.authenticated) return <LoginScreen onSignedIn={session.reload} setupComplete={info?.setupComplete ?? false} />;
  if (info.mustChangePassword) return <ChangePasswordScreen onDone={session.reload} />;
  return <AdminShell session={info} onSignedOut={session.reload} />;
}

function Centred({ children }: { children: ReactNode }) {
  // aqua-root is what carries the design system's typography; without it this screen
  // renders in whatever the browser considers a default, which is a serif at 16px.
  return <div className="aqua-root admin-centred">{children}</div>;
}

function LoginScreen({ onSignedIn, setupComplete }: { onSignedIn: () => void; setupComplete: boolean }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const login = useAction(async (u: string, p: string) => api('authLogin', { body: { username: u, password: p } }));

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const result = await login.run(username, password);
      if (result) {
        setCsrfToken((result as SessionInfo).csrfToken ?? null);
        onSignedIn();
      }
    },
    [login, username, password, onSignedIn],
  );

  return (
    <Centred>
      <form className="admin-login" onSubmit={submit}>
        <h1>Now Playing Hub</h1>
        {!setupComplete ? (
          <p className="admin-login__hint">
            First run: sign in with <strong>admin</strong> / <strong>admin</strong>. You will be asked to choose a real password before anything else is enabled.
          </p>
        ) : null}
        <TextField label="Username" value={username} autoComplete="username" onChange={(e) => setUsername(e.currentTarget.value)} />
        <TextField
          label="Password"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.currentTarget.value)}
          {...(login.error ? { validation: { kind: 'error' as const, message: login.error.message } } : {})}
        />
        <Button type="submit" variant="default" busy={login.busy} wide>
          Sign in
        </Button>
      </form>
    </Centred>
  );
}

/**
 * The first-run gate, in the mockup's amber voice. It is still a screen of its own and not a
 * banner over a live interface: the server refuses every gated route until this is done, so a
 * disabled interface behind it would only be a picture of one.
 */
function ChangePasswordScreen({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const change = useAction(async (c: string, n: string) => api('authChangePassword', { body: { currentPassword: c, newPassword: n } }));
  const mismatch = confirm.length > 0 && next !== confirm;

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (mismatch) return;
      const result = await change.run(current, next);
      if (result) {
        setCsrfToken((result as SessionInfo).csrfToken ?? null);
        onDone();
      }
    },
    [change, current, next, mismatch, onDone],
  );

  return (
    <Centred>
      <form className="admin-login admin-login--gate" onSubmit={submit}>
        <div className="admin-gate">
          <Glyph name="warning" className="admin-gate__icon" aria-hidden="true" />
          <div className="admin-gate__body">
            <h1>Choose a password</h1>
            <p className="admin-login__hint">
              You’re signed in as <strong>admin / admin</strong>. Until this is done the hub stays on this machine only: pairing, providers, group listening, the Discord bot and remote access are all
              disabled. The server enforces this, not this page. Use a passphrase of several unrelated words, or a password manager.
            </p>
          </div>
        </div>
        <TextField label="Current password" type="password" value={current} autoComplete="current-password" onChange={(e) => setCurrent(e.currentTarget.value)} />
        <TextField
          label="New password"
          type="password"
          value={next}
          autoComplete="new-password"
          hint="At least 12 characters."
          onChange={(e) => setNext(e.currentTarget.value)}
          {...(change.error ? { validation: { kind: 'error' as const, message: change.error.message } } : {})}
        />
        <TextField
          label="Repeat new password"
          type="password"
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.currentTarget.value)}
          {...(mismatch ? { validation: { kind: 'error' as const, message: 'The two passwords do not match' } } : {})}
        />
        <Button type="submit" variant="default" busy={change.busy} disabled={mismatch || next.length === 0} wide>
          Set password
        </Button>
      </form>
    </Centred>
  );
}

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
      return <DownloadsView />;
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

function AdminShell({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const [storedTab, setStoredTab] = useStoredState<TabId>('np.admin.tab', 'overview', isTabId);
  const [tab, setTabState] = useState<TabId>(() => tabFromHash() ?? storedTab);
  const setTab = useCallback(
    (next: TabId) => {
      setTabState(next);
      setStoredTab(next);
      if (window.location.hash && window.location.hash !== `#${next}`) history.replaceState(null, '', window.location.pathname + window.location.search);
    },
    [setStoredTab],
  );
  useEffect(() => {
    const onHash = () => {
      const next = tabFromHash();
      if (next) setTab(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [setTab]);

  const toast = useToast();
  const hub = useResource('hubIdentity');
  const overview = useResource('metricsOverview', {}, { pollMs: 10_000 });
  const network = useResource('networkGet', {}, { pollMs: 30_000 });

  const logout = useAction(async () => api('authLogout'));
  const signOut = useCallback(async () => {
    await logout.run();
    setCsrfToken(null);
    onSignedOut();
  }, [logout, onSignedOut]);

  const metrics = overview.data as OverviewMetrics | null;
  const alerts = metrics?.alerts ?? [];
  const worst = alerts.some((a) => a.level === 'error') ? 'error' : alerts.some((a) => a.level === 'warning') ? 'warning' : 'ok';
  const tabItems = useMemo(
    () => TABS.map((t) => (t.id === 'overview' && alerts.length ? { id: t.id, label: t.label, icon: t.icon, badge: alerts.length, badgeLabel: `${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}` } : { id: t.id, label: t.label, icon: t.icon })),
    [alerts.length],
  );

  const identity = hub.data as { name?: string; version?: string; fingerprint?: string } | null;
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;
  const net = network.data as NetworkConfig | null;

  // The status line reads the real bind and port, never a constant: "Hub running · 0.0.0.0:4546 ·
  // reachable from your network". Until the network config has answered it says only what it knows.
  const reach = { localhost: 'this machine only', lan: 'your network', remote: 'the internet' } as const;
  const statusLine = [
    `${identity?.name ?? 'Hub'} ${identity?.version ?? ''}`.trim(),
    net ? `${net.bindAddress}:${net.port}` : null,
    net ? `reachable from ${reach[net.bindMode]}` : null,
    `signed in as ${session.username ?? 'admin'}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const counts = metrics
    ? `${metrics.connections.active} connected · ${metrics.groups.filter((g) => g.status === 'playing').length} playing`
    : null;

  return (
    <AquaWindow active title={identity?.name ?? 'Now Playing Hub'} flush className="admin-window">
      <div className="admin-chrome">
        <Toolbar
          display={<div className="admin-toolbar__title">{identity?.name ?? 'Now Playing Hub'}</div>}
          secondary={
            <>
              <Button
                size="small"
                icon="refresh"
                onClick={() => {
                  overview.reload();
                  network.reload();
                  toast.show('Refreshed');
                }}
              >
                Refresh
              </Button>
              <Button size="small" icon="lock" busy={logout.busy} onClick={() => void signOut()}>
                Sign out
              </Button>
            </>
          }
        />
        <ToolTabs tabs={tabItems} value={tab} onChange={setTab} label="Sections" idPrefix="admin" />
      </div>
      <Content className="admin-pane" id={`admin-pane-${current.id}`} role="tabpanel" aria-labelledby={`admin-tab-${current.id}`}>
        {current.sections.map((section) => (
          <section key={section} className="admin-section" id={section} aria-label={SECTION_TITLES[section]}>
            <ViewBoundary resetKey={section}>{sectionBody(section)}</ViewBoundary>
          </section>
        ))}
      </Content>
      <BottomBar
        left={<StatusDot kind={worst === 'ok' ? 'ok' : worst} label={worst === 'ok' ? 'Healthy' : `${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}`} />}
        status={statusLine}
        right={
          <>
            {counts ? <span className="admin-counts">{counts}</span> : null}
            {identity?.fingerprint ? (
              <span className="admin-fingerprint" title="Compare this with the fingerprint a device shows while pairing">
                {identity.fingerprint}
              </span>
            ) : null}
          </>
        }
      />
    </AquaWindow>
  );
}

/** What each section is called when a tab stacks several. The views keep their own panel titles;
 * these are the landmarks a screen reader lists. */
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

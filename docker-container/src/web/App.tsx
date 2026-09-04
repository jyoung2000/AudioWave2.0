/**
 * The admin GUI shell.
 *
 * Three states, in order of precedence:
 *
 * 1. **Not signed in** — the login screen, which also explains the first-run credentials rather
 *    than leaving someone guessing.
 * 2. **Signed in but the bootstrap password is still in place** — the password screen, with no way
 *    past it. Nothing else is reachable, mirroring the server's own gate rather than duplicating a
 *    rule the API might not enforce.
 * 3. **Signed in and set up** — the full interface.
 *
 * Aqua's window model is used as intended: one window, a persistent source list, a toolbar, and a
 * bottom status bar (docs/design/APPLE_AQUA_2009_2010_UI_DESIGN_SPEC.md §§9.3–9.6).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AquaWindow, BottomBar, Button, Content, Glyph, LoadingState, SourceList, StatusDot, TextField, Toolbar, WorkArea, useToast, type SourceGroup } from '@now-playing/aqua-ui';
import type { SessionInfo } from '@now-playing/contracts';
import { api, setCsrfToken } from './lib/api.js';
import { useAction, useResource, useStoredState } from './lib/hooks.js';
import { ViewBoundary } from './ViewBoundary.js';
import { OverviewView } from './views/Overview.js';
import { DevicesView } from './views/Devices.js';
import { GroupsView } from './views/Groups.js';
import { ProvidersView } from './views/Providers.js';
import { LibraryView } from './views/Library.js';
import { DownloadsView } from './views/Downloads.js';
import { SharesView } from './views/Shares.js';
import { DiscordView } from './views/Discord.js';
import { NetworkView } from './views/Network.js';
import { DiagnosticsView } from './views/Diagnostics.js';
import { BackupView } from './views/Backup.js';
import { RecommendationsView } from './views/Recommendations.js';

export type ViewId = 'overview' | 'devices' | 'groups' | 'providers' | 'library' | 'downloads' | 'shares' | 'recommendations' | 'discord' | 'network' | 'diagnostics' | 'backup';

const SOURCE_GROUPS: SourceGroup<ViewId>[] = [
  {
    id: 'status',
    label: 'Hub',
    items: [
      { id: 'overview', label: 'Overview', icon: <Glyph name="info" /> },
      { id: 'devices', label: 'Devices', icon: <Glyph name="device" /> },
      { id: 'groups', label: 'Groups', icon: <Glyph name="group" /> },
    ],
  },
  {
    id: 'music',
    label: 'Music',
    items: [
      { id: 'library', label: 'Library', icon: <Glyph name="note" /> },
      { id: 'providers', label: 'Providers', icon: <Glyph name="cloud" /> },
      { id: 'downloads', label: 'Downloads', icon: <Glyph name="download" /> },
      { id: 'shares', label: 'Shared links', icon: <Glyph name="link" /> },
      { id: 'recommendations', label: 'Recommendations', icon: <Glyph name="star" /> },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    items: [{ id: 'discord', label: 'Discord', icon: <Glyph name="share" /> }],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'network', label: 'Network', icon: <Glyph name="reconnect" /> },
      { id: 'backup', label: 'Backup', icon: <Glyph name="folder" /> },
      { id: 'diagnostics', label: 'Diagnostics', icon: <Glyph name="gear" /> },
    ],
  },
];

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

function Centred({ children }: { children: React.ReactNode }) {
  return <div className="admin-centred">{children}</div>;
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
      <form className="admin-login" onSubmit={submit}>
        <h1>Choose a password</h1>
        <p className="admin-login__hint">
          Until this is done the hub stays on this machine only: pairing, providers, group listening, the Discord bot and remote access are all disabled. Use a passphrase of several unrelated words, or a
          password manager.
        </p>
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

function AdminShell({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const [view, setView] = useStoredState<ViewId>('np.admin.view', 'overview');
  const [sidebarWidth, setSidebarWidth] = useStoredState<number>('np.admin.sidebar', 200);
  const toast = useToast();
  const hub = useResource('hubIdentity');
  const overview = useResource('metricsOverview', {}, { pollMs: 10_000 });

  const logout = useAction(async () => api('authLogout'));
  const signOut = useCallback(async () => {
    await logout.run();
    setCsrfToken(null);
    onSignedOut();
  }, [logout, onSignedOut]);

  const alerts = (overview.data as { alerts?: Array<{ level: string; message: string }> } | null)?.alerts ?? [];
  const worst = alerts.some((a) => a.level === 'error') ? 'error' : alerts.some((a) => a.level === 'warning') ? 'warning' : 'ok';

  const groups = useMemo<SourceGroup<ViewId>[]>(
    () =>
      SOURCE_GROUPS.map((group) => ({
        ...group,
        items: group.items.map((item) => (item.id === 'overview' && alerts.length ? { ...item, count: alerts.length } : item)),
      })),
    [alerts.length],
  );

  const body = (() => {
    switch (view) {
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
      default:
        return null;
    }
  })();

  const identity = hub.data as { name?: string; version?: string; fingerprint?: string } | null;
  const currentName = groups.flatMap((g) => g.items).find((i) => i.id === view)?.label ?? 'Hub';

  return (
    <AquaWindow active title={identity?.name ?? 'Now Playing Hub'} flush>
      <Toolbar
        display={<div className="admin-toolbar__title">{identity?.name ?? 'Now Playing Hub'}</div>}
        secondary={
          <>
            <Button
              size="small"
              icon="refresh"
              onClick={() => {
                overview.reload();
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
      <WorkArea
        sidebar={<SourceList groups={groups} selectedId={view} onSelect={setView} label="Sections" dimUnfocused />}
        currentSourceName={currentName}
        sidebarWidth={sidebarWidth}
        onSidebarWidthChange={setSidebarWidth}
      >
        <Content>
          <ViewBoundary resetKey={view}>{body}</ViewBoundary>
        </Content>
      </WorkArea>
      <BottomBar
        left={<StatusDot kind={worst === 'ok' ? 'ok' : worst} label={worst === 'ok' ? 'Healthy' : `${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}`} />}
        status={`${identity?.name ?? 'Hub'} ${identity?.version ?? ''} · signed in as ${session.username ?? 'admin'}`}
        right={identity?.fingerprint ? <span className="admin-fingerprint" title="Compare this with the fingerprint a device shows while pairing">{identity.fingerprint}</span> : null}
      />
    </AquaWindow>
  );
}

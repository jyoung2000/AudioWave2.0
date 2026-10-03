/**
 * The Discord bot.
 *
 * The design's preference pane: status, token, allowlist, prefix, roles, the group it controls, and
 * Save and Start. Two things trip people up and the pane says both: the token is checked with
 * Discord before it is stored (a typo fails here, not silently at 3am), and prefix commands need
 * the Message Content intent that only the operator can switch on in Discord's Developer Portal.
 * Nothing is sent while typing; Save and Start sends the lot.
 */
import { useState } from 'react';
import type { DiscordConfiguration, DiscordStatus, GroupView } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, Check, errorSentence, Field, Group, Note, Pop, Push, Sdot, useHubUi, type DotKind } from '../ui.js';

interface Draft {
  token?: string;
  guildAllowlist?: string;
  prefix?: string;
  prefixEnabled?: boolean;
  djRoleIds?: string;
  adminRoleIds?: string;
  defaultGroupId?: string;
  autoPostNowPlaying?: boolean;
  updateInsteadOfSpam?: boolean;
}

const ids = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

function statusLine(s: DiscordStatus, groupName: string | null): { dot: DotKind; text: string } {
  if (!s.configured) return { dot: 'off', text: 'Not running. Paste a token and start it.' };
  if (s.gateway === 'connected') return { dot: 'ok', text: `Online${groupName ? ` · controls “${groupName}”` : ''}${s.currentTrackTitle ? ` · playing ${s.currentTrackTitle}` : ''}` };
  if (s.gateway === 'connecting' || s.gateway === 'reconnecting') return { dot: 'busy', text: 'Connecting to Discord…' };
  if (s.gateway === 'error') return { dot: 'bad', text: s.lastError ? `Stopped by a problem: ${s.lastError}` : 'Stopped by a problem. Start it again.' };
  return { dot: 'off', text: s.enabled ? 'Has a token, not running. Start it.' : 'Has a token, switched off.' };
}

export function DiscordView() {
  const config = useResource('discordConfigGet');
  const status = useResource('discordStatus', {}, { pollMs: 5_000 });
  const invite = useResource('discordInviteUrl');
  const groups = useResource('groupsList');
  const { say, confirm } = useHubUi();

  const [draft, setDraft] = useState<Draft>({});
  const [problem, setProblem] = useState<string | null>(null);
  const setTokenAction = useAction(async (value: string) => api('discordTokenSet', { body: { token: value } }));
  const clearToken = useAction(async () => api('discordTokenClear'));
  const update = useAction(async (patch: Partial<DiscordConfiguration>) => api('discordConfigPut', { body: patch }));
  const act = useAction(async (action: 'start' | 'stop' | 'reconnect' | 'register-commands') => api('discordAction', { params: { action } }));

  const c = config.data as DiscordConfiguration | null;
  const live = status.data as DiscordStatus | null;
  const groupList = ((groups.data as { items: GroupView[] } | null)?.items ?? []).filter((g) => g.status === 'active');
  const inviteData = invite.data as { url: string | null; permissions: string; reason: string | null } | null;
  const reloadAll = (): void => {
    config.reload();
    status.reload();
    invite.reload();
  };

  const value = {
    token: draft.token ?? '',
    guildAllowlist: draft.guildAllowlist ?? c?.guildAllowlist.join(', ') ?? '',
    prefix: draft.prefix ?? c?.prefix ?? '!',
    prefixEnabled: draft.prefixEnabled ?? c?.prefixEnabled ?? true,
    djRoleIds: draft.djRoleIds ?? c?.djRoleIds.join(', ') ?? '',
    adminRoleIds: draft.adminRoleIds ?? c?.adminRoleIds.join(', ') ?? '',
    defaultGroupId: draft.defaultGroupId ?? c?.defaultGroupId ?? '',
    autoPostNowPlaying: draft.autoPostNowPlaying ?? c?.autoPostNowPlaying ?? true,
    updateInsteadOfSpam: draft.updateInsteadOfSpam ?? c?.updateInsteadOfSpam ?? true,
  };
  const edit = (patch: Draft): void => setDraft((d) => ({ ...d, ...patch }));
  const busy = setTokenAction.busy || update.busy || act.busy;
  const hasToken = Boolean(live?.configured);

  const saveAndStart = async (): Promise<void> => {
    setProblem(null);
    const token = value.token.trim();
    if (!hasToken && token.length < 20) {
      setProblem('That doesn’t look like a bot token. Copy it from the Bot tab of Discord’s Developer Portal.');
      return;
    }
    if (ids(value.guildAllowlist).some((id) => !/^\d{5,25}$/.test(id))) {
      setProblem('Server IDs are numbers. Right-click a server in Discord and choose Copy Server ID.');
      return;
    }
    if (!value.prefix.trim() || value.prefix.trim().length > 3) {
      setProblem('Use a prefix of one to three characters.');
      return;
    }
    if (token) {
      const result = (await setTokenAction.run(token)) as { valid: boolean; message: string } | null;
      if (!result) return;
      if (!result.valid) {
        setProblem(result.message);
        return;
      }
    }
    const saved = await update.run({
      enabled: true,
      guildAllowlist: ids(value.guildAllowlist),
      prefix: value.prefix.trim(),
      prefixEnabled: value.prefixEnabled,
      djRoleIds: ids(value.djRoleIds),
      adminRoleIds: ids(value.adminRoleIds),
      defaultGroupId: value.defaultGroupId || null,
      autoPostNowPlaying: value.autoPostNowPlaying,
      updateInsteadOfSpam: value.updateInsteadOfSpam,
    });
    if (!saved) return;
    setDraft({});
    const started = await act.run('start');
    reloadAll();
    if (started) say('Saved. The Discord bot is starting.');
  };

  const run = (action: 'stop' | 'reconnect' | 'register-commands', done: string): void =>
    void act.run(action).then((r) => {
      reloadAll();
      if (r) say(done);
    });

  const line = live ? statusLine(live, groupList.find((g) => g.id === c?.defaultGroupId)?.name ?? null) : null;

  return (
    <Group title="Discord bot" hint="Plays the group’s queue in a voice channel and takes commands. Its token is checked with Discord before it is stored." last>
      {!c ? (
        <Note bad={Boolean(config.error)}>{config.error ? errorSentence(config.error) : 'Loading…'}</Note>
      ) : (
        <>
          <div className="pref">
            <span className="k">Status:</span>
            <div className="v" role="status">
              {line ? (
                <>
                  <Sdot kind={line.dot} inline />
                  <span>{line.text}</span>
                </>
              ) : (
                <span className="sub">{status.error ? errorSentence(status.error) : 'Loading…'}</span>
              )}
              {live?.configured ? (
                <span className="sub">
                  {live.commandsRegistered ? 'Slash commands are registered.' : 'Slash commands are not registered yet.'}
                </span>
              ) : null}
              {/* The hub words its warnings as sentences that name the control to use; shown as they come. */}
              {(live?.warnings ?? []).map((w, i) => (
                <span className="sub" key={i}>
                  {w}
                </span>
              ))}
            </div>
            <label className="k" htmlFor="botToken">
              Bot token:
            </label>
            <div className="v">
              <Field id="botToken" type="password" placeholder={c.tokenLast4 ? `Stored, ending ${c.tokenLast4}. Paste a new one to replace it` : 'Paste the token'} value={value.token} onChange={(e) => edit({ token: e.currentTarget.value })} />
              <span className="sub">
                {c.tokenSource === 'env' ? 'Set in the container’s environment. ' : ''}The bot token from the Developer Portal’s Bot tab, not the client secret. Encrypted at rest with the installation key.
              </span>
            </div>
            <label className="k" htmlFor="botGuilds">
              Server allowlist:
            </label>
            <div className="v">
              <Field id="botGuilds" mono placeholder="Answers in every server it’s invited to" value={value.guildAllowlist} onChange={(e) => edit({ guildAllowlist: e.currentTarget.value })} />
              <span className="sub">Server IDs, separated by commas. With a list, slash commands appear in those servers at once.</span>
            </div>
            <label className="k" htmlFor="botPrefix">
              Prefix:
            </label>
            <div className="v">
              <Field id="botPrefix" className="num field--left" maxLength={3} value={value.prefix} onChange={(e) => edit({ prefix: e.currentTarget.value })} />
              <Check checked={value.prefixEnabled} onChange={(on) => edit({ prefixEnabled: on })}>
                Also take prefix commands
              </Check>
            </div>
            <label className="k" htmlFor="botDj">
              DJ role IDs:
            </label>
            <div className="v">
              <Field id="botDj" mono placeholder="Anyone may queue" value={value.djRoleIds} onChange={(e) => edit({ djRoleIds: e.currentTarget.value })} />
              <span className="sub">These roles may skip, pause, clear and shuffle.</span>
            </div>
            <label className="k" htmlFor="botAdmin">
              Admin role IDs:
            </label>
            <div className="v">
              <Field id="botAdmin" mono placeholder="Server administrators only" value={value.adminRoleIds} onChange={(e) => edit({ adminRoleIds: e.currentTarget.value })} />
            </div>
            <label className="k" htmlFor="botGroup">
              Group it controls:
            </label>
            <div className="v">
              <Pop id="botGroup" value={value.defaultGroupId} onChange={(e) => edit({ defaultGroupId: e.currentTarget.value })}>
                <option value="">{groupList.length ? 'Choose a group…' : 'No groups yet'}</option>
                {groupList.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Pop>
            </div>
            <span className="k top">Messages:</span>
            <div className="v stack">
              <Check checked={value.autoPostNowPlaying} onChange={(on) => edit({ autoPostNowPlaying: on })}>
                Post what is playing
              </Check>
              <Check checked={value.updateInsteadOfSpam} onChange={(on) => edit({ updateInsteadOfSpam: on })}>
                Edit the last message instead of posting a new one
              </Check>
            </div>
            <span className="k" />
            <div className="v">
              <Push primary busy={busy} onClick={() => void saveAndStart()}>
                Save and Start
              </Push>
              {inviteData?.url ? (
                <a className="push push--link" href={inviteData.url} target="_blank" rel="noreferrer noopener" title={`Asks only for: ${inviteData.permissions}`}>
                  Invite the Bot…
                </a>
              ) : (
                <Push disabled reason={inviteData?.reason ?? 'Save a token first.'}>
                  Invite the Bot…
                </Push>
              )}
              {Object.keys(draft).length ? (
                <Push
                  onClick={() => {
                    setDraft({});
                    setProblem(null);
                  }}
                >
                  Revert
                </Push>
              ) : null}
            </div>
            {hasToken ? (
              <>
                <span className="k" />
                <div className="v">
                  <Push busy={act.busy} onClick={() => run('stop', 'The Discord bot is stopping.')}>
                    Stop
                  </Push>
                  <Push busy={act.busy} onClick={() => run('reconnect', 'The Discord bot is reconnecting.')}>
                    Reconnect
                  </Push>
                  <Push busy={act.busy} onClick={() => run('register-commands', 'Registered the slash commands.')}>
                    Register Commands
                  </Push>
                  {c.tokenSource === 'encrypted' ? (
                    <Push
                      busy={clearToken.busy}
                      onClick={() =>
                        void confirm({ title: 'Remove the bot token?', text: 'The bot stops and stays off until a token is pasted again.', verb: 'Remove Token' }).then((go) => {
                          if (go)
                            void clearToken.run().then(() => {
                              reloadAll();
                              say('Removed the token. The bot is off.');
                            });
                        })
                      }
                    >
                      Remove Token…
                    </Push>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
          {problem ? <Note bad>{problem}</Note> : <ActionError error={setTokenAction.error ?? update.error ?? act.error ?? clearToken.error} />}
        </>
      )}
    </Group>
  );
}

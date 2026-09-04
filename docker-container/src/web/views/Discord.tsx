/**
 * The Discord bot.
 *
 * This screen is deliberately explicit about the two things that trip people up: the token is
 * validated with Discord *before* it is stored (so a typo fails here, not silently at 3am), and
 * prefix commands need the Message Content intent that only the operator can enable in Discord's
 * Developer Portal. The status panel says which of those is missing rather than showing a
 * green light and doing nothing.
 */
import { useState } from 'react';
import { Button, Checkbox, KeyValueList, Panel, PanelSection, PopUpMenu, StatusDot, TextField, useToast } from '@now-playing/aqua-ui';
import type { DiscordConfiguration, DiscordStatus, GroupView } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { AsyncPanel, InlineError } from './common.js';

export function DiscordView() {
  const config = useResource('discordConfigGet');
  const status = useResource('discordStatus', {}, { pollMs: 5_000 });
  const invite = useResource('discordInviteUrl');
  const groups = useResource('groupsList');
  const toast = useToast();

  const [token, setToken] = useState('');
  const setTokenAction = useAction(async (value: string) => api('discordTokenSet', { body: { token: value } }));
  const clearToken = useAction(async () => api('discordTokenClear'));
  const update = useAction(async (patch: Partial<DiscordConfiguration>) => api('discordConfigPut', { body: patch }));
  const act = useAction(async (action: 'start' | 'stop' | 'reconnect' | 'test' | 'register-commands') => api('discordAction', { params: { action } }));

  const current = config.data as DiscordConfiguration | null;
  const live = status.data as DiscordStatus | null;
  const groupOptions = ((groups.data as { items: GroupView[] } | null)?.items ?? []).map((g) => ({ value: g.id, label: g.name }));

  return (
    <>
      <AsyncPanel resource={status} title="Bot status">
        {(raw) => {
          const s = raw as DiscordStatus;
          return (
            <>
              <KeyValueList
                items={[
                  { key: 'Token', value: <StatusDot kind={s.configured ? 'ok' : 'warning'} label={s.configured ? 'installed' : 'not installed'} /> },
                  { key: 'Gateway', value: <StatusDot kind={s.gateway === 'connected' ? 'ok' : s.gateway === 'error' ? 'error' : 'neutral'} label={s.gateway} /> },
                  { key: 'Voice', value: s.voice },
                  { key: 'Slash commands', value: s.commandsRegistered ? `registered${s.commandsRegisteredAt ? ` ${new Date(s.commandsRegisteredAt).toLocaleString()}` : ''}` : 'not registered' },
                  { key: 'Message Content intent', value: s.messageContentIntent },
                  { key: 'Latency', value: s.latencyMs === null ? '—' : `${Math.round(s.latencyMs)} ms` },
                  { key: 'Reconnects', value: s.reconnects },
                  ...(s.lastError ? [{ key: 'Last error', value: s.lastError }] : []),
                ]}
              />
              {s.warnings.length ? (
                <ul className="admin-alerts">
                  {s.warnings.map((w, i) => (
                    <li key={i} data-level="warning">
                      {w}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="admin-actions">
                {(['start', 'stop', 'reconnect', 'register-commands'] as const).map((action) => (
                  <Button
                    key={action}
                    size="small"
                    busy={act.busy}
                    onClick={() =>
                      void act.run(action).then((r) => {
                        if (r) {
                          status.reload();
                          toast.show(`Discord: ${action.replace('-', ' ')}`);
                        }
                      })
                    }
                  >
                    {action === 'register-commands' ? 'Register slash commands' : action[0]!.toUpperCase() + action.slice(1)}
                  </Button>
                ))}
              </div>
              <InlineError error={act.error} />
            </>
          );
        }}
      </AsyncPanel>

      <Panel title="Token">
        <PanelSection>
          <p className="admin-hint">
            From the Discord Developer Portal, Bot tab: the <em>bot token</em>, not the client secret. It is checked against Discord before being stored, then encrypted at rest with this hub's installation
            key and never shown again.
          </p>
          <div className="admin-form">
            <TextField label="Bot token" type="password" value={token} onChange={(e) => setToken(e.currentTarget.value)} autoComplete="off" hint={current?.tokenLast4 ? `A token ending ${current.tokenLast4} is installed.` : undefined} />
            <div className="admin-actions">
              <Button
                variant="default"
                busy={setTokenAction.busy}
                disabled={token.trim().length < 20}
                onClick={() =>
                  void setTokenAction.run(token.trim()).then((r) => {
                    if (r) {
                      const result = r as { valid: boolean; message: string };
                      toast.show(result.message, { kind: result.valid ? 'success' : 'error' });
                      if (result.valid) {
                        setToken('');
                        config.reload();
                        status.reload();
                        invite.reload();
                      }
                    }
                  })
                }
              >
                Save token
              </Button>
              {current?.tokenSource === 'encrypted' ? (
                <Button
                  variant="destructive"
                  busy={clearToken.busy}
                  onClick={() =>
                    void clearToken.run().then(() => {
                      config.reload();
                      status.reload();
                      toast.show('Token removed; the bot is disabled.');
                    })
                  }
                >
                  Remove token
                </Button>
              ) : null}
            </div>
            <InlineError error={setTokenAction.error} />
          </div>
        </PanelSection>

        <PanelSection title="Invite the bot">
          {(() => {
            const data = invite.data as { url: string | null; permissions: string; reason: string | null } | null;
            if (!data) return null;
            if (!data.url) return <p className="admin-hint admin-hint--warning">{data.reason}</p>;
            return (
              <>
                <p className="admin-hint">The link requests only what the bot needs: {data.permissions}.</p>
                <p>
                  <a href={data.url} target="_blank" rel="noreferrer noopener">
                    Open the invite link
                  </a>
                </p>
              </>
            );
          })()}
        </PanelSection>
      </Panel>

      <AsyncPanel resource={config} title="Configuration">
        {(raw) => {
          const c = raw as DiscordConfiguration;
          const patch = (body: Partial<DiscordConfiguration>) =>
            void update.run(body).then((r) => {
              if (r) {
                config.reload();
                status.reload();
              }
            });
          return (
            <div className="admin-form">
              <Checkbox checked={c.enabled} onChange={(e) => patch({ enabled: e.currentTarget.checked })}>
                Enable the bot
              </Checkbox>
              <PopUpMenu
                label="Group the bot controls"
                value={c.defaultGroupId ?? ''}
                onChange={(e) => patch({ defaultGroupId: e.currentTarget.value || null })}
                options={[{ value: '', label: 'Choose a group…' }, ...groupOptions]}
              />
              <Checkbox checked={c.prefixEnabled} onChange={(e) => patch({ prefixEnabled: e.currentTarget.checked })}>
                Also accept prefix commands (needs the Message Content intent)
              </Checkbox>
              <TextField label="Prefix" value={c.prefix} maxLength={3} onChange={(e) => patch({ prefix: e.currentTarget.value })} />
              <TextField
                label="Guild allowlist"
                value={c.guildAllowlist.join(', ')}
                placeholder="Leave empty to answer in every server it is invited to"
                onChange={(e) => patch({ guildAllowlist: e.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                hint="Server IDs, comma separated. Slash commands register per guild when this is set, so they appear immediately."
              />
              <TextField
                label="DJ role IDs"
                value={c.djRoleIds.join(', ')}
                onChange={(e) => patch({ djRoleIds: e.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                hint="These roles may skip, pause, clear and shuffle."
              />
              <TextField
                label="Admin role IDs"
                value={c.adminRoleIds.join(', ')}
                onChange={(e) => patch({ adminRoleIds: e.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              />
              <Checkbox checked={c.autoPostNowPlaying} onChange={(e) => patch({ autoPostNowPlaying: e.currentTarget.checked })}>
                Post what is playing
              </Checkbox>
              <Checkbox checked={c.updateInsteadOfSpam} onChange={(e) => patch({ updateInsteadOfSpam: e.currentTarget.checked })}>
                Edit the previous message instead of posting a new one
              </Checkbox>
              <InlineError error={update.error} />
              {live && !live.configured ? <p className="admin-hint admin-hint--warning">The bot cannot start until a token is installed above.</p> : null}
            </div>
          );
        }}
      </AsyncPanel>
    </>
  );
}

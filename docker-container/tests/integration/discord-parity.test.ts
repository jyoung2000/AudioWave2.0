/**
 * Slash and prefix commands must behave identically.
 *
 * This is not asserted by inspecting the two code paths; it is asserted by running every command
 * through both transports and comparing the outcome, because "identical by construction" is only
 * worth claiming if something checks it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DISCORD_TEMPLATE_KEYS } from '@now-playing/contracts';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
let groupId: string;

const COMMANDS = ['nowplaying', 'queue', 'skip', 'pause', 'resume', 'stop', 'shuffle', 'clear', 'join', 'leave', 'settings'] as const;

async function run(command: string, transport: 'slash' | 'prefix', options: { channelId?: string; roleIds?: string[]; args?: string } = {}) {
  const response = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/discord/commands/test',
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    payload: { command, args: options.args ?? '', guildId: '111', channelId: options.channelId ?? '222', userId: '333', roleIds: options.roleIds ?? [], transport },
  });
  return response;
}

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
  const device = await pairDevice(hub, admin);
  const group = await hub.app.inject({ method: 'POST', url: '/api/v1/groups', headers: { authorization: device.authorization }, payload: { name: 'Discord group' } });
  groupId = (group.json() as { id: string }).id;
  await hub.app.inject({
    method: 'PUT',
    url: '/api/v1/discord/config',
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    payload: { defaultGroupId: groupId, prefixEnabled: true, designatedChannels: { '111': '222' }, djRoleIds: ['dj-role'], adminRoleIds: ['admin-role'] },
  });
});

afterEach(async () => {
  await hub.dispose();
});

describe('slash and prefix parity', () => {
  it('produces identical outcomes for every command', async () => {
    for (const command of COMMANDS) {
      const slash = await run(command, 'slash');
      const prefix = await run(command, 'prefix');
      expect(slash.statusCode, command).toBe(prefix.statusCode);
      expect(slash.json(), `${command} must behave the same on both transports`).toEqual(prefix.json());
    }
  });

  it('applies the same permission decision on both transports', async () => {
    // `clear` and `stop` are DJ-only, so the role visibly changes the outcome — without that the
    // parity assertion would pass vacuously on two identical refusals.
    for (const command of ['clear', 'stop'] as const) {
      const asGuest = await Promise.all([run(command, 'slash'), run(command, 'prefix')]);
      expect(asGuest[0].json(), command).toEqual(asGuest[1].json());
      expect(asGuest[0].json(), command).toMatchObject({ ok: false, templateKey: 'permissionDenied' });

      const asDj = await Promise.all([run(command, 'slash', { roleIds: ['dj-role'] }), run(command, 'prefix', { roleIds: ['dj-role'] })]);
      expect(asDj[0].json(), command).toEqual(asDj[1].json());
      expect(asDj[0].json(), command).toMatchObject({ ok: true });
    }
  });

  it('applies the designated-channel rule identically', async () => {
    const wrong = await Promise.all([run('queue', 'slash', { channelId: '999' }), run('queue', 'prefix', { channelId: '999' })]);
    expect(wrong[0].json()).toEqual(wrong[1].json());
    expect(wrong[0].json()).toMatchObject({ templateKey: 'wrongChannel', ok: false });
  });

  it('rejects an unknown command the same way on both transports', async () => {
    const responses = await Promise.all([run('selfdestruct', 'slash'), run('selfdestruct', 'prefix')]);
    expect(responses[0].statusCode).toBe(400);
    // Everything but the per-request correlation id must match.
    const strip = (body: Record<string, unknown>): Record<string, unknown> => {
      const { correlationId: _c, ...rest } = body;
      return rest;
    };
    expect(strip(responses[0].json() as Record<string, unknown>)).toEqual(strip(responses[1].json() as Record<string, unknown>));
  });

  it('resolves the same aliases on both transports', async () => {
    const canonical = await run('nowplaying', 'slash');
    for (const alias of ['np', 'now']) {
      expect((await run(alias, 'slash')).json(), alias).toEqual(canonical.json());
      expect((await run(alias, 'prefix')).json(), alias).toEqual(canonical.json());
    }
  });
});

describe('templates', () => {
  it('ships a default for every template key', async () => {
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/discord/templates', headers: { cookie: admin.cookie } });
    const templates = (response.json() as { templates: Record<string, unknown> }).templates;
    for (const key of DISCORD_TEMPLATE_KEYS) expect(templates[key], `missing default template for ${key}`).toBeDefined();
  });

  it('refuses a template with an unknown variable, naming it', async () => {
    const current = await hub.app.inject({ method: 'GET', url: '/api/v1/discord/templates', headers: { cookie: admin.cookie } });
    const templates = current.json() as { templates: Record<string, unknown>; schemaVersion: number; allowedMentionRoleIds: string[]; allowEveryone: boolean };
    const response = await hub.app.inject({
      method: 'PUT',
      url: '/api/v1/discord/templates',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { ...templates, templates: { ...templates.templates, queued: { content: 'Added {{nonsense}}', embedTitle: null, embedDescription: null, color: null, ephemeral: false } } },
    });
    expect(response.statusCode).toBe(400);
    expect(String((response.json() as { detail: string }).detail)).toContain('nonsense');
  });

  it('never lets a template mention @everyone unless the operator allowed it', async () => {
    const preview = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/discord/templates/preview',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { key: 'queued', template: { content: 'Hey @everyone, {{title}} is queued', embedTitle: null, embedDescription: null, color: null, ephemeral: false } },
    });
    expect(preview.statusCode).toBe(200);
    const rendered = preview.json() as { content: string };
    expect(rendered.content).not.toContain('@everyone');
    expect(rendered.content).toContain('Blue Monday');
  });

  it('escapes a mention injected through a variable', async () => {
    const preview = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/discord/templates/preview',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { key: 'queued', template: { content: '{{title}} added', embedTitle: null, embedDescription: null, color: null, ephemeral: false }, sample: { title: '@everyone gotcha' } },
    });
    expect((preview.json() as { content: string }).content).not.toContain('@everyone');
  });
});

describe('bot status honesty', () => {
  it('reports what is missing rather than pretending to be ready', async () => {
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/discord/status', headers: { cookie: admin.cookie } });
    const status = response.json() as { configured: boolean; gateway: string; warnings: string[] };
    expect(status.configured).toBe(false);
    expect(status.gateway).toBe('stopped');
    expect(status.warnings.join(' ')).toContain('No bot token');
    expect(status.warnings.join(' ')).toContain('Message Content');
  });

  it('offers no invite URL until an application id exists, and explains why', async () => {
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/discord/invite-url', headers: { cookie: admin.cookie } });
    const invite = response.json() as { url: string | null; reason: string | null; scopes: string[] };
    expect(invite.url).toBeNull();
    expect(invite.reason).toContain('application id');
    expect(invite.scopes).toEqual(['bot', 'applications.commands']);
  });

  it('refuses to enable the bot without a token', async () => {
    const response = await hub.app.inject({
      method: 'PUT',
      url: '/api/v1/discord/config',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(403);
    expect(String((response.json() as { detail: string }).detail)).toContain('bot token');
  });

  it('validates a token with Discord before storing it, and never returns it', async () => {
    hub.fetch.on('discord.com/api/v10/users/@me', () => ({ status: 200, body: { id: '123456789012345678', username: 'now-playing-bot' } }));
    const token = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.this-is-a-fake-bot-token-value';
    const set = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/discord/token',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { token },
    });
    expect(set.json()).toMatchObject({ valid: true, botUsername: 'now-playing-bot', applicationId: '123456789012345678', tokenLast4: token.slice(-4) });

    const config = await hub.app.inject({ method: 'GET', url: '/api/v1/discord/config', headers: { cookie: admin.cookie } });
    expect(config.body).not.toContain(token);
    expect(config.json()).toMatchObject({ tokenSource: 'encrypted', tokenLast4: token.slice(-4) });

    const audit = await hub.app.inject({ method: 'GET', url: '/api/v1/security/audit', headers: { cookie: admin.cookie } });
    expect(audit.body).not.toContain(token);
  });

  it('rejects a token Discord refuses, and does not store it', async () => {
    hub.fetch.on('discord.com/api/v10/users/@me', () => ({ status: 401, body: { message: '401: Unauthorized' } }));
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/discord/token',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { token: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.a-token-discord-does-not-like' },
    });
    expect(response.json()).toMatchObject({ valid: false });
    expect(String((response.json() as { message: string }).message)).toContain('rejected');
    const config = await hub.app.inject({ method: 'GET', url: '/api/v1/discord/config', headers: { cookie: admin.cookie } });
    expect(config.json()).toMatchObject({ tokenSource: 'none' });
  });
});

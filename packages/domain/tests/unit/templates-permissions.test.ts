import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCORD_TEMPLATES, escapeMentions, renderTemplate, validateTemplate, validateTemplates } from '../../src/templates.js';
import { authorizeCommand, buildInviteUrl, type CommandActor, type CommandPolicy } from '../../src/permissions.js';

describe('templates', () => {
  it('validates variables and braces', () => {
    expect(validateTemplate({ content: 'Hi {{title}}', embedTitle: null, embedDescription: null, color: null, ephemeral: false }).errors).toHaveLength(0);
    expect(validateTemplate({ content: 'Hi {{evil}} {{', embedTitle: null, embedDescription: null, color: null, ephemeral: false }).errors.length).toBeGreaterThan(0);
    for (const r of Object.values(validateTemplates(DEFAULT_DISCORD_TEMPLATES))) expect(r.errors).toHaveLength(0);
  });
  it('escapes mentions unless allowlisted', () => {
    expect(escapeMentions('@everyone <@&123> <@42>')).toBe('@\u200beveryone <@\u200b&123> <@\u200b42>');
    expect(escapeMentions('<@&123>', { allowedRoleIds: ['123'] })).toBe('<@&123>');
    const r = renderTemplate({ content: 'Now: {{title}}', embedTitle: null, embedDescription: null, color: null, ephemeral: false }, { title: '@everyone pwn' });
    expect(r.content).toBe('Now: @\u200beveryone pwn');
  });
  it('truncates to Discord limits', () => {
    const r = renderTemplate({ content: 'x'.repeat(3000), embedTitle: null, embedDescription: null, color: null, ephemeral: false }, {});
    expect(r.content.length).toBe(2000);
    expect(r.warnings[0]).toContain('truncated');
  });
});

const policy: CommandPolicy = { djRoleIds: ['dj'], adminRoleIds: ['adm'], guestsMayRequest: true, voteSkipThreshold: 0.5, designatedChannelId: 'music', cooldownSeconds: 5, maxRequestsPerUser: 2 };
const member: CommandActor = { id: 'u1', displayName: 'U', roleIds: [], isGuildAdmin: false, hasManageGuild: false, isRequesterOfCurrent: false };
const dj: CommandActor = { ...member, roleIds: ['dj'] };

describe('permissions', () => {
  it('channel gating applies to slash and prefix but not web', () => {
    expect(authorizeCommand('play', member, policy, { channelId: 'other', transport: 'slash' }).code).toBe('wrong-channel');
    expect(authorizeCommand('play', member, policy, { channelId: 'other', transport: 'prefix' }).code).toBe('wrong-channel');
    expect(authorizeCommand('play', member, policy, { channelId: 'other', transport: 'web' }).allowed).toBe(true);
  });
  it('same decision for slash and prefix', () => {
    for (const cmd of ['pause', 'resume', 'stop', 'shuffle', 'clear', 'join', 'leave'] as const) {
      const s = authorizeCommand(cmd, member, policy, { channelId: 'music', transport: 'slash' });
      const p = authorizeCommand(cmd, member, policy, { channelId: 'music', transport: 'prefix' });
      expect(s).toEqual(p);
      expect(s.allowed).toBe(false);
      expect(authorizeCommand(cmd, dj, policy, { channelId: 'music', transport: 'slash' }).allowed).toBe(true);
    }
  });
  it('skip: requester, dj, or vote', () => {
    expect(authorizeCommand('skip', { ...member, isRequesterOfCurrent: true }, policy, { channelId: 'music', transport: 'slash' }).allowed).toBe(true);
    const vote = authorizeCommand('skip', member, policy, { channelId: 'music', transport: 'slash' });
    expect(vote.allowed).toBe(false);
    expect(vote.voteEligible).toBe(true);
  });
  it('cooldowns, limits, settings', () => {
    expect(authorizeCommand('play', member, policy, { channelId: 'music', transport: 'slash', secondsSinceLastRequest: 1 }).code).toBe('cooldown');
    expect(authorizeCommand('play', member, policy, { channelId: 'music', transport: 'slash', pendingRequestsByActor: 2 }).code).toBe('limit');
    expect(authorizeCommand('play', dj, policy, { channelId: 'music', transport: 'slash', pendingRequestsByActor: 9 }).allowed).toBe(true);
    expect(authorizeCommand('settings', member, policy, { channelId: 'x', transport: 'slash' }).allowed).toBe(false);
    expect(authorizeCommand('settings', { ...member, hasManageGuild: true }, policy, { channelId: 'x', transport: 'slash' }).allowed).toBe(true);
    expect(buildInviteUrl('123')).toContain('scope=bot+applications.commands');
  });
});

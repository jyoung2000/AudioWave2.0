/** Minimal, transport-agnostic Discord fixtures for command-service tests (no discord.js objects). */
export const DISCORD_FIXTURE = {
  guildId: '100000000000000001',
  designatedChannelId: '200000000000000001',
  otherChannelId: '200000000000000002',
  voiceChannelId: '300000000000000001',
  djRoleId: '400000000000000001',
  adminRoleId: '400000000000000002',
  users: {
    dj: { id: '500000000000000001', displayName: 'DJ Dana', roleIds: ['400000000000000001'] },
    member: { id: '500000000000000002', displayName: 'Member Mo', roleIds: [] },
    admin: { id: '500000000000000003', displayName: 'Admin Ari', roleIds: ['400000000000000002'] },
    guest: { id: '500000000000000004', displayName: 'Guest Gus', roleIds: [] },
  },
} as const;
